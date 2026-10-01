/**
 * GET /api/skills/<id> — 站內只讀單條**公開**技能（builtin + recipe + template）。
 *
 * **公開面隔離（2026-09-27 立）**：只在公開集合找，**不得**以 id 直接命中他人的
 * 私有自建 skill（`user-…` id 在此天然 404，不查 user 來源）。自己的私有 skill
 * 走 `GET /api/skills/mine`。
 *
 * 回應：`{ skill }`；找不到回 404 `{ error: "not_found" }`。
 * 只讀：不寫入、不計費。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSkillByIdPublic } from "@/lib/agent-skills/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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
