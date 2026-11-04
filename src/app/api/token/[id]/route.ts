// DELETE /api/token/[id] — delete a specific token
import { NextRequest } from "next/server";
import { makeProxy } from "@/lib/proxy";

export const preferredRegion = "sfo1";

// 路径参数交给 makeProxy 统一校验 + encodeURIComponent（S-16），不再在此拼接。
const deleteToken = makeProxy({ upstreamPath: "/api/token/:id" });

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return deleteToken(req, context);
}
