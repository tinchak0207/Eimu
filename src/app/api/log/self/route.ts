// GET /api/log/self — paginated usage logs
import { makeProxy } from "@/lib/generation-core/proxy";

export const preferredRegion = "sfo1";

export const GET = makeProxy({ upstreamPath: "/api/log/self" });
