/**
 * GET /api/skills — 站内只读**公开**技能列举/搜寻（builtin + recipe + template）。
 *
 * **公开面隔离（2026-09-27 立）**：本端点**永不**含任何使用者的私有自建 skill——
 * 即使呼叫者登入也一样（公开列举与身份无关，不读 user 来源插槽）。`source=user`
 * 因此不是合法筛选值（回 400，不静默回空集合假装「没有」）。「我的技能」走
 * `GET /api/skills/mine`（需登入），前端要「公开＋我的」就打两支端点。
 *
 * query：`family=<家族id>`、`q=<关键词>`、`source=builtin|recipe|template`、`limit=<n>`。
 * 回应：`{ skills, total, families }`；`total` = 过滤后总数（未受 limit 截断），
 * `families` = 全家族列举（id + 简体标签 + 公开库条目数，含 0 条的家族）。
 * 只读：不写入、不计费、不动任何帐本。
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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const noStore = { "Cache-Control": "no-store" } as const;

/** 单次回应上限（公开库全量 151 条，500 足够且能挡扫库）。 */
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
