import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

const { default: worker } = await import("../src/index.ts");

function createEnv(stubOverrides = {}) {
  const calls = [];
  const stub = {
    async registerImage(...args) {
      calls.push(["register", ...args]);
    },
    async destroy() {
      calls.push(["destroy"]);
    },
    async getStatus() {
      return { registered: false, booting: false };
    },
    async fetch() {
      return new Response("proxied");
    },
    ...stubOverrides,
  };
  return {
    calls,
    env: {
      CI_WEBHOOK_SECRET: "test-secret",
      API_HOSTNAME: "api.preview.example.com",
      PREVIEW_BASE_DOMAIN: "preview.example.com",
      PREVIEW_DO: { idFromName: (name) => name, get: () => stub },
      ENV_REGISTRY: {
        idFromName: (name) => name,
        get: () => ({ async upsert() {}, async remove() {}, async list() { return []; } }),
      },
    },
  };
}

const api = (path, init = {}) =>
  new Request(`https://api.preview.example.com${path}`, {
    ...init,
    headers: { "X-CI-Secret": "test-secret", ...(init.headers ?? {}) },
  });

test("register: returns 400 when JSON body is not an object", async () => {
  const { env, calls } = createEnv();
  for (const body of ["null", "[]", '"str"', "1"]) {
    const res = await worker.fetch(api("/api/envs/pr-1/register", { method: "POST", body }), env);
    assert.equal(res.status, 400, `body=${body}`);
  }
  assert.equal(calls.length, 0);
});

test("register: accepts imageIdentifier/imageId and rejects empty or oversized values with 400", async () => {
  const { env, calls } = createEnv();
  const ok = await worker.fetch(
    api("/api/envs/pr-1/register", { method: "POST", body: JSON.stringify({ imageId: "img-1", imageVersion: "2" }) }),
    env
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, [["register", "img-1", "2"]]);

  for (const body of [{}, { imageIdentifier: "" }, { imageIdentifier: 1 }, { imageIdentifier: "x".repeat(257) }]) {
    const res = await worker.fetch(api("/api/envs/pr-1/register", { method: "POST", body: JSON.stringify(body) }), env);
    assert.equal(res.status, 400);
  }
});

test("accepts only valid DNS labels as envId", async () => {
  const { env } = createEnv();
  for (const envId of ["pr-1-", "-pr-1", "a".repeat(64)]) {
    const res = await worker.fetch(api(`/api/envs/${envId}/status`), env);
    assert.equal(res.status, 404, envId);
  }
  assert.equal((await worker.fetch(api(`/api/envs/${"a".repeat(63)}/status`), env)).status, 200);
});

test("destroy: returns 502 when cleanup is incomplete", async () => {
  const { env } = createEnv({
    async destroy() {
      throw new Error("Cleanup incomplete (images: img-1); it will be retried automatically.");
    },
  });
  const res = await worker.fetch(api("/api/envs/pr-1/destroy", { method: "DELETE" }), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).ok, false);
});

test("register: returns 409 when image is deleted by an in-flight cleanup", async () => {
  const { env } = createEnv({
    async registerImage() {
      throw new Error("Image img-1 was deleted by a pending cleanup while registering; rebuild the image and register again.");
    },
  });
  const res = await worker.fetch(
    api("/api/envs/pr-1/register", { method: "POST", body: JSON.stringify({ imageIdentifier: "img-1" }) }),
    env
  );
  assert.equal(res.status, 409);
});

test("returns 401 when X-CI-Secret is missing or invalid", async () => {
  const { env } = createEnv();
  const noSecret = new Request("https://api.preview.example.com/api/envs/pr-1/status");
  assert.equal((await worker.fetch(noSecret, env)).status, 401);
  const wrong = api("/api/envs/pr-1/status", { headers: { "X-CI-Secret": "wrong" } });
  assert.equal((await worker.fetch(wrong, env)).status, 401);
});

test("list: returns registered envs with live state and excludes destroyed/destroying ones", async () => {
  const entries = ["pr-1", "pr-2", "pr-3", "pr-4", "pr-5", "pr-6"].map((envId, i) => ({
    envId,
    imageIdentifier: `img-${envId}`,
    registeredAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_100_000 + i,
    revision: 1,
  }));
  const statuses = {
    "pr-1": { registered: true, booting: false, microvmId: "vm-1", imageIdentifier: "img-pr-1", imageVersion: "3" },
    "pr-2": { registered: true, booting: true },
    "pr-6": { registered: true, booting: false, microvmId: "vm-6", expiresAt: new Date(Date.now() - 1000).toISOString() },
    "pr-3": { registered: false, booting: false }, // destroyed → pruned
    "pr-4": { registered: false, booting: false, cleanupPending: { microvmIds: ["vm-4"], imageIdentifiers: [] } }, // destroying
  };
  const removed = [];
  const { env } = createEnv();
  env.PREVIEW_DO = {
    idFromName: (name) => name,
    get: (id) => ({
      async getStatus() {
        if (id === "pr-5") throw new Error("boom");
        return statuses[id];
      },
    }),
  };
  env.ENV_REGISTRY = {
    idFromName: (name) => name,
    get: () => ({
      async list() {
        return entries;
      },
      async remove(envId) {
        removed.push(envId);
        return true;
      },
    }),
  };

  const res = await worker.fetch(api("/api/envs"), env);
  assert.equal(res.status, 200);
  const { envs } = await res.json();
  assert.deepEqual(
    envs.map((e) => [e.envId, e.state]),
    [
      ["pr-1", "running"],
      ["pr-2", "booting"],
      ["pr-5", "unavailable"],
      ["pr-6", "idle"],
    ]
  );
  assert.equal(envs[0].url, "https://pr-1.preview.example.com/");
  assert.equal(envs[0].imageVersion, "3");
  assert.equal(envs[0].registeredAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(envs[2].imageIdentifier, "img-pr-5");
  assert.deepEqual(removed, ["pr-3"]);
});

test("list: requires the CI secret", async () => {
  const { env } = createEnv();
  const res = await worker.fetch(new Request("https://api.preview.example.com/api/envs"), env);
  assert.equal(res.status, 401);
  assert.equal((await worker.fetch(api("/api/envs"), env)).status, 200);
});
