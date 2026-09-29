/**
 * GET  /api/skills/mine — 列出**當前身份**的私有自建 skill。
 * POST /api/skills/mine — 建立或更新當前身份的一條私有自建 skill。
 *
 * 定性（2026-09-27 修正）：使用者自建 skill 是**私有庫 CRUD**，**沒有**「發布到
 * 公開市集」這個語義——公開列舉（`GET /api/skills`）永不包含任何人的 user skill。
 * 故本端點取代了原本語義錯誤的 `publish` 端點（同日刪除）。
 *
 * 本 route 只是薄殼：身份 → `resolveSkillOwner`（不是第二套鑑權）；業務本體
 * （歸屬判定／驗證／憑證閘／store 互動）在 `@/lib/agent-skills/user-skill` 的
 * `saveMySkill`，故同一段行為可被單元測試直接驅動（真行為斷言，非源碼掃描）。
 *
 * POST body（草稿，全部由 validateUserSkill 正規化）：
 *   { name, oneLiner, family, useScenario, inputType, outputContent,
 *     outputKind, toolIds, expertId?, tags, aesthetic?, id? }
 *   `id` 存在且屬於自己＝更新；否則建立（外來／未知 id 被丟棄，改由驗證器派生）。
 * 響應：GET `{ skills }`；POST 成功 `{ skill, created }`；
 *   400 `{ error: "invalid_skill", reason }`（含憑證閘的 `sensitive_content:<kind>`）；
 *   409 `{ error: "duplicate", reason }`；429 `{ error: "quota_exceeded", reason }`。
 * **永不**把 reason／body／命中片段寫進 log——憑證閘命中的原文不經此處外洩。
 */

import { NextRequest, NextResponse } from "next/server";
import { listMySkills, registerUserSkillSource } from "@/lib/agent-skills/registry";
import { saveMySkill, userSkillLoader, type UserSkillDraft } from "@/lib/agent-skills/user-skill";
import { noStore, resolveSkillOwner } from "./owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 把 user-skill 的載入器接上 registry 的 ownerKey 插槽：registry 的私有列舉
// （`listMySkills` 等）與本端點因此走同一份讀取邏輯，不會有兩條會分叉的路。
// 公開列舉不讀這個插槽，故此註冊不影響公開面。
registerUserSkillSource(userSkillLoader);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;

  try {
    const skills = await listMySkills(owner.ownerKey);
    return NextResponse.json({ skills }, { headers: noStore });
  } catch {
    // 不對外帶內部訊息（可能含路徑細節）。
    return NextResponse.json({ error: "internal_error", success: false }, { status: 500, headers: noStore });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;

  let body: UserSkillDraft;
  try {
    body = (await req.json()) as UserSkillDraft;
  } catch {
    return NextResponse.json({ error: "invalid_json", success: false }, { status: 400, headers: noStore });
  }

  const result = await saveMySkill(owner.ownerKey, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, success: false, reason: result.reason },
      { status: result.status, headers: noStore },
    );
  }
  return NextResponse.json({ skill: result.skill, created: result.created }, { headers: noStore });
}
