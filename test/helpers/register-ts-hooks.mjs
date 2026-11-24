import { registerHooks } from "node:module";

/**
 * Loader hook to import src/*.ts directly using Node.js type stripping.
 * - Stubs "cloudflare:workers" with a minimal DurableObject base class.
 * - Stubs "aws4fetch" (records constructor options on AwsClient.lastOptions).
 * - Resolves extensionless relative imports inside src/ to .ts.
 */
const STUBS = {
  "cloudflare:workers":
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  aws4fetch:
    "export class AwsClient { constructor(options) { this.options = options; AwsClient.lastOptions = options; } fetch() { throw new Error('aws4fetch is stubbed in tests'); } }",
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
