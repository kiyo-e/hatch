import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

/**
 * Hono のルーター (src/index.ts) から本物の PreviewEnvironmentDO まで通して、
 * 管理 API での登録 → プレビューへのアクセス（MicroVM への転送）→ 破棄 の流れを確かめる。
 * AWS とアプリ（MicroVM のエンドポイント）はフェイクにする。
 */

// Node の Request は本文がストリームのとき duplex を求める（Workers では不要）。テストでは補って再現する
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) {
    super(input, init?.body && !init.duplex ? { ...init, duplex: "half" } : init);
  }
};

const { default: worker } = await import("../src/index.ts");
const { PreviewEnvironmentDO } = await import("../src/preview-do.ts");
const { EnvRegistryDO } = await import("../src/registry-do.ts");

function createStorage() {
  const data = new Map();
  let alarm = null;
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async deleteAll() { data.clear(); },
    async list({ prefix = "" } = {}) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
    },
    async setAlarm(ms) { alarm = ms; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; },
  };
}

function createWorld() {
  const aws = {
    calls: [],
    terminated: [],
    async runMicroVm(p) { this.calls.push(["run", p.imageIdentifier]); return { microvmId: "mvm-1", endpointUrl: "abc.lambda-microvm.ap-northeast-1.on.aws", state: "RUNNING" }; },
    async createMicroVmAuthToken({ microvmId }) { this.calls.push(["token", microvmId]); return { token: "jwe-secret", expirationInMinutes: 15 }; },
    async getMicroVmState(id) { this.calls.push(["getState", id]); return this.terminated.includes(id) ? "TERMINATED" : "RUNNING"; },
    async terminateMicroVm(id) { this.calls.push(["terminate", id]); this.terminated.push(id); },
    async deleteMicroVmImage(id) { this.calls.push(["deleteImage", id]); },
  };
  const env = {
    CI_WEBHOOK_SECRET: "s3cret",
    API_HOSTNAME: "api.preview.example.com",
    PREVIEW_BASE_DOMAIN: "preview.example.com",
    APP_TARGET_PORT: "8080",
    COLD_START_LOADING_PAGE: "true",
  };
  const waits = [];
  const dos = new Map();
  env.PREVIEW_DO = {
    idFromName: (name) => name,
    get(name) {
      if (!dos.has(name)) {
        const ctx = { storage: createStorage(), waitUntil: (p) => waits.push(p) };
        dos.set(name, new PreviewEnvironmentDO(ctx, env, aws, { terminationPollIntervalMs: 1 }));
      }
      return dos.get(name);
    },
  };
  const registry = new EnvRegistryDO({ storage: createStorage() }, env);
  env.ENV_REGISTRY = { idFromName: (n) => n, get: () => registry };
  return { env, aws, registry, settle: async () => { while (waits.length) await Promise.all(waits.splice(0)); } };
}

const upstream = [];
globalThis.fetch = async (req) => {
  upstream.push({
    url: req.url,
    method: req.method,
    body: req.body ? await req.text() : null,
    host: req.headers.get("host"),
    forwardedHost: req.headers.get("x-forwarded-host"),
    forwardedProto: req.headers.get("x-forwarded-proto"),
    auth: req.headers.get("x-aws-proxy-auth"),
    port: req.headers.get("x-aws-proxy-port"),
    cookie: req.headers.get("cookie"),
  });
  const res = new Response(`app:${req.method}`, { status: 201, headers: { "x-app": "1", "set-cookie": "s=1; Path=/" } });
  res.headers.append("set-cookie", "t=2; Path=/");
  return res;
};

const ci = (path, init = {}) =>
  new Request(`https://api.preview.example.com${path}`, {
    ...init,
    headers: { "X-CI-Secret": "s3cret", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

test("登録 → コールドスタート画面 → 転送 → 破棄 をルーター経由で通す", async () => {
  upstream.length = 0;
  const { env, aws, registry, settle } = createWorld();
  const image = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-7";

  // 未登録の環境は 404
  assert.equal((await worker.fetch(new Request("https://pr-7.preview.example.com/"), env)).status, 404);

  const reg = await worker.fetch(ci("/api/envs/pr-7/register", { method: "POST", body: JSON.stringify({ imageIdentifier: image }) }), env);
  assert.equal(reg.status, 200);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-7"]);

  // ブラウザのナビゲーションは、裏で起動しつつ自動リロード画面を返す
  const cold = await worker.fetch(
    new Request("https://pr-7.preview.example.com/", { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } }),
    env
  );
  assert.equal(cold.status, 503);
  assert.equal(cold.headers.get("Retry-After"), "3");
  await settle();
  assert.deepEqual(aws.calls.map(([k]) => k), ["run"]);

  // 起動後は MicroVM へ転送する（メソッド・本文・クエリ・Cookie を保ち、JWE とプロキシ用ヘッダーを付ける）
  const res = await worker.fetch(
    new Request("https://pr-7.preview.example.com/posts?page=2", {
      method: "POST",
      body: "title=hello",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "_session=abc" },
    }),
    env
  );
  assert.equal(res.status, 201);
  assert.equal(await res.text(), "app:POST");
  assert.equal(res.headers.get("x-app"), "1");
  assert.deepEqual(res.headers.getSetCookie(), ["s=1; Path=/", "t=2; Path=/"]);
  assert.deepEqual(upstream.at(-1), {
    url: "https://abc.lambda-microvm.ap-northeast-1.on.aws/posts?page=2",
    method: "POST",
    body: "title=hello",
    host: "abc.lambda-microvm.ap-northeast-1.on.aws",
    forwardedHost: "pr-7.preview.example.com",
    forwardedProto: "https",
    auth: "jwe-secret",
    port: "8080",
    cookie: "_session=abc",
  });

  // 状態 API
  const status = await (await worker.fetch(ci("/api/envs/pr-7/status"), env)).json();
  assert.equal(status.envId, "pr-7");
  assert.equal(status.microvmId, "mvm-1");

  // 破棄: MicroVM を終了しきってからイメージを削除し、台帳からも外す
  const destroyed = await worker.fetch(ci("/api/envs/pr-7/destroy", { method: "DELETE" }), env);
  assert.equal(destroyed.status, 200);
  assert.deepEqual(aws.calls.slice(-3).map(([k]) => k), ["terminate", "getState", "deleteImage"]);
  assert.deepEqual(await registry.list(), []);
  assert.equal((await worker.fetch(new Request("https://pr-7.preview.example.com/"), env)).status, 404);
});

test("管理画面からの破棄も、本物の DO で MicroVM の終了とイメージの削除まで行う", async () => {
  const { env, aws, registry } = createWorld();
  env.API_HOSTNAME = "api.localhost";
  const image = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-8";
  await worker.fetch(
    new Request("https://api.localhost/api/envs/pr-8/register", {
      method: "POST",
      headers: { "X-CI-Secret": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ imageIdentifier: image }),
    }),
    env
  );
  await worker.fetch(new Request("https://pr-8.preview.example.com/"), env); // 起動させる

  const list = await (await worker.fetch(new Request("https://api.localhost/admin"), env)).text();
  assert.match(list, /稼働中/);

  const res = await worker.fetch(
    new Request("https://api.localhost/admin/envs/pr-8/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://api.localhost" },
    }),
    env
  );
  assert.equal(res.status, 303);
  assert.ok(aws.calls.some(([k, id]) => k === "deleteImage" && id === image));
  assert.deepEqual(await registry.list(), []);
});

test("管理 API の想定外の例外は、内容を返さず JSON の 500 にする", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env } = createWorld();
  env.PREVIEW_DO = { idFromName: (n) => n, get: () => ({ getStatus: async () => { throw new Error("secret detail"); } }) };
  const res = await worker.fetch(ci("/api/envs/pr-1/status"), env);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Internal Server Error" });
});
