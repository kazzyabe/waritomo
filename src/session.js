import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE_NAME = "waritomo_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;

  if (process.env.APP_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }

  return "local-dev-session-secret";
}

export function createSessionToken(payload, options = {}) {
  const secret = options.secret ?? getSessionSecret();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifySessionToken(token, options = {}) {
  if (!token || typeof token !== "string") return null;

  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;

  const secret = options.secret ?? getSessionSecret();
  const expectedSignature = sign(encodedPayload, secret);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        if (index === -1) return [cookie, ""];
        return [cookie.slice(0, index), decodeURIComponent(cookie.slice(index + 1))];
      }),
  );
}

export function getSessionFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie ?? "");
  return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
}

export function createSessionCookie(token, options = {}) {
  const maxAge = options.maxAge ?? DEFAULT_TTL_SECONDS;
  const secure = options.secure ?? false;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function createExpiredSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
