import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

/**
 * エッジルーター (src/index.ts) の管理 API 入力検証を、Durable Object のスタブで検証する。
 */

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
    },
  };
}

const api = (path, init = {}) =>
  new Request(`https://api.preview.example.com${path}`, {
    ...init,
    headers: { "X-CI-Secret": "test-secret", ...(init.headers ?? {}) },
  });

test("register: JSON がオブジェクトでなければ 400（例外で 500 にならない）", async () => {
  const { env, calls } = createEnv();
  for (const body of ["null", "[]", '"str"', "1"]) {
    const res = await worker.fetch(api("/api/envs/pr-1/register", { method: "POST", body }), env);
    assert.equal(res.status, 400, `body=${body}`);
  }
  assert.equal(calls.length, 0);
});

test("register: imageIdentifier / imageId を受理し、空や長すぎる値は 400", async () => {
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

test("envId はプレビューのサブドメインとして有効なものだけ受け付ける", async () => {
  const { env } = createEnv();
  for (const envId of ["pr-1-", "-pr-1", "a".repeat(64)]) {
    const res = await worker.fetch(api(`/api/envs/${envId}/status`), env);
    assert.equal(res.status, 404, envId);
  }
  assert.equal((await worker.fetch(api(`/api/envs/${"a".repeat(63)}/status`), env)).status, 200);
});

test("destroy: クリーンアップが不完全なら 502 を返す（CI で失敗を検知できる）", async () => {
  const { env } = createEnv({
    async destroy() {
      throw new Error("Cleanup incomplete (images: img-1); it will be retried automatically.");
    },
  });
  const res = await worker.fetch(api("/api/envs/pr-1/destroy", { method: "DELETE" }), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).ok, false);
});

test("register: 待機中に同じイメージが削除された場合は 409", async () => {
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

test("シークレットがない・誤っている場合は 401", async () => {
  const { env } = createEnv();
  const noSecret = new Request("https://api.preview.example.com/api/envs/pr-1/status");
  assert.equal((await worker.fetch(noSecret, env)).status, 401);
  const wrong = api("/api/envs/pr-1/status", { headers: { "X-CI-Secret": "wrong" } });
  assert.equal((await worker.fetch(wrong, env)).status, 401);
});
