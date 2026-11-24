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
  /** Undefined when getStatus failed; kept in the list as unavailable. */
  status?: PreviewStatusResponse;
}

/**
 * Fetch live status for every registered environment.
 * - Individual getStatus failures do not break the whole list.
 * - Environments with neither registration nor pending cleanup are pruned from the registry,
 *   guarded by revision so a concurrent re-registration is never removed.
 */
async function loadEnvs(env: Env): Promise<EnvRow[]> {
  const registry = registryStub(env);
  const entries = await registry.list();
  const results = await Promise.allSettled(
    entries.map(async (entry): Promise<EnvRow | null> => {
      const status = await env.PREVIEW_DO.get(env.PREVIEW_DO.idFromName(entry.envId)).getStatus();
      if (!status.registered && !status.cleanupPending) {
        const removed = await registry.remove(entry.envId, entry.revision ?? 0);
        return removed ? null : { entry };
      }
      return { entry, status };
    })
  );
  return results.flatMap((result, i): EnvRow[] => {
    if (result.status === "fulfilled") return result.value ? [result.value] : [];
    console.error(`[admin] getStatus ${entries[i].envId} failed:`, result.reason);
    return [{ entry: entries[i] }];
  });
}

export function previewUrl(
  requestUrl: string,
  envId: string,
  env: Pick<Env, "PREVIEW_BASE_DOMAIN">
): string {
  const url = new URL(requestUrl);
  const base = env.PREVIEW_BASE_DOMAIN || "preview.example.com";
  // Production previews are always https; local wrangler dev (*.localhost) uses http in the browser
  // even though upstream_protocol: https makes the Worker see https.
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  return `${local ? "http" : "https"}://${envId}.${base}${local && url.port ? `:${url.port}` : ""}/`;
}

const EMPTY = html`<span class="empty-value">-</span>`;

function formatTime(value?: string | number): Markup | string {
  if (value === undefined) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? EMPTY
    : `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function codeOrEmpty(value?: string): Markup {
  return value ? html`<code>${value}</code>` : EMPTY;
}

function shortImage(identifier?: string): Markup {
  if (!identifier) return EMPTY;
  return html`<code title="${identifier}">${identifier.split(":").pop() ?? identifier}</code>`;
}

function stateBadge(status: PreviewStatusResponse | undefined): Markup {
  if (!status) return html`<span class="badge">Unavailable</span>`;
  if (!status.registered) return html`<span class="badge warn">Destroying</span>`;
  if (status.booting) return html`<span class="badge info">Booting</span>`;
  if (status.microvmId) return html`<span class="badge ok">Running</span>`;
  return html`<span class="badge">Idle</span>`;
}

function layout(title: string, body: Markup, notice?: string): Markup {
  return html`<!doctype html>
<html lang="en">
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
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
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
    <header><div class="inner"><a href="/admin">hatch</a><span>Preview Environment Manager</span></div></header>
    <main>
      ${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
      ${body}
    </main>
  </body>
</html>`;
}

function listPage(rows: EnvRow[], requestUrl: string, env: Env, notice?: string): Markup {
  const body = html`<h1>Environments (${rows.length})</h1>
    <div class="table-wrap">
      ${rows.length === 0
        ? html`<p class="empty">No registered environments.</p>`
        : html`<table>
            <thead>
              <tr><th>Environment</th><th>Status</th><th class="wide-only">Image</th><th>MicroVM Expires</th><th class="wide-only">Last Registered</th><th>Pending Cleanup</th><th></th></tr>
            </thead>
            <tbody>
              ${rows.map(({ entry, status }) => {
                const pending = status?.cleanupPending;
                const pendingCount = pending ? pending.microvmIds.length + pending.imageIdentifiers.length : 0;
                return html`<tr>
                  <td><a href="/admin/envs/${entry.envId}">${entry.envId}</a></td>
                  <td>${stateBadge(status)}</td>
                  <td class="wide-only">${shortImage(status?.imageIdentifier ?? entry.imageIdentifier)}</td>
                  <td>${formatTime(status?.expiresAt)}</td>
                  <td class="wide-only">${formatTime(entry.updatedAt)}</td>
                  <td>${pendingCount > 0 ? html`<span class="badge warn">${pendingCount}</span>` : EMPTY}</td>
                  <td>${status?.registered ? html`<a href="${previewUrl(requestUrl, entry.envId, env)}" target="_blank" rel="noopener">Open</a>` : ""}</td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>`;
  return layout("hatch Admin", body, notice);
}

function detailPage(
  envId: string,
  status: PreviewStatusResponse,
  entry: RegistryEntry | undefined,
  requestUrl: string,
  env: Env
): Markup {
  const pending = status.cleanupPending;
  const image = status.imageIdentifier ?? entry?.imageIdentifier;
  const body = html`<h1>${envId}</h1>
    <dl>
      <dt>Status</dt><dd>${stateBadge(status)}</dd>
      <dt>Preview</dt><dd>${status.registered
        ? html`<a href="${previewUrl(requestUrl, envId, env)}" target="_blank" rel="noopener">${previewUrl(requestUrl, envId, env)}</a>`
        : EMPTY}</dd>
      <dt>Image</dt><dd>${codeOrEmpty(image)}${!status.registered && image ? html` <span class="muted">(last registered before destroy)</span>` : ""}</dd>
      <dt>Image Version</dt><dd>${status.registered ? (status.imageVersion ?? "latest") : EMPTY}</dd>
      <dt>MicroVM</dt><dd>${codeOrEmpty(status.microvmId)}</dd>
      <dt>MicroVM Started</dt><dd>${formatTime(status.createdAt)}</dd>
      <dt>MicroVM Expires</dt><dd>${formatTime(status.expiresAt)}</dd>
      <dt>Next Alarm</dt><dd>${formatTime(status.alarmAt)}</dd>
      <dt>Pending Cleanup</dt><dd>${pending
        ? html`MicroVM: ${codeOrEmpty(pending.microvmIds.join(", "))}<br />Image: ${codeOrEmpty(pending.imageIdentifiers.join(", "))}
            <div class="muted">Failed deletions are retried automatically on the next Alarm.</div>`
        : EMPTY}</dd>
    </dl>
    <div class="actions">
      <form method="post" action="/admin/envs/${envId}/destroy"
        onsubmit="return confirm('Destroy ${raw(envId)}? This will terminate the MicroVM and delete its image.')">
        <button type="submit" class="danger">${status.registered ? "Destroy" : "Retry Destroy"}</button>
      </form>
      <a href="/admin">Back to list</a>
    </div>`;
  return layout(`${envId} - hatch Admin`, body);
}

/** Admin UI mounted under /admin on API_HOSTNAME. */
export const adminApp = new Hono<AppEnv>();

adminApp.use("*", async (c, next) => {
  const access = await verifyAdminAccess(c.req.raw, c.env);
  if (!access.ok) return c.text(access.message, access.status as 401 | 403 | 500 | 503);
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  await next();
});
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
    return c.redirect(`/admin?notice=${encodeURIComponent(`${envId} is not registered`)}`, 303);
  }
  const entry = await registryStub(c.env).get(envId);
  return c.html(detailPage(envId, status, entry, c.req.url, c.env));
});

adminApp.post("/envs/:envId/destroy", async (c) => {
  const envId = c.req.param("envId");
  if (!ENV_ID_REGEX.test(envId)) return c.notFound();
  const back = (notice: string) => c.redirect(`/admin?notice=${encodeURIComponent(notice)}`, 303);

  try {
    await c.env.PREVIEW_DO.get(c.env.PREVIEW_DO.idFromName(envId)).destroy();
  } catch (err) {
    // Only CleanupIncompleteError guarantees failed resources were persisted for Alarm retry.
    const message = (err as Error)?.message ?? "";
    console.error(`[admin] destroy ${envId} failed:`, err);
    return back(
      message.startsWith("Cleanup incomplete")
        ? `${envId} destroy is partially incomplete; remaining resources will be retried automatically`
        : `Failed to destroy ${envId}. Automatic retry is not scheduled; please try again`
    );
  }

  try {
    await registryStub(c.env).remove(envId);
  } catch (err) {
    // Environment is already destroyed; stale registry entry will be pruned on next list view.
    console.error(`[admin] registry remove ${envId} failed:`, err);
  }
  return back(`Destroyed ${envId}`);
});
