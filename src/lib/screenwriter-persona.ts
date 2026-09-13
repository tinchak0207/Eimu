/**
 * 编剧分镜 persona 契约真源（MOE 改革 Wave2b 片，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/music-director-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换编剧版（SCREENWRITER_PERSONA_ID="screenwriter"、工具白名单
 *      六个编剧域 harness 工具 + image_quote，id 面已在 harness-tool-registry
 *      考古登记在案——script_scene_parse L86 / story_sequence_consistency L87 /
 *      storyboard_qc_17 L88 / doc_struct L69 / world_bible_extract L114 /
 *      canvas_apply_ops L37 / image_quote L76，行号以现场为准）；
 *   ② 委托单/回传契约 import 自 screenwriter-delegate.ts（编剧版委派组装，
 *      交付物三栏 beats/shotlist/qc）；
 *   ③ SKILL 挂载：skills/ 无编剧域配方库，SKILL_PATH 为空（skill 待补，
 *      expert-registry screenwriter 佔位行同源声明）。
 * 交互/组装逻辑一行不动：assembleScreenwriterReply 六段同构（唯一出口、
 * 不新增校验、composeScreenwriterDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music 版同构——persona 的运行时
 * 真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt /
 * AGENTS.md）都在 VPS /opt/agent-harness，本地 repo 无 gateway 真源可改。
 * 本档钉死契约四要素并被委托单/回传两端 import。
 *
 * 隔离铁律：编剧分镜回传只含交付物契约 + 交付摘要（三栏 payload +
 * screenwriter_summary ≤500 token），过程（解析日志/分镜草稿中间态/多轮
 * 痕迹）不出 subagent——对应 gateway subagent.ts 既有隔离语义（subagent.delta
 * 只透 text、summary 截 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  SCREENWRITER_DELIVERABLES,
  collectScreenwriterDeliverableFromToolResult,
  composeScreenwriterDelegation,
  type ScreenwriterDelegation,
  type ScreenwriterDelegationResult,
} from "./screenwriter-delegate";
import type { ExpertDeliverable } from "./expert-contract";
import type { ScreenwriterToolResult } from "./screenwriter-delegate";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const SCREENWRITER_PERSONA_ID = "screenwriter" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值，与 registry 佔位行 label 一致）。 */
export const SCREENWRITER_PERSONA_LABEL = "编剧分镜" as const;

/** persona 一句话定位（设定页/选单描述用，与 registry 佔位行 description 一致）。 */
export const SCREENWRITER_PERSONA_DESCRIPTION =
  "剧本与分镜：故事节拍、分镜清单与一致性，输出 beats 与 shotlist。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 编剧分镜可调用的工具白名单（MOE Wave2b 钉死；禁给全工具面——编剧分镜
 * 不需要画图/跑 Blender/渲染视频）。
 *
 * 六个编剧域工具 + image_quote 报价查询，id 全部在 harness-tool-registry
 * 登记在案（行号考古见档头 ①；registry 佔位行 toolIds 为考古六件，
 * image_quote 为 persona 常量补充，与 blender/music 版同款）。
 */
export const SCREENWRITER_PERSONA_TOOL_IDS = [
  "script_scene_parse",
  "storyboard_qc_17",
  "story_sequence_consistency",
  "canvas_apply_ops",
  "doc_struct",
  "world_bible_extract",
  "image_quote",
] as const;

export type ScreenwriterPersonaToolId = (typeof SCREENWRITER_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：skills/ 无编剧域配方库（无域目录），SKILL_PATH 为空数组
 * （skill 待补；与 expert-registry screenwriter 佔位行 skillPaths: [] 同源）。
 */
export const SCREENWRITER_PERSONA_SKILL_PATHS: readonly string[] = [];

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = screenwriter-delegate.ts composeScreenwriterDelegation 的
 * schema。类型全 import（ScreenwriterDelegation / ScreenwriterDelegationResult），
 * 此处零重定义。
 */
export type { ScreenwriterDelegation, ScreenwriterDelegationResult };

/** 编剧域工具回执契约（screenwriter-delegate.ts 原型 import）。 */
export type { ScreenwriterToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type ScreenwriterDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：三栏 payload + QC 签名）。 */
      deliverable: ExpertDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      screenwriter_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music 版同构）。 */
export const SCREENWRITER_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 编剧分镜回传组装（唯一出口）：编剧域工具回执 → 交付物契约 →
 * ExpertDeliverable。两端函数均 import 自 screenwriter-delegate.ts，本档只做
 * 序列（不新增校验、不改契约形状）。
 */
export function assembleScreenwriterReply(
  result: ScreenwriterToolResult,
  ctx: Parameters<typeof collectScreenwriterDeliverableFromToolResult>[1],
): ScreenwriterDelegationReply {
  const assembled = collectScreenwriterDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    screenwriter_summary: screenwriterSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function screenwriterSummaryFromDeliverable(d: ExpertDeliverable, ctx: Parameters<typeof collectScreenwriterDeliverableFromToolResult>[1]): string {
  const p = d.payload as {
    beats?: string[];
    shotlist?: Array<{ description?: string; scene?: number }>;
  };
  const beatCount = Array.isArray(p.beats) ? p.beats.length : 0;
  const shotCount = Array.isArray(p.shotlist) ? p.shotlist.length : 0;
  return [
    `编剧交付：节拍 ${beatCount} 拍、分镜 ${shotCount} 场（明细见交付物）`,
    `交付物指针：${d.evidence.artifactPath ?? d.evidence.url ?? "（见交付物 evidence）"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 编剧分镜委托单构造（唯一入口）：直接透传 composeScreenwriterDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeScreenwriterPersonaDelegation = composeScreenwriterDelegation;

/** 交付字段白名单 re-export（契约钉死：与 registry screenwriter 行 requiredFields 一一对应）。 */
export { SCREENWRITER_DELIVERABLES };
