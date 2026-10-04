/**
 * DELETE /api/skills/mine/<id> — 删除**自己**的一条私有自建 skill。
 *
 * 语义：使用者私有库的 CRUD（下架自己的东西），**没有**「公开市集下架」这回事。
 * 不属于自己／不存在一律回 **404**（不用 403，不以状态码泄漏他人资源存在性）。
 * 未登入在 `resolveSkillOwner` 就 401（与 GET/POST 同一支身份入口，非第二套鉴权）。
 *
 * 薄壳：业务本体在 `@/lib/agent-skills/user-skill` 的 `deleteMySkill`
 * （复用 store 的 `retractMemoryDocs`，不自造第二套删除）。
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteMySkill } from "@/lib/agent-skills/user-skill";
import { noStore, resolveSkillOwner } from "../owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;

  const { id } = await context.params;
  const result = await deleteMySkill(owner.ownerKey, id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, success: false },
      { status: result.status, headers: noStore },
    );
  }
  return NextResponse.json({ ok: true, id: result.id }, { headers: noStore });
}
