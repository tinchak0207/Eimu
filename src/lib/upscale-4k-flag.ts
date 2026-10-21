// 4K 超分上游校准开关（**服务端专用**，禁止被 client component 或任何客户端可达模组 import）。
//
// 为什么独立成档（红队 2026-10-05）：`generation-core/upscale-tier.ts` 经
// `generation-model-catalog/capabilities.ts` 进客户端 bundle。若在那里读
// `process.env.UPSCALE_4K_UPSTREAM`，内部 env 名会泄漏到公开 JS 产物。
// 因此 env 读取只留在本档，服务端调用点（两个 upscale 提交路由、/v1/models）
// 把本函式的回传值注入受限函式的 `fourKEnabled` 参数；客户端与共享能力投射
// 不 import 本档，恒走 `fourKEnabled = false`（默认 fail-closed）。
//
// 语义（与 P1-3 `VIDEO_POST_PRODUCTION_UPSTREAM` 同一手法）：
//   · 未设／空值／其他值 ⇒ false（默认关闭，4K 档位对提交端具名拒）
//   · "1" 或 "true"（大小写不敏感，允许前后空白）⇒ true（校准后放行 4K）
//
// 本档零 import：不拖 node 内建／DB／catalog 进任何调用方。

/** 4K 档位的上游语义是否已由真单校准（env `UPSCALE_4K_UPSTREAM`）。 */
export function upscaleFourKUpstreamEnabled(): boolean {
  const value = (process.env.UPSCALE_4K_UPSTREAM ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}
