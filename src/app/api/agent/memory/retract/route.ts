// POST /api/agent/memory/retract —— 批次／指定 doc 撤回（契約 §3.2）。
//
// 與 ingest 同一套紀律：raw bytes 驗簽 → snake_case 映射 → 調 store，route 內零業務閘門。
// 請求二選一：`{ "batch_id": "..." }` 或 `{ "doc_ids": ["a","b"] }`；
// 動作（status=retracted + 從 INDEX 移除、不刪檔留證）全在 store 的 retractMemoryDocs。
// 響應形狀：`{ "retracted": ["<id>"] }`（契約 §3.2）。

import { NextRequest, NextResponse } from "next/server";
import { retractMemoryDocs } from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
