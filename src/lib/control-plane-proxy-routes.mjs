// 控面代理清单的单一真源：next.config.mjs 的 rewrites().beforeFiles 由此生成，
// src/lib/control-plane-proxy-routes.test.ts 以此对 src/app/api 做漂移棘轮。
// 纯 ESM、无依赖（next.config.mjs 在建置期直接 import）。
// 注意：本清单是逐条列举，不是通配；新增/删除条目会改生产路由，且控面副本不一定有该 route。

export const CONTROL_PLANE_PROXY_SOURCES = [
  // Vercel remains the public web edge while durable work runs beside its
  // PostgreSQL database and worker on the VPS.
  "/v1/:path*",
  // /api/v1/* 与 /v1/* 是同一套 B 端 API 的两个入口（afterFiles 把 /v1 视为
  // /api/v1 的别名）。若不在 beforeFiles 一并代理，直打 /api/v1 的请求会落在
  // Vercel 本地 route——而 Vercel 按 设计不持有 GENERATION_DATABASE_URL，
  // getGenerationJobForTenant 首次触库即抛错 → 任何任务 ID 都 500（2026-08-21
  // 实测：成功任务、不存在任务全部 500）。控制面在 /image-control/api/v1/*
  // 前缀下可达（已验证 200），代理后两个入口语义一致。
  "/api/v1/:path*",
  "/api/generate-images",
  // 裸路径要单独列一条。Next 的 `/:path*` 不匹配「后面完全没有一段」的
  // `/api/generation-jobs`，而前端提交新任务打的正是这个裸路径（带 :path*
  // 的那条只服务 /api/generation-jobs/<id> 这种轮询）。少了这条，POST 会
  // 落在 Vercel，而 Vercel 没有 GENERATION_CONTROL_PLANE_ENABLED 与
  // GENERATION_DATABASE_URL，于是回 503 control_plane_disabled，前端退回
  // 旧生成路径并把上游直链交给浏览器（载不到、下载失败）。
  "/api/generation-jobs",
  "/api/generation-jobs/:path*",
  // 下列四条 2026-09-28 由漂移棘轮揪出：route 只有裸路径（原 `/:path*` 匹配不到、
  // 控面也没有子路径），且直接触库、Vercel 无闸 → 登入后必 500。控面容器内实测四条皆 401（存在）。
  "/api/admin/billing-operations",
  "/api/admin/biz-keys/provision",
  "/api/probe/stuck",
  "/api/probe/jobs/:path*",
  // 团队归属桥（HMAC 签名通道，域 team-membership）。Vercel 侧不持有
  // GENERATION_DATABASE_URL，画布闸门要判「该 user 是否为团队成员」只能问
  // 控制面；同样列在 beforeFiles，否则会落在 Vercel 上的同名 route（会被
  // 本地副本以「映射层未配置」挡下，永远看不到真实归属）。
  "/api/internal/team-membership",
  // 营销邮件退订：email_preference 在控制面 postgres。
  "/api/email/unsubscribe",
  // OpenAI 同步兼容层（2026-09-28）。必须在控面执行，不能留在 Vercel：
  // ①同步等待要等生成完成（实测 p50 ≈36s），而本专案 Vercel 是 Hobby，函数
  // 硬上限 60s，等待中的函数会被平台硬杀，连 504 都送不出去；
  // ②`/openai/v1/models` 的熔断／断供闸要读 GENERATION_DATABASE_URL，Vercel
  // 不持有该环境变数，留在本地只会 fail-open（把已断供的模型照样列出去）。
  // 控面没有函数时长上限，且直接持有资料库，两件事同时解决。
  "/openai/v1/:path*",
  // 后台统计（2026-09-30）：统计投影要读帐本与能力表（GENERATION_DATABASE_URL），Vercel 侧
  // 不持该库 ⇒ 本地副本只能回「本实例没有控制面资料库连线…统计不可用」的降级投影，后台看板上
  // 永远没有真数字（CSV 导出／类别切分同理）。控面同时有库与该 route，故代理过去执行。
  // 前提（缺了代理过去也只是 401）：控面要有 ADMIN_SESSION_SECRET／ADMIN_USERNAME
  // ——签发 session 的秘密原本只在 Vercel，2026-09-30 已同步进控面 .env.control-plane。
  "/api/admin/statistics",
  // 模型路由（2026-10-01 路由收口）：读写 model_route_override 与 supplier 表，只在控面库；
  // 面板显示＝调度器同一份 resolveModelRoute 结果。
  "/api/admin/model-routes",
  // 管理员调额（2026-10-01）：占位表 admin_account_adjustment 与 account_ledger 都在控面库，
  // 上游管理凭证也只在控面；留在 Vercel 触库即 500。
  "/api/admin/account-adjustments",
  // PixAI 同步计费路由（2026-09-28，V-08）：扣退款改走 generation-core/sync-charge
  // 帐本门面，需 GENERATION_DATABASE_URL；留在 Vercel 只会回落直扣、不留帐本列。
  // 鉴权同 /api/generate-images（authenticateImageUser，已在控面运行）；上游同
  // /api/v1/images/edits 的 proxyPixai（已在控面运行）。
  "/api/pixai/edit",
  "/api/pixai/upscale",
  "/api/pixai/template-generations",
  // 分镜门禁／逐镜配音（2026-10-01）：两条都走 `readCanvasProject`／
  // `mutateCanvasProject`（canvas project-store 闭包触 GENERATION_DATABASE_URL）。
  // Vercel 侧不持有该库，留在本地即 500（读画布失败）；且 voiceover 真跑本就走
  // 控制面生成管线（`generationControlPlaneEnabled()` 未配置即 503）。控面同一
  // 份 Next 应用（basePath /image-control）持有这两条 route，故 beforeFiles 代理过去。
  "/api/canvas/storyboard-qc",
  "/api/canvas/storyboard-voiceover",
];

/**
 * @param {string | undefined | null} origin 已 trim、去尾斜线的控面 origin
 * @returns {{ source: string; destination: string }[]}
 */
export function controlPlaneRewrites(origin) {
  if (!origin) return [];
  return CONTROL_PLANE_PROXY_SOURCES.map((s) => ({
    source: s,
    destination: `${origin}/image-control${s}`,
  }));
}
