import { NextResponse } from "next/server";
import { useVpsBlobBackend } from "@/lib/blob-backend";
import {
  generationControlPlaneEnabled,
  generationDatabaseConfigured,
} from "@/lib/generation-core/database";

/**
 * /api/version — 「生產跑的是哪一版」的最小可查證面。
 *
 * 存在理由：過去只能事後取證（Vercel files API 抓原始源碼比 md5、逐 chunk grep），
 * 而 alias 曾 34 小時未更新、跑的是舊部署（memory `mapay-fee-rejection-fix-0920`），
 * 「HEAD 已修的代碼」≠「生產在跑的代碼」是常態風險。本端點讓這條問題有一等公民答案。
 *
 * 誠實邊界（不得誇大）：
 *   - 本端點只證明「這個部署是哪個 commit、哪個建置時間、哪些後端生效」，
 *     不證明功能可用。HTTP 200 ≠ 可用。
 *   - 禁止快取：被邊緣/CDN 快取的版本回應本身就是假證據，故 force-dynamic + no-store。
 *
 * 安全：只輸出後端名稱與布林，永不輸出任何 secret / 憑證 / token 的值。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

// ⚠️ 必須寫成「字面 process.env.X」：Next 的 env 內聯（DefinePlugin）只替換字面成員存取，
// 動態 `process.env[name]` 不會被替換，會靜默取到 runtime 的空值（本檔初版就踩到，
// 已用建置產物 `.next/server/app/api/version/route.js` grep 出內聯常數證偽）。
// 建置期由 next.config.mjs 凍結；本機（無 Vercel 注入）為空字串 → 明說 unknown。
const BUILD_COMMIT_SHA = process.env.BUILD_COMMIT_SHA ?? "";
const BUILD_COMMIT_REF = process.env.BUILD_COMMIT_REF ?? "";
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP ?? "";

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function envText(name: string): string | null {
  return text(process.env[name]);
}

export async function GET() {
  // builtAt 用建置期凍結值，不用 route 內的 new Date()——那是「請求時間」，
  // 被誤讀成建置時間正是假記憶的來源之一。
  // commit/ref 先看建置期注入，再 fallback 到 runtime 的 Vercel 系統變數
  // （VERCEL_GIT_COMMIT_SHA 只在 build 階段保證存在），最後明說 unknown，不編造假值。
  const commit =
    text(BUILD_COMMIT_SHA) ?? envText("VERCEL_GIT_COMMIT_SHA") ?? "unknown";
  const ref =
    text(BUILD_COMMIT_REF) ?? envText("VERCEL_GIT_COMMIT_REF") ?? "unknown";
  const builtAt = text(BUILD_TIMESTAMP) ?? "unknown";

  // 儲存後端判斷一律呼叫既有 selector，不在此重寫規則（單源）。
  // `useVpsBlobBackend` 不是 React hook，是 blob-backend 的同步後端選擇器，只因命名以 use
  // 開頭被 react-hooks/rules-of-hooks 誤判。單源判斷不可在此重抄一份，故就地豁免該規則。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const vpsBlobConfigured = useVpsBlobBackend();
  const vercelBlobTokenPresent = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
  const storage = vpsBlobConfigured
    ? "vps-image-data-api"
    : vercelBlobTokenPresent
      ? "vercel-blob"
      : "unconfigured";

  return NextResponse.json(
    {
      commit,
      ref,
      builtAt,
      deployment: {
        id: envText("VERCEL_DEPLOYMENT_ID"),
        env: envText("VERCEL_ENV") ?? "local",
        url: envText("VERCEL_URL"),
        region: envText("VERCEL_REGION"),
      },
      backends: {
        storage,
        storageVpsConfigured: vpsBlobConfigured,
        storageVercelTokenPresent: vercelBlobTokenPresent,
        controlPlaneEnabled: generationControlPlaneEnabled(),
        controlPlaneDatabaseConfigured: generationDatabaseConfigured(),
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
