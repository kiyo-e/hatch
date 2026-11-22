import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/**
 * src/preview-do.ts を Node.js の型ストリッピングで直接読み込み、
 * インメモリのストレージと AWS クライアントのフェイクで Durable Object の振る舞いを検証する。
 */

const CF_WORKERS_STUB = "stub:cloudflare-workers";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: CF_WORKERS_STUB, shortCircuit: true };
    }
    // src 内の拡張子なし相対 import（"./aws-microvm" 等）を .ts に解決する
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CF_WORKERS_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      };
    }
    return nextLoad(url, context);
  },
});

const { PreviewEnvironmentDO } = await import("../src/preview-do.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function createCtx() {
  const data = new Map();
  let alarm = null;
  const waits = [];
  return {
    data,
    waits,
    waitUntil(p) {
      waits.push(p);
    },
    storage: {
      async get(key) {
        return structuredClone(data.get(key));
      },
      async put(key, value) {
        data.set(key, structuredClone(value));
      },
      async deleteAll() {
        data.clear();
      },
      async setAlarm(ms) {
        alarm = ms;
      },
      async getAlarm() {
        return alarm;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
  };
}

function createFakeAws() {
  let seq = 0;
  const aws = {
    calls: [],
    terminated: [],
    /** 設定すると RunMicrovm がこの Promise の解決まで待つ */
    runGate: null,
    async runMicroVm(params) {
      aws.calls.push(["run", params.imageIdentifier]);
      const id = `mvm-${++seq}`;
      if (aws.runGate) await aws.runGate;
      return { microvmId: id, endpointUrl: `https://${id}.microvm.example`, state: "RUNNING" };
    },
    async createMicroVmAuthToken({ microvmId }) {
      aws.calls.push(["token", microvmId]);
      await Promise.resolve();
      return { token: `jwe-${microvmId}`, expirationInMinutes: 15 };
    },
    async getMicroVmState() {
      return "RUNNING";
    },
    async terminateMicroVm(id) {
      aws.calls.push(["terminate", id]);
      aws.terminated.push(id);
    },
    async deleteMicroVmImage(id) {
      aws.calls.push(["deleteImage", id]);
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

const upstream = [];
globalThis.fetch = async (req) => {
  upstream.push({ url: req.url, auth: req.headers.get("X-aws-proxy-auth") });
  return new Response("ok", { status: 200 });
};

const apiRequest = (path = "/") =>
  new Request(`https://pr-1.preview.example.com${path}`, { headers: { Accept: "application/json" } });

const tick = () => new Promise((r) => setTimeout(r, 0));

test("通常アクセスで MicroVM を起動し、JWE を付けて転送する", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  upstream.length = 0;

  const res = await dObj.fetch(apiRequest("/hello?a=1"));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream, [{ url: "https://mvm-1.microvm.example/hello?a=1", auth: "jwe-mvm-1" }]);
  assert.equal(ctx.data.get("state").microvmId, "mvm-1");
  assert.deepEqual(aws.calls, [["run", "img-v1"], ["token", "mvm-1"]]);
});

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
  assert.equal(aws.calls.filter(([k]) => k === "run").length, 1);
  assert.equal(aws.calls.filter(([k]) => k === "token").length, 1);
});

test("起動中に新イメージが登録されたら、旧起動結果を捨てて新イメージで起動し直す", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const pending = dObj.fetch(apiRequest("/"));
  await tick();
  assert.deepEqual(aws.calls, [["run", "img-v1"]]);

  await dObj.registerImage("img-v2");
  gate.resolve();
  const res = await pending;
  await Promise.all(ctx.waits);

  assert.equal(res.status, 200);
  const state = ctx.data.get("state");
  assert.equal(state.imageIdentifier, "img-v2");
  assert.equal(state.microvmId, "mvm-2");
  // 旧イメージで起動した VM は終了されている
  assert.ok(aws.terminated.includes("mvm-1"));
  assert.ok(!aws.terminated.includes("mvm-2"));
});

test("コールドスタート中に新イメージが登録されても、バックグラウンド起動は新イメージになる", async () => {
  const { aws, dObj, ctx } = setup();
  await dObj.registerImage("img-v1");
  const gate = deferred();
  aws.runGate = gate.promise;

  const htmlReq = new Request("https://pr-1.preview.example.com/", {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  const res = await dObj.fetch(htmlReq);
  assert.equal(res.status, 503);
  await tick();

  await dObj.registerImage("img-v2");
  gate.resolve();
  await Promise.all(ctx.waits);
  await Promise.all(ctx.waits);

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
  await Promise.all(ctx.waits);

  assert.equal(res.status, 404);
  assert.equal(ctx.data.size, 0, "ストレージは空のまま");
  assert.deepEqual(await dObj.getStatus(), { registered: false, booting: false });
  assert.ok(aws.terminated.includes("mvm-1"));
});
