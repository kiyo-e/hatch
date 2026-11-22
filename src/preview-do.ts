import { DurableObject } from "cloudflare:workers";
import { AwsMicroVmClient, normalizeEndpointUrl, type MicroVmClient } from "./aws-microvm";
import {
  acceptsHtmlBrowserRequest,
  renderBootFailedResponse,
  renderColdStartResponse,
} from "./loading-page";
import type {
  ActiveVmState,
  CachedJweToken,
  Env,
  MicroVmLifecycleState,
  PendingCleanup,
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
const STORAGE_KEY_PENDING_CLEANUP = "pendingCleanup";
// 起動中に再登録が続いた場合に起動をやり直す最大回数
const MAX_BOOT_ATTEMPTS = 3;
// RunMicrovm 失敗後、次の起動を試みるまでの待機時間（リロードのたびに AWS を叩かないため）
export const BOOT_FAILURE_BACKOFF_MS = 30 * 1000;
// アプリ自身が返す 403 / 404 / 502 のたびに AWS API を呼ばないための間隔
export const TOKEN_FORCE_REFRESH_INTERVAL_MS = 30 * 1000;
export const VM_STATE_CHECK_INTERVAL_MS = 30 * 1000;
// 破棄に失敗した MicroVM / イメージの再削除間隔
export const CLEANUP_RETRY_DELAY_MS = 10 * 60 * 1000;

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

/**
 * 直近の起動失敗から BOOT_FAILURE_BACKOFF_MS 経過していないため起動を見送ったことを示す。
 */
export class BootBackoffError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("MicroVM failed to start recently; retrying later.");
    this.name = "BootBackoffError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * destroy で MicroVM の終了またはイメージの削除に失敗したことを示す（Alarm で自動再試行される）。
 */
export class CleanupIncompleteError extends Error {
  readonly pending: PendingCleanup;

  constructor(pending: PendingCleanup) {
    super(
      `Cleanup incomplete (microvms: ${pending.microvmIds.join(",") || "-"}, images: ${
        pending.imageIdentifiers.join(",") || "-"
      }); it will be retried automatically.`
    );
    this.name = "CleanupIncompleteError";
    this.pending = pending;
  }
}

/**
 * 登録しようとしたイメージが、実行中だった削除待ちの再試行で削除されたことを示す（再ビルドして登録し直す必要がある）。
 */
export class ImageDeletedDuringCleanupError extends Error {
  constructor(imageIdentifier: string) {
    super(
      `Image ${imageIdentifier} was deleted by a pending cleanup while registering; rebuild the image and register again.`
    );
    this.name = "ImageDeletedDuringCleanupError";
  }
}

export class PreviewEnvironmentDO extends DurableObject<Env> {
  private readonly aws: MicroVmClient;
  private bootPromise: Promise<ActiveVmState> | null = null;
  private lastBootFailureAt: number | null = null;
  private cachedToken: CachedJweToken | null = null;
  private tokenPromise: { microvmId: string; promise: Promise<string> } | null = null;
  private lastForcedTokenRefresh: { microvmId: string; at: number } | null = null;
  /** 登録・破棄・削除の再試行を直列に実行するためのキュー */
  private exclusiveChain: Promise<void> = Promise.resolve();
  /** 直列キューに並んでいる登録のイメージ（キューの先のクリーンアップはこれらを削除しない） */
  private readonly registrationIntents = new Map<string, number>();
  /** 登録待ちのためクリーンアップが削除を見送ったイメージ（登録が失敗したら削除待ちに戻す） */
  private readonly skippedForRegistration = new Set<string>();
  /** AWS に送信済みで完了待ちのイメージ削除 */
  private imageDeletionInFlight: { imageIdentifier: string; promise: Promise<void> } | null = null;
  private vmStateCheck: {
    microvmId: string;
    at: number;
    promise: Promise<MicroVmLifecycleState>;
  } | null = null;

  constructor(ctx: DurableObjectState, env: Env, awsClient?: MicroVmClient) {
    super(ctx, env);
    this.aws = awsClient ?? new AwsMicroVmClient(env);
  }

  /**
   * CI からビルド済み MicroVM イメージを登録（新コミット時は旧 MicroVM を破棄）。
   * 同時にゾンビイメージ掃除用の DO Alarm を設定する。
   */
  async registerImage(imageIdentifier: string, imageVersion?: string): Promise<void> {
    // 同じイメージの削除が AWS に送信済みなら、その結果を後で確認する
    const deletion =
      this.imageDeletionInFlight?.imageIdentifier === imageIdentifier
        ? this.imageDeletionInFlight.promise
        : null;

    // キューに並んでいる間、先に実行される破棄・削除の再試行がこのイメージを消さないよう意図を示す
    this.registrationIntents.set(imageIdentifier, (this.registrationIntents.get(imageIdentifier) ?? 0) + 1);
    try {
      return await this.exclusive(async () => {
        const wasPending = await this.removeFromPendingCleanup({
          microvmIds: [],
          imageIdentifiers: [imageIdentifier],
        });
        try {
          await this.registerImageLocked(imageIdentifier, imageVersion, deletion);
        } catch (err) {
          // 登録に失敗したら、外した・見送った削除を元に戻す（登録も削除もされないイメージを残さない）
          const skipped = wasPending || this.skippedForRegistration.has(imageIdentifier);
          if (skipped && !(err instanceof ImageDeletedDuringCleanupError)) {
            await this.restorePendingImage(imageIdentifier);
          }
          throw err;
        }
      });
    } finally {
      const count = (this.registrationIntents.get(imageIdentifier) ?? 1) - 1;
      if (count > 0) {
        this.registrationIntents.set(imageIdentifier, count);
      } else {
        this.registrationIntents.delete(imageIdentifier);
        this.skippedForRegistration.delete(imageIdentifier);
      }
    }
  }

  private async restorePendingImage(imageIdentifier: string): Promise<void> {
    try {
      const registered = await this.getActiveState();
      if (registered?.imageIdentifier !== imageIdentifier) {
        await this.enqueueCleanup({ microvmIds: [], imageIdentifiers: [imageIdentifier] });
      }
    } catch (err) {
      console.error(`[preview-do] failed to restore pending cleanup for ${imageIdentifier}:`, err);
    }
  }

  private async registerImageLocked(
    imageIdentifier: string,
    imageVersion: string | undefined,
    deletion: Promise<void> | null
  ): Promise<void> {
    // 送信済みだった削除が成功していたら、存在しないイメージを登録しないよう拒否する
    if (deletion && (await deletion.then(() => true, () => false))) {
      throw new ImageDeletedDuringCleanupError(imageIdentifier);
    }

    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);

    // 起動中の bootPromise は破棄する（完了時に generation 不一致を検出して自ら VM を終了する）
    this.resetInMemoryState();

    const now = Date.now();
    const nextState: PersistedVmState = {
      imageIdentifier,
      imageVersion,
      generation: crypto.randomUUID(),
      zombieAt: now + this.getZombieTtlMs(),
      updatedAt: now,
    };
    // 旧 MicroVM は先に削除待ちとして永続化してから終了する（終了に失敗しても Alarm で再試行される）。
    // 未完了の破棄（状態の削除待ち）があれば、この登録が後勝ちするので取り消す
    await this.enqueueCleanup(
      { microvmIds: current?.microvmId ? [current.microvmId] : [], imageIdentifiers: [] },
      { destroyState: false }
    );
    await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, nextState);
    await this.scheduleNextAlarm();

    if (current?.microvmId) {
      await this.processCleanupQueueLocked({ microvmIds: [current.microvmId], imageIdentifiers: [] });
    }
  }

  /**
   * PR クローズ時または DO Alarm 発火時の完全クリーンアップ。
   * MicroVM の終了・イメージ削除に失敗した場合は削除待ちとして Alarm で再試行し、
   * CleanupIncompleteError を投げる（呼び出し元の CI が失敗として検知できるようにする）。
   */
  async destroy(): Promise<void> {
    return this.exclusive(() => this.destroyLocked());
  }

  private async destroyLocked(): Promise<void> {
    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);

    // 削除対象と「状態を消す」意図を先に永続化する。状態の削除に失敗しても、以降のアクセスでは
    // 破棄済みとして扱い、Alarm で状態の削除から再試行する
    await this.enqueueCleanup(
      {
        microvmIds: current?.microvmId ? [current.microvmId] : [],
        imageIdentifiers: current?.imageIdentifier ? [current.imageIdentifier] : [],
      },
      { destroyState: true }
    );
    this.resetInMemoryState();

    const remaining = await this.processCleanupQueueLocked();
    if (remaining) {
      throw new CleanupIncompleteError(remaining);
    }
  }

  /**
   * DO Alarm ハンドラ。
   * - 放置 PR（Webhook 取りこぼし等）のゾンビイメージを自動掃除する
   * - 破棄に失敗した MicroVM / イメージの削除を再試行する
   */
  async alarm(): Promise<void> {
    try {
      // 掃除期限の判定と破棄を同じ直列処理の中で行う（キューの先の登録で更新された状態を消さない）
      const remaining = await this.exclusive(async () => {
        const state = await this.getActiveState();
        // zombieAt を持たない旧バージョンの状態は、従来どおり Alarm 発火 = 掃除期限とみなす
        if (state && (state.zombieAt === undefined || state.zombieAt <= Date.now())) {
          await this.destroyLocked();
          return null;
        }
        return this.processCleanupQueueLocked();
      });
      if (remaining) {
        console.error("[preview-do] alarm cleanup incomplete; will retry:", remaining);
      }
    } catch (err) {
      // CleanupIncompleteError は失敗分が削除待ちとして永続化され、次の Alarm も設定済み。
      // それ以外（ストレージ障害等）は再設定できていないため、再送出してプラットフォームの自動リトライに任せる
      if (err instanceof CleanupIncompleteError) {
        console.error("[preview-do] alarm cleanup incomplete:", err);
        return;
      }
      throw err;
    }
  }

  /**
   * 有効な登録状態を返す。破棄の途中（状態の削除待ち）なら登録なしとして扱う。
   */
  private async getActiveState(): Promise<PersistedVmState | undefined> {
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (pending?.destroyState) return undefined;
    return this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
  }

  /**
   * 管理 API 向けの状態確認 RPC。
   */
  async getStatus(): Promise<PreviewStatusResponse> {
    const state = await this.getActiveState();
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    const alarmMs = await this.ctx.storage.getAlarm();
    const cleanup = pending
      ? {
          cleanupPending: {
            microvmIds: pending.microvmIds,
            imageIdentifiers: pending.imageIdentifiers,
          },
          alarmAt: alarmMs ? new Date(alarmMs).toISOString() : undefined,
        }
      : {};

    if (!state?.imageIdentifier) {
      return { registered: false, booting: false, ...cleanup };
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
      ...cleanup,
    };
  }

  /**
   * HTTP / WebSocket 透過リバースプロキシのエントリーポイント。
   */
  async fetch(request: Request): Promise<Response> {
    const state = await this.getActiveState();
    if (!state?.imageIdentifier) {
      return new Response("Preview environment is not built yet.", { status: 404 });
    }

    const hostLabel = new URL(request.url).hostname;

    // コールドスタート UX 改善: 起動が必要かつブラウザの HTML リクエストなら即座に自動リロード画面を返す
    if (
      !this.isVmAlive(state) &&
      this.env.COLD_START_LOADING_PAGE === "true" &&
      acceptsHtmlBrowserRequest(request)
    ) {
      // 直近で起動に失敗していたら「起動中」を出し続けず、失敗画面を返す
      const backoffSeconds = this.bootBackoffRemainingSeconds();
      if (backoffSeconds > 0) {
        return renderBootFailedResponse(hostLabel, backoffSeconds);
      }
      this.ctx.waitUntil(this.ensureRunningMicroVm().catch(() => {}));
      return renderColdStartResponse(hostLabel, 3);
    }

    try {
      return await this.proxyWithRecovery(request);
    } catch (err) {
      if (err instanceof NoImageRegisteredError) {
        return new Response(err.message, { status: 404 });
      }
      // AWS のエラー内容は未認証の閲覧者に見せず、ログにのみ残す
      console.error(`[preview-do] ${hostLabel}: failed to serve request:`, err);
      const retryAfter = err instanceof BootBackoffError ? err.retryAfterSeconds : 5;
      if (acceptsHtmlBrowserRequest(request)) {
        return renderBootFailedResponse(hostLabel, retryAfter);
      }
      return new Response("Preview environment is temporarily unavailable.", {
        status: 502,
        headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
      });
    }
  }

  private async proxyWithRecovery(request: Request): Promise<Response> {
    const vm = await this.ensureRunningMicroVm();
    let token = await this.getValidJweToken(vm.microvmId);
    let response = await this.proxyToMicroVm(request, vm.endpointUrl, token);

    // トークンが想定外に失効していた場合（403）はトークンを再発行して 1 回リトライ。
    // アプリ自身の 403 で毎回発行しないよう、強制再発行は VM ごとに一定間隔に 1 回まで
    if (response.status === 403 && this.canRetryRequest(request)) {
      const refreshed = await this.refreshTokenAfter403(vm.microvmId, token);
      if (refreshed) {
        await response.body?.cancel();
        token = refreshed;
        response = await this.proxyToMicroVm(request, vm.endpointUrl, token);
      }
    }

    // 寿命内でも AWS 側で TERMINATED / NOT_FOUND になっていた場合の自己修復リトライ（1 回だけ）
    if (
      (response.status === 410 || response.status === 404 || response.status === 502) &&
      this.canRetryRequest(request)
    ) {
      const vmState = await this.checkVmState(vm.microvmId);
      if (vmState === "TERMINATED" || vmState === "TERMINATING" || vmState === "NOT_FOUND") {
        await response.body?.cancel();
        await this.invalidateVmInstance(vm.microvmId);
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
      const state = await this.getActiveState();
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
      const backoffSeconds = this.bootBackoffRemainingSeconds();
      if (backoffSeconds > 0) {
        return Promise.reject(new BootBackoffError(backoffSeconds));
      }

      const boot: Promise<ActiveVmState> = this.provisionNewMicroVm(state)
        .then(
          (vm) => {
            if (this.bootPromise === boot) this.lastBootFailureAt = null;
            return vm;
          },
          (err: unknown) => {
            if (this.bootPromise === boot && !(err instanceof StaleBootError)) {
              this.lastBootFailureAt = Date.now();
            }
            throw err;
          }
        )
        .finally(() => {
          // registerImage / destroy 後に始まった別の起動のロックを解放しないよう、自分自身の場合のみ解除
          if (this.bootPromise === boot) {
            this.bootPromise = null;
          }
        });
      this.bootPromise = boot;
    }
    return this.bootPromise;
  }

  private bootBackoffRemainingSeconds(): number {
    if (this.lastBootFailureAt === null) return 0;
    const remainingMs = this.lastBootFailureAt + BOOT_FAILURE_BACKOFF_MS - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  private resetInMemoryState(): void {
    this.cachedToken = null;
    this.tokenPromise = null;
    this.bootPromise = null;
    this.lastBootFailureAt = null;
    this.lastForcedTokenRefresh = null;
    this.vmStateCheck = null;
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
      // aws4fetch は 5xx / 429 で自動リトライするため、重複起動しないよう冪等トークンを付ける
      clientToken: crypto.randomUUID(),
    });

    // RunMicrovm 待ちの間に registerImage / destroy が走っていたら、起動結果を書き戻さずに VM を終了する
    // （get → put の間に外部 I/O を挟まないため、DO の入力ゲートにより他のイベントは割り込まない）
    const latest = await this.getActiveState();
    if (
      !latest?.imageIdentifier ||
      latest.generation !== state.generation ||
      latest.imageIdentifier !== state.imageIdentifier ||
      latest.imageVersion !== state.imageVersion
    ) {
      // 終了に失敗しても見失わないよう、削除待ちとして永続化してから終了する
      try {
        await this.enqueueCleanup({ microvmIds: [started.microvmId], imageIdentifiers: [] });
      } catch (err) {
        // 永続化できなければ、記録の残らない VM を放置しないよう直接終了を試みる
        console.error(`[preview-do] failed to persist stale MicroVM ${started.microvmId}:`, err);
        this.ctx.waitUntil(
          this.aws
            .terminateMicroVm(started.microvmId)
            .catch((terminateErr) =>
              console.error(`[preview-do] TerminateMicrovm(${started.microvmId}) failed:`, terminateErr)
            )
        );
        throw new StaleBootError();
      }
      this.ctx.waitUntil(
        this.exclusive(() =>
          this.processCleanupQueueLocked({ microvmIds: [started.microvmId], imageIdentifiers: [] })
        ).catch((err) => console.error("[preview-do] stale MicroVM cleanup failed:", err))
      );
      throw new StaleBootError();
    }

    const now = Date.now();
    const nextState: ActiveVmState = {
      ...latest,
      microvmId: started.microvmId,
      endpointUrl: started.endpointUrl,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, nextState);
    return nextState;
  }

  /**
   * 停止を確認した MicroVM の記録を消す。並行リクエストが既に新しい VM を起動・保存していた場合は
   * その記録を消さないよう、保存中の microvmId が一致するときだけ消す。
   */
  private async invalidateVmInstance(deadMicrovmId: string): Promise<void> {
    if (this.cachedToken?.microvmId === deadMicrovmId) this.cachedToken = null;
    if (this.tokenPromise?.microvmId === deadMicrovmId) this.tokenPromise = null;

    const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    if (state?.imageIdentifier && state.microvmId === deadMicrovmId) {
      const { microvmId: _id, endpointUrl: _url, createdAt: _at, ...rest } = state;
      await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, {
        ...rest,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * GetMicrovm の結果を VM ごとに一定時間共有する（同時リクエストやアプリ自身の 404 で連打しない）。
   */
  private checkVmState(microvmId: string): Promise<MicroVmLifecycleState> {
    const cached = this.vmStateCheck;
    if (
      cached &&
      cached.microvmId === microvmId &&
      Date.now() - cached.at < VM_STATE_CHECK_INTERVAL_MS
    ) {
      return cached.promise;
    }
    const promise = this.aws.getMicroVmState(microvmId).catch(() => "UNKNOWN" as const);
    this.vmStateCheck = { microvmId, at: Date.now(), promise };
    return promise;
  }

  /**
   * 403 を受けたリクエスト用の新しいトークンを返す（再試行しない場合は null）。
   * 同じ失効トークンで同時に 403 を受けたリクエストは、発行中・発行済みの新トークンに相乗りする。
   */
  private async refreshTokenAfter403(microvmId: string, staleToken: string): Promise<string | null> {
    const cached = this.cachedToken;
    if (cached && cached.microvmId === microvmId && cached.token !== staleToken) {
      return cached.token;
    }
    if (this.tokenPromise?.microvmId === microvmId) {
      const joined = await this.tokenPromise.promise;
      return joined !== staleToken ? joined : null;
    }
    if (!this.claimForcedTokenRefresh(microvmId)) {
      return null;
    }
    this.cachedToken = null;
    return this.getValidJweToken(microvmId);
  }

  private claimForcedTokenRefresh(microvmId: string): boolean {
    const last = this.lastForcedTokenRefresh;
    const now = Date.now();
    if (last && last.microvmId === microvmId && now - last.at < TOKEN_FORCE_REFRESH_INTERVAL_MS) {
      return false;
    }
    this.lastForcedTokenRefresh = { microvmId, at: now };
    return true;
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

  private getZombieTtlMs(): number {
    const days = Number.parseInt(this.env.ZOMBIE_TTL_DAYS || String(DEFAULT_ZOMBIE_TTL_DAYS), 10);
    const ttlDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_ZOMBIE_TTL_DAYS;
    return ttlDays * 24 * 60 * 60 * 1000;
  }

  /**
   * 登録・破棄・削除の再試行を直列に実行する。fn の中から exclusive を呼ばないこと（デッドロックする）。
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.then(fn);
    this.exclusiveChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * 削除待ちに対象を追加する（外部 I/O を挟まない読み書きなので、他のイベントと交錯しない）。
   */
  private async enqueueCleanup(
    targets: CleanupTargets,
    options: { destroyState?: boolean } = {}
  ): Promise<void> {
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    const destroyState = options.destroyState ?? pending?.destroyState;
    if (
      targets.microvmIds.length === 0 &&
      targets.imageIdentifiers.length === 0 &&
      Boolean(destroyState) === Boolean(pending?.destroyState)
    ) {
      return;
    }
    await this.savePendingCleanup({
      microvmIds: uniq([...(pending?.microvmIds ?? []), ...targets.microvmIds]),
      imageIdentifiers: uniq([...(pending?.imageIdentifiers ?? []), ...targets.imageIdentifiers]),
      retryAt: pending?.retryAt ?? Date.now() + CLEANUP_RETRY_DELAY_MS,
      ...(destroyState ? { destroyState: true } : {}),
    });
    await this.scheduleNextAlarm();
  }

  /**
   * 削除待ちから対象を外す。処理中に他の操作が追加した対象は残す。
   */
  private async removeFromPendingCleanup(targets: CleanupTargets, nextRetryAt?: number): Promise<boolean> {
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (!pending) return false;
    const removed =
      pending.microvmIds.some((id) => targets.microvmIds.includes(id)) ||
      pending.imageIdentifiers.some((id) => targets.imageIdentifiers.includes(id));
    await this.savePendingCleanup({
      ...pending,
      microvmIds: pending.microvmIds.filter((id) => !targets.microvmIds.includes(id)),
      imageIdentifiers: pending.imageIdentifiers.filter((id) => !targets.imageIdentifiers.includes(id)),
      retryAt: nextRetryAt ?? pending.retryAt,
    });
    return removed;
  }

  /**
   * 削除待ちの MicroVM 終了・イメージ削除を実行し、成功した分を削除待ちから外す（exclusive の中で呼ぶ）。
   * only を指定した場合はその対象だけを処理する。削除しきれなかった対象を返す（なければ null）。
   */
  private async processCleanupQueueLocked(only?: CleanupTargets): Promise<PendingCleanup | null> {
    // 破棄の途中なら、まず状態を消す（失敗したら例外のまま。削除待ちと意図は残るので Alarm で再試行される）
    const tombstone = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (tombstone?.destroyState) {
      await this.ctx.storage.delete(STORAGE_KEY_STATE);
      const { destroyState: _done, ...rest } = tombstone;
      await this.savePendingCleanup(rest);
    }

    // キューで実際に処理を始める時点の内容を読む（並んでいる間に追加された対象も含める）
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    const done: CleanupTargets = { microvmIds: [], imageIdentifiers: [] };
    const microvmIds = (pending?.microvmIds ?? []).filter((id) => !only || only.microvmIds.includes(id));
    const imageIdentifiers = (pending?.imageIdentifiers ?? []).filter(
      (id) => !only || only.imageIdentifiers.includes(id)
    );

    for (const id of microvmIds) {
      try {
        await this.aws.terminateMicroVm(id);
        done.microvmIds.push(id);
      } catch (err) {
        console.error(`[preview-do] TerminateMicrovm(${id}) failed:`, err);
      }
    }
    for (const id of imageIdentifiers) {
      // 直前に削除待ちから外された（再登録された）イメージは消さない
      const latest = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
      if (!latest?.imageIdentifiers.includes(id)) continue;
      // キューの後ろに同じイメージの登録が並んでいれば削除を見送る（登録が失敗したら削除待ちに戻される）
      if (this.registrationIntents.has(id)) {
        this.skippedForRegistration.add(id);
        done.imageIdentifiers.push(id);
        continue;
      }
      const registered = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
      if (registered?.imageIdentifier === id) {
        done.imageIdentifiers.push(id);
        continue;
      }
      const promise = this.aws.deleteMicroVmImage(id);
      this.imageDeletionInFlight = { imageIdentifier: id, promise };
      try {
        await promise;
        done.imageIdentifiers.push(id);
      } catch (err) {
        console.error(`[preview-do] DeleteMicrovmImage(${id}) failed:`, err);
      } finally {
        if (this.imageDeletionInFlight?.promise === promise) this.imageDeletionInFlight = null;
      }
    }

    // 一部の対象だけを処理した場合（登録時の旧 VM 終了など）は、試していない対象の再試行時刻を延ばさない
    const nextRetryAt = Date.now() + CLEANUP_RETRY_DELAY_MS;
    await this.removeFromPendingCleanup(
      done,
      only && pending ? Math.min(pending.retryAt, nextRetryAt) : nextRetryAt
    );
    await this.scheduleNextAlarm();
    return (await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP)) ?? null;
  }

  private async savePendingCleanup(pending: PendingCleanup): Promise<void> {
    if (pending.microvmIds.length === 0 && pending.imageIdentifiers.length === 0 && !pending.destroyState) {
      await this.ctx.storage.delete(STORAGE_KEY_PENDING_CLEANUP);
    } else {
      await this.ctx.storage.put<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP, pending);
    }
  }

  /**
   * ゾンビ掃除期限と削除待ちの再試行時刻のうち、早いほうに Alarm を設定する。
   */
  private async scheduleNextAlarm(): Promise<void> {
    const state = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    const times = [state?.zombieAt, pending?.retryAt].filter((t): t is number => typeof t === "number");
    if (times.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...times));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
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
    const targetUrl = new URL(normalizeEndpointUrl(endpointUrl));
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

type CleanupTargets = Omit<PendingCleanup, "retryAt">;

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}
