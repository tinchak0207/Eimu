// GET/POST /api/biz/character-cards — agent 工具真正会打到的挂载点。
//
// `/api/biz/*` **不在** next.config.mjs 的 beforeFiles 改写清单里（清单只有 `/v1/:path*`、
// `/api/v1/:path*`、`/api/generate-images`、`/api/generation-jobs(:path*)`、
// `/api/admin/billing-operations/:path*`），所以这里是 Vercel 全功能应用在服务：
// 有 Blob、有完整五值卡模型（character/scene/style/prop/audio）。
//
// 本档**零业务逻辑**：实现只有一份，在 src/lib/biz-character-cards-route.ts（与
// `/api/v1/character-cards` 共用同一份处理逻辑与同一份契约）。
// 这里只保留 Next.js 的 route segment config（必须在 route 档内字面导出，不能被 re-export 带走）。
export { GET, POST } from "@/lib/biz-character-cards-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
