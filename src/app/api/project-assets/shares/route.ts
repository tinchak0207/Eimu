// REQ-B2 团队资产空间 API（显式分享授权）：
//   POST   { assetKind, assetId, fromProjectId, toProjectId } → 授权（幂等：同键重放回 created:false）
//   DELETE { id } 或 { assetKind, assetId, fromProjectId, toProjectId } → 撤销
// 认证：requireVerifiedUser。
// 红线：跨项目复用只能靠**这个显式动作**——没有隐含可见、没有「同帐号自动放行」。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { findOwnedAsset } from "@/lib/asset-library";
import { AssetShareConflictError, AssetShareLimitError, grantAssetShare, revokeAssetShare } from "@/lib/asset-scope-store";
import { assetShareId, decideAssetShareGrant, toAssetKind } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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
      // 越权与值域错分开：不是自己的资产回 403，参数问题回 400。
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
      // 确定性键碰撞（别名）：这是冲突，不是「已授权」——不得回 success:true 冒充幂等。
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
