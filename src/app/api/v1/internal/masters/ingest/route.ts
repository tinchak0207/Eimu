// POST /api/v1/internal/masters/ingest —— 成片导出索引的唯一写入入口（G4 生产端）。
//
// 呼叫者：VPS gateway 在 POST /agent/v1/timeline/master 导出成功后回呼。
// 公网入口经 Vercel beforeFiles 代理到控制面容器（`/api/v1/:path*` →
// `${controlPlaneOrigin}/image-control/api/v1/:path*`，next.config.ts）——控制面持有
// GENERATION_DATABASE_URL，Vercel 按设计不持有，所以本 route 必须挂在 /api/v1 前缀下。
//
// 鉴栏：**HMAC 签名，不是 B 端 Bearer**。呼叫者是 gateway（机器对机器），复用
// memory-hmac 的通道密钥与 header（`MEMORY_INGEST_SECRET` / `x-memory-signature`）：
// 同一条 gateway→控制面签名通道、同一把密钥、同一套 raw-bytes 验签法，不另立第二套 HMAC
// （两套密钥 = 两个漂移点；gateway 侧 `memoryPostIngest` 已按该通道签名）。无签/错签/密钥
// 未配置 → 401。验签铁律同 memory/ingest：先 `req.arrayBuffer()` 取原始位元组再验，
// 禁止先 `req.json()` 再重序列化（键序/空白差异会让签名永远对不上）。
//
// 业务闸门在 `ingestMasterExport`：栏位缺失/非法逐栏回 422，**不补预设值**（索引里一条
// 假资料比缺一条糟——metadata 会被读取端当事实转录给 B 端用户）。

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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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
        // 诚实对外：重放导出（同会话同素材指纹）≠ 新成片——job 幂等、artifact 不重复插。
        job_deduped: result.jobDeduped,
        artifact_inserted: result.artifactInserted,
      }),
      traceId,
    );
  } catch (e) {
    // 控制面侧故障（DB 不可达等）→ 5xx，gateway 侧按「索引登记失败」记 note，导出本身不受影响。
    return error(500, e instanceof Error ? e.message : "ingest failed", "ingest_failed", traceId);
  }
}
