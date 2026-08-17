/**
 * Runtime-safe site URL detection for dual-domain support.
 *
 * 優先級：
 *   1. 請求的 Host header（Server Component / API Route）
 *   2. NEXT_PUBLIC_SITE_URL / SITE_URL 環境變數
 *   3. 硬編碼 fallback https://image.tinchak0207.xyz
 *
 * 目的：不替換任何硬編碼，新增 runtime 域名檢測，舊域名永遠是 fallback。
 */

const FALLBACK_URL = "https://image.tinchak0207.xyz";

/** 從環境變數取得 site URL，fallback 到硬編碼預設值。非法值（被 `[SENSITIVE]` 佔位符污染等）也 fallback。 */
export function getSiteUrlFromEnv(): string {
  const candidate = (process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? FALLBACK_URL).replace(/\/+$/, "");
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) return FALLBACK_URL;
  try {
    new URL(candidate);
  } catch {
    return FALLBACK_URL;
  }
  return candidate;
}

/** 從 NextRequest 取得 site URL（API Route handler 用）。 */
export function getSiteUrlFromRequest(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * 從目前請求的 Host header 取得 site URL（Server Component 用）。
 *
 * 在 Server Component、generateMetadata、sitemap、robots 等情境中呼叫，
 * 透過 `headers()` 取得當前請求的域名，而非靜態寫死。
 *
 * ⚠ 不能在 Client Component 或非 Next.js 請求脈絡中呼叫。
 *    在那種情況下會 fallback 到環境變數 → 硬編碼。
 */
export async function getSiteUrl(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? "https";
      return `${proto}://${host}`;
    }
  } catch {
    // 不在請求脈絡中（build time 等）
  }
  return getSiteUrlFromEnv();
}