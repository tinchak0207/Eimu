// 超分档位可用性判据（**客户端安全**叶模组）。
//
// 为什么独立成档：`generation-core/upscale-tier.ts` 的 env 开关（`upscale-4k-flag.ts`）
// 是服务端专用；而 `generation-model-catalog/capabilities.ts` 会进客户端 bundle
// （ModelPicker／ImagePlayground／画布 hook）。把「哪些档位未校准」这一条纯判据放在本档，
// 双方共用同一份规则，同时客户端路径永远不会 import 任何 env 读取模组。
//
// 本档零 import（只有 type-only）：不拖 node/DB/catalog 进客户端。
//
// 单一真源：`UPSCALE_UNVERIFIED_TIERS` 是「未校准档位」的唯一清单；
// `upscale-tier.ts` 的 `UPSCALE_TIER_CONTRACTS[*].semantics` 必须与之一致（4k）。

import type { UpscaleTier } from "../generation-model-catalog/types";

/** 上游语义尚未由真单校准的档位（默认 fail-closed，仅服务端开关可放行）。 */
export const UPSCALE_UNVERIFIED_TIERS: readonly UpscaleTier[] = ["4k"];

export function isUpscaleTierUnverified(tier: UpscaleTier): boolean {
  return UPSCALE_UNVERIFIED_TIERS.includes(tier);
}

/** 档位是否可提交：未校准档位仅在 `fourKEnabled=true` 时可提交；其余恒可。 */
export function isUpscaleTierServable(tier: UpscaleTier, fourKEnabled: boolean = false): boolean {
  return isUpscaleTierUnverified(tier) ? fourKEnabled : true;
}

/** 可提交档位（声明序）。`declared` 由调用端给（客户端路径恒传 false 的开关）。 */
export function servableUpscaleTiers(
  declared: readonly UpscaleTier[],
  fourKEnabled: boolean = false,
): readonly UpscaleTier[] {
  return declared.filter((tier) => isUpscaleTierServable(tier, fourKEnabled));
}

/** 一键预设档位＝最高可提交档位；全被过滤时回 "1k"（不会回空）。 */
export function defaultUpscaleTier(
  declared: readonly UpscaleTier[],
  fourKEnabled: boolean = false,
): UpscaleTier {
  const servable = servableUpscaleTiers(declared, fourKEnabled);
  return servable.length ? servable[servable.length - 1] : "1k";
}
