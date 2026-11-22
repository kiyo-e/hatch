import { registerHooks } from "node:module";

/**
 * src/*.ts を Node.js の型ストリッピングで直接 import するためのフック。
 * - "cloudflare:workers" は最小限のスタブに差し替える
 * - "aws4fetch" はスタブに差し替える（テストでは AWS クライアントをフェイクで注入するため、依存未インストールでも動く）
 * - src 内の拡張子なし相対 import（"./aws-microvm" 等）を .ts に解決する
 */
const STUBS = {
  "cloudflare:workers":
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  aws4fetch:
    "export class AwsClient { constructor() {} fetch() { throw new Error('aws4fetch is stubbed in tests'); } }",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) {
      return { url: `stub:${specifier}`, shortCircuit: true };
    }
    if (
      specifier.startsWith(".") &&
      context.parentURL?.endsWith(".ts") &&
      !/\.[cm]?[jt]s$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) {
      return { format: "module", shortCircuit: true, source: STUBS[url.slice("stub:".length)] };
    }
    return nextLoad(url, context);
  },
});
