// POST /api/agent/memory/forget —— gateway 的 memory_forget 工具落点：按 id 硬删某 owner 的私有记忆。
//
// HMAC 验签同 ingest/retract。body：`{ owner_key, ids: [..] }`；回 `{ deleted: n, failed: n }`。
// 只作用于该 owner 的 private 条目（store 层再校一次 scope／ownerKey）。

import { NextRequest, NextResponse } from "next/server";
import { deleteUserMemories } from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer();
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { owner_key?: unknown; ids?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ownerKey = typeof body.owner_key === "string" ? body.owner_key.trim() : "";
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)).slice(0, 50) : [];
  if (!ownerKey || ids.length === 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await deleteUserMemories(ownerKey, ids);
    return NextResponse.json(
      { deleted: result.deleted.length, failed: result.failed.length, removed: result.removed.map((r) => ({ description: r.description, body: r.body })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
