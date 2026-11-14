import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let cached = jwksCache.get(teamDomain);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, cached);
  }
  return cached;
}

function isLocalhostBypass(request: Request, env: Env): boolean {
  if (env.LOCAL_DEV_BYPASS !== "true") {
    return false;
  }
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** Verify an incoming request holds a valid Cloudflare Access user JWT. */
export async function verifyUserAccess(
  request: Request,
  env: Env,
): Promise<{ ok: true; email: string } | { ok: false; status: number; reason: string }> {
  if (isLocalhostBypass(request, env)) {
    return { ok: true, email: "local-dev@localhost" };
  }

  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return { ok: false, status: 401, reason: "Missing Cloudflare Access assertion" };
  }

  try {
    const jwks = getJwks(env.CF_ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: env.CF_ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : String(payload.sub ?? "authenticated");
    return { ok: true, email };
  } catch {
    return { ok: false, status: 403, reason: "Invalid Cloudflare Access token" };
  }
}

/** Constant-time string comparison using SHA-256 digests to avoid length leaks. */
export async function timingSafeSecretEqual(provided: string, expected: string): Promise<boolean> {
  if (!expected) {
    return false;
  }
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/** Verify machine-to-machine ingest requests via Bearer secret plus Cloudflare Access JWT. */
export async function verifyIngestAuth(
  request: Request,
  env: Env,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const expectedSecret = env.INGEST_BEARER_TOKEN ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return { ok: false, status: 401, reason: "Missing Bearer token" };
  }

  const secretValid = await timingSafeSecretEqual(match[1].trim(), expectedSecret);
  if (!secretValid) {
    return { ok: false, status: 403, reason: "Invalid Bearer token" };
  }

  if (isLocalhostBypass(request, env)) {
    return { ok: true };
  }

  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return { ok: false, status: 401, reason: "Missing Access Service Token assertion" };
  }

  const audiences = [env.CF_INGEST_ACCESS_AUD, env.CF_ACCESS_AUD].filter(
    (v): v is string => Boolean(v && v.length > 0),
  );
  try {
    const jwks = getJwks(env.CF_ACCESS_TEAM_DOMAIN);
    await jwtVerify(jwt, jwks, {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: audiences,
    });
    return { ok: true };
  } catch {
    return { ok: false, status: 403, reason: "Invalid Service Token JWT" };
  }
}

/** Build a non-cacheable JSON response with baseline security headers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

