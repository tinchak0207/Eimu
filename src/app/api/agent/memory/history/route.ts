// GET /api/agent/memory/history —— 读单个记忆文档的世代历史（审计用）。
//
// 验签沿用同套 HMAC：GET 没有 body → 对「空 bytes」验签（与 export/route.ts 同款）。
// query：`doc_id=<catalog 条目 id>`；缺 doc_id → 400，目录与历史都找不到 → 404。
// 响应：`{ doc_id, current, revisions, generated_at }`，revisions 按 revision 升序，
// 每个世代都是完整正文（含 superseded／retracted 的历史事实，供审计与回滚参考）。
// no-store：历史是低频审计读，不需要缓存；也不导出到 gateway 召回语料。

import { NextRequest, NextResponse } from "next/server";
import { listMemoryRevisions } from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer(); // GET 无 body → 空 bytes 验签
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const docId = (req.nextUrl.searchParams.get("doc_id") ?? "").trim();
  if (!docId) {
    return NextResponse.json({ error: "missing_doc_id" }, { status: 400 });
  }

  try {
    const history = await listMemoryRevisions(docId);
    if (!history.current && history.revisions.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        doc_id: docId,
        current: history.current,
        revisions: history.revisions,
        generated_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
