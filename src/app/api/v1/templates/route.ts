// GET /v1/templates — 模板目录。
//
// 2026-08-05 从 VPS 补回 repo。目录是公开的（C 端浏览器不带 key 直接取），
// 不出图、不计费，因此没有认证与扣费环节。

import { json, pixaiError, proxyPixai } from "@/lib/pixai-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET() {
  const { status, data } = await proxyPixai("templates", undefined, "GET");
  if (status === 200) return json(data, 200);
  return json(pixaiError(data, "Template catalog unavailable."), status >= 400 ? status : 502);
}
