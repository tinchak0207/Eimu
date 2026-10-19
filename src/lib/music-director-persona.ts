/**
 * 音乐导演 persona 契约真源（MOE 改革 Wave1 片B3，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/blender-director-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换音乐版（MUSIC_DIRECTOR_PERSONA_ID="music-director"、
 *      工具白名单 import music-tools.ts 的 MUSIC_HARNESS_TOOL_IDS）；
 *   ② 委托单/回传契约 import 自 music-delegate.ts（音乐版委派组装，
 *      交付物六栏 emotion_contract/lyrics/melody_notation/audio_url/duration_source/qc）；
 *   ③ 交付物契约 expertId 钉死 "music"（expert-contract.ts ExpertId 联合成员）。
 * 交互/组装逻辑一行不动：assembleDirectorReply 同构（唯一出口、不新增校验、
 * composeDirectorDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender 版同构——persona 的运行时真源
 * （模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt / AGENTS.md）
 * 都在 VPS /opt/eimu-harness，本地 repo 无 gateway 真源可改。本档钉死契约
 * 四要素并被委托单/回传两端 import。
 *
 * 隔离铁律：音乐导演回传只含交付物契约 + 交付摘要（契约 payload + music_summary
 * ≤500 token），过程（生成日志/试听中间态/多轮痕迹）不出 subagent——对应
 * gateway subagent.ts 既有隔离语义（subagent.delta 只透 text、summary 截
 * 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  MUSIC_DELIVERABLES,
  collectMusicDeliverableFromToolResult,
  composeMusicDelegation,
  type MusicDelegation,
  type MusicDelegationResult,
} from "./music-delegate";
import type { ExpertDeliverable } from "./expert-contract";
import { MUSIC_HARNESS_TOOL_IDS, type MusicToolResult } from "./music-tools";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const MUSIC_DIRECTOR_PERSONA_ID = "music-director" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值）。 */
export const MUSIC_DIRECTOR_PERSONA_LABEL = "音乐导演" as const;

/** persona 一句话定位（设定页/选单描述用）。 */
export const MUSIC_DIRECTOR_PERSONA_DESCRIPTION =
  "专属音乐导演：接委托单自主驱动 Lyria 产出配乐/主题曲/插曲，只回交付物契约与交付摘要，过程不出子代理。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 音乐导演可调用的工具白名单（MOE Wave1 片B3 钉死；禁给全工具面——音乐导演
 * 不需要画图/跑 Blender）。
 *
 * - music_gen：直接取 music-tools.ts 的 MUSIC_HARNESS_TOOL_IDS（禁止手抄
 *   id 字符串面）。
 * - image_quote：报价查询（harness 既有 id，harness-tool-registry 登记在案）。
 */
export const MUSIC_DIRECTOR_PERSONA_TOOL_IDS = [
  ...MUSIC_HARNESS_TOOL_IDS, // music_gen
  "image_quote",
] as const;

export type MusicDirectorPersonaToolId = (typeof MUSIC_DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：repo 内音乐导演配方库（SunoForge v3.0 12 档 MIT verbatim +
 * SKILL.md）。VPS 侧 agent 条目 prompt 段引用同内容路径（路由：配乐/主题曲/
 * 委托一律先读该 SKILL 再动手）。本地只持有路径与用途声明，不复制内容
 * （单一真源防漂移）。
 */
export const MUSIC_DIRECTOR_PERSONA_SKILL_PATH = "skills/music-director/SKILL.md" as const;

/**
 * 配方库 files/ 目录 must-load 路径（SunoForge 12 档）。registry skillPaths
 * 带此声明（must-load 语义：进 Expert 即载，不是「高兴才查」）；委派 prompt
 * 引用配方库按「目录树+SKILL.md 全文+按需读档」组装、不做 YAML 解析
 * （档案首行是 HTML 注释块、原文 frontmatter 从第 2 行起，片05 留观事项）。
 */
export const MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH = "skills/music-director/files/" as const;

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = music-delegate.ts composeMusicDelegation 的 schema。
 * 类型全 import（MusicDelegation / MusicDelegationResult），此处零重定义。
 */
export type { MusicDelegation, MusicDelegationResult };

/** music_gen 工具回执契约（music-tools.ts 原型 import）。 */
export type { MusicToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type MusicDirectorDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：契约 payload + QC 签名）。 */
      deliverable: ExpertDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      music_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender 版同构）。 */
export const MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 音乐导演回传组装（唯一出口）：music_gen 工具回执 → 交付物契约 →
 * ExpertDeliverable。两端函数均 import 自 music-delegate.ts，本档只做序列
 * （不新增校验、不改契约形状）。
 */
export function assembleMusicDirectorReply(
  result: MusicToolResult,
  ctx: Parameters<typeof collectMusicDeliverableFromToolResult>[1],
): MusicDirectorDelegationReply {
  const assembled = collectMusicDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    music_summary: musicSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function musicSummaryFromDeliverable(d: ExpertDeliverable, ctx: Parameters<typeof collectMusicDeliverableFromToolResult>[1]): string {
  const p = d.payload as {
    emotion_contract?: { style?: string; genre?: string; bpm?: number; musicalKey?: string; mood?: string };
    audio_url?: string;
    duration_source?: string;
  };
  const c = p.emotion_contract ?? ctx.emotion_contract;
  const contractBits = [
    c.style,
    c.genre,
    typeof c.bpm === "number" ? `${c.bpm} BPM` : undefined,
    c.musicalKey,
    c.mood,
  ].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return [
    `音乐交付：${contractBits.join("，") || "（情绪契约见交付物）"}`,
    `音频：${p.audio_url ?? "（见交付物 evidence）"}`,
    `时长口径：${p.duration_source ?? "未知"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 音乐导演委托单构造（唯一入口）：直接透传 composeMusicDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeMusicDirectorDelegation = composeMusicDelegation;

/** 交付字段白名单 re-export（契约钉死：与 registry music 行 requiredFields 一一对应）。 */
export { MUSIC_DELIVERABLES };
