import { NextResponse } from "next/server";
import { getSiteUrlFromEnv } from "@/lib/site-url";

export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const REDIRECT_URI = `${getSiteUrlFromEnv()}/api/adobe/callback`;

export async function GET() {
  const clientId = process.env.ADOBE_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Adobe OAuth 设定</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff}div{text-align:center;padding:2rem;max-width:600px}ol{text-align:left;line-height:2;color:#ccc}code{background:#222;padding:2px 6px;border-radius:4px;font-size:0.9em}.step{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1rem 1.5rem;margin:1rem 0;text-align:left}.btn{display:inline-block;padding:12px 24px;background:#4ade80;color:#000;text-decoration:none;border-radius:8px;font-weight:bold;margin-top:1rem}</style>
</head><body>
<div>
<h1>Adobe OAuth 设定</h1>
<p style="color:#aaa">需要先完成以下步骤才能启用自动登入：</p>

<ol>
<li>前往 <a href="https://developer.adobe.com/console" style="color:#60a5fa">Adobe Developer Console</a></li>
<li>进入你的 Project → 「Add credential」→ <strong>OAuth Web</strong></li>
<li>设定 Redirect URI 为：<br><code>${REDIRECT_URI}</code></li>
<li>建立后复制 <strong>Client ID</strong> 和 <strong>Client Secret</strong></li>
</ol>

<p style="color:#aaa">把 Client ID 和 Client Secret 设定到环境变数后重新整理此页面。</p>
</div>
</body></html>`,
      {
        status: 412,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid,AdobeID,profile,email,additional_info.roles,org.read,firefly_api,ff_apis",
    prompt: "consent",
    access_type: "offline",
  });

  return NextResponse.redirect(
    `https://ims-na1.adobelogin.com/ims/authorize?${params.toString()}`,
  );
}