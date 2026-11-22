import { DurableObject } from "cloudflare:workers";
import { AwsMicroVmClient, type MicroVmClient } from "./aws-microvm";
import { acceptsHtmlBrowserRequest, renderColdStartResponse } from "./loading-page";
import type {
  ActiveVmState,
  CachedJweToken,
  Env,
  PersistedVmState,
  PreviewStatusResponse,
} from "./types";

// AWS Lambda MicroVM の最大寿命 8 時間 (28,800 秒) から安全マージン 15 分を引いた実効 TTL
export const MAX_VM_LIFETIME_MS = (8 * 60 - 15) * 60 * 1000;
// JWE トークンの有効期限（15 分）の 60 秒前にリフレッシュ
export const TOKEN_DURATION_MINUTES = 15;
export const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
// 自動サスペンド設定（5 分無アクセスでサスペンド、最大 8 時間まで維持）
const MAX_IDLE_DURATION_SECONDS = 300;
const SUSPENDED_DURATION_SECONDS = 28800;
const DEFAULT_ZOMBIE_TTL_DAYS = 14;
const STORAGE_KEY_STATE = "state";

export class NoImageRegisteredError extends Error {
  constructor() {
    super("Preview environment is not built yet.");
    this.name = "NoImageRegisteredError";
  }
}

/**
 * RunMicrovm の完了までの間に再登録・破棄が行われ、起動結果が古くなったことを示す。
 */
export class StaleBootError extends Error {
  constructor() {
    super("Preview environment was re-registered or destroyed while the MicroVM was booting.");
    this.name = "StaleBootError";
  }
}

// 起動中に再登録が続いた場合に起動をやり直す最大回数
const MAX_BOOT_ATTEMPTS = 3;

export class PreviewEnvironmentDO extends DurableObject<Env> {
  private readonly aws: MicroVmClient;
  private bootPromise: Promise<ActiveVmState> | null = null;
  private cachedToken: CachedJweToken | null = null;
  private tokenPromise: { microvmId: string; promise: Promise<string> } | null = null;

  constructor(ctx: DurableObjectState, env: Env, awsClient?: MicroVmClient) {
    super(ctx, env);
    this.aws = awsClient ?? new AwsMicroVmClient(env);
  }

  /**
   * CI からビルド済み MicroVM イメージを登録（新コミット時は旧 MicroVM を破棄）。
   * 同時にゾンビイメージ掃除用の DO Alarm を設定する。
   */
  async registerImage(imageIdentifier: string, imageVersion?: string): Promise<void> {
    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    if (current?.microvmId) {
      await this.aws.terminateMicroVm(current.microvmId).catch(() => {});
    }

    // 起動中の bootPromise は破棄する（完了時に generation 不一致を検出して自ら VM を終了する）
    this.resetInMemoryState();

    const nextState: PersistedVmState = {
      imageIdentifier,
      imageVersion,
      generation: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, nextState);
    await this.scheduleZombieCleanupAlarm();
  }

  /**
   * PR クローズ時または DO Alarm 発火時の完全クリーンアップ。
   */
  async destroy(): Promise<void> {
    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    if (current?.microvmId) {
      await this.aws.terminateMicroVm(current.microvmId).catch(() => {});
    }
    if (current?.imageIdentifier) {
      await this.aws.deleteMicroVmImage(current.imageIdentifier).catch(() => {});
    }
    this.resetInMemoryState();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * 放置 PR（Webhook 取りこぼし等）のゾンビイメージを自動掃除する Alarm ハンドラ。
   */
  async alarm(): Promise<void> {
    await this.destroy();
  }

  /**
   * 管理 API 向けの状態確認 RPC。
   */
  async getStatus(): Promise<PreviewStatusResponse> {
    const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    const alarmMs = await this.ctx.storage.getAlarm();

    if (!state?.imageIdentifier) {
      return { registered: false, booting: false };
    }

    return {
      registered: true,
      imageIdentifier: state.imageIdentifier,
      imageVersion: state.imageVersion,
      microvmId: state.microvmId,
      booting: this.bootPromise !== null,
      createdAt: state.createdAt ? new Date(state.createdAt).toISOString() : undefined,
      expiresAt: state.createdAt
        ? new Date(state.createdAt + MAX_VM_LIFETIME_MS).toISOString()
        : undefined,
      alarmAt: alarmMs ? new Date(alarmMs).toISOString() : undefined,
    };
  }

  /**
   * HTTP / WebSocket 透過リバースプロキシのエントリーポイント。
   */
  async fetch(request: Request): Promise<Response> {
    const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    if (!state?.imageIdentifier) {
      return new Response("Preview environment is not built yet.", { status: 404 });
    }

    // コールドスタート UX 改善: 起動が必要かつブラウザの HTML リクエストなら即座に自動リロード画面を返す
    if (
      !this.isVmAlive(state) &&
      this.env.COLD_START_LOADING_PAGE === "true" &&
      acceptsHtmlBrowserRequest(request)
    ) {
      this.ctx.waitUntil(this.ensureRunningMicroVm().catch(() => {}));
      const hostLabel = new URL(request.url).hostname;
      return renderColdStartResponse(hostLabel, 3);
    }

    let vm: ActiveVmState;
    try {
      vm = await this.ensureRunningMicroVm();
    } catch (err) {
      if (err instanceof NoImageRegisteredError) {
        return new Response(err.message, { status: 404 });
      }
      return new Response(`Failed to start MicroVM: ${(err as Error).message}`, { status: 502 });
    }

    let token = await this.getValidJweToken(vm.microvmId);
    let response = await this.proxyToMicroVm(request, vm.endpointUrl, token);

    // トークンが想定外に失効していた場合（403）はトークンを再発行して 1 回リトライ
    if (response.status === 403 && this.canRetryRequest(request)) {
      this.cachedToken = null;
      token = await this.getValidJweToken(vm.microvmId);
      response = await this.proxyToMicroVm(request, vm.endpointUrl, token);
    }

    // 寿命内でも AWS 側で TERMINATED / NOT_FOUND になっていた場合の自己修復リトライ（1 回だけ）
    if (
      (response.status === 410 || response.status === 404 || response.status === 502) &&
      this.canRetryRequest(request)
    ) {
      const vmState = await this.aws.getMicroVmState(vm.microvmId);
      if (vmState === "TERMINATED" || vmState === "TERMINATING" || vmState === "NOT_FOUND") {
        await this.invalidateVmInstance();
        const freshVm = await this.ensureRunningMicroVm();
        const freshToken = await this.getValidJweToken(freshVm.microvmId);
        response = await this.proxyToMicroVm(request, freshVm.endpointUrl, freshToken);
      }
    }

    return response;
  }

  private isVmAlive(state: PersistedVmState): state is ActiveVmState {
    return Boolean(
      state.microvmId &&
        state.endpointUrl &&
        state.createdAt &&
        Date.now() - state.createdAt < MAX_VM_LIFETIME_MS
    );
  }

  private canRetryRequest(request: Request): boolean {
    // ボディを消費済みの POST/PUT 等は再送不可のため安全にリトライできるメソッドに限定
    return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  }

  /**
   * 稼働中の MicroVM を保証する（未起動 or 7h45m 超過なら排他ロック付きで RunMicrovm）。
   */
  private async ensureRunningMicroVm(): Promise<ActiveVmState> {
    for (let attempt = 1; ; attempt++) {
      const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
      if (!state?.imageIdentifier) {
        throw new NoImageRegisteredError();
      }

      if (this.isVmAlive(state)) {
        return state;
      }

      try {
        return await this.startOrJoinBoot(state);
      } catch (err) {
        // 起動中に再登録された場合は最新の登録内容で起動し直す（破棄済みなら次ループで 404）
        if (err instanceof StaleBootError && attempt < MAX_BOOT_ATTEMPTS) {
          continue;
        }
        throw err;
      }
    }
  }

  private startOrJoinBoot(state: PersistedVmState): Promise<ActiveVmState> {
    if (!this.bootPromise) {
      const boot: Promise<ActiveVmState> = this.provisionNewMicroVm(state).finally(() => {
        // registerImage / destroy 後に始まった別の起動のロックを解放しないよう、自分自身の場合のみ解除
        if (this.bootPromise === boot) {
          this.bootPromise = null;
        }
      });
      this.bootPromise = boot;
    }
    return this.bootPromise;
  }

  private resetInMemoryState(): void {
    this.cachedToken = null;
    this.tokenPromise = null;
    this.bootPromise = null;
  }

  private async provisionNewMicroVm(state: PersistedVmState): Promise<ActiveVmState> {
    if (state.microvmId) {
      await this.aws.terminateMicroVm(state.microvmId).catch(() => {});
    }
    this.cachedToken = null;

    const egressConnectors = this.env.AWS_EGRESS_NETWORK_CONNECTORS
      ? this.env.AWS_EGRESS_NETWORK_CONNECTORS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const started = await this.aws.runMicroVm({
      imageIdentifier: state.imageIdentifier,
      imageVersion: state.imageVersion,
      maxIdleDurationSeconds: MAX_IDLE_DURATION_SECONDS,
      autoResumeEnabled: true,
      suspendedDurationSeconds: SUSPENDED_DURATION_SECONDS,
      maximumDurationInSeconds: 28800,
      executionRoleArn: this.env.AWS_MICROVM_EXECUTION_ROLE_ARN,
      egressNetworkConnectors: egressConnectors,
    });

    // RunMicrovm 待ちの間に registerImage / destroy が走っていたら、起動結果を書き戻さずに VM を終了する
    // （get → put の間に外部 I/O を挟まないため、DO の入力ゲートにより他のイベントは割り込まない）
    const latest = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    if (
      !latest?.imageIdentifier ||
      latest.generation !== state.generation ||
      latest.imageIdentifier !== state.imageIdentifier ||
      latest.imageVersion !== state.imageVersion
    ) {
      this.ctx.waitUntil(this.aws.terminateMicroVm(started.microvmId).catch(() => {}));
      throw new StaleBootError();
    }

    const now = Date.now();
    const nextState: ActiveVmState = {
      imageIdentifier: state.imageIdentifier,
      imageVersion: state.imageVersion,
      generation: state.generation,
      microvmId: started.microvmId,
      endpointUrl: started.endpointUrl,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, nextState);
    return nextState;
  }

  private async invalidateVmInstance(): Promise<void> {
    const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    this.cachedToken = null;
    this.tokenPromise = null;
    if (state?.imageIdentifier) {
      await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, {
        imageIdentifier: state.imageIdentifier,
        imageVersion: state.imageVersion,
        generation: state.generation,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * JWE 認証トークンのインメモリキャッシュと期限 60 秒前リフレッシュ。
   */
  private getValidJweToken(microvmId: string): Promise<string> {
    const cached = this.cachedToken;
    if (
      cached &&
      cached.microvmId === microvmId &&
      Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return Promise.resolve(cached.token);
    }

    // 同時リクエストでトークンを重複発行しないよう、発行中の Promise に相乗りする
    if (this.tokenPromise?.microvmId === microvmId) {
      return this.tokenPromise.promise;
    }

    const promise: Promise<string> = this.issueJweToken(microvmId).finally(() => {
      if (this.tokenPromise?.promise === promise) {
        this.tokenPromise = null;
      }
    });
    this.tokenPromise = { microvmId, promise };
    return promise;
  }

  private async issueJweToken(microvmId: string): Promise<string> {
    const issuedAt = Date.now();
    const issued = await this.aws.createMicroVmAuthToken({
      microvmId,
      expirationInMinutes: TOKEN_DURATION_MINUTES,
      allowedPort: this.getTargetPort(),
    });

    // 発行中に cachedToken が無効化（403 リトライ・再登録等）されていても、この VM 用のトークンとしては有効
    if (this.tokenPromise?.microvmId === microvmId) {
      this.cachedToken = {
        microvmId,
        token: issued.token,
        expiresAt: issuedAt + issued.expirationInMinutes * 60 * 1000,
      };
    }
    return issued.token;
  }

  private getTargetPort(): number {
    const parsed = Number.parseInt(this.env.APP_TARGET_PORT || "8080", 10);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8080;
  }

  private async scheduleZombieCleanupAlarm(): Promise<void> {
    const days = Number.parseInt(this.env.ZOMBIE_TTL_DAYS || String(DEFAULT_ZOMBIE_TTL_DAYS), 10);
    const ttlDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_ZOMBIE_TTL_DAYS;
    await this.ctx.storage.setAlarm(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }

  /**
   * X-aws-proxy-auth と X-aws-proxy-port を付与して MicroVM エンドポイントへ透過転送。
   * Upgrade: websocket ヘッダが含まれる場合も Workers の fetch が双方向トンネルを確立する。
   */
  private async proxyToMicroVm(
    incomingRequest: Request,
    endpointUrl: string,
    jweToken: string
  ): Promise<Response> {
    const incomingUrl = new URL(incomingRequest.url);
    const targetUrl = new URL(endpointUrl);
    targetUrl.pathname = incomingUrl.pathname;
    targetUrl.search = incomingUrl.search;

    const headers = new Headers(incomingRequest.headers);
    // オリジナルの Host 情報を Rails 等（URL 生成・CSRF 検証・config.hosts）へ伝達
    headers.set("X-Forwarded-Host", incomingUrl.host);
    headers.set("X-Forwarded-Proto", "https");
    headers.set("Host", targetUrl.host);

    // AWS Lambda MicroVMs 必須ヘッダー（Lambda 側でアプリ転送前に自動除去される）
    headers.set("X-aws-proxy-auth", jweToken);
    headers.set("X-aws-proxy-port", String(this.getTargetPort()));

    const proxyReq = new Request(targetUrl.toString(), {
      method: incomingRequest.method,
      headers,
      body:
        incomingRequest.method === "GET" || incomingRequest.method === "HEAD"
          ? undefined
          : incomingRequest.body,
      redirect: "manual",
    });

    return fetch(proxyReq);
  }
}
