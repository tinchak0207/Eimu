// PATCH/DELETE /api/agent/memory/mine/[id] —— 改／删当前用户自己的一条私有记忆。
// 删除是硬删（正文＋历史世代＋目录＋索引），不是撤回留证。id 不属于该用户一律 404。

import { NextRequest, NextResponse } from "next/server";
import { deleteUserMemories, updateUserMemory } from "@/lib/agent-memory-store";
import { noStore, resolveSkillOwner } from "@/app/api/skills/mine/owner";
import { toMineView } from "../view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  const { id } = await ctx.params;
  let body: { description?: unknown; body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: noStore });
  }
  try {
    const result = await updateUserMemory(owner.ownerKey, id, {
      description: typeof body.description === "string" ? body.description : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 400;
      return NextResponse.json({ error: result.reason }, { status, headers: noStore });
    }
    return NextResponse.json({ memory: toMineView(result.value) }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  const { id } = await ctx.params;
  try {
    const result = await deleteUserMemories(owner.ownerKey, [id]);
    if (result.deleted.length === 0 && result.failed.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    }
    return NextResponse.json({ deleted: result.deleted.length, failed: result.failed.length }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}
