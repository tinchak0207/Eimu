// GET /api/usage — backward-compat shim
import { NextRequest } from "next/server";
import { makeProxy } from "@/lib/proxy";

export const preferredRegion = "sfo1";

const emptyCtx = { params: Promise.resolve({}) };

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? "logs";
  if (type === "stat") return makeProxy({ upstreamPath: "/api/log/self/stat" })(req, emptyCtx);
  if (type === "data") return makeProxy({ upstreamPath: "/api/data/self" })(req, emptyCtx);
  return makeProxy({ upstreamPath: "/api/log/self" })(req, emptyCtx);
}
