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

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/** 一次批量删除最多接受的条数，避免有人拿这个端点做放大攻击。 */
const MAX_DELETE_IDS = 200;

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
  const since = parseTimestamp(searchParams.get("since"));
  const until = parseTimestamp(searchParams.get("until"));

  return {
    ...(keyword ? { keyword: keyword.slice(0, 200) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(parseBoolean(searchParams.get("starred")) ? { starredOnly: true } : {}),
    ...(parseBoolean(searchParams.get("withImage")) ? { withImageOnly: true } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

/**
 * GET /api/history
 *
 * 查询参数：cursor、pageSize、keyword、modelId、imageSize、starred、withImage、since、until、facets。
 * 返回 `{ success, data: { entries, cursor, total }, facets? }`。
 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const { searchParams } = new URL(req.url);
  const pageSize = Number(searchParams.get("pageSize")) || HISTORY_PAGE_SIZE;
  const cursor = searchParams.get("cursor");

  const storedEntries = await listGeneratedHistoryEntries(auth.user.id);
  let taskEntries: HistoryEntry[] = [];
  if (generationControlPlaneEnabled()) {
    try {
      const jobs = await listGenerationJobsForTenant(`web:${auth.user.id}`, { limit: 500 });
      taskEntries = jobs.map(generationJobHistoryEntry);
    } catch (error) {
      console.error("[history] generation task projection unavailable", error);
    }
  }
  const merged = mergeHistoryEntries(storedEntries, taskEntries);
  const data = paginateHistoryEntries(filterHistoryEntries(merged, readQuery(searchParams)), cursor, pageSize);

  // 分面基于全量记录，只有第一屏需要；翻页时不必重复计算。
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
