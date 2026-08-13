import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.ADOBE_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "OAuth not configured. Set ADOBE_OAUTH_CLIENT_ID first." },
      { status: 412 },
    );
  }

  const redirectUri = "https://image.tinchak0207.xyz/api/adobe/callback";
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