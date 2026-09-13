/**
 * Web3D 导演 persona 契约真源（MOE 改革 Wave2b，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换 Web3D 版（WEB3D_DIRECTOR_PERSONA_ID="web3d-director"、
 *      工具白名单 = blender_export_gltf + 报价对偶 image_quote，与
 *      expert-registry web3d-director 行 toolIds 逐件一致；blender_export_gltf
 *      定义真源 blender-tools.ts L795、L853 BLENDER_HARNESS_TOOL_IDS 经
 *      harness-tool-registry L36 spread；image_quote L76 报价对偶先例；
 *      three.js 域本身无 harness 工具，场景规格走 scene_spec/bundle_ref
 *      交付契约，registry 佔位行注释同源声明）；
 *   ② 委托单/回传契约 import 自 web3d-delegate.ts（Web3D 版委派组装，
 *      交付物三栏 scene_spec/bundle_ref/qc）；
 *   ③ SKILL 挂载：skills/web-3d-awwwards/SKILL.md（2026-09-08 现场验证存在；
 *      与 expert-registry web3d-director 行 skillPaths 同源）。
 * 交互/组装逻辑一行不动：assembleWeb3dDirectorReply 六段同构（唯一出口、
 * 不新增校验、composeWeb3dDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music/screenwriter 版同构——persona
 * 的运行时真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt /
 * AGENTS.md）都在 VPS /opt/agent-harness，本地 repo 无 gateway 真源可改。本档
 * 钉死契约四要素并被委托单/回传两端 import。
 *
 * 隔离铁律：Web3D 导演回传只含交付物契约 + 交付摘要（三栏 payload +
 * web3d_summary ≤500 token），过程（three.js 调试中间态/导出日志/多轮痕迹）
 * 不出 subagent——对应 gateway subagent.ts 既有隔离语义（subagent.delta 只透
 * text、summary 截 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  WEB3D_DELIVERABLES,
  collectWeb3dDeliverableFromToolResult,
  composeWeb3dDelegation,
  type Web3dDelegation,
  type Web3dDelegationResult,
} from "./web3d-delegate";
import type { ExpertDeliverable } from "./expert-contract";
import type { Web3dToolResult } from "./web3d-delegate";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const WEB3D_DIRECTOR_PERSONA_ID = "web3d-director" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值，与 registry 佔位行 label 一致）。 */
export const WEB3D_DIRECTOR_PERSONA_LABEL = "Web3D 导演" as const;

/** persona 一句话定位（设定页/选单描述用，与 registry 佔位行 description 一致）。 */
export const WEB3D_DIRECTOR_PERSONA_DESCRIPTION =
  "Web3D 交互场景：three.js 场景规格与 GLB 资产导出，交付可部署的交互体验。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * Web3D 导演可调用的工具白名单（MOE Wave2b 钉死；禁给全工具面——Web3D
 * 导演不需要画图/跑视频/跑音乐；GLB 资产唯一现成出口 = blender_export_gltf）。
 *
 * id 与 expert-registry web3d-director 行 toolIds 逐件一致，全部在 harness
 * 真源登记在案（行号考古见档头 ①）。
 */
export const WEB3D_DIRECTOR_PERSONA_TOOL_IDS = [
  "blender_export_gltf",
  "image_quote",
] as const;

export type Web3dDirectorPersonaToolId = (typeof WEB3D_DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：skills/web-3d-awwwards/SKILL.md（2026-09-08 现场验证存在；
 * 与 expert-registry web3d-director 行 skillPaths 同源）。
 */
export const WEB3D_DIRECTOR_PERSONA_SKILL_PATHS: readonly string[] = ["skills/web-3d-awwwards/SKILL.md"];

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = web3d-delegate.ts composeWeb3dDelegation 的 schema。
 * 类型全 import（Web3dDelegation / Web3dDelegationResult），此处零重定义。
 */
export type { Web3dDelegation, Web3dDelegationResult };

/** Web3D 域工具回执契约（web3d-delegate.ts 原型 import）。 */
export type { Web3dToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type Web3dDirectorDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：三栏 payload + QC 签名）。 */
      deliverable: ExpertDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      web3d_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music/screenwriter 版同构）。 */
export const WEB3D_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * Web3D 导演回传组装（唯一出口）：Web3D 域工具回执 → 交付物契约 →
 * ExpertDeliverable。两端函数均 import 自 web3d-delegate.ts，本档只做
 * 序列（不新增校验、不改契约形状）。
 */
export function assembleWeb3dDirectorReply(
  result: Web3dToolResult,
  ctx: Parameters<typeof collectWeb3dDeliverableFromToolResult>[1],
): Web3dDirectorDelegationReply {
  const assembled = collectWeb3dDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    web3d_summary: web3dSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function web3dSummaryFromDeliverable(d: ExpertDeliverable, ctx: Parameters<typeof collectWeb3dDeliverableFromToolResult>[1]): string {
  const p = d.payload as {
    scene_spec?: string;
    bundle_ref?: string;
  };
  return [
    `Web3D 交付：场景规格就绪（见交付物）`,
    `资产 bundle：${p.bundle_ref ?? "（见交付物 bundle_ref）"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → Web3D 导演委托单构造（唯一入口）：直接透传 composeWeb3dDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeWeb3dDirectorDelegation = composeWeb3dDelegation;

/** 交付字段白名单 re-export（契约钉死：与 registry web3d-director 行 requiredFields 一一对应）。 */
export { WEB3D_DELIVERABLES };
