// POST /api/agent/memory/ingest —— 记忆库唯一写入入口（契约 §3.1）。
//
// 本 route 只做三件事：HMAC 验签（raw body bytes）→ snake_case 栏位映射 → 调 store。
// 业务闸门全在 store（G5 去重／G7 配额）与 gateway（G1-G4/G6/G8），此处不重复拦
// （契约 §5 闸门分工）。结构不合的 doc 由 store 的 structure 防线拒绝并逐条回报。
//
// 验签铁律：先 `req.arrayBuffer()` 拿原始位元组验签，再 `TextDecoder` 解析；
// 若先 `req.json()` 再重新序列化，键序／空白差异会让签名永远对不上
// （理由见 memory-hmac.ts 档头）。无签／错签／密钥未配置 → 401（不靠网络位置做安全）。

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
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

interface IngestRequestBody {
  batch_id?: unknown;
  prompt_version?: unknown;
  docs?: unknown;
}

/**
 * 请求 doc（契约 §1/§3.1 的 snake_case 栏位）→ store 输入（camelCase）。
 * 原值直传不做类型 coercion——坏类型交由 store 的 isStructurallyValid 拒（structure）。
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
    // 响应形状 = MemoryIngestResult：{ accepted, rejected, stats{received,accepted,index_lines} }（契约 §3.1）。
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
