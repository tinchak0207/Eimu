// GET /api/agent/memory/export —— 導出 active 記憶供 gateway 召回語料與共享索引（契約 §3.3 §3.4）。
//
// 驗簽沿用同套 HMAC：GET 沒有 body → 對「空 bytes」驗簽（memory-hmac.ts 檔頭已載明，
// gateway 端同算法）。query：`scope=shared|private`，private 另帶 `owner_key=<hex>`；
// scope 缺省／非法由 store 歸一化為 shared，private 缺 ownerKey 由 store 回空——
// route 內不重複攔。只回 status="active"（listMemoryDocs 語義）。
//
// 響應形狀（契約 §3.3）：`{ "docs": [...], "index_md": "...", "generated_at": "ISO" }`。
// gateway 側 TTL 快取 5 分鐘，故本端 no-store。

import { NextRequest, NextResponse } from "next/server";
import {
  listMemoryDocs,
  readMemoryIndexMd,
  type MemoryScope,
} from "@/lib/agent-memory-store";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer(); // GET 無 body → 空 bytes 驗簽
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const scope = (params.get("scope") ?? "shared") as MemoryScope;
  const ownerKey = params.get("owner_key") ?? undefined;

  try {
    const [docs, indexMd] = await Promise.all([
      listMemoryDocs({ scope, ownerKey }),
      readMemoryIndexMd(scope, ownerKey),
    ]);
    return NextResponse.json(
      { docs, index_md: indexMd, generated_at: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
