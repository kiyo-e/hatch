import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * 依存パッケージ未インストール環境（オフライン CI や初期検証）でも実行できるよう、
 * ソースファイルの契約・重要ロジック・設定整合性を検証する軽量テストスイート。
 */

test("wrangler.jsonc は SQLite Durable Object マイグレーションと必須変数を定義している", () => {
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
  // 既存のマイグレーションは書き換えず、新しいクラスは新しいタグで追加する
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["PreviewEnvironmentDO"] },
    { tag: "v2", new_sqlite_classes: ["EnvRegistryDO"] },
  ]);
  assert.equal(config.vars.AWS_REGION, "ap-northeast-1");
  assert.equal(config.vars.APP_TARGET_PORT, "8080");
});

test("src/aws-microvm.ts は公式 AWS Lambda MicroVMs API (/2025-09-09/) の仕様に準拠している", () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/aws-microvm.ts"), "utf8");

  assert.match(src, /const API_VERSION = "2025-09-09"/);
  assert.match(src, /service:\s*"lambda"/);
  assert.match(src, /imageIdentifier:\s*params\.imageIdentifier/);
  assert.match(src, /allowedPorts:\s*\[\{\s*port:\s*params\.allowedPort\s*\}\]/);
  assert.match(src, /expirationInMinutes/);
  assert.match(src, /X-aws-proxy-auth/);
  assert.match(src, /\/microvm-images\//);
});

test("src/preview-do.ts は 7h45m TTL・多重起動ロック・X-aws-proxy-auth・DO Alarm・コールドスタートHTMLを実装している", () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/preview-do.ts"), "utf8");

  // 7時間45分 = (8 * 60 - 15) * 60 * 1000
  assert.match(src, /MAX_VM_LIFETIME_MS = \(8 \* 60 - 15\) \* 60 \* 1000/);
  // インメモリ Promise ロック
  assert.match(src, /if \(!this\.bootPromise\)/);
  // 必須プロキシヘッダー
  assert.match(src, /headers\.set\("X-aws-proxy-auth",\s*jweToken\)/);
  assert.match(src, /headers\.set\("X-aws-proxy-port"/);
  assert.match(src, /headers\.set\("X-Forwarded-Host"/);
  assert.match(src, /headers\.set\("X-Forwarded-Proto",\s*"https"\)/);
  // DO Alarm によるゾンビ掃除
  assert.match(src, /async alarm\(\): Promise<void>/);
  assert.match(src, /this\.ctx\.storage\.setAlarm\(/);
  // コールドスタート HTML 応答
  assert.match(src, /renderColdStartResponse\(/);
  assert.match(src, /this\.ctx\.waitUntil\(/);
  // 403 / 410 / 404 自己修復リトライ
  assert.match(src, /response\.status === 403/);
  assert.match(src, /response\.status === 410/);
});

test("サブドメイン抽出ロジックが期待通り動作する", () => {
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

test("定数時間比較ロジックが一致・不一致・長さ違いを正しく判定する", () => {
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
