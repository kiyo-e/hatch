import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

const { default: worker } = await import("../src/index.ts");
const { EnvRegistryDO } = await import("../src/registry-do.ts");
const { previewUrl } = await import("../src/admin.ts");

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

// --- Registry ---

test("registry: preserves initial registeredAt on re-registration and sorts newest first", async (t) => {
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

test("Management API: adds to registry on register, removes on destroy, keeps on incomplete cleanup", async () => {
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
  assert.deepEqual((await ng.registry.list()).map((e) => e.envId), ["pr-2"]);
});

test("Management API: register returns 503 when the registry update fails so CI retries", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, calls } = createEnv();
  env.ENV_REGISTRY = { idFromName: () => "x", get: () => ({ upsert: async () => { throw new Error("registry down"); } }) };
  const res = await worker.fetch(
    ci("api.localhost", "/api/envs/pr-1/register", { method: "POST", body: JSON.stringify({ imageIdentifier: "img-1" }) }),
    env
  );
  assert.equal(res.status, 503);
  assert.deepEqual(calls, [["register", "pr-1", "img-1"]]);
});

test("Management API: returns 405 for wrong method and 404 for unknown paths after auth", async () => {
  const { env } = createEnv();
  assert.equal((await worker.fetch(ci("api.localhost", "/api/envs/pr-1/status", { method: "POST" }), env)).status, 405);
  assert.equal((await worker.fetch(ci("api.localhost", "/api/envs/pr-1/unknown"), env)).status, 404);
  assert.equal((await worker.fetch(ci("api.localhost", "/nothing"), env)).status, 404);
  assert.equal((await worker.fetch(page("api.localhost", "/nothing"), env)).status, 401);
});

// --- Admin UI Auth ---

test("Admin UI: returns 503 on production host without Access config, allows localhost", async () => {
  const prod = createEnv({ apiHostname: "api.preview.example.com" });
  const res = await worker.fetch(page("api.preview.example.com", "/admin"), prod.env);
  assert.equal(res.status, 503);

  const local = createEnv();
  assert.equal((await worker.fetch(page("api.localhost", "/admin"), local.env)).status, 200);
});

test("Admin UI: requires Access JWT even on localhost when Access is configured; rejects CI secret", async () => {
  const { env } = createEnv({
    extra: { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_ADMIN_AUD: "admin-aud" },
  });
  assert.equal((await worker.fetch(page("api.localhost", "/admin"), env)).status, 401);
  const withSecret = page("api.localhost", "/admin", { headers: { "X-CI-Secret": "test-secret" } });
  assert.equal((await worker.fetch(withSecret, env)).status, 401);
});

test("Admin UI: preview Access config (CF_ACCESS_AUD) alone does not enable /admin", async () => {
  const { env } = createEnv({
    apiHostname: "api.preview.example.com",
    extra: { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "preview-aud" },
  });
  assert.equal((await worker.fetch(page("api.preview.example.com", "/admin"), env)).status, 503);
});

// --- List, Detail, Destroy ---

test("Admin UI: lists registered environments with live status and prunes missing ones", async () => {
  const { env, statuses, registry } = createEnv();
  await register(env, "pr-1");
  await register(env, "pr-2");
  statuses["pr-1"] = {
    registered: true,
    imageIdentifier: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-1",
    microvmId: "microvm-abc",
    booting: false,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  statuses["pr-2"] = { registered: false, booting: false };

  const res = await worker.fetch(page("api.localhost:8787", "/admin"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.text();
  assert.match(body, /Environments \(1\)/);
  assert.match(body, /href="\/admin\/envs\/pr-1"/);
  assert.match(body, /Running/);
  assert.match(body, /<code title="arn:aws:lambda:[^"]+:pr-1">pr-1<\/code>/);
  assert.match(body, /href="http:\/\/pr-1\.localhost:8787\/"/);

  // Even when upstream_protocol: https makes the Worker see https://, localhost links use http://
  const viaHttpsUpstream = await (await worker.fetch(new Request("https://api.localhost:8787/admin"), env)).text();
  assert.match(viaHttpsUpstream, /href="http:\/\/pr-1\.localhost:8787\/"/);
  assert.doesNotMatch(body, /pr-2/);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("Admin UI: detail page shows pending cleanup and escapes HTML values", async () => {
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
  assert.match(body, /Destroying/);
  assert.match(body, /Retry Destroy/);
  assert.match(body, /microvm-image:pr-1<\/code> <span class="muted">\(last registered before destroy\)/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert/);

  const missing = await worker.fetch(page("api.localhost", "/admin/envs/pr-9"), env);
  assert.equal(missing.status, 303);
  assert.equal((await worker.fetch(page("api.localhost", "/admin/envs/-bad-"), env)).status, 404);
});

test("Admin UI: destroy enforces same-origin POST and redirects with notice", async () => {
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
  assert.equal(location.searchParams.get("notice"), "Destroyed pr-1");
  assert.deepEqual(await registry.list(), []);
});

test("Admin UI: redirects with automatic retry notice on CleanupIncompleteError", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, registry } = createEnv({ destroyError: new Error("Cleanup incomplete (microvms: -, images: img-1); it will be retried automatically.") });
  await register(env, "pr-1");
  const res = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://api.localhost" },
    }),
    env
  );
  assert.equal(res.status, 303);
  assert.match(new URL(res.headers.get("Location"), "http://x").searchParams.get("notice"), /retried automatically/);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("preview host forwards /admin to the app (Admin UI only on API_HOSTNAME)", async () => {
  const { env } = createEnv();
  const res = await worker.fetch(page("pr-1.localhost", "/admin"), env);
  assert.equal(await res.text(), "proxied");
});

test("registry: remove with stale revision does not delete a concurrent re-registration", async () => {
  const registry = new EnvRegistryDO({ storage: createStorage() }, {});
  await registry.upsert("pr-1", "img-a");
  const [read] = await registry.list();
  await registry.upsert("pr-1", "img-b");
  assert.equal(await registry.remove("pr-1", read.revision), false);
  assert.deepEqual((await registry.list()).map((e) => e.imageIdentifier), ["img-b"]);
  assert.equal(await registry.remove("pr-1", read.revision + 1), true);
  assert.deepEqual(await registry.list(), []);
});

test("Admin UI: does not prune an environment re-registered after getStatus returned unregistered", async () => {
  const { env, registry } = createEnv();
  await register(env, "pr-1");
  const original = env.PREVIEW_DO.get;
  env.PREVIEW_DO = {
    idFromName: (n) => n,
    get: (n) => ({
      ...original(n),
      async getStatus() {
        await registry.upsert(n, "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-1-v2");
        return { registered: false, booting: false };
      },
    }),
  };
  const res = await worker.fetch(page("api.localhost", "/admin"), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("Admin UI: renders list even when one environment's getStatus fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, registry } = createEnv();
  await register(env, "pr-1");
  await register(env, "pr-2");
  const original = env.PREVIEW_DO.get;
  env.PREVIEW_DO = {
    idFromName: (n) => n,
    get: (n) =>
      n === "pr-2"
        ? { ...original(n), async getStatus() { throw new Error("Durable Object is overloaded"); } }
        : original(n),
  };
  const res = await worker.fetch(page("api.localhost", "/admin"), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Environments \(2\)/);
  assert.match(body, /href="\/admin\/envs\/pr-1"/);
  assert.match(body, /href="\/admin\/envs\/pr-2"[\s\S]*Unavailable/);
  assert.deepEqual((await registry.list()).map((e) => e.envId).sort(), ["pr-1", "pr-2"]);
});

test("Admin UI: does not claim automatic retry when destroy fails without pending cleanup", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, registry } = createEnv({ destroyError: new Error("Network connection lost.") });
  await register(env, "pr-1");
  const res = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://api.localhost" },
    }),
    env
  );
  const notice = new URL(res.headers.get("Location"), "http://x").searchParams.get("notice");
  assert.match(notice, /Automatic retry is not scheduled/);
  assert.doesNotMatch(notice, /will be retried automatically/);
  assert.deepEqual((await registry.list()).map((e) => e.envId), ["pr-1"]);
});

test("Admin UI: reports destroy success even if registry removal fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const { env, statuses } = createEnv();
  await register(env, "pr-1");
  env.ENV_REGISTRY = { idFromName: (n) => n, get: () => ({ remove: async () => { throw new Error("registry down"); } }) };
  const res = await worker.fetch(
    page("api.localhost", "/admin/envs/pr-1/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://api.localhost" },
    }),
    env
  );
  assert.equal(new URL(res.headers.get("Location"), "http://x").searchParams.get("notice"), "Destroyed pr-1");
  assert.equal(statuses["pr-1"].registered, false);
});

test("previewUrl: uses https without port in production and http with port on localhost", () => {
  const prod = { PREVIEW_BASE_DOMAIN: "preview.example.com" };
  assert.equal(previewUrl("https://api.preview.example.com/admin", "pr-1", prod), "https://pr-1.preview.example.com/");
  assert.equal(previewUrl("https://api.preview.example.com:8443/admin", "pr-1", prod), "https://pr-1.preview.example.com/");
  const local = { PREVIEW_BASE_DOMAIN: "localhost" };
  assert.equal(previewUrl("https://api.localhost:8787/admin", "pr-1", local), "http://pr-1.localhost:8787/");
  assert.equal(previewUrl("http://api.localhost/admin", "pr-1", local), "http://pr-1.localhost/");
});
