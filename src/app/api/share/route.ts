// 作品公开分享：建立 / 列出 / 撤销。
//
// 三条规矩（都在纯函式层有对应断言，见 src/lib/share-remix.test.ts）：
//   ①shareId 由 128-bit 随机产生，不能由 artifact/entry id 推得。
//   ②预设不公开——没有点过分享就没有记录，/p/<shareId> 查无此页。
//   ③撤销＝删记录，删完同一条连结当场 404。
//
// 图片位元组沿用既有 artifact/blob owner（server-history-store 的 persistGeneratedImage），
// 这里不另造存储、不搬图片。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { listGeneratedHistoryEntries, persistGeneratedImage } from "@/lib/server-history-store";
import { getSiteUrl } from "@/lib/site-url";
import { inviteCodeFor, referralSecret } from "@/lib/referral-code";
import { isShareId } from "@/lib/share-id";
import {
  buildShareSnapshot,
  buildShareUrl,
  shareableResult,
  type ShareSnapshot,
} from "@/lib/share-remix";
import { createShare, listSharesForUser, revokeShare, setShareHidden } from "@/lib/share-store";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/** 分享者自己的邀请码（密钥缺失＝不带，分享照常）。 */
function ownInviteCode(userId: number): string | null {
  const secret = referralSecret();
  return secret ? inviteCodeFor(userId, secret) : null;
}

function fail(status: number, message: string) {
  return NextResponse.json({ success: false, message }, { status });
}

interface CreateBody {
  entryId?: unknown;
  resultIndex?: unknown;
  hidePrompt?: unknown;
}

/**
 * POST /api/share — 把一件自己的作品分享出去（或取回既有连结）。
 *
 * body `{ entryId, resultIndex?, hidePrompt? }`。
 * 幂等：同一件作品重复呼叫回同一条连结（使用者贴出去的连结不能被悄悄换掉）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return fail(400, "请求体不是合法的 JSON。");
  }

  const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
  if (!entryId) return fail(400, "缺少作品 id。");

  let entries = await listGeneratedHistoryEntries(auth.user.id);
  let entry = entries.find((item) => item.id === entryId);
  if (!entry) {
    // 助理图卡「分享」是先 POST /api/history 补写、紧接著建分享：落在另一个实例时，
    // 该实例的历史索引快取（3s）可能还是写入前的版本。等快取过期重读一次再判 404。
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    entries = await listGeneratedHistoryEntries(auth.user.id);
    entry = entries.find((item) => item.id === entryId);
  }
  // 不存在与不属于自己一律同一句话：不泄漏「这个 id 存在但不是你的」。
  if (!entry) return fail(404, "找不到这件作品。");

  const requestedIndex = Number.isFinite(body.resultIndex) ? Number(body.resultIndex) : 0;
  const picked = shareableResult(entry, requestedIndex);
  if (!picked.ok) return fail(400, picked.reason);

  // 结果只带 base64 时（本地补录、上游直回）先经既有 artifact owner 转存成公开 URL；
  // 分享页只认 URL，不把几 MB 的 base64 塞进记录。
  let imageUrl = picked.result.imageUrl ?? "";
  if (picked.needsPersist) {
    if (!picked.result.image) return fail(400, "这一项没有可分享的图片。");
    try {
      imageUrl = await persistGeneratedImage(auth.user.id, entry.id, picked.result.provider, picked.result.image);
    } catch (error) {
      console.error("[share] 转存图片失败", error);
      return fail(502, "图片转存失败，请稍后重试。");
    }
  }

  const snapshot: ShareSnapshot | null = buildShareSnapshot(entry, picked.index, imageUrl);
  if (!snapshot) return fail(400, "这一项没有可分享的图片。");

  const { record, reused } = await createShare({
    userId: auth.user.id,
    entryId: entry.id,
    resultIndex: picked.index,
    hidePrompt: body.hidePrompt === true,
    snapshot,
  });

  const siteUrl = await getSiteUrl();
  return NextResponse.json({
    success: true,
    data: {
      shareId: record.shareId,
      url: buildShareUrl(siteUrl, record.shareId, ownInviteCode(auth.user.id)),
      path: `/p/${record.shareId}`,
      hidePrompt: record.hidePrompt,
      resultIndex: record.resultIndex,
      createdAt: record.createdAt,
      reused,
    },
  });
}

/** GET /api/share — 自己的分享清单（历史卡据此显示「已分享」与连结）。 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const siteUrl = await getSiteUrl();
  const shares = await listSharesForUser(auth.user.id);
  return NextResponse.json({
    success: true,
    data: {
      shares: shares.map((item) => ({
        ...item,
        url: buildShareUrl(siteUrl, item.shareId, ownInviteCode(auth.user.id)),
        path: `/p/${item.shareId}`,
      })),
    },
  });
}

/**
 * PATCH /api/share — 改可见性（隐藏／恢复提示词）。
 * body `{ shareId, hidePrompt }`。所有权只认验证过的身份。
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  let body: { shareId?: unknown; hidePrompt?: unknown };
  try {
    body = (await req.json()) as { shareId?: unknown; hidePrompt?: unknown };
  } catch {
    return fail(400, "请求体不是合法的 JSON。");
  }

  const shareId = typeof body.shareId === "string" ? body.shareId : "";
  if (!isShareId(shareId)) return fail(400, "分享 id 不合法。");

  const record = await setShareHidden(auth.user.id, shareId, body.hidePrompt === true);
  if (!record) return fail(404, "找不到这条分享。");

  const siteUrl = await getSiteUrl();
  return NextResponse.json({
    success: true,
    data: {
      shareId: record.shareId,
      url: buildShareUrl(siteUrl, record.shareId, ownInviteCode(auth.user.id)),
      hidePrompt: record.hidePrompt,
    },
  });
}

/** DELETE /api/share — 撤销。body `{ shareId }`。撤销后 /p/<shareId> 立即 404。 */
export async function DELETE(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  let body: { shareId?: unknown };
  try {
    body = (await req.json()) as { shareId?: unknown };
  } catch {
    return fail(400, "请求体不是合法的 JSON。");
  }

  const shareId = typeof body.shareId === "string" ? body.shareId : "";
  if (!isShareId(shareId)) return fail(400, "分享 id 不合法。");

  const revoked = await revokeShare(auth.user.id, shareId);
  if (!revoked) return fail(404, "找不到这条分享。");

  return NextResponse.json({ success: true, data: { shareId, revoked: true } });
}
