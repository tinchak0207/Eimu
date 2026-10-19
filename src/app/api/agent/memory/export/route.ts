// GET /api/agent/memory/export —— 导出 active 记忆供 gateway 召回语料与共享索引（契约 §3.3 §3.4）。
//
// 验签沿用同套 HMAC：GET 没有 body → 对「空 bytes」验签（memory-hmac.ts 档头已载明，
// gateway 端同算法）。query：`scope=shared|private`，private 另带 `owner_key=<hex>`；
// scope 缺省／非法由 store 归一化为 shared，private 缺 ownerKey 由 store 回空——
// route 内不重复拦。只回 status="active"（listMemoryDocs 语义）。
//
// 响应形状（契约 §3.3）：`{ "docs": [...], "index_md": "...", "generated_at": "ISO" }`。
// gateway 侧 TTL 快取 5 分钟，故本端 no-store。

import { NextRequest, NextResponse } from "next/server";
import {
  listMemoryDocs,
  readMemoryIndexMd,
  type MemoryScope,
} from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

/** `as_of`（ISO）：可 parse 才采用，非法一律忽略（保持默认「当前有效」行为）。 */
function asOfParam(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer(); // GET 无 body → 空 bytes 验签
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const scope = (params.get("scope") ?? "shared") as MemoryScope;
  const ownerKey = params.get("owner_key") ?? undefined;
  const asOf = asOfParam(params.get("as_of"));

  try {
    const [docs, indexMd] = await Promise.all([
      listMemoryDocs({ scope, ownerKey, ...(asOf ? { asOf } : {}) }),
      readMemoryIndexMd(scope, ownerKey, asOf),
    ]);
    // 只导出 live 字段：`proposed` 是未佐证的正文提案，绝不能随导出进入 gateway
    // 召回语料或共享索引（只有提升为 live 后才会出现在 INDEX）。
    const liveDocs = docs.map((doc) => {
      const live = { ...doc };
      delete live.proposed;
      return live;
    });
    return NextResponse.json(
      { docs: liveDocs, index_md: indexMd, generated_at: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
