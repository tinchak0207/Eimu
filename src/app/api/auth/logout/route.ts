import { NextRequest, NextResponse } from "next/server";
import {
  lookupUserIdByToken,
  revokeNewApiSessionToken,
  rotateUpstreamAccessToken,
} from "@/lib/newapi-session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function POST(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  if (!token) {
    return NextResponse.json({ ok: false, revoked: false, persisted: false, upstreamRevoked: false }, { status: 401 });
  }
  const headerUser = Number(req.headers.get("x-user-id") ?? "");
  const lookedUp = await lookupUserIdByToken(token);
  const userId = lookedUp ?? (Number.isInteger(headerUser) && headerUser > 0 ? headerUser : null);
  const upstreamRevoked = userId ? await rotateUpstreamAccessToken(token, userId) : false;
  const revoked = await revokeNewApiSessionToken(token, userId);
  const response = NextResponse.json({
    ok: true,
    revoked: revoked.revoked,
    persisted: revoked.persisted,
    upstreamRevoked,
  });
  response.cookies.set("napi_token", "", { path: "/", maxAge: 0 });
  response.cookies.set("napi_user", "", { path: "/", maxAge: 0 });
  return response;
}
