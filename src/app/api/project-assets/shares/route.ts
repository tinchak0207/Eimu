// REQ-B2 團隊資產空間 API（顯式分享授權）：
//   POST   { assetKind, assetId, fromProjectId, toProjectId } → 授權（冪等：同鍵重放回 created:false）
//   DELETE { id } 或 { assetKind, assetId, fromProjectId, toProjectId } → 撤銷
// 認證：requireVerifiedUser。
// 紅線：跨項目復用只能靠**這個顯式動作**——沒有隱含可見、沒有「同帳號自動放行」。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { findOwnedAsset } from "@/lib/asset-library";
import { AssetShareConflictError, AssetShareLimitError, grantAssetShare, revokeAssetShare } from "@/lib/asset-scope-store";
import { assetShareId, decideAssetShareGrant, toAssetKind } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

const REJECT_MESSAGES: Record<string, string> = {
  cross_user: "只能分享自己名下的资产",
  not_a_project_asset: "个人资产本身跨项目可用，无需分享；只有项目归属的资产需要显式分享",
  project_mismatch: "分享来源项目与资产归属项目不一致",
  missing_target_project: "缺少目标项目",
  same_project: "来源与目标项目相同，无需分享",
};

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const assetKind = toAssetKind(body?.assetKind);
  const assetId = typeof body?.assetId === "string" ? body.assetId.trim() : "";
  const fromProjectId = typeof body?.fromProjectId === "string" ? body.fromProjectId.trim() : "";
  const toProjectId = typeof body?.toProjectId === "string" ? body.toProjectId.trim() : "";
  if (!assetKind || !assetId || !fromProjectId || !toProjectId) {
    return fail(400, "缺少 assetKind / assetId / fromProjectId / toProjectId", "invalid_payload");
  }

  try {
    const asset = await findOwnedAsset({ userId: caller.user.id, assetKind, assetId });
    if (!asset) return fail(404, "资产不存在", "not_found");
    const decision = decideAssetShareGrant({
      viewerUserId: caller.user.id,
      asset,
      fromProjectId,
      toProjectId,
    });
    if (!decision.ok) {
      // 越權與值域錯分開：不是自己的資產回 403，參數問題回 400。
      const status = decision.reason === "cross_user" ? 403 : 400;
      return fail(status, REJECT_MESSAGES[decision.reason] ?? "分享被拒绝", `share_rejected:${decision.reason}`);
    }
    const { share, created } = await grantAssetShare(caller.user.id, {
      assetKind,
      assetId,
      fromProjectId,
      toProjectId,
    });
    return NextResponse.json({ success: true, share, created }, { status: 200 });
  } catch (error) {
    if (error instanceof AssetShareConflictError) {
      // 確定性鍵碰撞（別名）：這是衝突，不是「已授權」——不得回 success:true 冒充冪等。
      return fail(409, "分享键冲突：该确定性键已对应另一笔授权，请勿复用同一 asset id", "asset_share_conflict");
    }
    if (error instanceof AssetShareLimitError) {
      return fail(400, "分享记录已达上限，请先撤销部分分享", "share_limit");
    }
    console.error("[project-assets] share grant failed:", error);
    return fail(500, "分享资产失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const explicitId = typeof body?.id === "string" ? body.id.trim() : "";
  const assetKind = toAssetKind(body?.assetKind);
  const assetId = typeof body?.assetId === "string" ? body.assetId.trim() : "";
  const fromProjectId = typeof body?.fromProjectId === "string" ? body.fromProjectId.trim() : "";
  const toProjectId = typeof body?.toProjectId === "string" ? body.toProjectId.trim() : "";
  const shareId = explicitId || (assetKind && assetId && fromProjectId && toProjectId
    ? assetShareId(assetKind, assetId, fromProjectId, toProjectId)
    : "");
  if (!shareId) {
    return fail(400, "缺少 id（或 assetKind / assetId / fromProjectId / toProjectId）", "invalid_payload");
  }

  try {
    const revoked = await revokeAssetShare(caller.user.id, shareId);
    return NextResponse.json({ success: true, revoked }, { status: 200 });
  } catch (error) {
    console.error("[project-assets] share revoke failed:", error);
    return fail(500, "撤销分享失败，请稍后再试", "internal_error");
  }
}
