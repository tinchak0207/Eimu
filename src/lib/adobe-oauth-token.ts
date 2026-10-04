import { get, list } from "@/lib/blob-backend";

let cachedToken: { token: string; expiresAt: number } | null = null;

/** @vercel/blob v2.x 的 list() 支援 abortSignal，但 TypeScript 型别未包含 */
function listWithTimeout(prefix: string, timeoutMs: number) {
  return list({ prefix, limit: 1, abortSignal: AbortSignal.timeout(timeoutMs) } as Parameters<typeof list>[0] & { abortSignal: AbortSignal });
}

/** @vercel/blob v2.x 的 get() 支援 abortSignal，但 TypeScript 型别未包含 */
function getWithTimeout(url: string, timeoutMs: number) {
  return get(url, { access: "public", abortSignal: AbortSignal.timeout(timeoutMs) } as Parameters<typeof get>[1] & { abortSignal: AbortSignal });
}

async function findOauthBlobUrl(): Promise<string | null> {
  try {
    if (process.env.ADOBE_OAUTH_BLOB_URL) return process.env.ADOBE_OAUTH_BLOB_URL;
    const result = await listWithTimeout("adobe_oauth_", 10_000);
    return result.blobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0]?.url ?? null;
  } catch {
    return null;
  }
}

async function loadOauthAccessToken(): Promise<{ access_token: string; expires_in: number; created_at: number; refresh_token?: string | null } | null> {
  try {
    const url = await findOauthBlobUrl();
    if (!url) return null;
    const blob = await getWithTimeout(url, 10_000);
    if (!blob || blob.statusCode !== 200) return null;
    // blob.stream 是 ReadableStream<Uint8Array>，用 Response 读取
    const text = await new Response(blob.stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getAdobeAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  // 先从 Vercel Blob 载入 OAuth token（Adobe IMS access token，adobe2api 容器专用格式）
  const oauthData = await loadOauthAccessToken();
  if (oauthData?.access_token) {
    const expiresAt = (oauthData.created_at ?? Date.now()) + (oauthData.expires_in ?? 86_399) * 1000;
    if (Date.now() < expiresAt) {
      cachedToken = { token: oauthData.access_token, expiresAt: expiresAt - 60_000 };
      return oauthData.access_token;
    }
    if (oauthData.refresh_token) {
      const clientId = process.env.ADOBE_OAUTH_CLIENT_ID?.trim();
      const clientSecret = process.env.ADOBE_OAUTH_CLIENT_SECRET?.trim();
      if (clientId && clientSecret) {
        try {
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: oauthData.refresh_token,
            client_id: clientId,
            client_secret: clientSecret,
            scope: "openid,AdobeID,profile,email,additional_info.roles,org.read,firefly_api,ff_apis",
          });
          const response = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
          if (response.ok) {
            const data = await response.json() as { access_token: string; expires_in?: number };
            cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 86_399) * 1000 - 60_000 };
            return data.access_token;
          }
        } catch {}
      }
    }
  }

  // 降级：client_credentials（可能没有 firefly_api scope，看 Adobe 应用配置）
  const clientId = process.env.ADOBE_CLIENT_ID?.trim();
  const clientSecret = process.env.ADOBE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis",
      });
      const response = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (response.ok) {
        const data = await response.json() as { access_token: string; expires_in?: number };
        cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 86_399) * 1000 - 60_000 };
        return data.access_token;
      }
    } catch {}
  }

  throw new Error("ADOBE_OAUTH_REQUIRED");
}
