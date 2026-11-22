function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 利用者に見せる 2 つの画面（起動中・起動失敗）の共通の枠。
 * - OS のライト / ダークに追従する
 * - 狭い画面でもカードの左右に余白を残す（padding を幅に含め、body にも余白を取る）
 * - 日本語は文節で改行し、行の長さをそろえて末尾の 1〜2 文字だけが次の行に残らないようにする
 */
function renderStatusPage(options: {
  title: string;
  envLabel: string;
  retryAfterSeconds: number;
  variant: "starting" | "failed";
  heading: string;
  lines: string[];
}): string {
  const safeLabel = escapeHtml(options.envLabel);
  const spinner =
    options.variant === "starting" ? `<div class="spinner" aria-hidden="true"></div>\n    ` : "";
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="${options.retryAfterSeconds}" />
  <title>${escapeHtml(options.title)} (${safeLabel})</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f1f5f9; --fg: #0f172a; --muted: #475569;
      --card: #ffffff; --line: #e2e8f0; --shadow: rgba(15, 23, 42, 0.08);
      --accent: #0284c7; --track: #e2e8f0; --label-bg: #f1f5f9; --label-fg: #0369a1;
      --failed-line: #fca5a5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a; --fg: #f8fafc; --muted: #cbd5e1;
        --card: rgba(30, 41, 59, 0.85); --line: rgba(148, 163, 184, 0.25); --shadow: rgba(0, 0, 0, 0.35);
        --accent: #38bdf8; --track: rgba(148, 163, 184, 0.3); --label-bg: rgba(15, 23, 42, 0.8); --label-fg: #7dd3fc;
        --failed-line: rgba(248, 113, 113, 0.45);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 24px 16px;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    .card {
      width: 100%;
      max-width: 420px;
      padding: 2rem 1.5rem;
      border-radius: 12px;
      background: var(--card);
      border: 1px solid var(--line);
      text-align: center;
      box-shadow: 0 20px 40px var(--shadow);
    }
    .card.failed { border-color: var(--failed-line); }
    .spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto 1rem;
      border: 3px solid var(--track);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.5s; } }
    h1, p { word-break: auto-phrase; text-wrap: balance; }
    h1 { font-size: 1.125rem; margin: 0 0 0.5rem; line-height: 1.5; }
    p { font-size: 0.9rem; color: var(--muted); margin: 0; line-height: 1.6; }
    code {
      display: inline-block;
      max-width: 100%;
      margin-top: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      background: var(--label-bg);
      color: var(--label-fg);
      font-size: 0.8rem;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main class="card ${options.variant}">
    ${spinner}<h1>${options.heading}</h1>
    ${options.lines.map((line) => `<p>${line}</p>`).join("\n    ")}
    <code>${safeLabel}</code>
  </main>
</body>
</html>`;
}

/**
 * コールドスタート中（run-microvm 実行中）にブラウザリクエストへ即返す軽量ローディング画面。
 * 3 秒ごとに自動リロードし、起動完了次第シームレスにアプリ画面へ遷移する。
 */
export function renderColdStartResponse(envLabel: string, retryAfterSeconds = 3): Response {
  const html = renderStatusPage({
    title: "Starting preview environment",
    envLabel,
    retryAfterSeconds,
    variant: "starting",
    heading: "プレビュー環境を起動しています…",
    lines: ["スナップショットから MicroVM を復元中です。", `${retryAfterSeconds} 秒後に自動で再読み込みします。`],
  });

  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * MicroVM の起動に失敗したときにブラウザへ返す画面。AWS のエラー内容は含めない。
 * 「起動中」画面を出し続けて利用者を待たせないよう、失敗であることを明示する。
 */
export function renderBootFailedResponse(envLabel: string, retryAfterSeconds: number): Response {
  const html = renderStatusPage({
    title: "Preview environment failed to start",
    envLabel,
    retryAfterSeconds,
    variant: "failed",
    heading: "プレビュー環境の起動に失敗しました",
    lines: [`${retryAfterSeconds} 秒後に自動で再試行します。`, "繰り返し失敗する場合は、管理者に連絡してください。"],
  });

  return new Response(html, {
    status: 502,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

export function acceptsHtmlBrowserRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const upgrade = request.headers.get("Upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return false;
  }
  // fetch / XHR（Turbo・htmx 等）は Accept に text/html を含んでもページ遷移ではないため除外する。
  // Sec-Fetch-Mode を送らない古いクライアントは従来どおり Accept だけで判定する
  const fetchMode = request.headers.get("Sec-Fetch-Mode");
  if (fetchMode && fetchMode !== "navigate") {
    return false;
  }
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/html");
}
