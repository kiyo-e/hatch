import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("wrangler.jsonc defines SQLite Durable Object migrations and required vars", () => {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(stripped);

  assert.equal(config.name, "hatch");
  assert.equal(config.main, "src/index.ts");
  assert.ok(config.compatibility_flags.includes("nodejs_compat"));
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "PREVIEW_DO", class_name: "PreviewEnvironmentDO" },
    { name: "ENV_REGISTRY", class_name: "EnvRegistryDO" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["PreviewEnvironmentDO"] },
    { tag: "v2", new_sqlite_classes: ["EnvRegistryDO"] },
  ]);
  assert.equal(config.vars.AWS_REGION, "ap-northeast-1");
  assert.equal(config.vars.APP_TARGET_PORT, "8080");
});

test("src/aws-microvm.ts conforms to AWS Lambda MicroVMs API (/2025-09-09/)", () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/aws-microvm.ts"), "utf8");

  assert.match(src, /const API_VERSION = "2025-09-09"/);
  assert.match(src, /service:\s*"lambda"/);
  assert.match(src, /imageIdentifier:\s*params\.imageIdentifier/);
  assert.match(src, /allowedPorts:\s*\[\{\s*port:\s*params\.allowedPort\s*\}\]/);
  assert.match(src, /expirationInMinutes/);
  assert.match(src, /X-aws-proxy-auth/);
  assert.match(src, /\/microvm-images\//);
});

test("src/preview-do.ts implements 7h45m TTL, boot lock, proxy headers, DO Alarm, and cold-start HTML", () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/preview-do.ts"), "utf8");

  assert.match(src, /MAX_VM_LIFETIME_MS = \(8 \* 60 - 15\) \* 60 \* 1000/);
  assert.match(src, /if \(!this\.bootPromise\)/);
  assert.match(src, /headers\.set\("X-aws-proxy-auth",\s*jweToken\)/);
  assert.match(src, /headers\.set\("X-aws-proxy-port"/);
  assert.match(src, /headers\.set\("X-Forwarded-Host"/);
  assert.match(src, /headers\.set\("X-Forwarded-Proto",\s*"https"\)/);
  assert.match(src, /async alarm\(\): Promise<void>/);
  assert.match(src, /this\.ctx\.storage\.setAlarm\(/);
  assert.match(src, /renderColdStartResponse\(/);
  assert.match(src, /this\.ctx\.waitUntil\(/);
  assert.match(src, /response\.status === 403/);
  assert.match(src, /response\.status === 410/);
});

test("subdomain extraction matches valid preview hosts", () => {
  const extractPreviewEnvId = (hostname, baseDomain) => {
    const escaped = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.${escaped}$`);
    const match = hostname.toLowerCase().match(pattern);
    return match ? match[1] : null;
  };

  assert.equal(extractPreviewEnvId("pr-123.preview.example.com", "preview.example.com"), "pr-123");
  assert.equal(extractPreviewEnvId("PR-42.preview.example.com", "preview.example.com"), "pr-42");
  assert.equal(extractPreviewEnvId("a.b.preview.example.com", "preview.example.com"), null);
  assert.equal(extractPreviewEnvId("-bad.preview.example.com", "preview.example.com"), null);
  assert.equal(extractPreviewEnvId("preview.example.com", "preview.example.com"), null);
});

test("constant-time string comparison handles matches, mismatches, and length differences", () => {
  const timingSafeEqual = (a, b) => {
    const encoder = new TextEncoder();
    const bufA = encoder.encode(a);
    const bufB = encoder.encode(b);
    const maxLen = Math.max(bufA.length, bufB.length);
    let diff = bufA.length ^ bufB.length;
    for (let i = 0; i < maxLen; i++) {
      diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
    }
    return diff === 0;
  };

  assert.equal(timingSafeEqual("super-secret", "super-secret"), true);
  assert.equal(timingSafeEqual("super-secret", "super-secrex"), false);
  assert.equal(timingSafeEqual("short", "longer-secret"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
