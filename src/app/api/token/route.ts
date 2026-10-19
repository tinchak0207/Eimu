// GET /api/token/ — list user's API tokens
// POST /api/token/ — create a new token
import { makeProxy } from "@/lib/proxy";

export const preferredRegion = "sfo1";

const proxy = makeProxy({ upstreamPath: "/api/token/" });
export const GET = proxy;
export const POST = proxy;
