import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

const {
  PreviewEnvironmentDO,
  MAX_VM_LIFETIME_MS,
  BOOT_FAILURE_BACKOFF_MS,
  CLEANUP_RETRY_DELAY_MS,
} = await import("../src/preview-do.ts");
const { normalizeEndpointUrl } = await import("../src/aws-microvm.ts");
const { acceptsHtmlBrowserRequest } = await import("../src/loading-page.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function createCtx() {
  const data = new Map();
  const waits = [];
  const ctx = {
    data,
    waits,
    alarm: null,
    waitUntil(p) {
      waits.push(p);
    },
    async settle() {
      while (waits.length > 0) await Promise.all(waits.splice(0));
    },
    storage: {
      async get(key) {
        return structuredClone(data.get(key));
      },
      async put(key, value) {
        data.set(key, structuredClone(value));
      },
      async delete(key) {
        return data.delete(key);
      },
      async deleteAll() {
        data.clear();
      },
      async setAlarm(ms) {
        ctx.alarm = ms;
      },
      async getAlarm() {
        return ctx.alarm;
      },
      async deleteAlarm() {
        ctx.alarm = null;
      },
    },
  };
  return ctx;
}

function createFakeAws() {
  let seq = 0;
  const aws = {
    calls: [],
    terminated: [],
    runGate: null,
    runError: null,
    tokenError: null,
    deleteImageError: null,
    deleteImageGate: null,
    terminateGate: null,
    terminateError: null,
    stateGate: null,
    vmState: "RUNNING",
    endpointFor: (id) => `https://${id}.microvm.example`,
    count(kind) {
      return aws.calls.filter(([k]) => k === kind).length;
    },
    async runMicroVm(params) {
      aws.calls.push(["run", params.imageIdentifier, params.clientToken]);
      const id = `mvm-${++seq}`;
      if (aws.runGate) await aws.runGate;
      if (aws.runError) throw aws.runError;
      return { microvmId: id, endpointUrl: aws.endpointFor(id), state: "RUNNING" };
    },
    async createMicroVmAuthToken({ microvmId }) {
      aws.calls.push(["token", microvmId]);
      await Promise.resolve();
      if (aws.tokenError) throw aws.tokenError;
      return { token: `jwe-${microvmId}-${aws.count("token")}`, expirationInMinutes: 15 };
    },
    terminatedStateFor: null,
    async getMicroVmState(id) {
      aws.calls.push(["getState", id]);
      if (aws.stateGate) await aws.stateGate;
      if (aws.terminated.includes(id)) return aws.terminatedStateFor?.(id) ?? "TERMINATED";
      return aws.vmState;
    },
    async terminateMicroVm(id) {
      aws.calls.push(["terminate", id]);
      if (aws.terminateGate) await aws.terminateGate;
      if (aws.terminateError) throw aws.terminateError;
      aws.terminated.push(id);
    },
    async deleteMicroVmImage(id) {
      aws.calls.push(["deleteImage", id]);
      if (aws.deleteImageGate) await aws.deleteImageGate;
      if (aws.deleteImageError) throw aws.deleteImageError;
    },
  };
  return aws;
}

const ENV = { APP_TARGET_PORT: "8080", COLD_START_LOADING_PAGE: "true", ZOMBIE_TTL_DAYS: "14" };

function setup(options) {
  const ctx = createCtx();
  const aws = createFakeAws();
  const dObj = new PreviewEnvironmentDO(ctx, ENV, aws, options);
  return { ctx, aws, dObj };
}

const upstream = [];
let upstreamHandler = () => new Response("ok", { status: 200 });
globalThis.fetch = async (req) => {
  upstream.push({ url: req.url, auth: req.headers.get("X-aws-proxy-auth") });
  return upstreamHandler(req);
};
test.beforeEach(() => {
  upstream.length = 0;
  upstreamHandler = () => new Response("ok", { status: 200 });
});

const apiRequest = (path = "/") =>
  new Request(`https://pr-1.preview.example.com${path}`, { headers: { Accept: "application/json" } });
const htmlRequest = (path = "/") =>
  new Request(`https://pr-1.preview.example.com${path}`, {
    headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" },
  });

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- Core Lifecycle ---

test("boots MicroVM on request and proxies with JWE token", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");

  const res = await dObj.fetch(apiRequest("/hello?a=1"));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream, [{ url: "https://mvm-1.microvm.example/hello?a=1", auth: "jwe-mvm-1-1" }]);
  assert.equal(ctx.data.get("state").microvmId, "mvm-1");
  assert.equal(aws.count("run"), 1);
  assert.equal(aws.count("token"), 1);
});

test("passes a UUID clientToken on each RunMicrovm call", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const [, , clientToken] = aws.calls.find(([k]) => k === "run");
  assert.match(clientToken, /^[0-9a-f-]{36}$/);
});

test("normalizes scheme-less endpoint hostnames to https://", async () => {
  assert.equal(normalizeEndpointUrl("abc.lambda-microvm.us-east-1.on.aws"), "https://abc.lambda-microvm.us-east-1.on.aws");
  assert.equal(normalizeEndpointUrl("https://abc.example/"), "https://abc.example/");

  const { aws, dObj } = setup();
  aws.endpointFor = (id) => `${id}.lambda-microvm.ap-northeast-1.on.aws`;
  await dObj.registerImage("img-v1");
  const res = await dObj.fetch(apiRequest("/x"));
  assert.equal(res.status, 200);
  assert.equal(upstream[0].url, "https://mvm-1.lambda-microvm.ap-northeast-1.on.aws/x");
});

test("rotates MicroVM after exceeding 7h45m effective TTL", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const state = ctx.data.get("state");
  state.createdAt = Date.now() - MAX_VM_LIFETIME_MS - 60_000;
  ctx.data.set("state", state);

  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 200);
  assert.ok(aws.terminated.includes("mvm-1"));
  assert.equal(ctx.data.get("state").microvmId, "mvm-2");
  assert.equal(upstream.at(-1).url, "https://mvm-2.microvm.example/");
});

// --- Concurrency & Races ---

test("deduplicates concurrent RunMicrovm and JWE token requests", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = Array.from({ length: 5 }, (_, i) => dObj.fetch(apiRequest(`/p${i}`)));
  await tick();
  gate.resolve();
  const results = await Promise.all(pending);

  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(aws.count("run"), 1);
  assert.equal(aws.count("token"), 1);
});

test("discards stale boot and re-provisions when a new image is registered mid-boot", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = dObj.fetch(apiRequest("/"));
  await tick();
  assert.equal(aws.count("run"), 1);

  await dObj.registerImage("img-v2");
  gate.resolve();
  const res = await pending;
  await ctx.settle();

  assert.equal(res.status, 200);
  const state = ctx.data.get("state");
  assert.equal(state.imageIdentifier, "img-v2");
  assert.equal(state.microvmId, "mvm-2");
  assert.ok(aws.terminated.includes("mvm-1"));
  assert.ok(!aws.terminated.includes("mvm-2"));
});

test("background cold-start boot switches to newly registered image", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const res = await dObj.fetch(htmlRequest("/"));
  assert.equal(res.status, 503);
  await tick();

  await dObj.registerImage("img-v2");
  gate.resolve();
  await ctx.settle();

  const state = ctx.data.get("state");
  assert.equal(state.imageIdentifier, "img-v2");
  assert.ok(state.microvmId);
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("terminates booted VM and keeps storage empty when destroyed mid-boot", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = dObj.fetch(apiRequest("/"));
  await tick();

  await dObj.destroy();
  gate.resolve();
  const res = await pending;
  await ctx.settle();

  assert.equal(res.status, 404);
  assert.equal(ctx.data.size, 0);
  assert.deepEqual(await dObj.getStatus(), { registered: false, booting: false });
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("self-healing under concurrent requests boots only one replacement MicroVM", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/warm"));

  upstreamHandler = (req) =>
    new Response(req.url.includes("mvm-1") ? "gone" : "ok", { status: req.url.includes("mvm-1") ? 410 : 200 });
  aws.vmState = "TERMINATED";
  const gate = deferred();
  aws.stateGate = gate.promise;

  const pending = Array.from({ length: 5 }, (_, i) => dObj.fetch(apiRequest(`/p${i}`)));
  await tick();
  gate.resolve();
  const results = await Promise.all(pending);

  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(aws.count("run"), 2);
  assert.equal(aws.count("getState"), 1);
  assert.equal(ctx.data.get("state").microvmId, "mvm-2");
});

// --- Error Handling ---

test("hides AWS error details with 502 on RunMicrovm failure and enforces boot backoff", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  aws.runError = new Error("RunMicrovm failed (402): ServiceQuotaExceededException secret-detail");

  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /secret-detail|ServiceQuota/);

  for (let i = 0; i < 3; i++) {
    const html = await dObj.fetch(htmlRequest("/"));
    assert.equal(html.status, 502);
    assert.match(await html.text(), /Failed to start preview environment/);
  }
  assert.equal(aws.count("run"), 1);
  assert.ok(BOOT_FAILURE_BACKOFF_MS >= 10_000);
});

test("logs background cold-start boot failures", async (t) => {
  const { aws, dObj, ctx } = setup();
  const logged = t.mock.method(console, "error", () => {});
  await dObj.registerImage("img-v1");
  aws.runError = new Error("RunMicrovm failed (403): The security token included in the request is expired");

  const res = await dObj.fetch(htmlRequest("/"));
  assert.equal(res.status, 503);
  await ctx.settle();

  const messages = logged.mock.calls.map((c) => c.arguments.map(String).join(" "));
  assert.ok(messages.some((m) => m.includes("background boot failed") && m.includes("security token")));
});

test("does not log error when background cold-start is canceled by destroy", async (t) => {
  const { aws, dObj, ctx } = setup();
  const logged = t.mock.method(console, "error", () => {});
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  assert.equal((await dObj.fetch(htmlRequest("/"))).status, 503);
  await tick();
  await dObj.destroy();
  gate.resolve();
  await ctx.settle();

  assert.ok(!logged.mock.calls.some((c) => String(c.arguments[0]).includes("background boot failed")));
});

test("returns 502 without leaking details when JWE token issuance fails", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  aws.tokenError = new Error("CreateMicrovmAuthToken failed (500): internal");
  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /internal/);
});

test("rate-limits GetMicrovm checks on repeated app 404 responses", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = () => new Response("not found", { status: 404 });

  for (let i = 0; i < 5; i++) {
    assert.equal((await dObj.fetch(apiRequest("/missing"))).status, 404);
  }
  assert.equal(aws.count("getState"), 1);
  assert.equal(aws.count("run"), 1);
});

test("rate-limits forced JWE refreshes on repeated app 403 responses", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = () => new Response("forbidden", { status: 403 });

  for (let i = 0; i < 5; i++) {
    assert.equal((await dObj.fetch(apiRequest("/forbidden"))).status, 403);
  }
  assert.equal(aws.count("token"), 2);
});

test("re-issues JWE token and retries once on 403", async () => {
  const { dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = (req) =>
    new Response("", { status: req.headers.get("X-aws-proxy-auth") === "jwe-mvm-1-1" ? 403 : 200 });
  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.map((u) => u.auth), ["jwe-mvm-1-1", "jwe-mvm-1-2"]);
});

test("concurrent requests receiving 403 on the same stale token all retry with one new token", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/warm"));
  upstreamHandler = (req) =>
    new Response("", { status: req.headers.get("X-aws-proxy-auth") === "jwe-mvm-1-1" ? 403 : 200 });

  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => dObj.fetch(apiRequest(`/p${i}`))));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(aws.count("token"), 2);
});

// --- Destroy & Alarms ---

test("destroy: throws CleanupIncompleteError and retries image deletion via Alarm", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  aws.deleteImageError = new Error("ThrottlingException");

  await assert.rejects(dObj.destroy(), { name: "CleanupIncompleteError" });
  const status = await dObj.getStatus();
  assert.equal(status.registered, false);
  assert.deepEqual(status.cleanupPending, { microvmIds: [], imageIdentifiers: ["img-v1"] });
  assert.ok(ctx.alarm && ctx.alarm <= Date.now() + CLEANUP_RETRY_DELAY_MS);
  assert.equal((await dObj.fetch(apiRequest("/"))).status, 404);

  aws.deleteImageError = null;
  await dObj.alarm();
  assert.equal(aws.count("deleteImage"), 2);
  assert.equal(ctx.data.size, 0);
  assert.equal(ctx.alarm, null);
});

test("destroy: polls until MicroVM terminates before deleting image", async () => {
  const { aws, dObj, ctx } = setup({ terminationPollIntervalMs: 1, terminationWaitTimeoutMs: 1000 });
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));

  let checks = 0;
  aws.terminatedStateFor = () => (++checks < 3 ? "TERMINATING" : "TERMINATED");
  const realDelete = aws.deleteMicroVmImage;
  aws.deleteMicroVmImage = async (id) => {
    if (checks < 3) throw new Error("DeleteMicrovmImage failed (400): Cannot delete microvm image with running microvms.");
    return realDelete(id);
  };

  await dObj.destroy();
  assert.deepEqual(
    aws.calls.filter(([k]) => k !== "token" && k !== "run").map(([k]) => k),
    ["terminate", "getState", "getState", "getState", "deleteImage"]
  );
  assert.equal(ctx.data.size, 0);
  assert.equal(ctx.alarm, null);
});

test("destroy: queues image for Alarm retry if termination polling times out", async (t) => {
  const { aws, dObj } = setup({ terminationPollIntervalMs: 1, terminationWaitTimeoutMs: 5 });
  t.mock.method(console, "error", () => {});
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  aws.terminatedStateFor = () => "TERMINATING";
  aws.deleteImageError = new Error("DeleteMicrovmImage failed (400): Cannot delete microvm image with running microvms.");

  await assert.rejects(dObj.destroy(), { name: "CleanupIncompleteError" });
  assert.equal(aws.count("deleteImage"), 1);
  const status = await dObj.getStatus();
  assert.deepEqual(status.cleanupPending, { microvmIds: [], imageIdentifiers: ["img-v1"] });

  aws.terminatedStateFor = null;
  aws.deleteImageError = null;
  await dObj.alarm();
  assert.equal(aws.count("deleteImage"), 2);
  assert.equal((await dObj.getStatus()).cleanupPending, undefined);
});

test("registerImage: does not wait for old MicroVM termination when not deleting image", async () => {
  const { aws, dObj } = setup({ terminationPollIntervalMs: 1, terminationWaitTimeoutMs: 1000 });
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  aws.terminatedStateFor = () => "TERMINATING";

  await dObj.registerImage("img-v2");
  assert.ok(aws.terminated.includes("mvm-1"));
  assert.equal(aws.count("getState"), 0);
});

test("removes image from pendingCleanup when re-registered", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  aws.deleteImageError = new Error("ThrottlingException");
  await assert.rejects(dObj.destroy());

  await dObj.registerImage("img-v1");
  assert.equal(ctx.data.get("pendingCleanup"), undefined);
  assert.equal((await dObj.getStatus()).registered, true);
});

test("skips deleting an image that was re-registered before Alarm retry reached it", async () => {
  const { aws, dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", {
    microvmIds: [],
    imageIdentifiers: ["img-a", "img-b"],
    retryAt: Date.now(),
  });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm();
  await tick();
  const register = dObj.registerImage("img-b");
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await alarm;
  await register;

  assert.deepEqual(aws.calls.filter(([k]) => k === "deleteImage").map(([, id]) => id), ["img-a"]);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-b");
  assert.equal(ctx.data.get("pendingCleanup"), undefined);
});

test("rejects registration with ImageDeletedDuringCleanupError if in-flight deletion succeeded", async () => {
  const { aws, dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm();
  await tick();
  const register = dObj.registerImage("img-a");
  gate.resolve();
  await alarm;

  await assert.rejects(register, { name: "ImageDeletedDuringCleanupError" });
  assert.equal((await dObj.getStatus()).registered, false);
});

test("queued Alarm retry does not delete image being registered while waiting on old VM termination", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-old");
  await dObj.fetch(apiRequest("/"));
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const gate = deferred();
  aws.terminateGate = gate.promise;

  const register = dObj.registerImage("img-a");
  await tick();
  const alarm = dObj.alarm();
  await tick();
  aws.terminateGate = null;
  gate.resolve();
  await register;
  await alarm;

  assert.equal(aws.count("deleteImage"), 0);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-a");
});

test("queues stale booted MicroVM for Alarm retry if termination fails", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = dObj.fetch(apiRequest("/"));
  await tick();
  await dObj.destroy();
  aws.terminateError = new Error("ThrottlingException");
  gate.resolve();
  await pending;
  await ctx.settle();

  assert.deepEqual(ctx.data.get("pendingCleanup").microvmIds, ["mvm-1"]);
  assert.ok(ctx.alarm);

  aws.terminateError = null;
  await dObj.alarm();
  assert.ok(aws.terminated.includes("mvm-1"));
  assert.equal(ctx.data.get("pendingCleanup"), undefined);
});

test("destroy: preserves state if pendingCleanup cannot be persisted", async () => {
  const { dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "pendingCleanup") throw new Error("storage unavailable");
    return put(key, value);
  };
  await assert.rejects(dObj.destroy(), /storage unavailable/);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-v1");
});

test("concurrent destroy calls do not drop previously failed cleanup targets", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.deleteImageGate = gate.promise;
  aws.deleteImageError = new Error("ThrottlingException");

  const first = dObj.destroy();
  await tick();
  const second = dObj.destroy();
  await tick();
  gate.resolve();
  await assert.rejects(first, { name: "CleanupIncompleteError" });
  await assert.rejects(second, { name: "CleanupIncompleteError" });

  assert.deepEqual(ctx.data.get("pendingCleanup").imageIdentifiers, ["img-v1"]);
  assert.ok(ctx.alarm);
});

test("keeps image in pendingCleanup if re-registration fails on state write", async () => {
  const { dObj, ctx } = setup();
  const retryAt = Date.now() + 1000;
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt });
  ctx.alarm = retryAt;
  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "state") throw new Error("storage unavailable");
    return put(key, value);
  };

  await assert.rejects(dObj.registerImage("img-a"), /storage unavailable/);
  assert.deepEqual(ctx.data.get("pendingCleanup").imageIdentifiers, ["img-a"]);
  assert.ok(ctx.alarm);
});

test("treats environment as destroyed and retries deletion via Alarm if state.delete fails", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const del = ctx.storage.delete;
  ctx.storage.delete = async (key) => {
    if (key === "state") throw new Error("storage unavailable");
    return del(key);
  };

  await assert.rejects(dObj.destroy(), /storage unavailable/);
  assert.equal((await dObj.fetch(apiRequest("/"))).status, 404);
  assert.equal((await dObj.getStatus()).registered, false);
  assert.equal(aws.count("run"), 1);

  ctx.storage.delete = del;
  await dObj.alarm();
  assert.equal(ctx.data.get("state"), undefined);
  assert.ok(aws.calls.some(([k, id]) => k === "deleteImage" && id === "img-v1"));
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("terminates stale booted VM directly if pendingCleanup write fails", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = dObj.fetch(apiRequest("/"));
  await tick();
  await dObj.registerImage("img-v2");
  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "pendingCleanup" && value.microvmIds.includes("mvm-1")) throw new Error("storage unavailable");
    return put(key, value);
  };
  gate.resolve();
  await pending;
  await ctx.settle();

  assert.ok(aws.terminated.includes("mvm-1"));
});

test("earlier destroy in queue does not delete a subsequent registration of the same image", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-a");
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-z"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm();
  await tick();
  const destroy = dObj.destroy();
  const register = dObj.registerImage("img-a");
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await alarm;
  await destroy;
  await register;

  assert.deepEqual(aws.calls.filter(([k]) => k === "deleteImage").map(([, id]) => id), ["img-z"]);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-a");
});

test("Alarm: evaluates zombieAt inside exclusive queue so newer registrations are preserved", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-old");
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-z"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const first = dObj.alarm();
  await tick();
  const state = ctx.data.get("state");
  state.zombieAt = Date.now() - 1;
  ctx.data.set("state", state);
  const register = dObj.registerImage("img-new");
  await tick();
  const second = dObj.alarm();
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await first;
  await register;
  await second;

  assert.equal((await dObj.getStatus()).imageIdentifier, "img-new");
});

test("partial cleanup on registerImage preserves retryAt for unrelated pending items", async () => {
  const { dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const retryAt = Date.now() + 1000;
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-z"], retryAt });

  await dObj.registerImage("img-v2");
  assert.equal(ctx.data.get("pendingCleanup").retryAt, retryAt);
  assert.equal(ctx.alarm, retryAt);
});

test("preserves pendingCleanup even when both state and pendingCleanup writes fail on re-register", async () => {
  const { dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "state" || key === "pendingCleanup") throw new Error("storage unavailable");
    return put(key, value);
  };

  await assert.rejects(dObj.registerImage("img-a"), /storage unavailable/);
  assert.deepEqual(ctx.data.get("pendingCleanup").imageIdentifiers, ["img-a"]);
});

test("failed re-registration on destroying environment does not resurrect old state", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-old");
  const del = ctx.storage.delete;
  ctx.storage.delete = async (key) => {
    if (key === "state") throw new Error("storage unavailable");
    return del(key);
  };
  await assert.rejects(dObj.destroy());
  ctx.storage.delete = del;

  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "state") throw new Error("storage unavailable");
    return put(key, value);
  };
  await assert.rejects(dObj.registerImage("img-new"), /storage unavailable/);
  ctx.storage.put = put;

  assert.equal((await dObj.getStatus()).registered, false);
  assert.equal((await dObj.fetch(apiRequest("/"))).status, 404);
  assert.equal(aws.count("run"), 0);
});

test("Alarm: rethrows non-cleanup errors so platform retries Alarm", async () => {
  const { dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  ctx.storage.get = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(dObj.alarm(), /storage unavailable/);
});

test("Alarm: retries pending cleanup before zombieAt and destroys environment after zombieAt", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");

  ctx.data.set("pendingCleanup", { microvmIds: ["mvm-old"], imageIdentifiers: [], retryAt: Date.now() });
  await dObj.alarm();
  assert.ok(aws.terminated.includes("mvm-old"));
  assert.equal((await dObj.getStatus()).registered, true);
  assert.ok(ctx.alarm > Date.now() + 13 * 24 * 60 * 60 * 1000);

  const state = ctx.data.get("state");
  state.zombieAt = Date.now() - 1;
  ctx.data.set("state", state);
  await dObj.alarm();
  assert.equal((await dObj.getStatus()).registered, false);
  assert.ok(aws.calls.some(([k, id]) => k === "deleteImage" && id === "img-v1"));
});

test("Alarm: destroys legacy state without zombieAt", async () => {
  const { dObj, ctx } = setup();
  ctx.data.set("state", { imageIdentifier: "img-legacy", updatedAt: Date.now() });
  await dObj.alarm();
  assert.equal(ctx.data.size, 0);
});

// --- Cold-Start Detection ---

test("does not serve cold-start loading page for non-navigation requests (e.g. Turbo / fetch)", () => {
  const req = (headers) => new Request("https://pr-1.preview.example.com/", { headers });
  assert.equal(acceptsHtmlBrowserRequest(req({ Accept: "text/html", "Sec-Fetch-Mode": "navigate" })), true);
  assert.equal(acceptsHtmlBrowserRequest(req({ Accept: "text/html" })), true);
  assert.equal(
    acceptsHtmlBrowserRequest(req({ Accept: "text/vnd.turbo-stream.html, text/html", "Sec-Fetch-Mode": "cors" })),
    false
  );
});
