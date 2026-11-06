// GET/POST/DELETE /api/agent/memory/mine —— 「我的记忆」：当前用户私有记忆的列表／新增／清空。
//
// 身份只来自 resolveSkillOwner（已验证账号 → ownerKey），绝不读请求里的 owner；
// 只碰 private scope，shared 文档不可经此路由读写。DELETE 必须带 `?confirm=all`，
// 防止误触清库。新增内容过凭证闸（sensitive_content:*），命中原文永不回显。

import { NextRequest, NextResponse } from "next/server";
import { createUserMemory, deleteUserMemories, listMemoryDocs } from "@/lib/agent-memory-store";
import { noStore, resolveSkillOwner } from "@/app/api/skills/mine/owner";
import { notifyGatewayMemoryChanged } from "./notify";
import { toMineView } from "./view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  try {
    const docs = await listMemoryDocs({ scope: "private", ownerKey: owner.ownerKey });
    const memories = docs.map(toMineView).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return NextResponse.json({ memories, total: memories.length }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  let body: { description?: unknown; body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: noStore });
  }
  const description = typeof body.description === "string" ? body.description : "";
  const text = typeof body.body === "string" ? body.body : description;
  try {
    const result = await createUserMemory(owner.ownerKey, { description, body: text });
    if (!result.ok) {
      const status = result.reason === "quota_exceeded" ? 429 : 400;
      return NextResponse.json({ error: result.reason }, { status, headers: noStore });
    }
    await notifyGatewayMemoryChanged(owner.key, {});
    return NextResponse.json({ memory: toMineView(result.value) }, { status: 201, headers: noStore });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  if (req.nextUrl.searchParams.get("confirm") !== "all") {
    return NextResponse.json({ error: "confirm_required" }, { status: 400, headers: noStore });
  }
  try {
    const result = await deleteUserMemories(owner.ownerKey, null);
    await notifyGatewayMemoryChanged(owner.key, { all: true });
    return NextResponse.json(
      { deleted: result.deleted.length, failed: result.failed.length },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}
