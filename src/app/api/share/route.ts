// 作品公開分享：建立 / 列出 / 撤銷。
//
// 三條規矩（都在純函式層有對應斷言，見 src/lib/share-remix.test.ts）：
//   ①shareId 由 128-bit 隨機產生，不能由 artifact/entry id 推得。
//   ②預設不公開——沒有點過分享就沒有記錄，/p/<shareId> 查無此頁。
//   ③撤銷＝刪記錄，刪完同一條連結當場 404。
//
// 圖片位元組沿用既有 artifact/blob owner（server-history-store 的 persistGeneratedImage），
// 這裡不另造存儲、不搬圖片。

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

/** 分享者自己的邀請碼（密鑰缺失＝不帶，分享照常）。 */
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
 * POST /api/share — 把一件自己的作品分享出去（或取回既有連結）。
 *
 * body `{ entryId, resultIndex?, hidePrompt? }`。
 * 幂等：同一件作品重複呼叫回同一條連結（使用者貼出去的連結不能被悄悄換掉）。
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
    // 助理圖卡「分享」是先 POST /api/history 補寫、緊接著建分享：落在另一個實例時，
    // 該實例的歷史索引快取（3s）可能還是寫入前的版本。等快取過期重讀一次再判 404。
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    entries = await listGeneratedHistoryEntries(auth.user.id);
    entry = entries.find((item) => item.id === entryId);
  }
  // 不存在与不属于自己一律同一句话：不洩漏「這個 id 存在但不是你的」。
  if (!entry) return fail(404, "找不到这件作品。");

  const requestedIndex = Number.isFinite(body.resultIndex) ? Number(body.resultIndex) : 0;
  const picked = shareableResult(entry, requestedIndex);
  if (!picked.ok) return fail(400, picked.reason);

  // 結果只帶 base64 時（本地補錄、上游直回）先經既有 artifact owner 轉存成公開 URL；
  // 分享頁只認 URL，不把幾 MB 的 base64 塞進記錄。
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

/** GET /api/share — 自己的分享清單（歷史卡據此顯示「已分享」與連結）。 */
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
 * PATCH /api/share — 改可見性（隱藏／恢復提示詞）。
 * body `{ shareId, hidePrompt }`。所有權只認驗證過的身份。
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

/** DELETE /api/share — 撤銷。body `{ shareId }`。撤銷後 /p/<shareId> 立即 404。 */
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
