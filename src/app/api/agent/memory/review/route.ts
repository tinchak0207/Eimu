// POST /api/agent/memory/review —— G8 抽检品质翻转（PRD §5.6；【契约外新增】，P1-1 本片）。
//
// 与 retract 同一套纪律：raw bytes 验签 → snake_case 映射 → 调 store，route 内零业务闸门。
// 请求：`{ "batch_id": "..." }` 或 `{ "doc_ids": [...] }`，加 `action`
// ∈ {pending_review, activate}；可选 `scope`（缺省时 pending_review 仅 shared）。
// 响应形状：`{ "reviewed": ["<id>"], "action": "..." }`。

import { NextRequest, NextResponse } from "next/server";
import {
  reviewMemoryDocs,
  type MemoryReviewAction,
  type MemoryScope,
} from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

interface ReviewRequestBody {
  batch_id?: unknown;
  doc_ids?: unknown;
  action?: unknown;
  scope?: unknown;
}

const REVIEW_ACTIONS: readonly string[] = ["pending_review", "activate"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer();
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ReviewRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as ReviewRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!REVIEW_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  try {
    const result = await reviewMemoryDocs({
      batchId: body.batch_id as string | undefined,
      docIds: Array.isArray(body.doc_ids) ? body.doc_ids.map((id) => String(id)) : undefined,
      action: action as MemoryReviewAction,
      scope:
        body.scope === "private" || body.scope === "shared"
          ? (body.scope as MemoryScope)
          : undefined,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
