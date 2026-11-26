// GET/PUT /api/user/self — user info + quota, update profile
import { makeProxy } from "@/lib/generation-core/proxy";

export const preferredRegion = "sfo1";

const proxy = makeProxy({ upstreamPath: "/api/user/self" });
export const GET = proxy;
export const PUT = proxy;
