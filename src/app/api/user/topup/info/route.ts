// GET /api/user/topup/info — top-up config (min amount, exchange rate, etc.)
import { makeProxy } from "@/lib/proxy";

export const preferredRegion = "sfo1";

export const GET = makeProxy({ upstreamPath: "/api/user/topup/info", revalidate: 600, browserCache: 120 });
