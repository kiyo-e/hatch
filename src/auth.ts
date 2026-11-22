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

async function fetchAccessJwks(teamDomain: string): Promise<JwkKey[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.domain === teamDomain && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
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
 * Cloudflare Access JWT (CF-Access-Jwt-Assertion) の検証。
 * CF_ACCESS_TEAM_DOMAIN と CF_ACCESS_AUD が両方設定されている場合のみ強制する。
 * 未設定の場合はパススルー（別途 Cloudflare Access / GitHub OAuth 等で保護する前提）。
 */
export async function verifyPreviewAccess(
  request: Request,
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return { ok: true };
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
      aud?: string[];
      exp?: number;
      iss?: string;
    };

    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= nowSec) {
      return { ok: false, status: 401, message: "Access token expired" };
    }
    if (!payload.aud || !payload.aud.includes(env.CF_ACCESS_AUD)) {
      return { ok: false, status: 403, message: "Invalid Access audience" };
    }

    const keys = await fetchAccessJwks(env.CF_ACCESS_TEAM_DOMAIN);
    const jwk = keys.find((k) => k.kid === header.kid);
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
