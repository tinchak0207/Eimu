import { NextResponse } from "next/server";
import { getSiteUrlFromEnv } from "@/lib/site-url";

export const preferredRegion = "sfo1";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: getSiteUrlFromEnv().replace(/^https?:\/\//, ""),
    timestamp: new Date().toISOString(),
  });
}
