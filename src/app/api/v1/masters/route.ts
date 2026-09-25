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

// GET /v1/masters —— 列舉本金鑰 tenant 產出的成片（刀 4 成片產物索引的讀取端）。
//
// 形狀照既有 B 端狀態端點（`v1/videos/[id]/route.ts` 的鑑權/trace/錯誤體；
// 清單信封照 `v1/history/route.ts` 的 `{object,data,limit,offset,total,has_more}`）。
// 隔離鍵：tenant = `biz:<keyId>`（`bizTenantId`），金鑰只能看自己 tenant 的成片；
// 可選 `session_id` 用來回答「這個會話產過哪些成片」，`project_id` 對應作品。
//
// 無成片時回空清單而非 404：索引為空是事實（尚未導出過），不是查詢失敗。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(status: number, message: string, code: string, traceId: string) {
  const response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  return withTraceId(response, traceId);
}

/** 索引列 → 對外投影（欄位名 snake_case，與既有 B 端端點一致）。 */
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

  // tenant＝`web:<userId>`（屬主維度，非金鑰維度）。生產端（/v1/internal/masters/ingest）
  // 的 tenant 由 gateway 帶 `web:<userId>`（resolve-owner 的屬主），與這裡同一推導、兩端對稱。
  // 刻意不用 `bizTenantId(auth.key.id)`：成片產於 agent 會話，同一用戶的 B key id 與
  // agent 會話屬主不是同一個鍵——按金鑰查永遠查空。
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
