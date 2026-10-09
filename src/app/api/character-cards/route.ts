// 角色/场景卡 API（P2 跨镜头一致性）：
//   GET    → 列出当前用户全部卡
//   POST   → 建立卡（id 可省略，服务端铸造）
//   PATCH  → 按 id 部分更新（name/kind/prompt/references/negativePrompt/loraIds）
//   DELETE → 批量删除（{ ids }）
// 认证：requireVerifiedUser（与 canvas/projects 同款，不信任 x-user-id）。
// 存储：character-card-store（Blob 世代模式，对齐 project-store）。
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  deleteCharacterCards,
  listCharacterCards,
  saveCharacterCard,
} from "@/lib/character-card-store";
import { normalizeCharacterCard } from "@/lib/character-cards";
import type { CharacterCard } from "@/lib/character-cards";
import { MAX_ASSET_PROJECT_TAGS, projectTagIdsOverLimit } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function mintCardId(): string {
  return `card-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    const cards = await listCharacterCards(caller.user.id);
    return NextResponse.json({ success: true, cards }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[character-cards] list failed:", error);
    return fail(500, "读取角色卡失败，请稍后再试", "internal_error");
  }
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  // 修复 3：项目标签超上限一律 fail-loud 拒收（不再让 normalizeProjectIds 静默截断丢标签）。
  if (projectTagIdsOverLimit(body?.projectIds)) {
    return fail(400, `项目标签最多 ${MAX_ASSET_PROJECT_TAGS} 个`, "too_many_project_tags");
  }
  const normalized = normalizeCharacterCard({
    ...body,
    ...(typeof body?.id === "string" && body.id.trim() ? {} : { id: mintCardId() }),
  });
  if (!normalized) return fail(400, "缺少 name 或格式非法", "invalid_payload");

  try {
    await saveCharacterCard(caller.user.id, normalized);
    return NextResponse.json({ success: true, card: normalized }, { status: 200 });
  } catch (error) {
    console.error("[character-cards] create failed:", error);
    return fail(500, "保存角色卡失败，请稍后再试", "internal_error");
  }
}

export async function PATCH(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return fail(400, "缺少 id", "invalid_payload");
  // 修复 3：项目标签超上限一律 fail-loud 拒收（未给 projectIds ＝ 不动，不在此拒）。
  if (projectTagIdsOverLimit(body?.projectIds)) {
    return fail(400, `项目标签最多 ${MAX_ASSET_PROJECT_TAGS} 个`, "too_many_project_tags");
  }

  try {
    const cards = await listCharacterCards(caller.user.id);
    const current = cards.find((c) => c.id === id);
    if (!current) return fail(404, "卡不存在", "not_found");
    // 部分更新：未提供的栏位沿用现值；normalizeCharacterCard 统一清洗。
    // P1-A：`projectIds` 走同一套局部更新语义——patch 未带 → `{...current}` 保留既有标签
    //（＝「未给＝不动」）；显式给值（含空阵列）才以该值为准。清洗在 normalizeCharacterCard。
    // 值一律经 normalizeCharacterCard 收口清洗，这里的 cast 只过型别关。
    const patch = body as Partial<CharacterCard>;
    const merged: CharacterCard = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const normalized = normalizeCharacterCard(merged);
    if (!normalized) return fail(400, "更新后格式非法", "invalid_payload");
    await saveCharacterCard(caller.user.id, normalized);
    return NextResponse.json({ success: true, card: normalized }, { status: 200 });
  } catch (error) {
    console.error("[character-cards] update failed:", error);
    return fail(500, "更新角色卡失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (!ids.length) return fail(400, "缺少 ids", "invalid_payload");

  try {
    const deleted = await deleteCharacterCards(caller.user.id, ids);
    return NextResponse.json({ success: true, deleted }, { status: 200 });
  } catch (error) {
    console.error("[character-cards] delete failed:", error);
    return fail(500, "删除角色卡失败，请稍后再试", "internal_error");
  }
}
