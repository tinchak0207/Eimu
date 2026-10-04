/**
 * Runtime-safe site URL detection.
 *
 * 优先级：
 *   1. NEXT_PUBLIC_SITE_URL / SITE_URL 环境变数
 *   2. 硬编码 fallback https://eimu.dev
 */

const FALLBACK_URL = "https://eimu.dev";

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

/** 从 NextRequest 取得 site URL（API Route handler 用）。 */
export function getSiteUrlFromRequest(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Canonical site URL for metadata, sitemap, robots, and structured data.
 *
 * Always returns the configured public domain, regardless of which
 * hostname the request arrived on. This ensures Google sees a single canonical
 * domain and avoids duplicate-indexing across eimu.dev / image.tinchak0207.xyz.
 */
export async function getSiteUrl(): Promise<string> {
  return getSiteUrlFromEnv();
}