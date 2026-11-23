import type { Env } from "./types";

/**
 * Constant-time string comparison to prevent timing attacks.
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
 * Verify the X-CI-Secret header from CI webhooks.
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

// Minimum interval between forced JWKS refreshes on unknown kids to prevent cache-busting floods.
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
 * Look up a JWK by kid, forcing a rate-limited JWKS refresh once if not found (handles key rotation).
 */
async function findAccessJwk(teamDomain: string, kid: string | undefined): Promise<JwkKey | undefined> {
  if (!kid) return undefined;
  const cached = await fetchAccessJwks(teamDomain);
  const hit = cached.find((k) => k.kid === kid);
  if (hit) return hit;

  if (!forcedJwksRefresh) {
    const now = Date.now();
    if (now - lastForcedJwksRefreshAt < JWKS_FORCE_REFRESH_MIN_INTERVAL_MS) {
      return undefined;
    }
    const previousRefreshAt = lastForcedJwksRefreshAt;
    lastForcedJwksRefreshAt = now;
    const refresh: Promise<JwkKey[]> = fetchAccessJwks(teamDomain, true)
      .catch((err: unknown) => {
        if (lastForcedJwksRefreshAt === now) lastForcedJwksRefreshAt = previousRefreshAt;
        throw err;
      })
      .finally(() => {
        if (forcedJwksRefresh === refresh) forcedJwksRefresh = null;
      });
    forcedJwksRefresh = refresh;
  }
  const refreshed = await forcedJwksRefresh;
  return refreshed.find((k) => k.kid === kid);
}

/**
 * Verify Cloudflare Access JWT (CF-Access-Jwt-Assertion) when both CF_ACCESS_TEAM_DOMAIN
 * and CF_ACCESS_AUD are set. Passes through if neither is set; fails closed (500) if only one is set.
 */
export async function verifyPreviewAccess(
  request: Request,
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD) {
    return { ok: true };
  }
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
    // aud can be a string or string[] per JWT spec; normalize to array for exact matching.
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

/**
 * Verify access to Admin UI (/admin on API_HOSTNAME).
 * Fails closed (503) when unconfigured, except on localhost / *.localhost for local dev.
 */
export async function verifyAdminAccess(
  request: Request,
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_ADMIN_AUD">
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_ADMIN_AUD) {
    return verifyPreviewAccess(request, {
      CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
      CF_ACCESS_AUD: env.CF_ACCESS_ADMIN_AUD,
    });
  }
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 503,
    message: "Admin UI is disabled. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_ADMIN_AUD to enable it.",
  };
}
