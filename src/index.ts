import { verifyCiSecret, verifyPreviewAccess } from "./auth";
import { PreviewEnvironmentDO } from "./preview-do";
import type { Env, RegisterImagePayload } from "./types";

export { PreviewEnvironmentDO };
export type { Env };

const DEFAULT_API_HOSTNAME = "api.preview.example.com";
const DEFAULT_PREVIEW_BASE_DOMAIN = "preview.example.com";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// DNS ラベルとして有効な envId（管理 API とプレビューのサブドメインで同じ規則を使う）
const ENV_ID_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const API_PATH_PATTERN = new RegExp(`^/api/envs/(${ENV_ID_PATTERN})/(register|destroy|status)$`);

export function extractPreviewEnvId(hostname: string, baseDomain: string): string | null {
  const pattern = new RegExp(`^(${ENV_ID_PATTERN})\\.${escapeRegExp(baseDomain)}$`);
  const match = hostname.toLowerCase().match(pattern);
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const apiHostname = (env.API_HOSTNAME || DEFAULT_API_HOSTNAME).toLowerCase();
    const previewBaseDomain = (env.PREVIEW_BASE_DOMAIN || DEFAULT_PREVIEW_BASE_DOMAIN).toLowerCase();

    // 1. 管理 API / CI からのビルド完了・PR クローズ Webhook
    if (url.hostname.toLowerCase() === apiHostname) {
      if (!verifyCiSecret(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const match = url.pathname.match(API_PATH_PATTERN);
      if (!match) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }

      const [, envId, action] = match;
      const stub = env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(envId));

      if (action === "register" && request.method === "POST") {
        let payload: RegisterImagePayload;
        try {
          payload = await request.json<RegisterImagePayload>();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return Response.json({ error: "JSON body must be an object" }, { status: 400 });
        }

        const imageIdentifier = payload.imageIdentifier ?? payload.imageId;
        if (!imageIdentifier || typeof imageIdentifier !== "string" || imageIdentifier.length > 256) {
          return Response.json(
            { error: "imageIdentifier (or imageId) is required" },
            { status: 400 }
          );
        }

        await stub.registerImage(imageIdentifier, payload.imageVersion);
        return Response.json({ ok: true, envId, imageIdentifier });
      }

      if (action === "destroy" && request.method === "DELETE") {
        try {
          await stub.destroy();
        } catch (err) {
          // 削除に失敗したリソースは DO が Alarm で再試行する。CI 側で失敗を検知できるよう 502 を返す
          return Response.json(
            { ok: false, envId, error: (err as Error).message },
            { status: 502 }
          );
        }
        return Response.json({ ok: true, envId });
      }

      if (action === "status" && request.method === "GET") {
        const status = await stub.getStatus();
        return Response.json({ envId, ...status });
      }

      return Response.json({ error: "Method Not Allowed" }, { status: 405 });
    }

    // 2. プレビュー環境へのユーザーアクセス (例: https://pr-123.preview.example.com/*)
    const envId = extractPreviewEnvId(url.hostname, previewBaseDomain);
    if (!envId) {
      return new Response("Invalid preview host", { status: 400 });
    }

    // 任意: Cloudflare Access JWT 検証（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD 設定時）
    const accessCheck = await verifyPreviewAccess(request, env);
    if (!accessCheck.ok) {
      return new Response(accessCheck.message, { status: accessCheck.status });
    }

    const stub = env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(envId));

    // DO に HTTP / WebSocket リクエストをそのまま転送
    return stub.fetch(request);
  },
};
