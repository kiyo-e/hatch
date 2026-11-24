import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { adminApp, ENV_ID_REGEX, registryStub } from "./admin";
import { verifyCiSecret, verifyPreviewAccess } from "./auth";
import { PreviewEnvironmentDO } from "./preview-do";
import { EnvRegistryDO } from "./registry-do";
import type { Env, RegisterImagePayload } from "./types";

export { PreviewEnvironmentDO, EnvRegistryDO };
export type { Env };

type AppEnv = { Bindings: Env };

const DEFAULT_API_HOSTNAME = "api.preview.example.com";
const DEFAULT_PREVIEW_BASE_DOMAIN = "preview.example.com";
const API_ACTIONS = new Set(["register", "destroy", "status"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ENV_ID_PATTERN = ENV_ID_REGEX.source.slice(1, -1);

export function extractPreviewEnvId(hostname: string, baseDomain: string): string | null {
  const pattern = new RegExp(`^(${ENV_ID_PATTERN})\\.${escapeRegExp(baseDomain)}$`);
  const match = hostname.toLowerCase().match(pattern);
  return match ? match[1] : null;
}

function previewStub(env: Env, envId: string) {
  return env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(envId));
}

/** Registry updates only back the Admin UI list; failures must not fail CI register/destroy calls. */
async function updateRegistry(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`[registry] ${label} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// 1. API_HOSTNAME: Admin UI (/admin) and CI Management API (/api/envs/:envId/*)
// ---------------------------------------------------------------------------
const apiApp = new Hono<AppEnv>();

apiApp.route("/admin", adminApp);

// Require CI secret for all non-/admin routes before route matching to avoid path enumeration.
apiApp.use("*", async (c, next) => {
  if (c.req.path === "/admin" || c.req.path.startsWith("/admin/")) return next();
  if (!verifyCiSecret(c.req.raw, c.env)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

apiApp.use("/api/envs/:envId/:action", async (c, next) => {
  if (!ENV_ID_REGEX.test(c.req.param("envId")) || !API_ACTIONS.has(c.req.param("action"))) {
    return c.json({ error: "Not Found" }, 404);
  }
  await next();
});

apiApp.post("/api/envs/:envId/register", async (c) => {
  const envId = c.req.param("envId");
  let payload: RegisterImagePayload;
  try {
    payload = await c.req.json<RegisterImagePayload>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return c.json({ error: "JSON body must be an object" }, 400);
  }

  const imageIdentifier = payload.imageIdentifier ?? payload.imageId;
  if (!imageIdentifier || typeof imageIdentifier !== "string" || imageIdentifier.length > 256) {
    return c.json({ error: "imageIdentifier (or imageId) is required" }, 400);
  }

  try {
    await previewStub(c.env, envId).registerImage(imageIdentifier, payload.imageVersion);
  } catch (err) {
    if ((err as Error).message?.includes("deleted by a pending cleanup")) {
      return c.json({ ok: false, envId, error: (err as Error).message }, 409);
    }
    throw err;
  }
  await updateRegistry(() => registryStub(c.env).upsert(envId, imageIdentifier), `upsert ${envId}`);
  return c.json({ ok: true, envId, imageIdentifier });
});

apiApp.delete("/api/envs/:envId/destroy", async (c) => {
  const envId = c.req.param("envId");
  try {
    await previewStub(c.env, envId).destroy();
  } catch (err) {
    // Return 502 so CI detects incomplete cleanup; keep registry entry so Admin UI shows pending cleanup.
    return c.json({ ok: false, envId, error: (err as Error).message }, 502);
  }
  await updateRegistry(() => registryStub(c.env).remove(envId), `remove ${envId}`);
  return c.json({ ok: true, envId });
});

apiApp.get("/api/envs/:envId/status", async (c) => {
  const envId = c.req.param("envId");
  const status = await previewStub(c.env, envId).getStatus();
  return c.json({ envId, ...status });
});

apiApp.all("/api/envs/:envId/:action", (c) => c.json({ error: "Method Not Allowed" }, 405));
apiApp.notFound((c) => c.json({ error: "Not Found" }, 404));
apiApp.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[api] ${c.req.method} ${c.req.path} failed:`, err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// ---------------------------------------------------------------------------
// 2. Preview Subdomains (e.g. https://pr-123.preview.example.com/*)
// ---------------------------------------------------------------------------
async function handlePreview(c: Context<AppEnv>): Promise<Response> {
  const previewBaseDomain = (c.env.PREVIEW_BASE_DOMAIN || DEFAULT_PREVIEW_BASE_DOMAIN).toLowerCase();
  const envId = extractPreviewEnvId(new URL(c.req.url).hostname, previewBaseDomain);
  if (!envId) {
    return new Response("Invalid preview host", { status: 400 });
  }

  const accessCheck = await verifyPreviewAccess(c.req.raw, c.env);
  if (!accessCheck.ok) {
    return new Response(accessCheck.message, { status: accessCheck.status });
  }

  return previewStub(c.env, envId).fetch(c.req.raw);
}

// Dispatch by hostname at runtime since API_HOSTNAME comes from env vars.
const app = new Hono<AppEnv>();

app.all("*", (c) => {
  const apiHostname = (c.env.API_HOSTNAME || DEFAULT_API_HOSTNAME).toLowerCase();
  if (new URL(c.req.url).hostname.toLowerCase() === apiHostname) {
    let executionCtx: Parameters<typeof apiApp.fetch>[2];
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    return apiApp.fetch(c.req.raw, c.env, executionCtx);
  }
  return handlePreview(c);
});

export default app;
