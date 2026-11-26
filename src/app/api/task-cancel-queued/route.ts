// POST /api/task-cancel-queued —— 「停掉还没跑的，跑起来的继续」（项目级一键停排队）。
//
// 吸收 AID 批量停止：一次最多 100 个任务，只取消**还在排队、尚未交给上游**的（pending_billing／queued／leased）；
// 已经在跑（submitting／running）的不动——它们的钱已经花在上游，停下只会浪费；提交结果未知的（*_unknown）
// 也不动，单列为「待确认」。回执逐类计数，用户看得见：停了几个、几个继续跑、几个待确认、几个早已结束。
// 取消与退款走既有门面 `cancelGenerationJobWithRefund`（与单任务 DELETE 同一条路径，本路由不碰帐本）。

import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/accounts/biz-api-key-store";
import { looksLikeBizApiKey, readBearerToken } from "@/lib/accounts/biz-api-keys";
import { cancelGenerationJobWithRefund } from "@/lib/generation-core/cancel-service";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { authenticateImageUser } from "@/lib/billing/image-billing";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

const MAX_TASKS = 100;
const STOPPABLE = new Set(["pending_billing", "queued", "leased"]);
const RUNNING = new Set(["submitting", "running"]);
const UNKNOWN = new Set(["billing_unknown", "submit_unknown"]);

export interface CancelQueuedReceipt {
  /** 已停止（排队中被取消，未交给上游）。 */
  stopped: string[];
  /** 正在执行、保持继续跑的。 */
  running: string[];
  /** 提交／计费结果未知、待确认的（不乱动）。 */
  pendingConfirm: string[];
  /** 已经结束（成功／失败／已退款／已取消），无需处理。 */
  alreadyDone: string[];
  /** 查不到（非本人任务或已清理）。 */
  notFound: string[];
  /** 想停但与并发终结竞态，实际已结束。 */
  raced: string[];
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const done = (body: unknown, status = 200) =>
    withTraceId(NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }), traceId);

  let tenantId: string;
  const bearer = readBearerToken(req.headers.get("authorization"));
  if (bearer && looksLikeBizApiKey(bearer)) {
    const auth = await authenticateBizApiKey(bearer);
    if (!auth.ok) return done({ error: auth.message }, auth.status);
    tenantId = `biz:${auth.key.id}`;
  } else {
    const auth = await authenticateImageUser(req.headers, 0);
    if (!auth.ok) return done({ error: auth.message }, auth.status);
    tenantId = `web:${auth.user.id}`;
  }

  let body: { taskIds?: unknown } | null = null;
  try {
    body = (await req.json()) as { taskIds?: unknown };
  } catch {
    return done({ error: "请求体必须是合法 JSON" }, 400);
  }
  const ids = Array.isArray(body?.taskIds)
    ? [...new Set(body!.taskIds.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))]
    : [];
  if (ids.length === 0) return done({ error: "taskIds 不能为空" }, 400);
  if (ids.length > MAX_TASKS) return done({ error: `一次最多停止 ${MAX_TASKS} 个任务` }, 400);

  const receipt: CancelQueuedReceipt = { stopped: [], running: [], pendingConfirm: [], alreadyDone: [], notFound: [], raced: [] };
  for (const id of ids) {
    const job = await getGenerationJobForTenant(id, tenantId);
    if (!job) { receipt.notFound.push(id); continue; }
    if (RUNNING.has(job.status)) { receipt.running.push(id); continue; }
    if (UNKNOWN.has(job.status)) { receipt.pendingConfirm.push(id); continue; }
    if (!STOPPABLE.has(job.status)) { receipt.alreadyDone.push(id); continue; }
    try {
      const result = await cancelGenerationJobWithRefund(id, tenantId, job);
      (result.cancelled ? receipt.stopped : receipt.raced).push(id);
    } catch {
      // 单个失败不拖累整批：归入待确认（状态不明就不假装停了）。
      receipt.pendingConfirm.push(id);
    }
  }
  return done({ ok: true, requested: ids.length, ...receipt });
}
