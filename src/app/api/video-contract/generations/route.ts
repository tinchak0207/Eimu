// 影片生成的动作合同入口（2026-10-20）。
//
// 为什么需要这个别名路由：next.config.mjs 的 beforeFiles 把 `/v1/*` 与 `/api/v1/*`
// 直接代理到控制面，请求根本不会进 Next 的 `/api/v1/videos/generations` 处理器，
// 于是站点侧的动作合同（directVideoPrompt）看不到任何 B 端影片请求。控制面镜像
// 又不能在 4GB 生产机上原地重建。这里让 next.config 用精确重写把这两个路径先导到
// 本路由：处理器套完合同后，走既有的 GENERATION_CONTROL_PLANE_PROXY_ORIGIN 代理
// 把带合同的 prompt 交给控制面。
//
// 实作只包一层 re-export，不复制处理器；x-eimu-video-contract 响应头是路由
// 是否真的被命中的探针（2026-10-20 用它验证 beforeFiles 顺序）。
import type { NextRequest } from "next/server";
import { POST as generationsPOST, runtime, preferredRegion } from "../../v1/videos/generations/route";

export { runtime, preferredRegion };

export async function POST(req: NextRequest): Promise<Response> {
  const response = await generationsPOST(req);
  const headers = new Headers(response.headers);
  headers.set("x-eimu-video-contract", "1");
  return new Response(response.body, { status: response.status, headers });
}
