/**
 * 剪辑师 persona 契约真源（MOE 改革 Wave2b，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/video-director-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换剪辑版（EDITOR_PERSONA_ID="editor"，LABEL="剪辑师"，工具白名单
 *      = harness 既有剪辑域 11 件：timeline_* 八件套 + editing_manifest +
 *      audio_first_timeline + video_upload，全部 harness-tool-registry 登记在案
 *      （行号考古见各 id 注释），禁手抄未登记 id）；
 *   ② 委托单/回传契约 import 自 editor-delegate.ts（剪辑版委派组装，交付物
 *      三栏 timeline_ops/duration_sec/qc）；
 *   ③ 交付物契约 expertId 钉死 "editor"（Wave2 收口接线翻正：值已在
 *      expert-contract ExpertId 联合内，交付物走全型 ExpertDeliverable，零 cast）。
 * 交互/组装逻辑一行不动：assembleEditorReply 同构（唯一出口、不新增
 * 校验、composeEditorDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music/video 版同构——persona 的
 * 运行时真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt /
 * AGENTS.md）都在 VPS /opt/agent-harness，本地 repo 无 gateway 真源可改。
 * 本档钉死契约四要素并被委托单/回传两端 import。
 *
 * SKILL 挂载（2026-09-27 配方库落库，消「skill 待补」）：考古结论 2026-09-08 时
 * repo skills/ 无剪辑域配方库（B1-B7 配方只沉淀在记忆
 * timeline-post-production-buildout-0831 与 docs/timeline-post-production-plan.md）
 * → 当时置空并声明待补。本片按既有盘面（docs/timeline-post-production-plan.md §2
 * B1-B7 拆片表 + §7 全役完结）把配方落成 skills/editor/ 域根 + 六子配方
 * （assembly / audio-first / rhythm / look / mix / qc-master），本节 skillPaths
 * 逐条指向已落盘的真实 SKILL.md 文件（禁幻影路径；存在性由
 * editor-timeline-activation.test.ts 逐条 fs 断言）。
 * 默认注入链：本常量 → expert-registry editor 行 skillPaths →
 * orchestrator-beast-frame.ts buildExpertLine → Orchestrator 主 prompt 的 Expert
 * 注册表摘要（beast ON 时），故补齐即默认可见（不需调用就在 prompt 里）。
 *
 * 隔离铁律：剪辑师回传只含交付物契约 + 交付摘要（三栏 payload + edit_summary
 * ≤500 token），过程（试剪中间态/逐次 lint 报告/多轮痕迹）不出 subagent——
 * 对应 gateway subagent.ts 既有隔离语义（subagent.delta 只透 text、summary 截
 * 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  EDITOR_DELIVERABLES,
  EDITOR_DELIVERABLE_EXPERT_ID,
  EDITOR_TIMELINE_KIND,
  collectEditorDeliverableFromToolResult,
  composeEditorDelegation,
  type EditorDelegation,
  type EditorDelegationResult,
  type EditorDeliverable,
  type EditorToolResult,
} from "./editor-delegate";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const EDITOR_PERSONA_ID = "editor" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值）。 */
export const EDITOR_PERSONA_LABEL = "剪辑师" as const;

/** persona 一句话定位（设定页/选单描述用）。 */
export const EDITOR_PERSONA_DESCRIPTION =
  "专属剪辑师：接委托单自主编排时间线（剪切/转场/节奏卡点/混音）并走 lint/master 质检导出成片，只回交付物契约与交付摘要，过程不出子代理。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 剪辑师可调用的工具白名单（MOE Wave2b 钉死；禁给全工具面——剪辑师不需要
 * 画图/跑 Blender/跑音乐/写分镜）。
 *
 * 全部 id 经 harness-tool-registry.ts 逐行考古（2026-09-08，与片09 registry
 * editor 行 toolIds 同源）：
 * - timeline_lint：L90 登记，8 检测项信号层（黑帧/白闪/静音/AV 失配等，
 *   记忆 2026-08-31-b4-lint-signal-layer）。
 * - timeline_master：L91 登记，母带导出闸（14 项聚合质检 + export 400 负向闸，
 *   记忆 timeline-post-production-buildout-0831）。
 * - timeline_mix：L92 登记，混音/ducking 后置 pass。
 * - timeline_ops：L93 登记，时间线指令工具族（add/trim/move 等语义 ops）。
 * - timeline_query：L94 登记，时间线状态查询（per-session JSON 真源只读面）。
 * - timeline_restore：L95 登记，时间线版本回滚。
 * - timeline_rhythm：L96 登记，节奏层（卡点/情绪曲线软输入）。
 * - timeline_style：L97 登记，风格 ffmpeg 子集（滤镜/LUT）。
 * - editing_manifest：L70 登记，剪辑清单（edl/manifest 语义层）。
 * - audio_first_timeline：L150 登记，音轨先行时间线（gateway /agent/v1/tts
 *   逐行真 TTS + ffprobe 实测时长 + 累计 offset_ms 锚点）。
 * - video_upload：L100 登记，剪辑素材上传入口（视频/音频素材进 gateway）。
 */
export const EDITOR_PERSONA_TOOL_IDS = [
  "timeline_ops",
  "timeline_query",
  "timeline_rhythm",
  "timeline_style",
  "timeline_mix",
  "timeline_master",
  "timeline_lint",
  "timeline_restore",
  "editing_manifest",
  "audio_first_timeline",
  "video_upload",
] as const;

export type EditorPersonaToolId = (typeof EDITOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：skills/editor/ 剪辑域配方库（2026-09-27 落库，7 份 SKILL.md：
 * 域根 + assembly / audio-first / rhythm / look / mix / qc-master），每条路径
 * 对应一条真链路（素材→manifest→ops→lint→rhythm→mix→style→master）。
 *
 * 逐条列 SKILL.md 文件路径（非域目录）：与 music-director 先例同款精确文件引用，
 * 且本档每条路径都经 fs 存在性断言（editor-timeline-activation.test.ts），
 * 禁幻影路径（记忆 subagent-spec-must-read-memory 幻影档教训）。
 * 全部为本片自建自有配方，非第三方轮子入库，无授权义务。
 */
export const EDITOR_PERSONA_SKILL_PATHS: readonly string[] = [
  "skills/editor/SKILL.md",
  "skills/editor/assembly/SKILL.md",
  "skills/editor/audio-first/SKILL.md",
  "skills/editor/rhythm/SKILL.md",
  "skills/editor/look/SKILL.md",
  "skills/editor/mix/SKILL.md",
  "skills/editor/qc-master/SKILL.md",
];

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = editor-delegate.ts composeEditorDelegation 的 schema。
 * 类型全 import（EditorDelegation / EditorDelegationResult），此处零重定义。
 */
export type { EditorDelegation, EditorDelegationResult };

/** 剪辑工具回执契约（editor-delegate.ts 钉死的 ok()/fail() JSON 字符串形）。 */
export type { EditorToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type EditorDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：三栏 payload + QC 签名）。 */
      deliverable: EditorDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      edit_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music/video 版同构）。 */
export const EDITOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 剪辑师回传组装（唯一出口）：剪辑工具回执 → 交付物契约 → EditorDeliverable。
 * 两端函数均 import 自 editor-delegate.ts，本档只做序列（不新增校验、不改契约
 * 形状）。
 */
export function assembleEditorReply(
  result: EditorToolResult,
  ctx: Parameters<typeof collectEditorDeliverableFromToolResult>[1],
): EditorDelegationReply {
  const assembled = collectEditorDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    edit_summary: editSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function editSummaryFromDeliverable(d: EditorDeliverable, ctx: Parameters<typeof collectEditorDeliverableFromToolResult>[1]): string {
  const p = d.payload;
  const ops = Array.isArray(p.timeline_ops) ? p.timeline_ops : undefined;
  return [
    `剪辑交付：${EDITOR_TIMELINE_KIND}，${ops && ops.length > 0 ? `${ops.length} 条时间线操作` : "（操作清单见交付物）"}${typeof p.duration_sec === "number" ? `，${p.duration_sec} 秒` : ""}`,
    `成片：${d.evidence.url ?? "（见交付物 evidence）"}`,
    `质检：${typeof p.qc === "string" ? p.qc : "（见交付物 payload.qc）"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 剪辑师委托单构造（唯一入口）：直接透传 composeEditorDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 * （video 版此处是 composeVideoDirectorDelegation 别名；剪辑域 delegate 函数
 * 名已是 spec 钉死的 composeEditorDelegation，re-export 即别名，零新语义。）
 */
export { composeEditorDelegation };

/** 交付字段白名单 re-export（契约钉死：与 registry editor 行 requiredFields 一一对应）。 */
export { EDITOR_DELIVERABLES, EDITOR_DELIVERABLE_EXPERT_ID };
