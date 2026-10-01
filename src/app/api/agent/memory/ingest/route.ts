// POST /api/agent/memory/ingest —— 記憶庫唯一寫入入口（契約 §3.1）。
//
// 本 route 只做三件事：HMAC 驗簽（raw body bytes）→ snake_case 欄位映射 → 調 store。
// 業務閘門全在 store（G5 去重／G7 配額）與 gateway（G1-G4/G6/G8），此處不重複攔
// （契約 §5 閘門分工）。結構不合的 doc 由 store 的 structure 防線拒絕並逐條回報。
//
// 驗簽鐵律：先 `req.arrayBuffer()` 拿原始位元組驗簽，再 `TextDecoder` 解析；
// 若先 `req.json()` 再重新序列化，鍵序／空白差異會讓簽名永遠對不上
// （理由見 memory-hmac.ts 檔頭）。無簽／錯簽／密鑰未配置 → 401（不靠網絡位置做安全）。

import { NextRequest, NextResponse } from "next/server";
import {
  ingestMemoryDocs,
  type AgentMemoryDocInput,
  type EvidenceKind,
  type MemoryScope,
  type MemoryType,
} from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

interface IngestRequestBody {
  batch_id?: unknown;
  prompt_version?: unknown;
  docs?: unknown;
}

/**
 * 請求 doc（契約 §1/§3.1 的 snake_case 欄位）→ store 輸入（camelCase）。
 * 原值直傳不做類型 coercion——壞類型交由 store 的 isStructurallyValid 拒（structure）。
 */
function mapDoc(raw: unknown): AgentMemoryDocInput {
  const doc = (raw ?? {}) as Record<string, unknown>;
  return {
    scope: doc.scope as MemoryScope,
    ownerKey: (doc.owner_key ?? doc.ownerKey) as string | undefined,
    domain: doc.domain as string,
    slug: doc.slug as string,
    description: doc.description as string,
    type: doc.type as MemoryType,
    body: doc.body as string,
    links: Array.isArray(doc.links) ? doc.links.map((link) => String(link)) : undefined,
    evidence: doc.evidence as string | undefined,
    evidenceKind: (doc.evidence_kind ?? doc.evidenceKind) as EvidenceKind,
    selfScore: (doc.self_score ?? doc.selfScore) as number,
    promptVersion: (doc.prompt_version ?? doc.promptVersion) as string | undefined,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer();
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: IngestRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as IngestRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await ingestMemoryDocs({
      batchId: body.batch_id as string,
      promptVersion: body.prompt_version as string | undefined,
      docs: Array.isArray(body.docs) ? body.docs.map(mapDoc) : [],
    });
    // 響應形狀 = MemoryIngestResult：{ accepted, rejected, stats{received,accepted,index_lines} }（契約 §3.1）。
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
