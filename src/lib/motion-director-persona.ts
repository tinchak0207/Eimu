/**
 * 动态设计 persona 契约真源（MOE 改革 Wave2b，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换动态设计版（MOTION_DIRECTOR_PERSONA_ID="motion-director"、
 *      工具白名单 = keyframe_render + blender 族 blender_exec/blender_render +
 *      报价对偶 image_quote，与 expert-registry motion-director 行 toolIds 逐件
 *      对账；keyframe_render 见 shortdrama-domain/index.ts（L217 定义）经
 *      harness-tool-registry L79 登记；blender 族 = blender-tools.ts
 *      L503/L587 定义、L853 BLENDER_HARNESS_TOOL_IDS 经 harness-tool-registry
 *      L36 spread；image_quote L76 报价对偶，blender/music/video 同款先例）；
 *   ② 委托单/回传契约 import 自 motion-delegate.ts（动态版委派组装，
 *      交付物两栏 motion_spec/qc）；
 *   ③ SKILL 挂载：skills/motion-design/ 有域目录但无域根 SKILL.md（子域
 *      SKILL.md 在 motion-design/、aftereffects-motion/、blender-motion/、
 *      motion-design-critique/ 四子目录，2026-09-08 现场清点），按 2026-09-07
 *      配方库索引先例（记忆 2026-09-07-blender-director-recipes-index）指域
 *      目录，与 expert-registry motion-director 行 skillPaths 同源。
 * 交互/组装逻辑一行不动：assembleMotionDirectorReply 六段同构（唯一出口、
 * 不新增校验、composeMotionDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music/screenwriter 版同构——persona
 * 的运行时真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt /
 * AGENTS.md）都在 VPS /opt/agent-harness，本地 repo 无 gateway 真源可改。本档
 * 钉死契约四要素并被委托单/回传两端 import。
 *
 * 隔离铁律：动态导演回传只含交付物契约 + 交付摘要（两栏 payload +
 * motion_summary ≤500 token），过程（关键帧草稿中间态/渲染日志/多轮痕迹）
 * 不出 subagent——对应 gateway subagent.ts 既有隔离语义（subagent.delta 只透
 * text、summary 截 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  MOTION_DELIVERABLES,
  collectMotionDeliverableFromToolResult,
  composeMotionDelegation,
  type MotionDelegation,
  type MotionDelegationResult,
} from "./motion-delegate";
import type { ExpertDeliverable } from "./expert-contract";
import type { MotionToolResult } from "./motion-delegate";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const MOTION_DIRECTOR_PERSONA_ID = "motion-director" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值，与 registry 佔位行 label 一致）。 */
export const MOTION_DIRECTOR_PERSONA_LABEL = "动态设计" as const;

/** persona 一句话定位（设定页/选单描述用，与 registry 佔位行 description 一致）。 */
export const MOTION_DIRECTOR_PERSONA_DESCRIPTION =
  "动态设计：MG 动画与动态规格，产出 motion_spec 与关键帧预览。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 动态设计可调用的工具白名单（MOE Wave2b 钉死；禁给全工具面——动态导演
 * 不需要画图/跑视频/跑音乐）。
 *
 * id 与 expert-registry motion-director 行 toolIds 逐件一致，全部在 harness
 * 真源登记在案（行号考古见档头 ①；keyframe_render 定义真源
 * shortdrama-domain/index.ts L217，经 harness-tool-registry L79 登记）。
 */
export const MOTION_DIRECTOR_PERSONA_TOOL_IDS = [
  "keyframe_render",
  "blender_exec",
  "blender_render",
  "image_quote",
] as const;

export type MotionDirectorPersonaToolId = (typeof MOTION_DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：skills/motion-design/ 域目录（无域根 SKILL.md；四子域配方
 * motion-design/、aftereffects-motion/、blender-motion/、motion-design-critique/
 * 各自带 SKILL.md，2026-09-08 现场清点），按 2026-09-07 配方库索引先例指域
 * 目录；与 expert-registry motion-director 行 skillPaths 同源。
 */
export const MOTION_DIRECTOR_PERSONA_SKILL_PATHS: readonly string[] = ["skills/motion-design/"];

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = motion-delegate.ts composeMotionDelegation 的 schema。
 * 类型全 import（MotionDelegation / MotionDelegationResult），此处零重定义。
 */
export type { MotionDelegation, MotionDelegationResult };

/** 动态域工具回执契约（motion-delegate.ts 原型 import）。 */
export type { MotionToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type MotionDirectorDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：两栏 payload + QC 签名）。 */
      deliverable: ExpertDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      motion_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music/screenwriter 版同构）。 */
export const MOTION_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 动态设计回传组装（唯一出口）：动态域工具回执 → 交付物契约 →
 * ExpertDeliverable。两端函数均 import 自 motion-delegate.ts，本档只做
 * 序列（不新增校验、不改契约形状）。
 */
export function assembleMotionDirectorReply(
  result: MotionToolResult,
  ctx: Parameters<typeof collectMotionDeliverableFromToolResult>[1],
): MotionDirectorDelegationReply {
  const assembled = collectMotionDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    motion_summary: motionSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function motionSummaryFromDeliverable(d: ExpertDeliverable, ctx: Parameters<typeof collectMotionDeliverableFromToolResult>[1]): string {
  const p = d.payload as {
    motion_spec?: string;
    keyframes?: string[];
  };
  const frameCount = Array.isArray(p.keyframes) ? p.keyframes.length : 0;
  return [
    `动态交付：motion_spec 就绪${frameCount > 0 ? `、关键帧 ${frameCount} 帧（明细见交付物）` : "（规格见交付物）"}`,
    `交付物指针：${d.evidence.artifactPath ?? d.evidence.url ?? "（见交付物 evidence）"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 动态设计委托单构造（唯一入口）：直接透传 composeMotionDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeMotionDirectorDelegation = composeMotionDelegation;

/** 交付字段白名单 re-export（契约钉死：与 registry motion-director 行 requiredFields 一一对应）。 */
export { MOTION_DELIVERABLES };
