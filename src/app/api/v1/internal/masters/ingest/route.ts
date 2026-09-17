// POST /api/v1/internal/masters/ingest —— 成片導出索引的唯一寫入入口（G4 生產端）。
//
// 呼叫者：VPS gateway 在 POST /agent/v1/timeline/master 導出成功後回呼。
// 公網入口經 Vercel beforeFiles 代理到控制面容器（`/api/v1/:path*` →
// `${controlPlaneOrigin}/image-control/api/v1/:path*`，next.config.ts）——控制面持有
// GENERATION_DATABASE_URL，Vercel 按設計不持有，所以本 route 必須掛在 /api/v1 前綴下。
//
// 鑑欄：**HMAC 簽名，不是 B 端 Bearer**。呼叫者是 gateway（機器對機器），复用
// memory-hmac 的通道密鑰與 header（`MEMORY_INGEST_SECRET` / `x-memory-signature`）：
// 同一條 gateway→控制面簽名通道、同一把密鑰、同一套 raw-bytes 驗簽法，不另立第二套 HMAC
// （兩套密鑰 = 兩個漂移點；gateway 側 `memoryPostIngest` 已按該通道簽名）。無簽/錯簽/密鑰
// 未配置 → 401。驗簽鐵律同 memory/ingest：先 `req.arrayBuffer()` 取原始位元組再驗，
// 禁止先 `req.json()` 再重序列化（鍵序/空白差異會讓簽名永遠對不上）。
//
// 業務閘門在 `ingestMasterExport`：欄位缺失/非法逐欄回 422，**不補預設值**（索引裡一條
// 假資料比缺一條糟——metadata 會被讀取端當事實轉錄給 B 端用戶）。

import { NextRequest, NextResponse } from "next/server";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import {
  ingestMasterExport,
  validateMasterIngestPayload,
} from "@/lib/generation-core/master-ingest-service";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(status: number, message: string, code: string, traceId: string) {
  const response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  return withTraceId(response, traceId);
}

export async function POST(req: NextRequest): Promise<Response> {
  const traceId = getOrCreateTraceId(req);
  const raw = await req.arrayBuffer();
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return error(401, "unauthorized", "unauthorized", traceId);
  }
  if (!generationControlPlaneEnabled()) {
    return error(503, "control plane disabled", "control_plane_disabled", traceId);
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return error(400, "request body must be JSON", "bad_request", traceId);
  }

  const validated = validateMasterIngestPayload(body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "invalid fields", fields: validated.fields, trace_id: traceId },
      { status: 422 },
    );
  }

  try {
    const result = await ingestMasterExport(validated.value);
    return withTraceId(
      NextResponse.json({
        ok: true,
        job_id: result.jobId,
        artifact_id: result.artifactId,
        // 誠實對外：重放導出（同會話同素材指紋）≠ 新成片——job 冪等、artifact 不重複插。
        job_deduped: result.jobDeduped,
        artifact_inserted: result.artifactInserted,
      }),
      traceId,
    );
  } catch (e) {
    // 控制面側故障（DB 不可達等）→ 5xx，gateway 側按「索引登記失敗」記 note，導出本身不受影響。
    return error(500, e instanceof Error ? e.message : "ingest failed", "ingest_failed", traceId);
  }
}
