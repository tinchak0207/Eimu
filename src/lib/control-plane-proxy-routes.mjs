// 控面代理清單的單一真源：next.config.mjs 的 rewrites().beforeFiles 由此生成，
// src/lib/control-plane-proxy-routes.test.ts 以此對 src/app/api 做漂移棘輪。
// 純 ESM、無依賴（next.config.mjs 在建置期直接 import）。
// 注意：本清單是逐條列舉，不是通配；新增/刪除條目會改生產路由，且控面副本不一定有該 route。

export const CONTROL_PLANE_PROXY_SOURCES = [
  // Vercel remains the public web edge while durable work runs beside its
  // PostgreSQL database and worker on the VPS.
  "/v1/:path*",
  // /api/v1/* 與 /v1/* 是同一套 B 端 API 的兩個入口（afterFiles 把 /v1 視為
  // /api/v1 的別名）。若不在 beforeFiles 一併代理，直打 /api/v1 的請求會落在
  // Vercel 本地 route——而 Vercel 按 设计不持有 GENERATION_DATABASE_URL，
  // getGenerationJobForTenant 首次觸庫即拋錯 → 任何任務 ID 都 500（2026-08-21
  // 實測：成功任務、不存在任務全部 500）。控制面在 /image-control/api/v1/*
  // 前綴下可達（已驗證 200），代理後兩個入口語義一致。
  "/api/v1/:path*",
  "/api/generate-images",
  // 裸路徑要單獨列一條。Next 的 `/:path*` 不匹配「後面完全沒有一段」的
  // `/api/generation-jobs`，而前端提交新任務打的正是這個裸路徑（帶 :path*
  // 的那條只服務 /api/generation-jobs/<id> 這種輪詢）。少了這條，POST 會
  // 落在 Vercel，而 Vercel 沒有 GENERATION_CONTROL_PLANE_ENABLED 與
  // GENERATION_DATABASE_URL，於是回 503 control_plane_disabled，前端退回
  // 舊生成路徑並把上游直鏈交給瀏覽器（載不到、下載失敗）。
  "/api/generation-jobs",
  "/api/generation-jobs/:path*",
  // 下列四條 2026-09-28 由漂移棘輪揪出：route 只有裸路徑（原 `/:path*` 匹配不到、
  // 控面也沒有子路徑），且直接觸庫、Vercel 無閘 → 登入後必 500。控面容器內實測四條皆 401（存在）。
  "/api/admin/billing-operations",
  "/api/admin/biz-keys/provision",
  "/api/probe/stuck",
  "/api/probe/jobs/:path*",
  // 團隊歸屬橋（HMAC 簽名通道，域 team-membership）。Vercel 側不持有
  // GENERATION_DATABASE_URL，畫布閘門要判「該 user 是否為團隊成員」只能問
  // 控制面；同樣列在 beforeFiles，否則會落在 Vercel 上的同名 route（會被
  // 本地副本以「映射層未配置」擋下，永遠看不到真實歸屬）。
  "/api/internal/team-membership",
  // 營銷郵件退訂：email_preference 在控制面 postgres。
  "/api/email/unsubscribe",
  // OpenAI 同步兼容層（2026-09-28）。必須在控面執行，不能留在 Vercel：
  // ①同步等待要等生成完成（實測 p50 ≈36s），而本專案 Vercel 是 Hobby，函數
  // 硬上限 60s，等待中的函數會被平台硬殺，連 504 都送不出去；
  // ②`/openai/v1/models` 的熔斷／斷供閘要讀 GENERATION_DATABASE_URL，Vercel
  // 不持有該環境變數，留在本地只會 fail-open（把已斷供的模型照樣列出去）。
  // 控面沒有函數時長上限，且直接持有資料庫，兩件事同時解決。
  "/openai/v1/:path*",
  // 後台統計（2026-09-30）：統計投影要讀帳本與能力表（GENERATION_DATABASE_URL），Vercel 側
  // 不持該庫 ⇒ 本地副本只能回「本實例沒有控制面資料庫連線…統計不可用」的降級投影，後台看板上
  // 永遠沒有真數字（CSV 導出／類別切分同理）。控面同時有庫與該 route，故代理過去執行。
  // 前提（缺了代理過去也只是 401）：控面要有 ADMIN_SESSION_SECRET／ADMIN_USERNAME
  // ——簽發 session 的秘密原本只在 Vercel，2026-09-30 已同步進控面 .env.control-plane。
  "/api/admin/statistics",
  // 模型路由（2026-10-01 路由收口）：讀寫 model_route_override 與 supplier 表，只在控面庫；
  // 面板顯示＝調度器同一份 resolveModelRoute 結果。
  "/api/admin/model-routes",
  // PixAI 同步計費路由（2026-09-28，V-08）：扣退款改走 generation-core/sync-charge
  // 帳本門面，需 GENERATION_DATABASE_URL；留在 Vercel 只會回落直扣、不留帳本列。
  // 鑑權同 /api/generate-images（authenticateImageUser，已在控面運行）；上游同
  // /api/v1/images/edits 的 proxyPixai（已在控面運行）。
  "/api/pixai/edit",
  "/api/pixai/upscale",
  "/api/pixai/template-generations",
  // 分鏡門禁／逐鏡配音（2026-10-01）：兩條都走 `readCanvasProject`／
  // `mutateCanvasProject`（canvas project-store 閉包觸 GENERATION_DATABASE_URL）。
  // Vercel 側不持有該庫，留在本地即 500（讀畫布失敗）；且 voiceover 真跑本就走
  // 控制面生成管線（`generationControlPlaneEnabled()` 未配置即 503）。控面同一
  // 份 Next 應用（basePath /image-control）持有這兩條 route，故 beforeFiles 代理過去。
  "/api/canvas/storyboard-qc",
  "/api/canvas/storyboard-voiceover",
];

/**
 * @param {string | undefined | null} origin 已 trim、去尾斜線的控面 origin
 * @returns {{ source: string; destination: string }[]}
 */
export function controlPlaneRewrites(origin) {
  if (!origin) return [];
  return CONTROL_PLANE_PROXY_SOURCES.map((s) => ({
    source: s,
    destination: `${origin}/image-control${s}`,
  }));
}
