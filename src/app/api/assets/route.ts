// 資產包 API：list / upsert / delete。
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。
//
// item kind 契約（由 src/lib/deliverable-kind.ts 註冊表推導，asset-pack-store 收口）：
//   * 資產專屬：prompt / reference / lora / recipe / scene_3d / bpy_script；
//   * 交付物媒體：image（有 imageUrl）/ video（有 mediaUrl）/ audio（有 mediaUrl）。
//   video/audio 缺 mediaUrl 的 item 會在 normalizeAssetPack 被 drop（本路由只收乾淨包）。
//
// P0-2 資產團隊維度（寫入端閘）：PUT 接受 `scope.owner === "team"` —— 照
// `src/lib/canvas/team-canvas-gate.ts` 的既有模式：用 `lookupTeamMembershipViaRelay`
// 驗成員身份，並以**relay 回的權威 teamId 蓋章**（客戶端送來的 teamId 一律不採信）。
//   * relay 回 null（未配置／逾時／查不到）→ **fail-open 降級個人**（不拒、不寫進別人的團隊），
//     與畫布閘的「查不到成員身份 → 降級個人命名空間」同語義。
//   * 宣告 team 但客戶端送的 teamId 與權威值不符 → 降級個人（**不**寫進別人的團隊）。
//   * 非 team 宣告（personal / project）→ 完全不查 relay，零額外開銷、既有語義逐位不變。
// 本路由不碰任何計費/配額（RBAC 與團隊配額由後續刀接手）。
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
import { decideTeamAssetScope, lookupAssetsTeamMembership } from "@/lib/asset-team-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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
  // 清洗 + 歸屬欄位（存檔端的唯一收口；team 的權威蓋章在下面的閘）。
  const cleaned = normalizeAssetPack(body);
  if (!cleaned) {
    return fail(400, "资产包数据无效（需要 id / title，items 每项需要合法 kind / title）", "invalid_payload");
  }

  // P0-2：team 宣告的寫入端閘——以 relay 權威 teamId 蓋章；查不到成員身份（fail-open）
  // 或客戶端送的 teamId 與權威值不符 → 降級個人（不拒、不寫進別人的團隊）。
  // 歸屬欄位**一律由本閘重新落定**（清洗出的 scope 只是「宣告」，不是權威）。
  let normalized: AssetPack = cleaned;
  if (cleaned.scope?.owner === "team") {
    const membership = await lookupAssetsTeamMembership(caller.user.id);
    const decision = decideTeamAssetScope({ declaredTeamId: cleaned.scope.teamId, membership });
    const { scope: _dropped, ...rest } = cleaned;
    // decision.ok → 蓋章（authoritative teamId）；否則降級個人（**剝掉** scope 欄，
    // personal 恆省略欄位，不寫 `{owner:"personal"}` 冒充已設定）。
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
