import { NextRequest, NextResponse } from "next/server";
import { list, put } from "@/lib/blob-backend";
import { getSiteUrlFromEnv } from "@/lib/site-url";

export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function redirectUri() {
  return process.env.ADOBE_OAUTH_REDIRECT_URI ?? `${getSiteUrlFromEnv()}/api/adobe/callback`;
}

// 外呼硬超時：IMS token 交換與 blob 刪除 hang 死時會一路佔滿函數時限；
// 兩類請求正常應答遠低於 5s，超時走既有 catch → 502/靜默跳過。
const ADOBE_CALLBACK_TIMEOUT_MS = 5_000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");

  if (errorParam) {
    return NextResponse.json(
      { error: `Adobe OAuth error: ${errorParam}` },
      { status: 400 },
    );
  }

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  const clientId = process.env.ADOBE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.ADOBE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return new NextResponse(
      `<!DOCTYPE html><html><body><h1>設定未完成</h1><p>缺少 ADOBE_OAUTH_CLIENT_ID 或 ADOBE_OAUTH_CLIENT_SECRET 環境變數。</p></body></html>`,
      { status: 412, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
  });

  try {
    const res = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(ADOBE_CALLBACK_TIMEOUT_MS),
    });

    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Token exchange failed: ${data.error_description || data.error}` },
        { status: 502 },
      );
    }

    if (!data.refresh_token) {
      // Adobe IMS doesn't issue refresh tokens for OAuth Web credentials.
      // Store the access token anyway (24h validity) and fall back to
      // manual re-auth when it expires.
      const blob = await put(
        `adobe_oauth_${Date.now()}.json`,
        JSON.stringify({
          refresh_token: null,
          access_token: data.access_token,
          expires_in: data.expires_in,
          created_at: Date.now(),
        }),
        { access: "public", addRandomSuffix: false },
      );
      process.env.ADOBE_OAUTH_BLOB_URL = blob.url;
      return new NextResponse(
        `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Adobe OAuth 設定完成</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff}div{text-align:center;padding:2rem;max-width:500px}h1{color:#4ade80}p{color:#aaa;line-height:1.5}.warn{color:#fbbf24;font-size:0.9em;margin-top:1rem;background:#1a1a1a;padding:1rem;border-radius:8px;border:1px solid #fbbf2444}</style>
</head><body>
<div><h1>✓ Adobe OAuth 設定完成</h1>
<p>access_token 已儲存，有效期 24 小時。</p>
<div class="warn">⚠ Adobe 不支援 refresh_token。24 小時後 token 過期時，再次訪問此頁面即可更新。</div>
</div>
</body></html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    // Remove old blobs, then store the new refresh token
    const existing = await list({ prefix: "adobe_oauth_" });
    await Promise.all(
      existing.blobs.map((b) =>
        fetch(b.url, { method: "DELETE", signal: AbortSignal.timeout(ADOBE_CALLBACK_TIMEOUT_MS) }).catch(() => {}),
      ),
    );

    const blob = await put(
      `adobe_oauth_${Date.now()}.json`,
      JSON.stringify({
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_in: data.expires_in,
        created_at: Date.now(),
      }),
      { access: "public", addRandomSuffix: false },
    );

    // Store the blob URL in an env var for easy retrieval
    process.env.ADOBE_OAUTH_BLOB_URL = blob.url;

    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Adobe OAuth 設定完成</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff}div{text-align:center;padding:2rem}h1{color:#4ade80}p{color:#aaa;max-width:500px;line-height:1.5}</style>
</head><body>
<div><h1>✓ Adobe OAuth 設定完成</h1>
<p>refresh_token 已安全儲存。現在自動登入已生效，用戶不再需要登入 Adobe。</p>
<p style="color:#666;font-size:0.85em">token 將在 24 小時後自動刷新，無需手動操作。</p>
</div>
</body></html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
