function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * コールドスタート中（run-microvm 実行中）にブラウザリクエストへ即返す軽量ローディング画面。
 * 3 秒ごとに自動リロードし、起動完了次第シームレスにアプリ画面へ遷移する。
 */
export function renderColdStartResponse(envLabel: string, retryAfterSeconds = 3): Response {
  const safeLabel = escapeHtml(envLabel);
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="${retryAfterSeconds}" />
  <title>Starting preview environment (${safeLabel})</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
    }
    .card {
      max-width: 420px;
      padding: 2rem;
      border-radius: 12px;
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.25);
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.35);
    }
    .spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto 1rem;
      border: 3px solid rgba(148, 163, 184, 0.3);
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
    p { font-size: 0.9rem; color: #cbd5e1; margin: 0; line-height: 1.5; }
    code {
      display: inline-block;
      margin-top: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.8);
      color: #7dd3fc;
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h1>プレビュー環境を起動しています…</h1>
    <p>スナップショットから MicroVM を復元中です。<br />${retryAfterSeconds} 秒後に自動で再読み込みします。</p>
    <code>${safeLabel}</code>
  </main>
</body>
</html>`;

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
  const safeLabel = escapeHtml(envLabel);
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="${retryAfterSeconds}" />
  <title>Preview environment failed to start (${safeLabel})</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
    }
    .card {
      max-width: 420px;
      padding: 2rem;
      border-radius: 12px;
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(248, 113, 113, 0.4);
      text-align: center;
    }
    h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
    p { font-size: 0.9rem; color: #cbd5e1; margin: 0; line-height: 1.5; }
    code { display: inline-block; margin-top: 0.75rem; color: #7dd3fc; font-size: 0.8rem; }
  </style>
</head>
<body>
  <main class="card">
    <h1>プレビュー環境の起動に失敗しました</h1>
    <p>${retryAfterSeconds} 秒後に自動で再試行します。<br />繰り返し失敗する場合は管理者に連絡してください。</p>
    <code>${safeLabel}</code>
  </main>
</body>
</html>`;

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
