import { NextResponse } from "next/server";

/**
 * /api/version — 「生产跑的是哪一版」的最小可查证面。
 *
 * 存在理由：过去只能事后取证（Vercel files API 抓原始源码比 md5、逐 chunk grep），
 * 而 alias 曾 34 小时未更新、跑的是旧部署（memory `mapay-fee-rejection-fix-0920`），
 * 「HEAD 已修的代码」≠「生产在跑的代码」是常态风险。本端点让这条问题有一等公民答案。
 *
 * 诚实边界（不得夸大）：
 *   - 本端点只证明「这个部署的建置时间」，不证明功能可用。HTTP 200 ≠ 可用。
 *   - 禁止快取：被边缘/CDN 快取的版本回应本身就是假证据，故 force-dynamic + no-store。
 *
 * 安全（2026-10-05 红队）：
 *   - 已剥离 deployment（Vercel 部署 id／URL／region）与 backends（储存后端、
 *     controlPlaneEnabled 等开关）——那是内部部署指纹，不是版本号。
 *   - 本次再剥离 `commit`/`ref`（生产＝git SHA）：精确 SHA 让对手对到 commit 后
 *     可直接打该版本已知 CVE；SHA 不属公开契约也无消费者（全 repo grep 无
 *     `/api/version` 的程式化消费者；`tools/check-deploy-freshness.ts` 走 Vercel
 *     部署 API 的 meta.gitCommitSha，与本端点无关），故不再回传。
 *     「生产是否新鲜」仍由 `builtAt`（建置期冻结的 ISO 时间）回答；不编造假值，
 *     取不到就明说 unknown。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

// ⚠️ 必须写成「字面 process.env.X」：Next 的 env 内联（DefinePlugin）只替换字面成员存取，
// 动态 `process.env[name]` 不会被替换，会静默取到 runtime 的空值（本档初版就踩到，
// 已用建置产物 `.next/server/app/api/version/route.js` grep 出内联常数证伪）。
// 建置期由 next.config.mjs 冻结；本机（无 Vercel 注入）为空字串 → 明说 unknown。
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP ?? "";

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function GET() {
  // builtAt 用建置期冻结值，不用 route 内的 new Date()——那是「请求时间」，
  // 被误读成建置时间正是假记忆的来源之一。取不到就明说 unknown，不编造。
  const builtAt = text(BUILD_TIMESTAMP) ?? "unknown";

  return NextResponse.json(
    { builtAt },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
