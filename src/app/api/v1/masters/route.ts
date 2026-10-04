import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { clampPagination } from "@/lib/generation-core/status-query";
import {
  countMasterArtifacts,
  listMasterArtifacts,
  type MasterArtifactRecord,
} from "@/lib/generation-core/master-artifact-index";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

// GET /v1/masters —— 列举本金钥 tenant 产出的成片（刀 4 成片产物索引的读取端）。
//
// 形状照既有 B 端状态端点（`v1/videos/[id]/route.ts` 的鉴权/trace/错误体；
// 清单信封照 `v1/history/route.ts` 的 `{object,data,limit,offset,total,has_more}`）。
// 隔离键：tenant = `biz:<keyId>`（`bizTenantId`），金钥只能看自己 tenant 的成片；
// 可选 `session_id` 用来回答「这个会话产过哪些成片」，`project_id` 对应作品。
//
// 无成片时回空清单而非 404：索引为空是事实（尚未导出过），不是查询失败。

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

/** 索引列 → 对外投影（栏位名 snake_case，与既有 B 端端点一致）。 */
function toMasterItem(record: MasterArtifactRecord) {
  return {
    artifact_id: record.artifactId,
    task_id: record.jobId,
    delivery_url: record.deliveryUrl,
    object_key: record.objectKey,
    mime_type: record.mimeType,
    sha256: record.sha256,
    byte_size: record.byteSize,
    created_at: record.createdAt.toISOString(),
    export_fingerprint: record.exportFingerprint,
    fingerprint_version: record.fingerprintVersion,
    preset: record.preset,
    resolution: record.resolution,
    duration_sec: record.durationSec,
    timeline_version: record.timelineVersion,
    session_id: record.sessionId,
    project_id: record.projectId,
    cover_url: record.coverUrl,
    source: record.source,
    probe: record.probe,
    job_kind: record.jobKind,
    model: record.modelId,
  };
}

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), { consumeRateLimit: false });
  if (!auth.ok) return error(auth.status, auth.message, auth.code, traceId);

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id")?.trim() || null;
  const projectId = url.searchParams.get("project_id")?.trim() || null;
  const { limit, offset } = clampPagination(url.searchParams.get("limit"), url.searchParams.get("offset"));

  // tenant＝`web:<userId>`（属主维度，非金钥维度）。生产端（/v1/internal/masters/ingest）
  // 的 tenant 由 gateway 带 `web:<userId>`（resolve-owner 的属主），与这里同一推导、两端对称。
  // 刻意不用 `bizTenantId(auth.key.id)`：成片产于 agent 会话，同一用户的 B key id 与
  // agent 会话属主不是同一个键——按金钥查永远查空。
  const filter = { tenantId: `web:${auth.key.userId}`, sessionId, projectId, limit, offset };
  const [records, total] = await Promise.all([
    listMasterArtifacts(filter),
    countMasterArtifacts(filter),
  ]);

  const data = records.map(toMasterItem);
  return withTraceId(
    NextResponse.json(
      {
        object: "list",
        data,
        limit,
        offset,
        total,
        has_more: offset + data.length < total,
        filters: { session_id: sessionId, project_id: projectId },
      },
      { headers: { "Cache-Control": "no-store" } },
    ),
    traceId,
  );
}
