import { NextResponse } from "next/server";
import { getSiteUrlFromEnv } from "@/lib/site-url";

export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

export async function GET() {
  const clientId = process.env.ADOBE_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "OAuth not configured. Set ADOBE_OAUTH_CLIENT_ID first." },
      { status: 412 },
    );
  }

  const redirectUri = `${getSiteUrlFromEnv()}/api/adobe/callback`;
  const scope = "openid,AdobeID,profile,email,additional_info.roles,org.read,firefly_api,ff_apis";

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
  });

  return NextResponse.redirect(
    `https://ims-na1.adobelogin.com/ims/authorize?${params.toString()}`,
  );
}