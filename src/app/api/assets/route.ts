// 資產包 API：list / upsert / delete。
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。
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
import { lookupTeamMembershipViaRelay, type TeamMembership } from "@/lib/team-membership-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 團隊閘的成員查詢簽名（測試可注入；缺省＝真實 relay）。 */
export interface AssetsTeamGateDeps {
  membership?: (userId: number) => Promise<TeamMembership | null>;
}

/**
 * 團隊閘的注入點（**測試用**）：route handler 的簽名由 Next.js 的
 * `.next/types/validator` 釘死，第二參數必須是 `{ params: Promise<{}> }`，
 * 故不能把 deps 塞進簽名。改為模組層可覆寫（測試設、測完還原）。
 * 生產路徑下恆為 undefined → 走真實 relay 查詢。
 */
let teamGateDeps: AssetsTeamGateDeps = {};

/** 僅測試：覆寫團隊閘的成員查詢（傳 undefined 還原真實 relay）。 */
export function __setAssetsTeamGateDepsForTests(deps?: AssetsTeamGateDeps): void {
  teamGateDeps = deps ?? {};
}

/**
 * team 作用域的寫入端裁決（純函式，資料源＝relay 的 membership）。
 *
 * 回 `{ ok: true, scope }`：
 *  - 非 team 宣告 → 原樣（personal / project 完全不走這裡的團隊邏輯）
 *  - team 宣告 + relay 權威 teamId 且（客戶端沒送 teamId 或送的與權威值相符）→ team 作用域，teamId ＝ **權威值**
 * 回 `{ ok: false }`：宣告 team 但 teamId 對不上權威值 → 呼叫端**降級個人**（fail-open，
 * 不拒、不寫進別人的團隊；與畫布閘同語義）。
 */
export function decideTeamAssetScope(input: {
  declaredTeamId: unknown;
  membership: TeamMembership | null;
}): { ok: true; scope: { owner: "team"; teamId: string } } | { ok: false } {
  const authoritativeTeamId =
    input.membership && typeof input.membership.teamId === "string" ? input.membership.teamId.trim() : "";
  if (!authoritativeTeamId) return { ok: false };
  const declared =
    typeof input.declaredTeamId === "string" && input.declaredTeamId.trim() ? input.declaredTeamId.trim() : null;
  if (declared && declared !== authoritativeTeamId) return { ok: false };
  return { ok: true, scope: { owner: "team", teamId: authoritativeTeamId } };
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
    const membership = await (teamGateDeps.membership
      ? teamGateDeps.membership(caller.user.id)
      : lookupTeamMembershipViaRelay(caller.user.id));
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
