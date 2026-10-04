/**
 * GET  /api/skills/mine — 列出**当前身份**的私有自建 skill。
 * POST /api/skills/mine — 建立或更新当前身份的一条私有自建 skill。
 *
 * 定性（2026-09-27 修正）：使用者自建 skill 是**私有库 CRUD**，**没有**「发布到
 * 公开市集」这个语义——公开列举（`GET /api/skills`）永不包含任何人的 user skill。
 * 故本端点取代了原本语义错误的 `publish` 端点（同日删除）。
 *
 * 本 route 只是薄壳：身份 → `resolveSkillOwner`（不是第二套鉴权）；业务本体
 * （归属判定／验证／凭证闸／store 互动）在 `@/lib/agent-skills/user-skill` 的
 * `saveMySkill`，故同一段行为可被单元测试直接驱动（真行为断言，非源码扫描）。
 *
 * POST body（草稿，全部由 validateUserSkill 正规化）：
 *   { name, oneLiner, family, useScenario, inputType, outputContent,
 *     outputKind, toolIds, expertId?, tags, aesthetic?, id? }
 *   `id` 存在且属于自己＝更新；否则建立（外来／未知 id 被丢弃，改由验证器派生）。
 * 响应：GET `{ skills }`；POST 成功 `{ skill, created }`；
 *   400 `{ error: "invalid_skill", reason }`（含凭证闸的 `sensitive_content:<kind>`）；
 *   409 `{ error: "duplicate", reason }`；429 `{ error: "quota_exceeded", reason }`。
 * **永不**把 reason／body／命中片段写进 log——凭证闸命中的原文不经此处外泄。
 */

import { NextRequest, NextResponse } from "next/server";
import { listMySkills, registerUserSkillSource } from "@/lib/agent-skills/registry";
import { saveMySkill, userSkillLoader, type UserSkillDraft } from "@/lib/agent-skills/user-skill";
import { noStore, resolveSkillOwner } from "./owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

// 把 user-skill 的载入器接上 registry 的 ownerKey 插槽：registry 的私有列举
// （`listMySkills` 等）与本端点因此走同一份读取逻辑，不会有两条会分叉的路。
// 公开列举不读这个插槽，故此注册不影响公开面。
registerUserSkillSource(userSkillLoader);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;

  try {
    const skills = await listMySkills(owner.ownerKey);
    return NextResponse.json({ skills }, { headers: noStore });
  } catch {
    // 不对外带内部讯息（可能含路径细节）。
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
