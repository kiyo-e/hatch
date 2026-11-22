import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

/**
 * 管理画面 (/admin)・環境の台帳 (EnvRegistryDO)・管理 API からの台帳の更新を検証する。
 */

const { default: worker } = await import("../src/index.ts");
const { EnvRegistryDO } = await import("../src/registry-do.ts");

// --- フェイク ---

function createStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      return data.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
    },
  };
}

/** envId ごとの状態を持つ PreviewEnvironmentDO のスタブと、本物の EnvRegistryDO を組み合わせた env */
function createEnv({ apiHostname = "api.localhost", statuses = {}, destroyError = null, extra = {} } = {}) {
  const registry = new EnvRegistryDO({ storage: createStorage() }, {});
  const calls = [];
  const envStub = (envId) => ({
    async registerImage(imageIdentifier) {
      calls.push(["register", envId, imageIdentifier]);
      statuses[envId] = { registered: true, imageIdentifier, booting: false };
    },
    async destroy() {
      calls.push(["destroy", envId]);
      if (destroyError) throw destroyError;
      statuses[envId] = { registered: false, booting: false };
    },
    async getStatus() {
      return statuses[envId] ?? { registered: false, booting: false };
    },
    async fetch() {
      return new Response("proxied");
    },
  });
  return {
    calls,
    statuses,
    registry,
    env: {
      CI_WEBHOOK_SECRET: "test-secret",
      API_HOSTNAME: apiHostname,
      PREVIEW_BASE_DOMAIN: "localhost",
      PREVIEW_DO: { idFromName: (name) => name, get: (name) => envStub(name) },
      ENV_REGISTRY: { idFromName: (name) => name, get: () => registry },
      ...extra,
    },
  };
}

const ci = (host, path, init = {}) =>
  new Request(`http://${host}${path}`, {
    ...init,
    headers: { "X-CI-Secret": "test-secret", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const page = (host, path, init = {}) => new Request(`http://${host}${path}`, init);

async function register(env, envId, image = `arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:${envId}`) {
  const res = await worker.fetch(
    ci("api.localhost", `/api/envs/${envId}/register`, { method: "POST", body: JSON.stringify({ imageIdentifier: image }) }),
    env
  );
  assert.equal(res.status, 200);
}

// --- 台帳 ---

test("台帳: 登録し直しても最初の登録時刻は保ち、新しい順に並べる", async (t) => {
  const registry = new EnvRegistryDO({ storage: createStorage() }, {});
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  await registry.upsert("pr-1", "img-a");
  t.mock.timers.setTime(2000);
  await registry.upsert("pr-2", "img-b");
  t.mock.timers.setTime(3000);
  await registry.upsert("pr-1", "img-c");

  const list = await registry.list();
  assert.deepEqual(
    list.map((e) => [e.envId, e.imageIdentifier, e.registeredAt, e.updatedAt]),
    [
      ["pr-1", "img-c", 1000, 3000],
      ["pr-2", "img-b", 2000, 2000],
    ]
  );
  await registry.remove("pr-1");
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-2"]);
});

test("管理 API: 登録で台帳に載り、破棄が完了したら外れる。破棄が不完全なら残す", async () => {
  const ok = createEnv();
  await register(ok.env, "pr-1");
  assert.deepEqual((await ok.registry.list()).map((e) => e.envId), ["pr-1"]);
  const destroyed = await worker.fetch(ci("api.localhost", "/api/envs/pr-1/destroy", { method: "DELETE" }), ok.env);
  assert.equal(destroyed.status, 200);
  assert.deepEqual(await ok.registry.list(), []);

  const ng = createEnv({ destroyError: new Error("Cleanup incomplete") });
  await register(ng.env, "pr-2");
  const failed = await worker.fetch(ci("api.localhost", "/api/envs/pr-2/destroy", { method: "DELETE" }), ng.env);
  assert.equal(failed.status, 502);
  assert.deepEqual((await ng.registry.list()).map((e) => e.envId), ["pr-2"], "削除待ちを管理画面で確認できるよう残す");
});

test("管理 API: 台帳の更新に失敗しても登録は成功として返す", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, calls } = createEnv();
  env.ENV_REGISTRY = { idFromName: () => "x", get: () => ({ upsert: async () => { throw new Error("registry down"); } }) };
  await register(env, "pr-1");
  assert.deepEqual(calls, [["register", "pr-1", "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-1"]]);
});

test("管理 API: パスは正しいがメソッドが違えば 405、知らないパスはシークレットの確認後に 404", async () => {
  const { env } = createEnv();
  assert.equal((await worker.fetch(ci("api.localhost", "/api/envs/pr-1/status", { method: "POST" }), env)).status, 405);
  assert.equal((await worker.fetch(ci("api.localhost", "/api/envs/pr-1/unknown"), env)).status, 404);
  assert.equal((await worker.fetch(ci("api.localhost", "/nothing"), env)).status, 404);
  assert.equal((await worker.fetch(page("api.localhost", "/nothing"), env)).status, 401);
});

// --- 管理画面の認証 ---

test("管理画面: Access の設定が無ければ本番のホストでは 503、localhost では開ける", async () => {
  const prod = createEnv({ apiHostname: "api.preview.example.com" });
  const res = await worker.fetch(page("api.preview.example.com", "/admin"), prod.env);
  assert.equal(res.status, 503);

  const local = createEnv();
  assert.equal((await worker.fetch(page("api.localhost", "/admin"), local.env)).status, 200);
});

test("管理画面: Access を設定したら、localhost でもトークンなしは 401。CI シークレットだけでは開けない", async () => {
  const { env } = createEnv({
    extra: { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_ADMIN_AUD: "admin-aud" },
  });
  assert.equal((await worker.fetch(page("api.localhost", "/admin"), env)).status, 401);
  const withSecret = page("api.localhost", "/admin", { headers: { "X-CI-Secret": "test-secret" } });
  assert.equal((await worker.fetch(withSecret, env)).status, 401);
});

test("管理画面: プレビュー用の Access 設定（CF_ACCESS_AUD）だけでは有効にならない", async () => {
  const { env } = createEnv({
    apiHostname: "api.preview.example.com",
    extra: { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "preview-aud" },
  });
  assert.equal((await worker.fetch(page("api.preview.example.com", "/admin"), env)).status, 503);
});

// --- 一覧・詳細・破棄 ---

test("管理画面: 一覧に台帳の環境と状態を表示し、実体の無い環境は台帳から外す", async () => {
  const { env, statuses, registry } = createEnv();
  await register(env, "pr-1");
  await register(env, "pr-2");
  statuses["pr-1"] = {
    registered: true,
    imageIdentifier: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-1",
    microvmId: "microvm-abc",
    booting: false,
    expiresAt: "2026-11-23T07:45:00.000Z",
  };
  // pr-2 は Alarm で自動破棄された想定
  statuses["pr-2"] = { registered: false, booting: false };

  const res = await worker.fetch(page("api.localhost:8787", "/admin"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.text();
  assert.match(body, /環境の一覧（1）/);
  assert.match(body, /href="\/admin\/envs\/pr-1"/);
  assert.match(body, /稼働中/);
  assert.match(body, /<code title="arn:aws:lambda:[^"]+:pr-1">pr-1<\/code>/, "イメージは ARN の末尾だけを表示する");
  assert.match(body, /href="http:\/\/pr-1\.localhost:8787\/"/, "プレビューのリンクは今のスキームとポートに合わせる");
  assert.doesNotMatch(body, /pr-2/);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("管理画面: 詳細ページは削除待ちを表示し、値はエスケープする", async () => {
  const { env, statuses } = createEnv();
  await register(env, "pr-1");
  statuses["pr-1"] = {
    registered: false,
    booting: false,
    cleanupPending: { microvmIds: [], imageIdentifiers: ["<script>alert(1)</script>"] },
  };
  const res = await worker.fetch(page("api.localhost", "/admin/envs/pr-1"), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /破棄中/);
  assert.match(body, /破棄を再試行する/);
  assert.match(body, /microvm-image:pr-1<\/code> <span class="muted">（破棄前に登録されていたイメージ）/, "破棄中でも台帳のイメージを表示する");
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert/);

  // 登録の無い環境は一覧へ戻す。envId として不正なら 404
  const missing = await worker.fetch(page("api.localhost", "/admin/envs/pr-9"), env);
  assert.equal(missing.status, 303);
  assert.equal((await worker.fetch(page("api.localhost", "/admin/envs/-bad-"), env)).status, 404);
});

test("管理画面: 破棄は同じオリジンからの POST だけ受け付け、結果を一覧に表示する", async () => {
  const { env, calls, registry } = createEnv();
  await register(env, "pr-1");
  const form = { "Content-Type": "application/x-www-form-urlencoded" };

  const crossSite = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", { method: "POST", headers: { ...form, Origin: "http://evil.example.com" } }),
    env
  );
  assert.equal(crossSite.status, 403);
  assert.ok(!calls.some(([k]) => k === "destroy"));

  const res = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", { method: "POST", headers: { ...form, Origin: "http://api.localhost" } }),
    env
  );
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("Location"), "http://api.localhost");
  assert.equal(location.pathname, "/admin");
  assert.equal(location.searchParams.get("notice"), "pr-1 を破棄しました");
  assert.deepEqual(await registry.list(), []);
});

test("管理画面: 破棄が不完全でも 500 にせず、自動で再試行されることを表示する", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, registry } = createEnv({ destroyError: new Error("Cleanup incomplete") });
  await register(env, "pr-1");
  const res = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://api.localhost" },
    }),
    env
  );
  assert.equal(res.status, 303);
  assert.match(new URL(res.headers.get("Location"), "http://x").searchParams.get("notice"), /自動で再試行/);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("プレビューのホストでは /admin もアプリへ転送する（管理画面は API_HOSTNAME だけ）", async () => {
  const { env } = createEnv();
  const res = await worker.fetch(page("pr-1.localhost", "/admin"), env);
  assert.equal(await res.text(), "proxied");
});
