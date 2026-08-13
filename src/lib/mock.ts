/**
 * Mock mode — stateless, token encodes username directly.
 * Works across Next.js hot-reload and separate API route modules.
 * Activated when ENABLE_MOCK_MODE=true in .env.local
 */

import type { NewApiUser } from "./new-api-client";

export const MOCK_MODE = process.env.ENABLE_MOCK_MODE === "true";

function mockUser(username: string, usedQuota = 0): NewApiUser {
  return {
    id: 1,
    username,
    display_name: username,
    email: "",
    quota: 10_000_000,   // 20 coins
    used_quota: usedQuota,
  };
}

function tokenFor(username: string) {
  return `mock-token-${username}`;
}

function usernameFrom(token: string): string | null {
  if (!token.startsWith("mock-token-")) return null;
  const u = token.replace("mock-token-", "");
  return u || null;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function mockRegister(username: string, _password: string, email?: string) {
  if (!username.trim()) return { success: false, message: "请填写账号" };
  const user = mockUser(username);
  if (email) user.email = email;
  return { success: true, message: "注册成功", data: { token: tokenFor(username), user } };
}

export function mockLogin(username: string, password: string) {
  if (!username.trim() || !password.trim()) {
    return { success: false, message: "账号或密码错误" };
  }
  return { success: true, message: "登录成功", data: { token: tokenFor(username), user: mockUser(username) } };
}

export function mockGetSelf(token: string) {
  const username = usernameFrom(token);
  if (!username) return { success: false, message: "session_expired" };
  return { success: true, data: mockUser(username, 500_000) };
}

// ─── Image generation ─────────────────────────────────────────────────────────

// Minimal valid 8x8 PNG (solid blue square)
const MOCK_IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQI12NgYGD4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==";

export function mockGenerateImage() {
  return { provider: "image_tinchak", image: MOCK_IMAGE_B64, imageUrl: null };
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export function mockGetLogs() {
  const now = Math.floor(Date.now() / 1000);
  return {
    success: true,
    data: [
      { id: 1, created_at: now - 60,  type: 2, model_name: "gpt-image-2", quota: 500_000 },
      { id: 2, created_at: now - 300, type: 2, model_name: "gpt-image-2", quota: 500_000 },
    ],
  };
}
