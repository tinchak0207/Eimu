import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  clearHistoryEntries,
  deleteHistoryEntries,
  listGeneratedHistoryEntries,
  saveGeneratedHistoryEntry,
} from "@/lib/server-history-store";
import {
  HISTORY_MAX_PROMPT_LENGTH,
  HISTORY_MAX_RESULTS_PER_ENTRY,
  HISTORY_PAGE_SIZE,
  normalizeHistoryEntry,
  buildHistoryFacets,
  filterHistoryEntries,
  mergeHistoryEntries,
  paginateHistoryEntries,
} from "@/lib/history-types";
import type { HistoryEntry, HistoryQuery } from "@/lib/history-types";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { listGenerationJobsForTenant } from "@/lib/generation-core/job-repository";
import { generationJobHistoryEntry } from "@/lib/generation-task-history";
import { loadScopedLibrary } from "@/lib/asset-library";
import { filterByProjectTag } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/** 一次批量删除最多接受的条数，避免有人拿这个端点做放大攻击。 */
const MAX_DELETE_IDS = 200;

/**
 * 从控制面取历史时一次要多少条。本地仍会按 cursor 重新分页，所以这里不传
 * cursor，只把控制面最新的一批一次拉回来参与归并——拉少了会让较旧的队列任务
 * 落在本地分页的第二页之外。100 是 paginateHistoryEntries 的上限，再多也会被夹回来。
 */
const CONTROL_PLANE_HISTORY_PAGE_SIZE = 100;
const CONTROL_PLANE_TIMEOUT_MS = 15_000;

function fail(status: number, message: string) {
  return NextResponse.json({ success: false, message }, { status });
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === "1" || value === "true";
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readQuery(searchParams: URLSearchParams): HistoryQuery {
  const keyword = searchParams.get("keyword")?.trim();
  const modelId = searchParams.get("modelId")?.trim();
  const imageSize = searchParams.get("imageSize")?.trim();
  const projectId = searchParams.get("projectId")?.trim();
  const since = parseTimestamp(searchParams.get("since"));
  const until = parseTimestamp(searchParams.get("until"));

  return {
    ...(keyword ? { keyword: keyword.slice(0, 200) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(projectId ? { projectId } : {}),
    ...(parseBoolean(searchParams.get("starred")) ? { starredOnly: true } : {}),
    ...(parseBoolean(searchParams.get("withImage")) ? { withImageOnly: true } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

/**
 * Vercel 按设计不持有控制面 Postgres（GENERATION_DATABASE_URL 只在 VPS 控制面那一侧），
 * 生成任务（含「再来 N 组」「微调变体」提交的、以及还在队列里的任务）全都落在那边。
 * 本地控制面没启用时，必须经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN 把同一份历史
 * 取回来归并——否则这些任务在 Vercel 上永远投影不出来：任务跑在 VPS、历史读在
 * Vercel，两边不相见，用户看到的就是「明明生成了、历史里没有这张卡」。
 *
 * 身份用调用者自己的 Bearer / x-user-id 转发（与 next.config 对 /api/generation-jobs
 * 的代理同一信任关系，控制面同样会自己校验一次），不新建内部签名通道 —— 控制面的
 * /image-control/api/history 就是本文件的同一份代码，不必再造一个只服务本文件的端点。
 *
 * 失败语义 fail-soft：控制面不可达时只记日志返回空数组，页面照旧显示本地那部分记录。
 */
async function fetchControlPlaneHistory(
  req: NextRequest,
  searchParams: URLSearchParams,
): Promise<HistoryEntry[]> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) return [];

  const forwarded: Record<string, string> = {};
  const authorization = req.headers.get("authorization");
  if (authorization) forwarded.authorization = authorization;
  const userId = req.headers.get("x-user-id");
  if (userId) forwarded["x-user-id"] = userId;

  const params = new URLSearchParams(searchParams);
  params.delete("cursor");
  params.delete("facets");
  params.set("pageSize", String(CONTROL_PLANE_HISTORY_PAGE_SIZE));

  let res: Response;
  try {
    res = await fetch(`${origin}/image-control/api/history?${params.toString()}`, {
      headers: forwarded,
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[history] 控制面代理请求失败，本次只返回本地记录", error);
    return [];
  }
  if (!res.ok) {
    console.error(`[history] 控制面代理返回 status=${res.status}，本次只返回本地记录`);
    return [];
  }

  const payload = (await res.json().catch(() => null)) as
    | { data?: { entries?: unknown } }
    | null;
  const raw = payload?.data?.entries;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    const normalized = normalizeHistoryEntry(item, "server");
    return normalized ? [normalized] : [];
  });
}

/**
 * 该项目标签下「来自生成记录」的资产 `source.id` 集合（历史条目 id）。
 *
 * 由**服务端自己算**（不依赖客户端把已加载条目过滤一遍）：这样 /api/history?projectId
 * 的分页能同时覆盖「新记录（有盖章栏位 projectIds）」与「存量记录（无栏位、只有资产血缘）」
 * ——谓词见 matchesHistoryQuery。复用既有资产库入口 loadScopedLibrary（列出当前用户
 * 全部资产候选）＋纯函数 filterByProjectTag（与资产面板同一实作），不新造跨 store 遍历。
 */
async function projectHistoryLineageIds(userId: number, projectId: string): Promise<Set<string>> {
  const snapshot = await loadScopedLibrary({ userId, projectId });
  const ids = new Set<string>();
  for (const item of filterByProjectTag(snapshot.candidates, projectId)) {
    if (item.source?.type === "history" && item.source.id) ids.add(item.source.id);
  }
  return ids;
}

/**
 * GET /api/history
 *
 * 查询参数：cursor、pageSize、keyword、modelId、imageSize、starred、withImage、since、until、projectId、facets。
 * 返回 `{ success, data: { entries, cursor, total }, facets? }`。
 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const { searchParams } = new URL(req.url);
  const pageSize = Number(searchParams.get("pageSize")) || HISTORY_PAGE_SIZE;
  const cursor = searchParams.get("cursor");

  const query = readQuery(searchParams);
  // 项目维度：服务端自己算血缘 id 集合。算不出来（后端不可用等）**不得放行全部记录**，
  // 照既有错误语义回 500（与 listGeneratedHistoryEntries 抛错时同款），fail-closed。
  if (query.projectId) {
    try {
      query.projectLineageIds = await projectHistoryLineageIds(auth.user.id, query.projectId);
    } catch (error) {
      console.error("[history] 项目血缘索引不可用，拒绝放行全部记录", error);
      return fail(500, "项目筛选暂时不可用，请稍后重试。");
    }
  }

  const storedEntries = await listGeneratedHistoryEntries(auth.user.id);
  let taskEntries: HistoryEntry[] = [];
  if (generationControlPlaneEnabled()) {
    try {
      const jobs = await listGenerationJobsForTenant(`web:${auth.user.id}`, { limit: 500 });
      taskEntries = jobs.map(generationJobHistoryEntry);
    } catch (error) {
      console.error("[history] generation task projection unavailable", error);
    }
  } else {
    taskEntries = await fetchControlPlaneHistory(req, searchParams);
  }
  const merged = mergeHistoryEntries(storedEntries, taskEntries);
  const data = paginateHistoryEntries(filterHistoryEntries(merged, query), cursor, pageSize);

  // 分面基于全量记录，只有第一屏需要；翻页时不必重复计算。
  // 刻意不随 projectId 收窄（最小改动）：分面是「筛选栏的可选值」而非分页结果，
  // 且 client 过滤时期它就是全量口径——保持逐字不变，不引入第二套语义。
  const facets = parseBoolean(searchParams.get("facets")) === true
    ? buildHistoryFacets(merged)
    : undefined;

  return NextResponse.json({ success: true, data, ...(facets ? { facets } : {}) });
}

/**
 * POST /api/history — 补写一条记录。
 *
 * 生成路由走的是内部调用，不经过这里；这个端点用于把本地缓存补录到服务端。
 * body 必须严格校验：旧实现直接 `{ ...body, userId }` 落盘，等于开放写入。
 */
export async function POST(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是合法的 JSON。");
  }

  const normalized = normalizeHistoryEntry(body, "server");
  if (!normalized) return fail(400, "记录缺少 id 或生成时间。");
  if (normalized.prompt.length > HISTORY_MAX_PROMPT_LENGTH) return fail(413, "提示词过长。");
  if (normalized.results.length > HISTORY_MAX_RESULTS_PER_ENTRY) return fail(413, "单条记录的图片数量过多。");

  // userId 只认校验过的身份，body 里带什么都不作数。
  await saveGeneratedHistoryEntry({ ...normalized, userId: auth.user.id });

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/history
 *
 * body `{ ids: string[] }` 批量删除；`{ all: true }` 清空。
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // 空 body 视为没有指定要删的记录，而不是清空 —— 清空必须显式传 all。
  }

  const payload = (body ?? {}) as { ids?: unknown; all?: unknown };

  if (payload.all === true) {
    const removed = await clearHistoryEntries(auth.user.id);
    return NextResponse.json({ success: true, removed });
  }

  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((id): id is string => typeof id === "string" && Boolean(id)).slice(0, MAX_DELETE_IDS)
    : [];

  if (!ids.length) return fail(400, "没有指定要删除的记录。");

  const removed = await deleteHistoryEntries(auth.user.id, ids);
  return NextResponse.json({ success: true, removed });
}
