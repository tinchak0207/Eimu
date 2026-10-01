/**
 * GET /api/skills — 站內只讀**公開**技能列舉/搜尋（builtin + recipe + template）。
 *
 * **公開面隔離（2026-09-27 立）**：本端點**永不**含任何使用者的私有自建 skill——
 * 即使呼叫者登入也一樣（公開列舉與身份無關，不讀 user 來源插槽）。`source=user`
 * 因此不是合法篩選值（回 400，不靜默回空集合假裝「沒有」）。「我的技能」走
 * `GET /api/skills/mine`（需登入），前端要「公開＋我的」就打兩支端點。
 *
 * query：`family=<家族id>`、`q=<關鍵詞>`、`source=builtin|recipe|template`、`limit=<n>`。
 * 回應：`{ skills, total, families }`；`total` = 過濾後總數（未受 limit 截斷），
 * `families` = 全家族列舉（id + 簡體標籤 + 公開庫條目數，含 0 條的家族）。
 * 只讀：不寫入、不計費、不動任何帳本。
 */

import { NextRequest, NextResponse } from "next/server";
import { AGENT_SKILL_FAMILY_LABELS } from "@/lib/agent-skills";
import {
  PUBLIC_SKILL_SOURCES,
  listPublicSkills,
  listSkillFamilies,
  searchPublicSkills,
  type AgentSkillSource,
} from "@/lib/agent-skills/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const noStore = { "Cache-Control": "no-store" } as const;

/** 單次回應上限（公開庫全量 151 條，500 足夠且能擋掃庫）。 */
const MAX_LIMIT = 500;

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ error: code, success: false, message, code }, { status, headers: noStore });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const family = params.get("family")?.trim() ?? "";
  const source = params.get("source")?.trim() ?? "";
  const q = params.get("q") ?? "";
  const limitRaw = params.get("limit")?.trim() ?? "";

  if (family && !(family in AGENT_SKILL_FAMILY_LABELS)) {
    return fail(400, `未知的题材家族：${family}`, "invalid_request");
  }
  if (source && !(PUBLIC_SKILL_SOURCES as readonly string[]).includes(source)) {
    return fail(400, `未知的来源：${source}`, "invalid_request");
  }
  let limit: number | undefined;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fail(400, "limit 必须为正整数。", "invalid_request");
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const all = await listPublicSkills();
    const families = listSkillFamilies(all);

    let matched = q.trim() ? await searchPublicSkills(q) : all;
    if (family) matched = matched.filter((skill) => skill.family === family);
    if (source) matched = matched.filter((skill) => skill.source === (source as AgentSkillSource));

    const total = matched.length;
    const skills = limit === undefined ? matched : matched.slice(0, limit);
    return NextResponse.json({ skills, total, families }, { headers: noStore });
  } catch (error) {
    console.error("[skills] list failed", error);
    return fail(503, "技能库暂时不可用，请稍后再试。", "skill_read_failed");
  }
}
