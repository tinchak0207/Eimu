import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "image_admin_session";
export const ADMIN_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 12,
};

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LENGTH = 64;

export function hashAdminPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, HASH_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString("hex")}`;
}

export function verifyAdminPassword(password: string, encoded: string): boolean {
  const [algorithm, nValue, rValue, pValue, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;

  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  try {
    const expected = Buffer.from(expectedHex, "hex");
    if (expected.length !== HASH_LENGTH) return false;
    const actual = scryptSync(password, salt, HASH_LENGTH, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function signSessionPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAdminSessionToken(
  username: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = ADMIN_SESSION_COOKIE_OPTIONS.maxAge,
): string {
  const payload = Buffer.from(JSON.stringify({ username, exp: nowSeconds + ttlSeconds })).toString("base64url");
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

export function verifyAdminSessionToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { username: string } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  const expected = Buffer.from(signSessionPayload(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.username !== "string" || typeof parsed.exp !== "number" || parsed.exp < nowSeconds) return null;
    return { username: parsed.username };
  } catch {
    return null;
  }
}
