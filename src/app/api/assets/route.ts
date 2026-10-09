// 资产包 API：list / upsert / delete。
// 认证：requireVerifiedUser（上游 /api/user/self 验证，不信任 x-user-id）。
//
// item kind 契约（由 src/lib/deliverable-kind.ts 注册表推导，asset-pack-store 收口）：
//   * 资产专属：prompt / reference / lora / recipe / scene_3d / bpy_script；
//   * 交付物媒体：image（有 imageUrl）/ video（有 mediaUrl）/ audio（有 mediaUrl）。
//   video/audio 缺 mediaUrl 的 item 会在 normalizeAssetPack 被 drop（本路由只收干净包）。
//
// P0-2 资产团队维度（写入端闸）：PUT 接受 `scope.owner === "team"` —— 照
// `src/lib/canvas/team-canvas-gate.ts` 的既有模式：用 `lookupTeamMembershipViaRelay`
// 验成员身份，并以**relay 回的权威 teamId 盖章**（客户端送来的 teamId 一律不采信）。
//   * relay 回 null（未配置／逾时／查不到）→ **fail-open 降级个人**（不拒、不写进别人的团队），
//     与画布闸的「查不到成员身份 → 降级个人命名空间」同语义。
//   * 宣告 team 但客户端送的 teamId 与权威值不符 → 降级个人（**不**写进别人的团队）。
//   * 非 team 宣告（personal / project）→ 完全不查 relay，零额外开销、既有语义逐位不变。
// 本路由不碰任何计费/配额（RBAC 与团队配额由后续刀接手）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  AssetPackLimitError,
  deleteAssetPacks,
  listAssetPacks,
  normalizeAssetPack,
  saveAssetPack,
} from "@/lib/asset-pack-store";
import type { AssetPack } from "@/lib/asset-pack-store";
import { MAX_ASSET_PROJECT_TAGS, projectTagIdsOverLimit } from "@/lib/asset-scope";
import { decideTeamAssetScope, lookupAssetsTeamMembership } from "@/lib/asset-team-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    let packs = await listAssetPacks(caller.user.id);
    if (q) {
      packs = packs.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          (p.digest ?? "").toLowerCase().includes(q),
      );
    }
    return NextResponse.json({ success: true, packs }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[asset-packs] list failed:", error);
    return fail(500, "读取资产包失败，请稍后再试", "internal_error");
  }
}

export async function PUT(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Partial<AssetPack> | null = null;
  try {
    body = (await req.json()) as Partial<AssetPack>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  // 修复 3：项目标签超上限一律 fail-loud 拒收（不再让 normalizeProjectIds 静默截断丢标签）。
  // 放在「缺键不动」合并之前：只对本次请求**显式送来**的 projectIds 判长度（未给＝不动，不拒）。
  if (projectTagIdsOverLimit(body?.projectIds)) {
    return fail(400, `项目标签最多 ${MAX_ASSET_PROJECT_TAGS} 个`, "too_many_project_tags");
  }
  // P1-A 项目标签语义（纯加法）：**未给 projectIds ＝ 不动**——一次不带标签的整包 PUT
  // 不得静默清空既有标签；显式给值（含空阵列＝明确清除）才以该值为准。
  // 依据的既有范式＝/api/character-cards PATCH 的 `{...current, ...patch}` 局部更新
  //（未提供的栏位沿用现值）；清洗仍由 normalizeAssetPack 收口，本路由不重复实作白名单。
  if (body && typeof body === "object" && body.projectIds === undefined) {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id) {
      const existing = (await listAssetPacks(caller.user.id)).find((p) => p.id === id);
      if (existing?.projectIds?.length) body = { ...body, projectIds: existing.projectIds };
    }
  }
  // 清洗 + 归属栏位（存档端的唯一收口；team 的权威盖章在下面的闸）。projectIds 由
  // normalizeAssetPack 内的 normalizeProjectIds 清洗，读取端原样回传（不从回应剥除）。
  const cleaned = normalizeAssetPack(body);
  if (!cleaned) {
    return fail(400, "资产包数据无效（需要 id / title，items 每项需要合法 kind / title）", "invalid_payload");
  }

  // P0-2：team 宣告的写入端闸——以 relay 权威 teamId 盖章；查不到成员身份（fail-open）
  // 或客户端送的 teamId 与权威值不符 → 降级个人（不拒、不写进别人的团队）。
  // 归属栏位**一律由本闸重新落定**（清洗出的 scope 只是「宣告」，不是权威）。
  let normalized: AssetPack = cleaned;
  if (cleaned.scope?.owner === "team") {
    const membership = await lookupAssetsTeamMembership(caller.user.id);
    const decision = decideTeamAssetScope({ declaredTeamId: cleaned.scope.teamId, membership });
    const { scope: _dropped, ...rest } = cleaned;
    // decision.ok → 盖章（authoritative teamId）；否则降级个人（**剥掉** scope 栏，
    // personal 恒省略栏位，不写 `{owner:"personal"}` 冒充已设定）。
    normalized = decision.ok
      ? { ...cleaned, scope: decision.scope }
      : (rest as AssetPack);
    void _dropped;
  }

  try {
    await saveAssetPack(caller.user.id, normalized);
    return NextResponse.json({ success: true, pack: normalized }, { status: 200 });
  } catch (error) {
    if (error instanceof AssetPackLimitError) {
      return fail(400, "资产包数量已达上限 100 个，请先删除部分资产包", "asset_limit");
    }
    console.error("[asset-packs] save failed:", error);
    return fail(500, "保存资产包失败，请稍后再试", "internal_error");
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
    await deleteAssetPacks(caller.user.id, ids);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("[asset-packs] delete failed:", error);
    return fail(500, "删除资产包失败，请稍后再试", "internal_error");
  }
}
