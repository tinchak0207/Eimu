// GET /api/data/self — daily quota consumption trend
import { makeProxy } from "@/lib/generation-core/proxy";

export const preferredRegion = "sfo1";

export const GET = makeProxy({ upstreamPath: "/api/data/self" });
