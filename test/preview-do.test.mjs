import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

/**
 * src/preview-do.ts を Node.js の型ストリッピングで直接読み込み、
 * インメモリのストレージと AWS クライアントのフェイクで Durable Object の振る舞いを検証する。
 */

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
    /** 設定すると RunMicrovm がこの Promise の解決まで待つ */
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
    async getMicroVmState(id) {
      aws.calls.push(["getState", id]);
      if (aws.stateGate) await aws.stateGate;
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

function setup() {
  const ctx = createCtx();
  const aws = createFakeAws();
  const dObj = new PreviewEnvironmentDO(ctx, ENV, aws);
  return { ctx, aws, dObj };
}

// MicroVM エンドポイント（アプリ）のフェイク。テストごとに upstreamHandler を差し替える
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

// --- 基本動作 ---

test("通常アクセスで MicroVM を起動し、JWE を付けて転送する", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");

  const res = await dObj.fetch(apiRequest("/hello?a=1"));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream, [{ url: "https://mvm-1.microvm.example/hello?a=1", auth: "jwe-mvm-1-1" }]);
  assert.equal(ctx.data.get("state").microvmId, "mvm-1");
  assert.equal(aws.count("run"), 1);
  assert.equal(aws.count("token"), 1);
});

test("RunMicrovm には起動ごとに冪等トークン (clientToken) を付ける", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const [, , clientToken] = aws.calls.find(([k]) => k === "run");
  assert.match(clientToken, /^[0-9a-f-]{36}$/);
});

test("endpoint がスキームなしのホスト名でも https で転送する", async () => {
  assert.equal(normalizeEndpointUrl("abc.lambda-microvm.us-east-1.on.aws"), "https://abc.lambda-microvm.us-east-1.on.aws");
  assert.equal(normalizeEndpointUrl("https://abc.example/"), "https://abc.example/");

  const { aws, dObj } = setup();
  aws.endpointFor = (id) => `${id}.lambda-microvm.ap-northeast-1.on.aws`;
  await dObj.registerImage("img-v1");
  const res = await dObj.fetch(apiRequest("/x"));
  assert.equal(res.status, 200);
  assert.equal(upstream[0].url, "https://mvm-1.lambda-microvm.ap-northeast-1.on.aws/x");
});

test("7時間45分を超えた MicroVM は終了して新しい MicroVM に切り替える", async () => {
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

// --- 同時実行・競合 ---

test("同時アクセスでも RunMicrovm と JWE 発行はそれぞれ 1 回だけ", async () => {
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

test("起動中に新イメージが登録されたら、旧起動結果を捨てて新イメージで起動し直す", async () => {
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

test("コールドスタート中に新イメージが登録されても、バックグラウンド起動は新イメージになる", async () => {
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
  assert.ok(state.microvmId, "新イメージの VM がバックグラウンドで起動している");
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("起動中に destroy されたら、環境を復活させず起動した VM を終了する", async () => {
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
  assert.equal(ctx.data.size, 0, "ストレージは空のまま");
  assert.deepEqual(await dObj.getStatus(), { registered: false, booting: false });
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("自己修復が同時に走っても MicroVM は 1 台だけ起動し、記録を取り違えない", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/warm"));

  // AWS 側で mvm-1 が終了済み: アプリへの転送は 410、GetMicrovm は TERMINATED
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
  assert.equal(aws.count("run"), 2, "初回起動 + 自己修復の 1 回だけ");
  assert.equal(aws.count("getState"), 1);
  assert.equal(ctx.data.get("state").microvmId, "mvm-2");
});

// --- AWS / アプリのエラー ---

test("RunMicrovm 失敗時は AWS のエラー内容を返さず 502、待機時間内は再起動しない", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  aws.runError = new Error("RunMicrovm failed (402): ServiceQuotaExceededException secret-detail");

  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /secret-detail|ServiceQuota/);

  // ブラウザのリロードを繰り返しても「起動中」を出し続けず、RunMicrovm も呼ばない
  for (let i = 0; i < 3; i++) {
    const html = await dObj.fetch(htmlRequest("/"));
    assert.equal(html.status, 502);
    assert.match(await html.text(), /起動に失敗しました/);
  }
  assert.equal(aws.count("run"), 1);
  assert.ok(BOOT_FAILURE_BACKOFF_MS >= 10_000);
});

test("JWE 発行が失敗したら例外を投げずに 502 を返す", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  aws.tokenError = new Error("CreateMicrovmAuthToken failed (500): internal");
  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /internal/);
});

test("アプリ自身の 404 が続いても GetMicrovm を毎回呼ばない", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = () => new Response("not found", { status: 404 });

  for (let i = 0; i < 5; i++) {
    assert.equal((await dObj.fetch(apiRequest("/missing"))).status, 404);
  }
  assert.equal(aws.count("getState"), 1);
  assert.equal(aws.count("run"), 1);
});

test("アプリ自身の 403 が続いても JWE を毎回再発行しない", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = () => new Response("forbidden", { status: 403 });

  for (let i = 0; i < 5; i++) {
    assert.equal((await dObj.fetch(apiRequest("/forbidden"))).status, 403);
  }
  assert.equal(aws.count("token"), 2, "初回発行 + 強制再発行 1 回");
});

test("トークン失効の 403 は再発行して 1 回リトライする", async () => {
  const { dObj } = setup();
  await dObj.registerImage("img-v1");
  upstreamHandler = (req) =>
    new Response("", { status: req.headers.get("X-aws-proxy-auth") === "jwe-mvm-1-1" ? 403 : 200 });
  const res = await dObj.fetch(apiRequest("/"));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.map((u) => u.auth), ["jwe-mvm-1-1", "jwe-mvm-1-2"]);
});

test("同じ失効トークンで同時に 403 を受けたリクエストは、全員が新トークンで再試行する", async () => {
  const { aws, dObj } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/warm")); // jwe-mvm-1-1 をキャッシュ
  upstreamHandler = (req) =>
    new Response("", { status: req.headers.get("X-aws-proxy-auth") === "jwe-mvm-1-1" ? 403 : 200 });

  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => dObj.fetch(apiRequest(`/p${i}`))));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(aws.count("token"), 2, "再発行は 1 回だけ");
});

// --- 破棄と Alarm ---

test("destroy でイメージ削除に失敗したら例外を投げ、削除待ちとして Alarm で再試行する", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  aws.deleteImageError = new Error("ThrottlingException");

  await assert.rejects(dObj.destroy(), { name: "CleanupIncompleteError" });
  const status = await dObj.getStatus();
  assert.equal(status.registered, false);
  assert.deepEqual(status.cleanupPending, { microvmIds: [], imageIdentifiers: ["img-v1"] });
  assert.ok(ctx.alarm && ctx.alarm <= Date.now() + CLEANUP_RETRY_DELAY_MS);
  // 削除待ちが残っていてもプレビューは復活しない
  assert.equal((await dObj.fetch(apiRequest("/"))).status, 404);

  aws.deleteImageError = null;
  await dObj.alarm();
  assert.equal(aws.count("deleteImage"), 2);
  assert.equal(ctx.data.size, 0);
  assert.equal(ctx.alarm, null);
});

test("削除待ちのイメージが再登録されたら削除対象から外す", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  aws.deleteImageError = new Error("ThrottlingException");
  await assert.rejects(dObj.destroy());

  await dObj.registerImage("img-v1");
  assert.equal(ctx.data.get("pendingCleanup"), undefined);
  assert.equal((await dObj.getStatus()).registered, true);
});

test("削除待ちの再試行より前に再登録されたイメージは、再試行で削除しない", async () => {
  const { aws, dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", {
    microvmIds: [],
    imageIdentifiers: ["img-a", "img-b"],
    retryAt: Date.now(),
  });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm();
  await tick(); // img-a の削除が進行中（img-b はまだ送信していない）
  const register = dObj.registerImage("img-b"); // 削除待ちから外したうえで、実行中の再試行の後ろに並ぶ
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await alarm;
  await register;

  assert.deepEqual(aws.calls.filter(([k]) => k === "deleteImage").map(([, id]) => id), ["img-a"]);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-b");
  assert.equal(ctx.data.get("pendingCleanup"), undefined);
});

test("登録の待機中に同じイメージの削除が完了していたら、登録を拒否する", async () => {
  const { aws, dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm();
  await tick(); // img-a の削除リクエストが AWS に送信済み
  const register = dObj.registerImage("img-a");
  gate.resolve();
  await alarm;

  await assert.rejects(register, { name: "ImageDeletedDuringCleanupError" });
  assert.equal((await dObj.getStatus()).registered, false);
});

test("登録が旧 VM の終了を待っている間に始まった削除の再試行は、登録するイメージを消さない", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-old");
  await dObj.fetch(apiRequest("/")); // mvm-1 起動
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const gate = deferred();
  aws.terminateGate = gate.promise;

  const register = dObj.registerImage("img-a"); // 旧 VM (mvm-1) の終了待ちで止まる
  await tick();
  const alarm = dObj.alarm(); // 登録の後ろに並ぶ
  await tick();
  aws.terminateGate = null;
  gate.resolve();
  await register;
  await alarm;

  assert.equal(aws.count("deleteImage"), 0);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-a");
});

test("古くなった起動結果の VM の終了に失敗したら、削除待ちとして Alarm で再試行する", async () => {
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

test("destroy: 削除対象を永続化できなければ状態を消さない", async () => {
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

test("destroy が重なっても、先に失敗した削除対象を後続が消さない", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.deleteImageGate = gate.promise;
  aws.deleteImageError = new Error("ThrottlingException");

  const first = dObj.destroy();
  await tick();
  const second = dObj.destroy(); // 1 回目の後ろに並ぶ
  await tick();
  gate.resolve();
  await assert.rejects(first, { name: "CleanupIncompleteError" });
  await assert.rejects(second, { name: "CleanupIncompleteError" });

  assert.deepEqual(ctx.data.get("pendingCleanup").imageIdentifiers, ["img-v1"]);
  assert.ok(ctx.alarm);
});

test("削除待ちのイメージの再登録が失敗したら、削除待ちに戻す", async () => {
  const { dObj, ctx } = setup();
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-a"], retryAt: Date.now() });
  const put = ctx.storage.put;
  ctx.storage.put = async (key, value) => {
    if (key === "state") throw new Error("storage unavailable");
    return put(key, value);
  };

  await assert.rejects(dObj.registerImage("img-a"), /storage unavailable/);
  assert.deepEqual(ctx.data.get("pendingCleanup").imageIdentifiers, ["img-a"]);
  assert.ok(ctx.alarm, "再試行の Alarm が設定されている");
});

test("destroy で状態の削除に失敗しても、破棄済みとして扱い Alarm で削除を再試行する", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  await dObj.fetch(apiRequest("/"));
  const del = ctx.storage.delete;
  ctx.storage.delete = async (key) => {
    if (key === "state") throw new Error("storage unavailable");
    return del(key);
  };

  await assert.rejects(dObj.destroy(), /storage unavailable/);
  assert.equal((await dObj.fetch(apiRequest("/"))).status, 404, "破棄途中の環境を再起動しない");
  assert.equal((await dObj.getStatus()).registered, false);
  assert.equal(aws.count("run"), 1);

  ctx.storage.delete = del;
  await dObj.alarm();
  assert.equal(ctx.data.get("state"), undefined);
  assert.ok(aws.calls.some(([k, id]) => k === "deleteImage" && id === "img-v1"));
  assert.ok(aws.terminated.includes("mvm-1"));
});

test("古くなった起動結果の VM を永続化できなければ、直接終了する", async () => {
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

test("キューに先に並んだ destroy は、後ろに並んだ同じイメージの登録を消さない", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-a");
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-z"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const alarm = dObj.alarm(); // img-z の削除中にキューを占有
  await tick();
  const destroy = dObj.destroy(); // 開始時に img-a を削除対象に入れる
  const register = dObj.registerImage("img-a"); // destroy の後ろに並ぶ
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await alarm;
  await destroy;
  await register;

  assert.deepEqual(aws.calls.filter(([k]) => k === "deleteImage").map(([, id]) => id), ["img-z"]);
  assert.equal((await dObj.getStatus()).imageIdentifier, "img-a");
});

test("Alarm: 掃除期限はキューの中で判定し、先に並んだ登録で更新された環境を消さない", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-old");
  ctx.data.set("pendingCleanup", { microvmIds: [], imageIdentifiers: ["img-z"], retryAt: Date.now() });
  const gate = deferred();
  aws.deleteImageGate = gate.promise;

  const first = dObj.alarm(); // 期限前なので削除の再試行だけ（img-z の削除中にキューを占有）
  await tick();
  const state = ctx.data.get("state");
  state.zombieAt = Date.now() - 1; // ここで掃除期限を過ぎる
  ctx.data.set("state", state);
  const register = dObj.registerImage("img-new");
  await tick(); // 登録がキューに並ぶのを待つ
  const second = dObj.alarm(); // 登録の後ろに並ぶ
  await tick();
  aws.deleteImageGate = null;
  gate.resolve();
  await first;
  await register;
  await second;

  assert.equal((await dObj.getStatus()).imageIdentifier, "img-new");
});

test("Alarm: クリーンアップ以外の失敗は再送出し、プラットフォームの自動リトライに任せる", async () => {
  const { dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  ctx.storage.get = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(dObj.alarm(), /storage unavailable/);
});

test("Alarm: 掃除期限を過ぎた環境は破棄し、期限前なら削除待ちの再試行だけ行う", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");

  // 期限前: 削除待ちだけ再試行し、登録は残す
  ctx.data.set("pendingCleanup", { microvmIds: ["mvm-old"], imageIdentifiers: [], retryAt: Date.now() });
  await dObj.alarm();
  assert.ok(aws.terminated.includes("mvm-old"));
  assert.equal((await dObj.getStatus()).registered, true);
  assert.ok(ctx.alarm > Date.now() + 13 * 24 * 60 * 60 * 1000, "次の Alarm は掃除期限");

  // 期限切れ: 破棄する
  const state = ctx.data.get("state");
  state.zombieAt = Date.now() - 1;
  ctx.data.set("state", state);
  await dObj.alarm();
  assert.equal((await dObj.getStatus()).registered, false);
  assert.ok(aws.calls.some(([k, id]) => k === "deleteImage" && id === "img-v1"));
});

test("zombieAt のない旧バージョンの状態は、Alarm 発火時に従来どおり破棄する", async () => {
  const { dObj, ctx } = setup();
  ctx.data.set("state", { imageIdentifier: "img-legacy", updatedAt: Date.now() });
  await dObj.alarm();
  assert.equal(ctx.data.size, 0);
});

// --- コールドスタート判定 ---

test("Turbo / fetch など非ナビゲーションのリクエストにはローディング画面を返さない", () => {
  const req = (headers) => new Request("https://pr-1.preview.example.com/", { headers });
  assert.equal(acceptsHtmlBrowserRequest(req({ Accept: "text/html", "Sec-Fetch-Mode": "navigate" })), true);
  assert.equal(acceptsHtmlBrowserRequest(req({ Accept: "text/html" })), true, "Sec-Fetch-Mode なしは従来どおり");
  assert.equal(
    acceptsHtmlBrowserRequest(req({ Accept: "text/vnd.turbo-stream.html, text/html", "Sec-Fetch-Mode": "cors" })),
    false
  );
});
