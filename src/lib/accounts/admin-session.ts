import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "./admin-auth";

function sessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not configured.");
  return secret;
}

export function configuredAdminUsername(): string {
  return process.env.ADMIN_USERNAME?.trim() || "tinchak0207";
}

export async function getAdminSession(): Promise<{ username: string } | null> {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const session = verifyAdminSessionToken(token, sessionSecret());
    return session?.username === configuredAdminUsername() ? session : null;
  } catch {
    return null;
  }
}

export async function setAdminSession(username: string): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, createAdminSessionToken(username, sessionSecret()), ADMIN_SESSION_COOKIE_OPTIONS);
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, "", { ...ADMIN_SESSION_COOKIE_OPTIONS, maxAge: 0 });
}

export async function requireAdminSession(): Promise<{ username: string }> {
  const session = await getAdminSession();
  if (!session) throw new Error("UNAUTHORIZED");
  return session;
}
