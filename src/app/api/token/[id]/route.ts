// DELETE /api/token/[id] — delete a specific token
import { NextRequest } from "next/server";
import { makeProxy } from "@/lib/proxy";

export const preferredRegion = "sfo1";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  // Re-use makeProxy with resolved path — pass a dummy context with empty params
  return makeProxy({ upstreamPath: `/api/token/${id}` })(req, { params: Promise.resolve({}) });
}
