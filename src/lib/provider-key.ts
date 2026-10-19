// 生成渠道键的**单一真源**（零依赖叶模组）。
//
// 为什么独立成档：红队 2026-10-05 实测线上 JS 产物泄漏内部渠道名（原 `image_`＋`eimu` 拼接）
// （65 处，在 `_next/static/chunks/*.js`）。改为中性值后，任何客户端可达模组
// 都从本档取键，不再各处硬写；本档零 import，保证可被历史模型（history-types）
// 与 node --test 直接加载，不把 generation-model-catalog 等拖进测试环境。
//
// 契约性判定（逐处取证）：
//   · 服务端 `readGenerateImageRequest` 读取 form `provider` 后**从未使用**
//     （generate-images/route.ts:219 赋值、:470 解构未取 provider）⇒ 非契约值。
//   · 历史记录 `results[].provider` 仅透传/存储，全库无 `provider === "…"` 比较
//     （唯一比较在 ImagePlayground.tsx:732 `img.provider === key`，两端同源）。
//   · 故改值安全；旧持久化值经 `normalizeProviderKey` 收敛，回读不破展示。

/** 当前唯一生成渠道的键。原内部名已移除，改用中性值。 */
export type ProviderKey = "primary";

/** 渠道键常量（客户端数组索引/展示分组用；不含任何内部标识）。 */
export const PROVIDER_KEY: ProviderKey = "primary";

/**
 * 把任意来源（旧 localStorage 缓存、服务端响应）的 provider 值收敛成当前键。
 * 我方只有一个渠道，任何非空值都归一到 `PROVIDER_KEY`；回读旧值不丢图。
 */
export function normalizeProviderKey(_value: unknown): ProviderKey {
  return PROVIDER_KEY;
}