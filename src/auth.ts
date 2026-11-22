import type { Env } from "./types";

/**
 * タイミング攻撃を防ぐための定数時間文字列比較。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  const maxLen = Math.max(bufA.length, bufB.length);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

/**
 * CI Webhook からの X-CI-Secret ヘッダーを検証する。
 */
export function verifyCiSecret(request: Request, env: Pick<Env, "CI_WEBHOOK_SECRET">): boolean {
  const provided = request.headers.get("X-CI-Secret");
  if (!provided || !env.CI_WEBHOOK_SECRET) {
    return false;
  }
  return timingSafeEqual(provided, env.CI_WEBHOOK_SECRET);
}

interface JwkKey {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

let jwksCache: { domain: string; keys: JwkKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// 未知の kid による JWKS 強制再取得の最短間隔（ランダムな kid で JWKS 取得を連打させないため）
const JWKS_FORCE_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
let lastForcedJwksRefreshAt = 0;
let forcedJwksRefresh: Promise<JwkKey[]> | null = null;

async function fetchAccessJwks(teamDomain: string, forceRefresh = false): Promise<JwkKey[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    jwksCache &&
    jwksCache.domain === teamDomain &&
    now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS
  ) {
    return jwksCache.keys;
  }

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Cloudflare Access JWKS (${res.status})`);
  }
  const data = await res.json<{ keys: JwkKey[] }>();
  jwksCache = { domain: teamDomain, keys: data.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

/**
 * kid に一致する鍵を探す。見つからなければ鍵ローテーションの可能性があるため、
 * 一定間隔に 1 回まで JWKS を再取得して探し直す。
 */
async function findAccessJwk(teamDomain: string, kid: string | undefined): Promise<JwkKey | undefined> {
  if (!kid) return undefined;
  const cached = await fetchAccessJwks(teamDomain);
  const hit = cached.find((k) => k.kid === kid);
  if (hit) return hit;

  // 同時に届いたリクエストは実行中の再取得に相乗りする（間隔制限は新たな再取得にのみ適用）
  if (!forcedJwksRefresh) {
    const now = Date.now();
    if (now - lastForcedJwksRefreshAt < JWKS_FORCE_REFRESH_MIN_INTERVAL_MS) {
      return undefined;
    }
    lastForcedJwksRefreshAt = now;
    const refresh: Promise<JwkKey[]> = fetchAccessJwks(teamDomain, true).finally(() => {
      if (forcedJwksRefresh === refresh) forcedJwksRefresh = null;
    });
    forcedJwksRefresh = refresh;
  }
  const refreshed = await forcedJwksRefresh;
  return refreshed.find((k) => k.kid === kid);
}

/**
 * Cloudflare Access JWT (CF-Access-Jwt-Assertion) の検証。
 * CF_ACCESS_TEAM_DOMAIN と CF_ACCESS_AUD が両方設定されている場合に強制する。
 * 両方未設定の場合はパススルー（別途 Cloudflare Access / GitHub OAuth 等で保護する前提）。
 * 片方だけ設定されている場合は設定ミスとして 500 を返す。
 */
export async function verifyPreviewAccess(
  request: Request,
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD) {
    return { ok: true };
  }
  // 片方だけ設定されている場合は設定ミスとみなし、認証なしで素通しさせない（fail closed）
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    console.error("[auth] Both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set to enable Cloudflare Access verification");
    return { ok: false, status: 500, message: "Cloudflare Access verification is misconfigured" };
  }

  const token =
    request.headers.get("CF-Access-Jwt-Assertion") ??
    extractCookie(request.headers.get("Cookie"), "CF_Authorization");

  if (!token) {
    return { ok: false, status: 401, message: "Missing Cloudflare Access token" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, message: "Malformed JWT" };
  }

  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as {
      kid?: string;
      alg?: string;
    };
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as {
      aud?: string[] | string;
      exp?: number;
      nbf?: number;
      iss?: string;
    };

    if (header.alg !== "RS256") {
      return { ok: false, status: 401, message: "Unsupported JWT algorithm" };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= nowSec) {
      return { ok: false, status: 401, message: "Access token expired" };
    }
    if (payload.nbf && payload.nbf > nowSec + 60) {
      return { ok: false, status: 401, message: "Access token not yet valid" };
    }
    // aud は配列または文字列（JWT 仕様）。文字列の部分一致にならないよう配列に揃えて完全一致で比較する
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!audiences.includes(env.CF_ACCESS_AUD)) {
      return { ok: false, status: 403, message: "Invalid Access audience" };
    }
    if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) {
      return { ok: false, status: 401, message: "Invalid Access issuer" };
    }

    const jwk = await findAccessJwk(env.CF_ACCESS_TEAM_DOMAIN, header.kid);
    if (!jwk) {
      return { ok: false, status: 401, message: "Unknown signing key" };
    }

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlDecode(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signingInput);

    if (!valid) {
      return { ok: false, status: 401, message: "Invalid JWT signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, message: "Failed to verify Access token" };
  }
}

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
