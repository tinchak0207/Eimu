// POST /api/agent/memory/retract —— 批次／指定 doc 撤回（契约 §3.2）。
//
// 与 ingest 同一套纪律：raw bytes 验签 → snake_case 映射 → 调 store，route 内零业务闸门。
// 请求二选一：`{ "batch_id": "..." }` 或 `{ "doc_ids": ["a","b"] }`；
// 动作（status=retracted + 从 INDEX 移除、不删档留证）全在 store 的 retractMemoryDocs。
// 响应形状：`{ "retracted": ["<id>"] }`（契约 §3.2）。

import { NextRequest, NextResponse } from "next/server";
import { retractMemoryDocs } from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

interface RetractRequestBody {
  batch_id?: unknown;
  doc_ids?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer();
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RetractRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as RetractRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await retractMemoryDocs({
      batchId: body.batch_id as string | undefined,
      docIds: Array.isArray(body.doc_ids) ? body.doc_ids.map((id) => String(id)) : undefined,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
