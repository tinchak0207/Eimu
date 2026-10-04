import { NextResponse } from "next/server";
import { useVpsBlobBackend } from "@/lib/blob-backend";
import {
  generationControlPlaneEnabled,
  generationDatabaseConfigured,
} from "@/lib/generation-core/database";

/**
 * /api/version — 「生产跑的是哪一版」的最小可查证面。
 *
 * 存在理由：过去只能事后取证（Vercel files API 抓原始源码比 md5、逐 chunk grep），
 * 而 alias 曾 34 小时未更新、跑的是旧部署（memory `mapay-fee-rejection-fix-0920`），
 * 「HEAD 已修的代码」≠「生产在跑的代码」是常态风险。本端点让这条问题有一等公民答案。
 *
 * 诚实边界（不得夸大）：
 *   - 本端点只证明「这个部署是哪个 commit、哪个建置时间、哪些后端生效」，
 *     不证明功能可用。HTTP 200 ≠ 可用。
 *   - 禁止快取：被边缘/CDN 快取的版本回应本身就是假证据，故 force-dynamic + no-store。
 *
 * 安全：只输出后端名称与布林，永不输出任何 secret / 凭证 / token 的值。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

// ⚠️ 必须写成「字面 process.env.X」：Next 的 env 内联（DefinePlugin）只替换字面成员存取，
// 动态 `process.env[name]` 不会被替换，会静默取到 runtime 的空值（本档初版就踩到，
// 已用建置产物 `.next/server/app/api/version/route.js` grep 出内联常数证伪）。
// 建置期由 next.config.mjs 冻结；本机（无 Vercel 注入）为空字串 → 明说 unknown。
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
  // builtAt 用建置期冻结值，不用 route 内的 new Date()——那是「请求时间」，
  // 被误读成建置时间正是假记忆的来源之一。
  // commit/ref 先看建置期注入，再 fallback 到 runtime 的 Vercel 系统变数
  // （VERCEL_GIT_COMMIT_SHA 只在 build 阶段保证存在），最后明说 unknown，不编造假值。
  const commit =
    text(BUILD_COMMIT_SHA) ?? envText("VERCEL_GIT_COMMIT_SHA") ?? "unknown";
  const ref =
    text(BUILD_COMMIT_REF) ?? envText("VERCEL_GIT_COMMIT_REF") ?? "unknown";
  const builtAt = text(BUILD_TIMESTAMP) ?? "unknown";

  // 储存后端判断一律呼叫既有 selector，不在此重写规则（单源）。
  // `useVpsBlobBackend` 不是 React hook，是 blob-backend 的同步后端选择器，只因命名以 use
  // 开头被 react-hooks/rules-of-hooks 误判。单源判断不可在此重抄一份，故就地豁免该规则。
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
