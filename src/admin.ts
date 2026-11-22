import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { verifyAdminAccess } from "./auth";
import type { Env, PreviewStatusResponse, RegistryEntry } from "./types";

type AppEnv = { Bindings: Env };
type Markup = HtmlEscapedString | Promise<HtmlEscapedString>;

export const ENV_ID_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function registryStub(env: Env) {
  return env.ENV_REGISTRY.get(env.ENV_REGISTRY.idFromName("global"));
}

interface EnvRow {
  entry: RegistryEntry;
  status: PreviewStatusResponse;
}

/**
 * 台帳の環境ごとに実際の状態を取得する。登録も削除待ちも無い環境（Alarm で自動破棄された等）は台帳から外す。
 */
async function loadEnvs(env: Env): Promise<EnvRow[]> {
  const registry = registryStub(env);
  const entries = await registry.list();
  const rows = await Promise.all(
    entries.map(async (entry): Promise<EnvRow | null> => {
      const status = await env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(entry.envId)).getStatus();
      if (!status.registered && !status.cleanupPending) {
        await registry.remove(entry.envId);
        return null;
      }
      return { entry, status };
    })
  );
  return rows.filter((row): row is EnvRow => row !== null);
}

function previewUrl(requestUrl: string, envId: string, env: Env): string {
  const url = new URL(requestUrl);
  const base = env.PREVIEW_BASE_DOMAIN || "preview.example.com";
  return `${url.protocol}//${envId}.${base}${url.port ? `:${url.port}` : ""}/`;
}

/** 値が無いときの表示（どの欄でも同じ見た目にする） */
const EMPTY = html`<span class="empty-value">-</span>`;

function formatTime(value?: string | number): Markup | string {
  if (value === undefined) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? EMPTY
    : date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
}

function codeOrEmpty(value?: string): Markup {
  return value ? html`<code>${value}</code>` : EMPTY;
}

/** ARN の末尾（イメージ名）だけを表示する */
function shortImage(identifier?: string): Markup {
  if (!identifier) return EMPTY;
  return html`<code title="${identifier}">${identifier.split(":").pop() ?? identifier}</code>`;
}

function stateBadge(status: PreviewStatusResponse): Markup {
  if (!status.registered) return html`<span class="badge warn">破棄中</span>`;
  if (status.booting) return html`<span class="badge info">起動中</span>`;
  if (status.microvmId) return html`<span class="badge ok">稼働中</span>`;
  return html`<span class="badge">待機</span>`;
}

function layout(title: string, body: Markup, notice?: string): Markup {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; --card: #ffffff; --line: #e2e8f0;
        --accent: #2563eb; --ok: #15803d; --info: #1d4ed8; --warn: #b45309; --danger: #b91c1c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8; --card: #1e293b; --line: #334155;
          --accent: #60a5fa; --ok: #4ade80; --info: #93c5fd; --warn: #fbbf24; --danger: #f87171;
        }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif; }
      header { border-bottom: 1px solid var(--line); background: var(--card); }
      header .inner { max-width: 1100px; margin: 0 auto; padding: 14px 16px; display: flex; gap: 12px; align-items: baseline; }
      header a { color: inherit; text-decoration: none; font-weight: 700; }
      header span { color: var(--muted); font-size: 0.85rem; }
      main { max-width: 1100px; margin: 0 auto; padding: 16px; }
      h1 { font-size: 1.25rem; margin: 0 0 16px; }
      .notice { padding: 10px 14px; border-radius: 8px; background: var(--card); border: 1px solid var(--line); margin-bottom: 16px; }
      .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
      table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
      th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
      th { color: var(--muted); font-weight: 600; font-size: 0.8rem; }
      tr:last-child td { border-bottom: none; }
      a { color: var(--accent); }
      code { font-size: 0.85em; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.8rem; border: 1px solid currentColor; color: var(--muted); }
      .badge.ok { color: var(--ok); } .badge.info { color: var(--info); } .badge.warn { color: var(--warn); }
      .empty { padding: 24px; color: var(--muted); text-align: center; }
      .empty-value { color: var(--muted); }
      .muted { color: var(--muted); font-size: 0.85rem; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; background: var(--card);
        border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 16px; }
      dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
      button.danger { background: var(--danger); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 0.9rem; cursor: pointer; }
      .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      /* 狭い画面: 一覧は補助的な列を隠し、詳細はラベルと値を縦に並べる（上の指定より後ろに置く） */
      @media (max-width: 640px) {
        .wide-only { display: none; }
        th, td { padding: 10px 8px; }
        dl { grid-template-columns: 1fr; gap: 2px 0; }
        dd { margin-bottom: 10px; }
        dd code { overflow-wrap: anywhere; }
      }
    </style>
  </head>
  <body>
    <header><div class="inner"><a href="/admin">hatch</a><span>プレビュー環境の管理</span></div></header>
    <main>
      ${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
      ${body}
    </main>
  </body>
</html>`;
}

function listPage(rows: EnvRow[], requestUrl: string, env: Env, notice?: string): Markup {
  const body = html`<h1>環境の一覧（${rows.length}）</h1>
    <div class="table-wrap">
      ${rows.length === 0
        ? html`<p class="empty">登録された環境はありません。</p>`
        : html`<table>
            <thead>
              <tr><th>環境</th><th>状態</th><th class="wide-only">イメージ</th><th>MicroVM の期限</th><th class="wide-only">最終登録</th><th>削除待ち</th><th></th></tr>
            </thead>
            <tbody>
              ${rows.map(({ entry, status }) => {
                const pending = status.cleanupPending;
                const pendingCount = pending ? pending.microvmIds.length + pending.imageIdentifiers.length : 0;
                return html`<tr>
                  <td><a href="/admin/envs/${entry.envId}">${entry.envId}</a></td>
                  <td>${stateBadge(status)}</td>
                  <td class="wide-only">${shortImage(status.imageIdentifier ?? entry.imageIdentifier)}</td>
                  <td>${formatTime(status.expiresAt)}</td>
                  <td class="wide-only">${formatTime(entry.updatedAt)}</td>
                  <td>${pendingCount > 0 ? html`<span class="badge warn">${pendingCount} 件</span>` : EMPTY}</td>
                  <td>${status.registered ? html`<a href="${previewUrl(requestUrl, entry.envId, env)}" target="_blank" rel="noopener">開く</a>` : ""}</td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>`;
  return layout("hatch 管理", body, notice);
}

function detailPage(
  envId: string,
  status: PreviewStatusResponse,
  entry: RegistryEntry | undefined,
  requestUrl: string,
  env: Env
): Markup {
  const pending = status.cleanupPending;
  // 破棄の途中は登録が消えているので、台帳に残っている最後のイメージを表示する
  const image = status.imageIdentifier ?? entry?.imageIdentifier;
  const body = html`<h1>${envId}</h1>
    <dl>
      <dt>状態</dt><dd>${stateBadge(status)}</dd>
      <dt>プレビュー</dt><dd>${status.registered
        ? html`<a href="${previewUrl(requestUrl, envId, env)}" target="_blank" rel="noopener">${previewUrl(requestUrl, envId, env)}</a>`
        : EMPTY}</dd>
      <dt>イメージ</dt><dd>${codeOrEmpty(image)}${!status.registered && image ? html` <span class="muted">（破棄前に登録されていたイメージ）</span>` : ""}</dd>
      <dt>イメージのバージョン</dt><dd>${status.registered ? (status.imageVersion ?? "最新") : EMPTY}</dd>
      <dt>MicroVM</dt><dd>${codeOrEmpty(status.microvmId)}</dd>
      <dt>MicroVM の起動</dt><dd>${formatTime(status.createdAt)}</dd>
      <dt>MicroVM の期限</dt><dd>${formatTime(status.expiresAt)}</dd>
      <dt>次の Alarm</dt><dd>${formatTime(status.alarmAt)}</dd>
      <dt>削除待ち</dt><dd>${pending
        ? html`MicroVM: ${codeOrEmpty(pending.microvmIds.join(", "))}<br />イメージ: ${codeOrEmpty(pending.imageIdentifiers.join(", "))}
            <div class="muted">削除できなかったリソースは、次の Alarm で自動的に再試行します</div>`
        : EMPTY}</dd>
    </dl>
    <div class="actions">
      <form method="post" action="/admin/envs/${envId}/destroy"
        onsubmit="return confirm('${raw(envId)} を破棄します。MicroVM を終了し、イメージを削除します。よろしいですか？')">
        <button type="submit" class="danger">${status.registered ? "破棄する" : "破棄を再試行する"}</button>
      </form>
      <a href="/admin">一覧に戻る</a>
    </div>`;
  return layout(`${envId} - hatch 管理`, body);
}

/** 管理画面（API_HOSTNAME の /admin 以下にマウントする） */
export const adminApp = new Hono<AppEnv>();

adminApp.use("*", async (c, next) => {
  const access = await verifyAdminAccess(c.req.raw, c.env);
  if (!access.ok) return c.text(access.message, access.status as 401 | 403 | 500 | 503);
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  await next();
});
// 破棄フォームの POST は同じオリジンからのものだけ受け付ける
adminApp.use("*", csrf());

adminApp.get("/", async (c) => {
  const notice = c.req.query("notice");
  return c.html(listPage(await loadEnvs(c.env), c.req.url, c.env, notice));
});

adminApp.get("/envs/:envId", async (c) => {
  const envId = c.req.param("envId");
  if (!ENV_ID_REGEX.test(envId)) return c.notFound();
  const status = await c.env.PREVIEW_DO.get(c.env.PREVIEW_DO.idFromName(envId)).getStatus();
  if (!status.registered && !status.cleanupPending) {
    return c.redirect(`/admin?notice=${encodeURIComponent(`${envId} は登録されていません`)}`, 303);
  }
  const entry = await registryStub(c.env).get(envId);
  return c.html(detailPage(envId, status, entry, c.req.url, c.env));
});

adminApp.post("/envs/:envId/destroy", async (c) => {
  const envId = c.req.param("envId");
  if (!ENV_ID_REGEX.test(envId)) return c.notFound();
  let notice: string;
  try {
    await c.env.PREVIEW_DO.get(c.env.PREVIEW_DO.idFromName(envId)).destroy();
    await registryStub(c.env).remove(envId);
    notice = `${envId} を破棄しました`;
  } catch (err) {
    console.error(`[admin] destroy ${envId} incomplete:`, err);
    notice = `${envId} の破棄は一部が未完了です。残りは自動で再試行されます`;
  }
  return c.redirect(`/admin?notice=${encodeURIComponent(notice)}`, 303);
});
