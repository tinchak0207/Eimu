/**
 * DELETE /api/skills/mine/<id> — 刪除**自己**的一條私有自建 skill。
 *
 * 語義：使用者私有庫的 CRUD（下架自己的東西），**沒有**「公開市集下架」這回事。
 * 不屬於自己／不存在一律回 **404**（不用 403，不以狀態碼洩漏他人資源存在性）。
 * 未登入在 `resolveSkillOwner` 就 401（與 GET/POST 同一支身份入口，非第二套鑑權）。
 *
 * 薄殼：業務本體在 `@/lib/agent-skills/user-skill` 的 `deleteMySkill`
 * （複用 store 的 `retractMemoryDocs`，不自造第二套刪除）。
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteMySkill } from "@/lib/agent-skills/user-skill";
import { noStore, resolveSkillOwner } from "../owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
