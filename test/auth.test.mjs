import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

const { verifyPreviewAccess } = await import("../src/auth.ts");

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-1234567890";
const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const b64u = (v) => Buffer.from(v).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

async function makeKey(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kid, kp, jwk: { kid, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e } };
}

async function sign(key, claims = {}, header = {}) {
  const payload = { aud: [AUD], iss: `https://${TEAM}`, exp: nowSec() + 300, ...claims };
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, ...header }));
  const p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let publishedKeys = [];
let jwksFetches = 0;
let jwksFailNext = false;
globalThis.fetch = async (url) => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  jwksFetches++;
  if (jwksFailNext) {
    jwksFailNext = false;
    return new Response("unavailable", { status: 503 });
  }
  return Response.json({ keys: publishedKeys.map((k) => k.jwk) });
};

const verify = (token, env = ENV) =>
  verifyPreviewAccess(
    new Request("https://pr-1.preview.example.com/", token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {}),
    env
  );

const k1 = await makeKey("k1");
const k2 = await makeKey("k2");
publishedKeys = [k1];

test("accepts valid Access JWT from header or cookie", async () => {
  assert.deepEqual(await verify(await sign(k1)), { ok: true });
  const cookieReq = new Request("https://pr-1.preview.example.com/", {
    headers: { Cookie: `foo=bar; CF_Authorization=${await sign(k1)}` },
  });
  assert.deepEqual(await verifyPreviewAccess(cookieReq, ENV), { ok: true });
});

test("rejects invalid, expired, or forged tokens", async () => {
  assert.equal((await verify(null)).status, 401);
  assert.equal((await verify("a.b")).status, 401);
  assert.equal((await verify(await sign(k1, { exp: nowSec() - 1 }))).status, 401);
  assert.equal((await verify(await sign(k1, { aud: ["other"] }))).status, 403);
  assert.equal((await verify(await sign(k1, { iss: "https://evil.cloudflareaccess.com" }))).status, 401);
  assert.equal((await verify(await sign(k1, {}, { alg: "HS256" }))).status, 401);
  // Sign with k2 while spoofing kid=k1
  assert.equal((await verify(await sign(k2, {}, { kid: "k1" }))).status, 401);
});

test("matches string aud exactly without substring matching", async () => {
  assert.deepEqual(await verify(await sign(k1, { aud: AUD })), { ok: true });
  assert.equal((await verify(await sign(k1, { aud: `x-${AUD}-x` }))).status, 403);
});

test("refreshes JWKS once across concurrent requests on key rotation", async () => {
  await verify(await sign(k1));
  publishedKeys = [k1, k2];
  const before = jwksFetches;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => sign(k2)));
  const results = await Promise.all(tokens.map((t) => verify(t)));
  assert.deepEqual(results, Array(5).fill({ ok: true }));
  assert.equal(jwksFetches, before + 1);
});

test("rate-limits forced JWKS refreshes for unknown kids", async () => {
  const before = jwksFetches;
  const key3 = await makeKey("unknown");
  for (let i = 0; i < 5; i++) assert.equal((await verify(await sign(key3))).status, 401);
  assert.ok(jwksFetches <= before + 1);
});

test("passes through when both Access vars are unset, fails closed (500) when only one is set", async () => {
  assert.deepEqual(await verify(null, {}), { ok: true });
  assert.equal((await verify("garbage", { CF_ACCESS_AUD: AUD })).status, 500);
  assert.equal((await verify("garbage", { CF_ACCESS_TEAM_DOMAIN: TEAM })).status, 500);
});

test("allows retry on next request if forced JWKS refresh fails", async (t) => {
  // Advance past the module-wide rate limit from previous tests
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 60 * 1000 });
  await verify(await sign(k1));
  const k0 = await makeKey("k0");
  publishedKeys = [k1, k0];
  jwksFailNext = true;
  assert.equal((await verify(await sign(k0))).status, 401);
  assert.deepEqual(await verify(await sign(k0)), { ok: true });
});
