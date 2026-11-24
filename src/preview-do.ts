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

// Effective TTL: 8h (28,800s) MicroVM maximum lifetime minus a 15-minute safety margin.
export const MAX_VM_LIFETIME_MS = (8 * 60 - 15) * 60 * 1000;
// Refresh 15-minute JWE tokens 60 seconds before expiry.
export const TOKEN_DURATION_MINUTES = 15;
export const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
// Auto-suspend after 5 minutes of inactivity; retain suspended state up to 8 hours.
const MAX_IDLE_DURATION_SECONDS = 300;
const SUSPENDED_DURATION_SECONDS = 28800;
const DEFAULT_ZOMBIE_TTL_DAYS = 14;
const STORAGE_KEY_STATE = "state";
const STORAGE_KEY_PENDING_CLEANUP = "pendingCleanup";
const MAX_BOOT_ATTEMPTS = 3;
// Cooldown after a RunMicrovm failure to avoid hammering AWS on repeated reloads.
export const BOOT_FAILURE_BACKOFF_MS = 30 * 1000;
// Rate-limit forced token refreshes / state checks triggered by upstream 403/404/502 responses.
export const TOKEN_FORCE_REFRESH_INTERVAL_MS = 30 * 1000;
export const VM_STATE_CHECK_INTERVAL_MS = 30 * 1000;
export const CLEANUP_RETRY_DELAY_MS = 10 * 60 * 1000;
// Wait up to 30s for TerminateMicrovm before deleting the image (AWS rejects deletion while VMs are running).
export const TERMINATION_WAIT_TIMEOUT_MS = 30 * 1000;
export const TERMINATION_POLL_INTERVAL_MS = 2 * 1000;

export class NoImageRegisteredError extends Error {
  constructor() {
    super("Preview environment is not built yet.");
    this.name = "NoImageRegisteredError";
  }
}

/**
 * Thrown when the environment is re-registered or destroyed while RunMicrovm is in flight.
 */
export class StaleBootError extends Error {
  constructor() {
    super("Preview environment was re-registered or destroyed while the MicroVM was booting.");
    this.name = "StaleBootError";
  }
}

/**
 * Thrown when a boot is skipped due to a recent failure within BOOT_FAILURE_BACKOFF_MS.
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
 * Thrown when destroy leaves MicroVMs or images to be retried by a DO Alarm.
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
 * Thrown when an in-flight pending cleanup deletes the image being registered.
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
  /** Serializes registerImage, destroy, and cleanup retries. */
  private exclusiveChain: Promise<void> = Promise.resolve();
  /** Images queued for registration so earlier cleanups in exclusiveChain do not delete them. */
  private readonly registrationIntents = new Map<string, number>();
  private imageDeletionInFlight: { imageIdentifier: string; promise: Promise<void> } | null = null;
  private vmStateCheck: {
    microvmId: string;
    at: number;
    promise: Promise<MicroVmLifecycleState>;
  } | null = null;

  private readonly terminationWaitTimeoutMs: number;
  private readonly terminationPollIntervalMs: number;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    awsClient?: MicroVmClient,
    options: { terminationWaitTimeoutMs?: number; terminationPollIntervalMs?: number } = {}
  ) {
    super(ctx, env);
    this.aws = awsClient ?? new AwsMicroVmClient(env);
    this.terminationWaitTimeoutMs = options.terminationWaitTimeoutMs ?? TERMINATION_WAIT_TIMEOUT_MS;
    this.terminationPollIntervalMs = options.terminationPollIntervalMs ?? TERMINATION_POLL_INTERVAL_MS;
  }

  /**
   * Register a built MicroVM image from CI (terminates any previous MicroVM and schedules zombie cleanup).
   */
  async registerImage(imageIdentifier: string, imageVersion?: string): Promise<void> {
    const deletion =
      this.imageDeletionInFlight?.imageIdentifier === imageIdentifier
        ? this.imageDeletionInFlight.promise
        : null;

    this.registrationIntents.set(imageIdentifier, (this.registrationIntents.get(imageIdentifier) ?? 0) + 1);
    try {
      return await this.exclusive(() => this.registerImageLocked(imageIdentifier, imageVersion, deletion));
    } finally {
      const count = (this.registrationIntents.get(imageIdentifier) ?? 1) - 1;
      if (count > 0) {
        this.registrationIntents.set(imageIdentifier, count);
      } else {
        this.registrationIntents.delete(imageIdentifier);
      }
    }
  }

  private async registerImageLocked(
    imageIdentifier: string,
    imageVersion: string | undefined,
    deletion: Promise<void> | null
  ): Promise<void> {
    if (deletion && (await deletion.then(() => true, () => false))) {
      throw new ImageDeletedDuringCleanupError(imageIdentifier);
    }

    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
    this.resetInMemoryState();

    const now = Date.now();
    const nextState: PersistedVmState = {
      imageIdentifier,
      imageVersion,
      generation: crypto.randomUUID(),
      zombieAt: now + this.getZombieTtlMs(),
      updatedAt: now,
    };
    // Persist the previous MicroVM for cleanup before updating state so failures are retried via Alarm.
    await this.enqueueCleanup({
      microvmIds: current?.microvmId ? [current.microvmId] : [],
      imageIdentifiers: [],
    });
    await this.ctx.storage.put<PersistedVmState>(STORAGE_KEY_STATE, nextState);
    await this.enqueueCleanup({ microvmIds: [], imageIdentifiers: [] }, { destroyState: false });
    await this.removeFromPendingCleanup({ microvmIds: [], imageIdentifiers: [imageIdentifier] });
    await this.scheduleNextAlarm();

    if (current?.microvmId) {
      await this.processCleanupQueueLocked({ microvmIds: [current.microvmId], imageIdentifiers: [] });
    }
  }

  /**
   * Destroy the environment (terminates MicroVM, deletes image, and clears DO state).
   * Throws CleanupIncompleteError if any AWS deletion fails (retried automatically via Alarm).
   */
  async destroy(): Promise<void> {
    return this.exclusive(() => this.destroyLocked());
  }

  private async destroyLocked(): Promise<void> {
    const current = await this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);

    // Persist cleanup targets and destroyState tombstone before deleting state.
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
   * DO Alarm handler: destroys expired idle environments and retries pending cleanups.
   */
  async alarm(): Promise<void> {
    try {
      const remaining = await this.exclusive(async () => {
        const state = await this.getActiveState();
        // Treat legacy state without zombieAt as immediately expired on Alarm.
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
      // CleanupIncompleteError already persisted pending items and scheduled the next Alarm;
      // rethrow other errors (e.g. storage failures) so the platform retries the Alarm.
      if (err instanceof CleanupIncompleteError) {
        console.error("[preview-do] alarm cleanup incomplete:", err);
        return;
      }
      throw err;
    }
  }

  /**
   * Returns active state, or undefined if a destroyState tombstone is pending.
   */
  private async getActiveState(): Promise<PersistedVmState | undefined> {
    const pending = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (pending?.destroyState) return undefined;
    return this.ctx.storage.get<PersistedVmState>(STORAGE_KEY_STATE);
  }

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
   * Transparent HTTP/WebSocket reverse proxy entry point.
   */
  async fetch(request: Request): Promise<Response> {
    const state = await this.getActiveState();
    if (!state?.imageIdentifier) {
      return new Response("Preview environment is not built yet.", { status: 404 });
    }

    const hostLabel = new URL(request.url).hostname;

    if (
      !this.isVmAlive(state) &&
      this.env.COLD_START_LOADING_PAGE === "true" &&
      acceptsHtmlBrowserRequest(request)
    ) {
      const backoffSeconds = this.bootBackoffRemainingSeconds();
      if (backoffSeconds > 0) {
        return renderBootFailedResponse(hostLabel, backoffSeconds);
      }
      this.ctx.waitUntil(
        this.ensureRunningMicroVm().catch((err) => {
          if (err instanceof StaleBootError || err instanceof NoImageRegisteredError) return;
          console.error(`[preview-do] ${hostLabel}: background boot failed:`, err);
        })
      );
      return renderColdStartResponse(hostLabel, 3);
    }

    try {
      return await this.proxyWithRecovery(request);
    } catch (err) {
      if (err instanceof NoImageRegisteredError) {
        return new Response(err.message, { status: 404 });
      }
      // Never leak AWS error details to unauthenticated viewers.
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

    if (response.status === 403 && this.canRetryRequest(request)) {
      const refreshed = await this.refreshTokenAfter403(vm.microvmId, token);
      if (refreshed) {
        await response.body?.cancel();
        token = refreshed;
        response = await this.proxyToMicroVm(request, vm.endpointUrl, token);
      }
    }

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
    // Only retry idempotent methods whose request body has not been consumed.
    return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  }

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
      // Idempotency token prevents duplicate MicroVMs when aws4fetch retries 5xx/429.
      clientToken: crypto.randomUUID(),
    });

    // Discard and terminate the newly booted VM if state changed while RunMicrovm was in flight.
    const latest = await this.getActiveState();
    if (
      !latest?.imageIdentifier ||
      latest.generation !== state.generation ||
      latest.imageIdentifier !== state.imageIdentifier ||
      latest.imageVersion !== state.imageVersion
    ) {
      try {
        await this.enqueueCleanup({ microvmIds: [started.microvmId], imageIdentifiers: [] });
      } catch (err) {
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
   * Clear dead MicroVM metadata only if storage still points to deadMicrovmId.
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

  private getValidJweToken(microvmId: string): Promise<string> {
    const cached = this.cachedToken;
    if (
      cached &&
      cached.microvmId === microvmId &&
      Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return Promise.resolve(cached.token);
    }

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
   * Serialize registerImage, destroy, and cleanup retries (never call recursively from within fn).
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.then(fn);
    this.exclusiveChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

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
   * Execute pending MicroVM terminations and image deletions (must run inside exclusive).
   * Returns any remaining failed targets, or null if all succeeded.
   */
  private async processCleanupQueueLocked(only?: CleanupTargets): Promise<PendingCleanup | null> {
    const tombstone = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (tombstone?.destroyState) {
      await this.ctx.storage.delete(STORAGE_KEY_STATE);
      const { destroyState: _done, ...rest } = tombstone;
      await this.savePendingCleanup(rest);
    }

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
    if (imageIdentifiers.length > 0) {
      await this.waitForTermination(done.microvmIds);
    }
    for (const id of imageIdentifiers) {
      const latest = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
      if (!latest?.imageIdentifiers.includes(id)) continue;
      if (this.registrationIntents.has(id)) {
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

    const nextRetryAt = Date.now() + CLEANUP_RETRY_DELAY_MS;
    await this.removeFromPendingCleanup(
      done,
      only && pending ? Math.min(pending.retryAt, nextRetryAt) : nextRetryAt
    );
    await this.scheduleNextAlarm();

    const remaining = await this.ctx.storage.get<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP);
    if (!remaining) return null;
    const failed = {
      ...remaining,
      imageIdentifiers: remaining.imageIdentifiers.filter((id) => !this.registrationIntents.has(id)),
    };
    return failed.microvmIds.length > 0 || failed.imageIdentifiers.length > 0 || failed.destroyState
      ? failed
      : null;
  }

  private async waitForTermination(microvmIds: string[]): Promise<void> {
    let waiting = [...microvmIds];
    const deadline = Date.now() + this.terminationWaitTimeoutMs;
    while (waiting.length > 0) {
      const states = await Promise.all(
        waiting.map((id) => this.aws.getMicroVmState(id).catch(() => "UNKNOWN" as const))
      );
      waiting = waiting.filter((_, i) => states[i] !== "TERMINATED" && states[i] !== "NOT_FOUND");
      if (waiting.length === 0) return;
      if (Date.now() + this.terminationPollIntervalMs > deadline) {
        console.error(`[preview-do] MicroVMs still terminating after ${this.terminationWaitTimeoutMs}ms:`, waiting);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.terminationPollIntervalMs));
    }
  }

  private async savePendingCleanup(pending: PendingCleanup): Promise<void> {
    if (pending.microvmIds.length === 0 && pending.imageIdentifiers.length === 0 && !pending.destroyState) {
      await this.ctx.storage.delete(STORAGE_KEY_PENDING_CLEANUP);
    } else {
      await this.ctx.storage.put<PendingCleanup>(STORAGE_KEY_PENDING_CLEANUP, pending);
    }
  }

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
    headers.set("X-Forwarded-Host", incomingUrl.host);
    headers.set("X-Forwarded-Proto", "https");
    headers.set("Host", targetUrl.host);

    // Required by AWS Lambda MicroVMs proxy (stripped before reaching the app).
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
