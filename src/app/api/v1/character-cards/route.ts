// GET/POST /v1/character-cards — 开发/测试挂载点；生产 `/v1/*` 会被 next.config.mjs 的
// beforeFiles 改写代理到控制面 origin（见 src/lib/biz-character-cards-route.ts 档头说明），
// 因此真正服务 agent 的是 `/api/biz/character-cards`。
//
// 本档**零业务逻辑**：实现只有一份，在 src/lib/biz-character-cards-route.ts。
// 这里只保留 Next.js 的 route segment config（必须在 route 档内字面导出，不能被 re-export 带走）。
export { GET, POST } from "@/lib/biz-character-cards-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）
