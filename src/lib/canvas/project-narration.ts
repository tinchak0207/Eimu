// 解说剧型别与旁白音色（P1-5／对称差 D7）。
//
// 对标口径（唯一）：`Dramagic对称差-全站-0928.md:92` 逐字——
// 对手有「AI Short drama」「AI **Commentary** Drama」两种型别，且
// 「There is a **narration voice configuration** item」；我方「零命中」。
// 决策表 `Dramagic对称差-决策表-0928.md:37`：P1-5「**做**」。
//
// ── 轮子已在，本刀只做「接线」──────────────────────────────────────────────
// `AID_SCRIPT_TYPE_ENUM`（`src/lib/aid-enums/creation.ts:122-127`，逐字转录自
// AID `ScriptTypeEnum.java`）**早就定义了本站需要的两型**：
//     PLOT:      { value: "plot",      desc: "剧情演绎" }   ← 普通剧（AI Short drama 对位）
//     MONOLOGUE: { value: "monologue", desc: "真人解说漫" }  ← **解说剧**（AI Commentary Drama 对位）
// 但全 repo 对它的引用**只有 aid-enums 自己的 index 与测试**（实查：
// `grep -rn AID_SCRIPT_TYPE_ENUM src | grep -v aid-enums/` 为空）⇒ 有型别、无接线，
// 这正是 D7 说「零命中」的形状。**故本刀不另立型别词表**（另立＝第二套真相），
// 而是把已有的 `AID_SCRIPT_TYPE_ENUM` 接成专案级一等栏位 ＋ 旁白音色绑定。
//
// ── 为什么旁白音色也要在这里判（而不只是存一个字串）────────────────────────
// 旁白音色是**要真的拿去合成语音**的：提交端 `POST /v1/tts/generations` 的 `voice`
// 值域收在 `voice-library.ts`（`normalizeVoiceId`，未知一律 400 `voice_unknown`）。
// 若本档只存一个自由字串，就会出现「专案设定里写著某音色，合成时拿到 400」的假设定。
// 故本档的值域判据**直接复用 `normalizeVoiceId`**（同一把尺，不重写第二份规则）。
//
// ── 三条不变量（照 D7 的产品语义）──────────────────────────────────────────
//   1. **型别与音色是一组**：只有 `monologue`（解说剧）才允许／需要旁白音色；
//      `plot`（剧情演绎）带旁白音色＝设定冲突（解说剧才靠旁白推进）。
//      冲突**如实回报**（`narrationVoiceConflict`），不静默忽略、也不静默清掉。
//   2. **缺省＝零改动**：不带 scriptType 的专案逐位不变（旧专案形状不变）。
//   3. **`voice` 未指定时不编造**：`narrationVoice` 缺席＝用上游预设
//      （`DEFAULT_TTS_VOICE`），不假装绑了某一颗。
//
// 叶模组：只 import 纯常数（aid-enums）与 voice-library 的判据，不碰 DB／`node:*`。

import { AID_SCRIPT_TYPE_ENUM } from "@/lib/aid-enums/creation";
import { normalizeVoiceId } from "@/lib/voice-library";

/** 剧本型别（＝AID `ScriptTypeEnum` 的值集合：`plot`｜`monologue`）。 */
export type CanvasScriptType = (typeof AID_SCRIPT_TYPE_ENUM)[keyof typeof AID_SCRIPT_TYPE_ENUM]["value"];

/**
 * 专案可选的剧本型别（**宣告序＝AID 原序**，UI 下拉直接吃这个阵列）。
 * 解说剧＝`monologue`（AID 原文 desc「真人解说漫」）。
 */
export const CANVAS_SCRIPT_TYPES = [
  AID_SCRIPT_TYPE_ENUM.PLOT.value,
  AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value,
] as const satisfies readonly CanvasScriptType[];

/** 解说剧的型别值（D7 的 AI Commentary Drama 对位）——旁白音色只在这一型有效。 */
export const COMMENTARY_SCRIPT_TYPE: CanvasScriptType = AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value;

/** 型别的中文标签（**desc 逐字取自 AID，未改写、未简繁转换**）。 */
export const CANVAS_SCRIPT_TYPE_LABELS: Readonly<Record<CanvasScriptType, string>> = {
  [AID_SCRIPT_TYPE_ENUM.PLOT.value]: AID_SCRIPT_TYPE_ENUM.PLOT.desc,
  [AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value]: AID_SCRIPT_TYPE_ENUM.MONOLOGUE.desc,
};

/** 执行期判据（agent 载荷与 Blob 读回的值都不可信，一律过此）。 */
export function isCanvasScriptType(value: unknown): value is CanvasScriptType {
  return typeof value === "string" && (CANVAS_SCRIPT_TYPES as readonly string[]).includes(value);
}

/** 这一型是不是解说剧（＝需要旁白的那一型）。 */
export function isCommentaryScriptType(value: unknown): boolean {
  return value === COMMENTARY_SCRIPT_TYPE;
}

/**
 * 专案级解说剧设定的清洗结果。
 * 语义：**逐栏独立、非法即省略该键**（与 `CanvasProjectMetaPatch` 既有范式一致——
 * 某栏非法只丢该栏，不整包作废；省略＝不动该栏）。
 */
export interface ProjectNarration {
  /** 剧本型别；缺席＝未宣告（旧专案语义）。 */
  scriptType?: CanvasScriptType;
  /** 旁白音色 id（必须是 `voice-library` 认可的值）；缺席＝用上游预设。 */
  narrationVoice?: string;
}

/** 清洗一组解说剧设定（逐栏白名单；`undefined`／非法一律不落键）。 */
export function normalizeProjectNarration(input: {
  scriptType?: unknown;
  narrationVoice?: unknown;
}): ProjectNarration {
  const out: ProjectNarration = {};
  if (isCanvasScriptType(input?.scriptType)) out.scriptType = input.scriptType;
  // 音色走**既有语音库的同一把尺**（未知＝不落键，不制造半形绑定）。
  const voice = normalizeVoiceId(input?.narrationVoice);
  if (voice) out.narrationVoice = voice;
  return out;
}

/**
 * 设定冲突如实回报（**不代用户决定**）：
 *   - 非解说剧（`plot` 或未宣告）却绑了旁白音色 ⇒ 该设定不会生效；
 *   - 解说剧但**没有**旁白音色 ⇒ 不是错误（会走上游预设音色），仅提示未指定。
 * 回传人类可读的中文讯息阵列（空阵列＝无冲突）；呼叫端据此提示，不得静默吞掉。
 */
export function narrationVoiceConflicts(settings: {
  scriptType?: unknown;
  narrationVoice?: unknown;
}): string[] {
  const cleaned = normalizeProjectNarration(settings);
  const problems: string[] = [];
  if (cleaned.narrationVoice && !isCommentaryScriptType(cleaned.scriptType)) {
    problems.push("旁白音色只在解说剧（monologue）下生效；当前剧本类型不是解说剧，该设置会被忽略。");
  }
  return problems;
}

/**
 * 旁白音色**此刻真正会被使用**的那一颗（给 UI／API 明示，不让呼叫端猜）：
 * 解说剧 → 绑定的音色，未绑定＝null（＝上游预设，由呼叫端填 `DEFAULT_TTS_VOICE` 显示）。
 * 非解说剧 → null（绑了也不会用；冲突由 `narrationVoiceConflicts` 具名回报）。
 */
export function effectiveNarrationVoice(settings: {
  scriptType?: unknown;
  narrationVoice?: unknown;
}): string | null {
  const cleaned = normalizeProjectNarration(settings);
  if (!isCommentaryScriptType(cleaned.scriptType)) return null;
  return cleaned.narrationVoice ?? null;
}
