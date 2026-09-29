// 解說劇型別與旁白音色（P1-5／對稱差 D7）。
//
// 對標口徑（唯一）：`Dramagic對稱差-全站-0928.md:92` 逐字——
// 對手有「AI Short drama」「AI **Commentary** Drama」兩種型別，且
// 「There is a **narration voice configuration** item」；我方「零命中」。
// 決策表 `Dramagic對稱差-決策表-0928.md:37`：P1-5「**做**」。
//
// ── 輪子已在，本刀只做「接線」──────────────────────────────────────────────
// `AID_SCRIPT_TYPE_ENUM`（`src/lib/aid-enums/creation.ts:122-127`，逐字轉錄自
// AID `ScriptTypeEnum.java`）**早就定義了本站需要的兩型**：
//     PLOT:      { value: "plot",      desc: "剧情演绎" }   ← 普通劇（AI Short drama 對位）
//     MONOLOGUE: { value: "monologue", desc: "真人解说漫" }  ← **解說劇**（AI Commentary Drama 對位）
// 但全 repo 對它的引用**只有 aid-enums 自己的 index 與測試**（實查：
// `grep -rn AID_SCRIPT_TYPE_ENUM src | grep -v aid-enums/` 為空）⇒ 有型別、無接線，
// 這正是 D7 說「零命中」的形狀。**故本刀不另立型別詞表**（另立＝第二套真相），
// 而是把已有的 `AID_SCRIPT_TYPE_ENUM` 接成專案級一等欄位 ＋ 旁白音色綁定。
//
// ── 為什麼旁白音色也要在這裡判（而不只是存一個字串）────────────────────────
// 旁白音色是**要真的拿去合成語音**的：提交端 `POST /v1/tts/generations` 的 `voice`
// 值域收在 `voice-library.ts`（`normalizeVoiceId`，未知一律 400 `voice_unknown`）。
// 若本檔只存一個自由字串，就會出現「專案設定裡寫著某音色，合成時拿到 400」的假設定。
// 故本檔的值域判據**直接複用 `normalizeVoiceId`**（同一把尺，不重寫第二份規則）。
//
// ── 三條不變量（照 D7 的產品語義）──────────────────────────────────────────
//   1. **型別與音色是一組**：只有 `monologue`（解說劇）才允許／需要旁白音色；
//      `plot`（劇情演繹）帶旁白音色＝設定衝突（解說劇才靠旁白推進）。
//      衝突**如實回報**（`narrationVoiceConflict`），不靜默忽略、也不靜默清掉。
//   2. **缺省＝零改動**：不帶 scriptType 的專案逐位不變（舊專案形狀不變）。
//   3. **`voice` 未指定時不編造**：`narrationVoice` 缺席＝用上游預設
//      （`DEFAULT_TTS_VOICE`），不假裝綁了某一顆。
//
// 葉模組：只 import 純常數（aid-enums）與 voice-library 的判據，不碰 DB／`node:*`。

import { AID_SCRIPT_TYPE_ENUM } from "@/lib/aid-enums/creation";
import { normalizeVoiceId } from "@/lib/voice-library";

/** 劇本型別（＝AID `ScriptTypeEnum` 的值集合：`plot`｜`monologue`）。 */
export type CanvasScriptType = (typeof AID_SCRIPT_TYPE_ENUM)[keyof typeof AID_SCRIPT_TYPE_ENUM]["value"];

/**
 * 專案可選的劇本型別（**宣告序＝AID 原序**，UI 下拉直接吃這個陣列）。
 * 解說劇＝`monologue`（AID 原文 desc「真人解说漫」）。
 */
export const CANVAS_SCRIPT_TYPES = [
  AID_SCRIPT_TYPE_ENUM.PLOT.value,
  AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value,
] as const satisfies readonly CanvasScriptType[];

/** 解說劇的型別值（D7 的 AI Commentary Drama 對位）——旁白音色只在這一型有效。 */
export const COMMENTARY_SCRIPT_TYPE: CanvasScriptType = AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value;

/** 型別的中文標籤（**desc 逐字取自 AID，未改寫、未簡繁轉換**）。 */
export const CANVAS_SCRIPT_TYPE_LABELS: Readonly<Record<CanvasScriptType, string>> = {
  [AID_SCRIPT_TYPE_ENUM.PLOT.value]: AID_SCRIPT_TYPE_ENUM.PLOT.desc,
  [AID_SCRIPT_TYPE_ENUM.MONOLOGUE.value]: AID_SCRIPT_TYPE_ENUM.MONOLOGUE.desc,
};

/** 執行期判據（agent 載荷與 Blob 讀回的值都不可信，一律過此）。 */
export function isCanvasScriptType(value: unknown): value is CanvasScriptType {
  return typeof value === "string" && (CANVAS_SCRIPT_TYPES as readonly string[]).includes(value);
}

/** 這一型是不是解說劇（＝需要旁白的那一型）。 */
export function isCommentaryScriptType(value: unknown): boolean {
  return value === COMMENTARY_SCRIPT_TYPE;
}

/**
 * 專案級解說劇設定的清洗結果。
 * 語義：**逐欄獨立、非法即省略該鍵**（與 `CanvasProjectMetaPatch` 既有範式一致——
 * 某欄非法只丟該欄，不整包作廢；省略＝不動該欄）。
 */
export interface ProjectNarration {
  /** 劇本型別；缺席＝未宣告（舊專案語義）。 */
  scriptType?: CanvasScriptType;
  /** 旁白音色 id（必須是 `voice-library` 認可的值）；缺席＝用上游預設。 */
  narrationVoice?: string;
}

/** 清洗一組解說劇設定（逐欄白名單；`undefined`／非法一律不落鍵）。 */
export function normalizeProjectNarration(input: {
  scriptType?: unknown;
  narrationVoice?: unknown;
}): ProjectNarration {
  const out: ProjectNarration = {};
  if (isCanvasScriptType(input?.scriptType)) out.scriptType = input.scriptType;
  // 音色走**既有語音庫的同一把尺**（未知＝不落鍵，不製造半形綁定）。
  const voice = normalizeVoiceId(input?.narrationVoice);
  if (voice) out.narrationVoice = voice;
  return out;
}

/**
 * 設定衝突如實回報（**不代用戶決定**）：
 *   - 非解說劇（`plot` 或未宣告）卻綁了旁白音色 ⇒ 該設定不會生效；
 *   - 解說劇但**沒有**旁白音色 ⇒ 不是錯誤（會走上游預設音色），僅提示未指定。
 * 回傳人類可讀的中文訊息陣列（空陣列＝無衝突）；呼叫端據此提示，不得靜默吞掉。
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
 * 旁白音色**此刻真正會被使用**的那一顆（給 UI／API 明示，不讓呼叫端猜）：
 * 解說劇 → 綁定的音色，未綁定＝null（＝上游預設，由呼叫端填 `DEFAULT_TTS_VOICE` 顯示）。
 * 非解說劇 → null（綁了也不會用；衝突由 `narrationVoiceConflicts` 具名回報）。
 */
export function effectiveNarrationVoice(settings: {
  scriptType?: unknown;
  narrationVoice?: unknown;
}): string | null {
  const cleaned = normalizeProjectNarration(settings);
  if (!isCommentaryScriptType(cleaned.scriptType)) return null;
  return cleaned.narrationVoice ?? null;
}
