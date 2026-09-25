/**
 * 音乐委托单构造器 + music_gen 工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave1 片B3 音乐 Expert 正式注册，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/blender-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式全部同构。白名单差异仅三处：
 *   ① prompt 组装：情绪契约（genre/BPM/key/mood/结构）经
 *      buildLyriaStylePrompt（music-lyria.ts 真源）拼 Lyria 风格 prompt；
 *   ② 交付物栏位：emotion_contract / lyrics / melody_notation / audio_url /
 *      duration_source / qc（MUSIC_DELIVERABLES 六栏，expert-registry music 行
 *      requiredFields 同源；melody_notation=人声主旋律音高序列，刀 I
 *      2026-09-15 补，round1/round3b 判词「能唱的词有，被唱出来的曲无」根因栏）；
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩）。
 *      载入范式照搬 blender-delegate.ts 的 DI 缺省（resolveArtifactUrl /
 *      music-tools uploadOverride 同款）：loadConstitution 可注入，缺省 fs 读
 *      落位稿，读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *
 * 与 blender 版的域差异（白名单内）：音乐无 canvas 节点类型（canvas/types.ts
 * 无 music 节点，禁自造），故 ③ 产 ExpertDeliverable（expert-contract.ts 契约）
 * 而非 add_node op；配方库挂载引用由 persona/注册表/VPS agent prompt 持路径
 * （blender 同款，单一路径真源防漂移），委派 prompt 不内嵌配方库原文。
 *
 * blender-delegate.ts 本体一行不动（另一 agent 并行施工中），本档只 import 其
 * estimateTokens / DELEGATION_TOKEN_BUDGET（单一真源，禁复制值）。
 * 文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { buildLyriaStylePrompt, type LyriaMusicContract } from "./music-lyria";
import { DELEGATION_TOKEN_BUDGET, estimateTokens } from "./blender-delegate";
import {
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
  type ExpertTaskContract,
  type MusicDeliverablePayload,
} from "./expert-contract";
import type { MusicToolResult } from "./music-tools";

// ─────────────────────────────────────────── ① 委托单构造器

/** 宪法落位稿路径（BEAST_MODE=ON 注入源；VPS gateway 同源引用）。 */
export const EXPERT_CONSTITUTION_PATH = "deploy-staging/expert-gateway/expert-constitution.md" as const;

/** 交付字段白名单：与 expert-registry music 行 requiredFields 一一对应。 */
export const MUSIC_DELIVERABLES = ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"] as const;
export type MusicDeliverable = (typeof MUSIC_DELIVERABLES)[number];

/** 交付物种类（expert-contract.ts 契约示例钉死的 music 域 kind）。 */
export const MUSIC_TRACK_KIND = "music_track" as const;

/** 委托单 schema（MOE Wave1 片B3 契约，钉死不得更改）。 */
export interface MusicDelegationInput {
  /** 效果描述（一句话人话，音乐导演据此自主拆解情绪契约与生成参数）。 */
  effect_description: string;
  /** 情绪契约（genre/BPM/key/mood/结构，music-lyria.ts 真源形）。 */
  emotion_contract: LyriaMusicContract;
  /** 自定义歌词（可选；[Verse]/[Chorus] 段落标签或 [0:00-0:10] 时间戳）。缺省=纯器乐。 */
  lyrics?: string;
  /** 参考素材引用（画布节点 id / 附件 path / URL，原样透传）。 */
  reference_refs?: string[];
  /** 时长档（full=整歌约 3 分钟 / clip30=30 秒片段；缺省 full）。 */
  duration_hint?: "full" | "clip30";
  /** 交付字段清单（白名单：MUSIC_DELIVERABLES）。 */
  deliverables: MusicDeliverable[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给音乐导演 subagent）。 */
export type MusicDelegation = MusicDelegationInput;

export type MusicDelegationResult =
  | { ok: true; delegation: MusicDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 效果描述长度上限（防主脑塞整篇剧本进委托单；同 blender 口径）。 */
const EFFECT_DESCRIPTION_MAX = 600;
/** 歌词长度上限（整歌词面；超限走 token 预算提示）。 */
const LYRICS_MAX = 2400;
const REFERENCE_REFS_MAX = 8;

/**
 * 主脑 → 音乐导演委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 blender-delegate.ts 错误铁律）。
 */
export function composeMusicDelegation(input: unknown): MusicDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const effect = strField(v.effect_description);
  if (effect === undefined) missing.push("effect_description");
  const contract = emotionContractField(v.emotion_contract);
  if (contract === undefined) missing.push("emotion_contract");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || effect === undefined || contract === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。effect_description 一句话效果描述、emotion_contract 情绪契约（至少含 style，可选 genre/BPM/key/mood/structure/instrumental）、deliverables 交付字段清单（${MUSIC_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: MusicDeliverable[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (MUSIC_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as MusicDeliverable)) cleanedDeliverables.push(d as MusicDeliverable);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (effect.length > EFFECT_DESCRIPTION_MAX) bad.push("effect_description");
  const lyrics = strField(v.lyrics);
  if (lyrics !== undefined && lyrics.length > LYRICS_MAX) bad.push("lyrics");
  const durationHint = strField(v.duration_hint);
  if (durationHint !== undefined && durationHint !== "full" && durationHint !== "clip30") bad.push("duration_hint");
  let refs: string[] | undefined;
  if (v.reference_refs !== undefined) {
    if (Array.isArray(v.reference_refs)) {
      refs = v.reference_refs.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim());
      if (refs.length > REFERENCE_REFS_MAX) bad.push("reference_refs");
      if (refs.some((r) => r.length > 200)) bad.push("reference_refs");
    } else {
      bad.push("reference_refs");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。effect_description ≤${EFFECT_DESCRIPTION_MAX} 字、lyrics ≤${LYRICS_MAX} 字、reference_refs ≤${REFERENCE_REFS_MAX} 条（各 ≤200 字）、duration_hint 只接受 "full"/"clip30"、deliverables 只接受 ${MUSIC_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: MusicDelegation = {
    effect_description: effect,
    emotion_contract: contract,
    ...(lyrics !== undefined ? { lyrics } : {}),
    ...(refs !== undefined && refs.length > 0 ? { reference_refs: refs } : {}),
    ...(durationHint !== undefined ? { duration_hint: durationHint as MusicDelegation["duration_hint"] } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 effect_description / lyrics 或减少 reference_refs。`,
      fields: ["effect_description", "lyrics", "reference_refs"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：复用 blender-delegate 单一真源（禁复制），口径 CJK 记 1、其余 ~0.25。 */
export { estimateTokens };

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * 情绪契约收敛（白名单欄位形）：只认 LyriaMusicContract 已知键，style 必填
 * 非空字符串，bpm 正数四舍五入；未知键丢弃（防 payload 注入，对齐 deliverables
 * 白名单收敛同哲学）。
 */
function emotionContractField(v: unknown): LyriaMusicContract | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const style = strField(raw.style);
  if (style === undefined) return undefined;
  const contract: LyriaMusicContract = { style };
  const genre = strField(raw.genre);
  if (genre !== undefined) contract.genre = genre;
  if (typeof raw.bpm === "number" && Number.isFinite(raw.bpm) && raw.bpm > 0) contract.bpm = Math.round(raw.bpm);
  const musicalKey = strField(raw.musicalKey);
  if (musicalKey !== undefined) contract.musicalKey = musicalKey;
  const mood = strField(raw.mood);
  if (mood !== undefined) contract.mood = mood;
  const structure = strField(raw.structure);
  if (structure !== undefined) contract.structure = structure;
  if (raw.instrumental === true) contract.instrumental = true;
  return contract;
}

// ─────────────────────────────────────────── ② 委派 prompt 组装（宪法注入挂点）

export interface MusicPromptAssemblyContext {
  /**
   * 野兽模式开关：调用方经 expert-registry.readBeastMode(settings) 计算后传入。
   * 本档不 import expert-registry（避免 registry → persona → delegate 依赖成环，
   * 见档头说明）。缺省 false = OFF = 宪法一个字不注入、档案不触碰。
   */
  beastMode?: boolean;
  /**
   * 宪法原文载入（DI，范式同 blender-delegate resolveArtifactUrl / music-tools
   * uploadOverride）；缺省 fs 读 EXPERT_CONSTITUTION_PATH 落位稿。
   */
  loadConstitution?: () => string;
}

export type MusicPromptAssemblyResult =
  | { ok: true; prompt: string }
  | { ok: false; code: "constitution_unavailable"; hint: string };

/** 缺省宪法载入：fs 读落位稿（cwd = repo 根；VPS 侧可经 loadConstitution 整体替换）。 */
function defaultLoadConstitution(): string {
  return readFileSync(nodePath.resolve(process.cwd(), EXPERT_CONSTITUTION_PATH), "utf8");
}

/**
 * 音乐导演委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（情绪契约经 buildLyriaStylePrompt 拼 Lyria 风格 prompt）。
 * OFF 时一个字不多：宪法原文不出现、落位稿不被读取。宪法载入失败结构化报错
 * （code/hint 带原文死因），绝不静默降级成无宪法派遣。
 */
export function assembleMusicDirectorPrompt(
  delegation: MusicDelegation,
  context: MusicPromptAssemblyContext = {},
): MusicPromptAssemblyResult {
  const stylePrompt = buildLyriaStylePrompt(delegation.emotion_contract);
  const body = [
    "# 音乐导演委托单",
    `效果意图：${delegation.effect_description}`,
    `风格契约（Lyria prompt）：${stylePrompt}`,
    `歌词：${delegation.lyrics?.trim() ? delegation.lyrics.trim() : "（纯器乐，无歌词；需要人声必须提供歌词）"}`,
    `时长：${delegation.duration_hint ?? "full"}（full=整歌约 3 分钟 / clip30=30 秒片段）`,
    `交付字段：${delegation.deliverables.join("、")}`,
    // 刀 I（2026-09-15）：melody_notation 可判形态指引——措辞对齐上方「时长：」行的
    // 「字段：值（判据）」格式；机器判据口径 = 栏位名逐字出现＋紧跟实质内容（缺整栏＝未交付）。
    // 2026-09-19 YuE2 白盒接线：追加真源句（additive，不删既有）——工具回执 score_abc
    // 有值时 melody_notation 从「导演自己编音名序列」变「有真源可引」。
    ...(delegation.deliverables.includes("melody_notation")
      ? [
          `交付字段格式：melody_notation 需含调性＋节拍＋至少一段人声主旋律以音名字符序列标注（例：A4–C5–B4–A4，含时值），交付正文须逐字出现栏位名 melody_notation 并紧跟上述实质内容（缺整栏＝未交付）。`,
          `真源优先：music_gen 回执的 score_abc 栏带 ABC 乐谱（K: 调号＋Q: 节拍＋V: Vocal 声部音符序列已齐）时，melody_notation 直接引用其 Vocal 声部，勿另行编造音名序列；score_abc 为 null 时仍由你自行标注。`,
        ]
      : []),
    // 2026-09-19 编辑/翻唱委託指引（additive）：任务性质是「改编/翻唱/二次精修」时
    // 指向 abc＋cot_mode 重渲染路径（工具参数由并行片接入）；措辞对齐上方
    // 「字段：值（判据）」格式。故意不含 melody_notation 字样（护栏测试断言
    // 无该交付栏时该词零出现）。
    `编辑路径：effect_description 性质为改编/翻唱/二次精修（判据：要求基于既有歌曲改风格/改和声/换语言，而非从零新写）时，music_gen 走 YuE2 通路带 abc＋cot_mode 重渲染（编辑用 cot=full 重渲染，翻唱用 cot=melody＋chord-free abc），编辑不变量与版本对比规约见 skills/music-director/SKILL.md「乐谱编辑与翻唱工作流」节。`,
    `参考素材：${delegation.reference_refs && delegation.reference_refs.length > 0 ? delegation.reference_refs.join("、") : "无"}`,
  ].join("\n");

  if (context.beastMode !== true) {
    return { ok: true, prompt: body };
  }

  let constitution: string;
  try {
    constitution = (context.loadConstitution ?? defaultLoadConstitution)();
  } catch (e) {
    return {
      ok: false,
      code: "constitution_unavailable",
      hint: `宪法原文载入失败（${EXPERT_CONSTITUTION_PATH}）：${(e as Error)?.message ?? String(e)}。BEAST_MODE=ON 时宪法必须注入 prompt 头，禁止无宪法派遣；请确认落位稿存在，或经 loadConstitution 注入。`,
    };
  }
  return { ok: true, prompt: `${constitution}\n\n${body}` };
}

// ─────────────────────────────────────────── ③ 工具产物 → Expert 交付物（QC 签名 + 组装闸门）

/** collect 的依赖：委託單原件（情绪契约回写 payload）+ 派工契约（回指可追溯）。 */
export interface MusicDeliverableCollectContext {
  /** 委托单原 emotion_contract（回写 payload.emotion_contract）。 */
  emotion_contract: LyriaMusicContract;
  /** 派工契约（ExpertDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
  /** 委托歌词（工具未回显 lyrics_echo 时的兜底；两处都空 = 纯器乐标注）。 */
  lyrics?: string;
}

export type MusicDeliverableCollectResult =
  | { ok: true; deliverable: ExpertDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

/**
 * music_gen 工具回执 → 交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（registry music 行 requiredFields，钉死）：六栏（含 melody_notation，
 * 人声主旋律音高序列——导演文案交付栏，VPS 闸门按正文逐字判定）；工具回执
 * 路径只产 audio_url/duration_source 等五栏，melody_notation 不经 music_gen
 * 回执回填、collect 不伪造。缺关键栏位返回结构化错误，不产半形数据
 * （对齐 blender-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - 无 audio_url（音频未上传 gateway）= missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 */
export function collectMusicDeliverableFromToolResult(
  result: MusicToolResult,
  context: MusicDeliverableCollectContext,
): MusicDeliverableCollectResult {
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(typeof result?.output === "string" ? result.output : "");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      code: "no_output",
      hint: "music_gen 工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `music_gen 工具回执 ok:false（未生成任何音频）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const url = strField(parsed.url);
  const durationSource = strField(parsed.duration_source);
  const missing: string[] = [];
  if (!url) missing.push("audio_url（音频未上传 gateway，无公网 URL）");
  if (!durationSource) missing.push("duration_source");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload ${MUSIC_DELIVERABLES.length} 栏必须全形（${MUSIC_DELIVERABLES.join("、")}，缺栏组装闸门不过；melody_notation 由导演文案侧交付回填，工具回执只产其余五栏）。回执实际字段：${seen}。`,
      missing,
    };
  }

  const audioBytes = typeof parsed.audio_bytes === "number" && Number.isFinite(parsed.audio_bytes) && parsed.audio_bytes > 0 ? parsed.audio_bytes : 0;
  const durationSeconds =
    typeof parsed.duration_seconds === "number" && Number.isFinite(parsed.duration_seconds) && parsed.duration_seconds > 0
      ? parsed.duration_seconds
      : undefined;
  const lyricsEcho = strField(parsed.lyrics_echo);
  const lyrics = lyricsEcho ?? (context.lyrics?.trim() ? context.lyrics.trim() : "（纯器乐，无歌词）");

  const payload: MusicDeliverablePayload = {
    emotion_contract: context.emotion_contract,
    lyrics,
    audio_url: url,
    duration_source: durationSource,
    qc: `duration_source=${durationSource}; mime=${strField(parsed.mime_type) ?? "未知"}; bytes=${audioBytes}; model=${strField(parsed.model) ?? "未知"}`,
  };

  const evidence: ExpertDeliverable["evidence"] = { url };
  if (audioBytes > 0) evidence.bytes = audioBytes;
  if (durationSeconds !== undefined) evidence.durationSec = durationSeconds;

  const deliverable: ExpertDeliverable = {
    expertId: "music",
    kind: MUSIC_TRACK_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: "music",
      kind: MUSIC_TRACK_KIND,
      payload,
      evidence,
      contract: context.contract,
    }),
    contract: context.contract,
  };

  // 组装闸门自检：出厂即全形，闸门不过 = 内部缺陷，结构化报错不外流半形产物。
  const gate = validateExpertDeliverable(deliverable);
  if (!gate.ok) {
    return {
      ok: false,
      code: "deliverable_invalid",
      hint: `交付物组装闸门不过（内部自检）：${gate.errors.join("；")}`,
      missing: [],
    };
  }
  return { ok: true, deliverable };
}
