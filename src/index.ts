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

// DNS ラベルとして有効な envId（管理 API とプレビューのサブドメインで同じ規則を使う）
const ENV_ID_PATTERN = ENV_ID_REGEX.source.slice(1, -1);

export function extractPreviewEnvId(hostname: string, baseDomain: string): string | null {
  const pattern = new RegExp(`^(${ENV_ID_PATTERN})\\.${escapeRegExp(baseDomain)}$`);
  const match = hostname.toLowerCase().match(pattern);
  return match ? match[1] : null;
}

function previewStub(env: Env, envId: string) {
  return env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(envId));
}

/** 台帳の更新は一覧表示のためのもの。失敗しても CI の登録・破棄は失敗にしない */
async function updateRegistry(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`[registry] ${label} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// 1. API_HOSTNAME: 管理画面 (/admin) と CI 用の管理 API (/api/envs/:envId/*)
// ---------------------------------------------------------------------------
const apiApp = new Hono<AppEnv>();

apiApp.route("/admin", adminApp);

// /admin 以外はすべて CI シークレットが必要（パスの存在を明かさないよう 404 より先に判定する）
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
    // 実行中だった削除待ちの再試行で同じイメージが削除された場合は 409（CI で再ビルドして登録し直す）
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
    // 削除に失敗したリソースは DO が Alarm で再試行する。CI 側で失敗を検知できるよう 502 を返す
    // （台帳には残し、管理画面で削除待ちを確認できるようにする）
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

// パスは正しいがメソッドが違う
apiApp.all("/api/envs/:envId/:action", (c) => c.json({ error: "Method Not Allowed" }, 405));
apiApp.notFound((c) => c.json({ error: "Not Found" }, 404));
// 想定外の例外は内容を返さずログに残す（CI には JSON で 500 を返す）
apiApp.onError((err, c) => {
  // csrf() の 403 など、Hono が意図して投げた HTTP エラーはそのまま返す
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[api] ${c.req.method} ${c.req.path} failed:`, err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// ---------------------------------------------------------------------------
// 2. プレビュー環境へのユーザーアクセス (例: https://pr-123.preview.example.com/*)
// ---------------------------------------------------------------------------
async function handlePreview(c: Context<AppEnv>): Promise<Response> {
  const previewBaseDomain = (c.env.PREVIEW_BASE_DOMAIN || DEFAULT_PREVIEW_BASE_DOMAIN).toLowerCase();
  const envId = extractPreviewEnvId(new URL(c.req.url).hostname, previewBaseDomain);
  if (!envId) {
    return new Response("Invalid preview host", { status: 400 });
  }

  // 任意: Cloudflare Access JWT 検証（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD 設定時）
  const accessCheck = await verifyPreviewAccess(c.req.raw, c.env);
  if (!accessCheck.ok) {
    return new Response(accessCheck.message, { status: accessCheck.status });
  }

  // DO に HTTP / WebSocket リクエストをそのまま転送
  return previewStub(c.env, envId).fetch(c.req.raw);
}

// ---------------------------------------------------------------------------
// ホスト名で振り分ける（API_HOSTNAME は環境変数で決まるため、ルート定義ではなく実行時に判定する）
// ---------------------------------------------------------------------------
const app = new Hono<AppEnv>();

app.all("*", (c) => {
  const apiHostname = (c.env.API_HOSTNAME || DEFAULT_API_HOSTNAME).toLowerCase();
  if (new URL(c.req.url).hostname.toLowerCase() === apiHostname) {
    let executionCtx: Parameters<typeof apiApp.fetch>[2];
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined; // テストなど ExecutionContext が無い場合
    }
    return apiApp.fetch(c.req.raw, c.env, executionCtx);
  }
  return handlePreview(c);
});

export default app;
