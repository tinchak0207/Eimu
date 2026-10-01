// GET /v1/templates — 模板目錄。
//
// 2026-08-05 從 VPS 補回 repo。目錄是公開的（C 端瀏覽器不帶 key 直接取），
// 不出圖、不計費，因此沒有認證與扣費環節。

import { json, pixaiError, proxyPixai } from "@/lib/pixai-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

export async function GET() {
  const { status, data } = await proxyPixai("templates", undefined, "GET");
  if (status === 200) return json(data, 200);
  return json(pixaiError(data, "Template catalog unavailable."), status >= 400 ? status : 502);
}
