/**
 * GET /api/skills/<id> — 站内只读单条**公开**技能（builtin + recipe + template）。
 *
 * **公开面隔离（2026-09-27 立）**：只在公开集合找，**不得**以 id 直接命中他人的
 * 私有自建 skill（`user-…` id 在此天然 404，不查 user 来源）。自己的私有 skill
 * 走 `GET /api/skills/mine`。
 *
 * 回应：`{ skill }`；找不到回 404 `{ error: "not_found" }`。
 * 只读：不写入、不计费。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSkillByIdPublic } from "@/lib/agent-skills/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const noStore = { "Cache-Control": "no-store" } as const;

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ error: code, success: false, message, code }, { status, headers: noStore });
}

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const skillId = (id ?? "").trim();
  if (!skillId) return notFound();

  try {
    const skill = await getSkillByIdPublic(skillId);
    if (!skill) return notFound();
    return NextResponse.json({ skill }, { headers: noStore });
  } catch (error) {
    console.error("[skills] get failed", error);
    return fail(503, "技能库暂时不可用，请稍后再试。", "skill_read_failed");
  }
}
