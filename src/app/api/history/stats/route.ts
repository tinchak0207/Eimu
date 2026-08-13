import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { listGeneratedHistoryEntries } from "@/lib/server-history-store";
import { buildHistoryFacets, buildHistoryStats, mergeHistoryEntries } from "@/lib/history-types";
import type { HistoryEntry } from "@/lib/history-types";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { listGenerationJobsForTenant } from "@/lib/generation-core/job-repository";
import { generationJobHistoryEntry } from "@/lib/generation-task-history";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/**
 * GET /api/history/stats
 *
 * 返回本站保存的历史记录的汇总与分面。
 * 注意：这里的 quota 只统计本站记录里能确认的消耗，不等于账户的累计消耗 ——
 * 账户级别的累计数字仍旧取上游的 /api/log/self/stat，两者不要混用。
 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  const storedEntries = await listGeneratedHistoryEntries(auth.user.id);
  let entries: HistoryEntry[] = storedEntries;
  if (generationControlPlaneEnabled()) {
    try {
      const jobs = await listGenerationJobsForTenant(`web:${auth.user.id}`, { limit: 500 });
      entries = mergeHistoryEntries(storedEntries, jobs.map(generationJobHistoryEntry));
    } catch (error) {
      console.error("[history-stats] generation tasks unavailable", error);
    }
  }
  const stats = buildHistoryStats(entries);
  const facets = buildHistoryFacets(entries);

  return NextResponse.json({ success: true, data: stats, facets });
}
