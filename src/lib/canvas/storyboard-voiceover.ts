// 逐鏡配音：分鏡 → 台詞表 → 逐行既有 TTS → 回寫分鏡雙音軌與錨（服務層）。
//
// 結構修因（病歷 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s。TTS 本身
// 沒問題，缺的是**逐鏡組台詞表**與**把結果寫回分鏡**這兩跳。橋接純函式層
// （`./storyboard-audio-bridge.ts`）已補上「分鏡 ↔ 台詞表 ↔ timeline」的純轉換；本檔是
// **站點服務層**：把專案讀成扁平分鏡、決定台詞表上限／分批、**逐行序列**呼叫注入的 TTS
// client、再用橋接層回寫，最後回報逐鏡時長漂移。
//
// ── 職責邊界（照本 repo 的既有分工，不越界）─────────────────────────────────
//   · 本檔**不碰網路、不碰 DB、不自己拼音頻 patch**：TTS 由上層注入
//     （`StoryboardVoiceoverTtsClient`，真實現由路由提供、測試給假 client）；
//     回寫一律走橋接層 `applyAudioTimelineToShots`（音頻判準與錨重算的唯一實作）。
//   · 本檔**不量時長**：`duration_ms` 由注入 client 提供；站點側沒有 ffprobe
//     （`music-tools.ts` 的 ffprobe 是 harness 沙箱工具，不是 Next 服務端；見
//     `video-frames` 檔頭「Vercel 无 ffmpeg」）⇒ client 回 null 就照 null 傳下去，
//     **不估算冒充實測**。
//   · 本檔**不切 `dialogue` 的 `[角色]：「…」` 標記、不從 `dialogue` 猜旁白**：逐字照
//     橋接層檔頭的三條裁定（該格式無契約、旁白只認 `metadata.narration`）。
//
// ── 四個欄位的讀取規則（逐字照 `storyboard-audio-bridge.ts` 檔頭）──────────────
//   · `shotNumber`  ← `node.metadata.storyboardShot.shotNumber`（非空＝這顆是分鏡）
//   · `dialogue`    ← `node.metadata.storyboardShot.dialogue`
//   · `narration`   ← `node.metadata.narration`（2026-09-30 落地的旁白文本鍵）
//   · 既有兩軌／錨  ← `node.metadata.dialogueAudioId` / `narrationAudioId` /
//                     `audioAnchorId`；**必須一起投影進扁平分鏡**，否則回寫時橋接層
//                     依 `dialogueAudioId || narrationAudioId` 重算的錨會漏掉另一軌。
//
// ── 「集」的讀取────複用既有輪子 `storyboard-episode-batch.storyboardShotsOfEpisode`
//   （只認「分鏡節點 ＋ `metadata.episodeId` 逐字相符」，不按節點序切段、不臆造歸屬）。
//   未指定 `episode` ＝ 全專案分鏡（按鏡號 numeric 排序，與既有輪子同序）。

import { usableAudioUrl } from "@/lib/agent-output-cards";
import { TTS_COINS_PER_CHAR, ttsCoinsForChars } from "@/lib/generation-model-catalog/tts-pricing";
import { DEFAULT_TTS_VOICE } from "@/lib/voice-library";
import {
  AUDIO_TOOL_DEFAULT_MAX_LINES,
  AUDIO_TOOL_MAX_LINES,
  applyAudioTimelineToShots,
  audioDurationDrift,
  shotsToAudioScript,
  type AudioApplyRefusalCode,
  type AudioDurationDrift,
  type AudioSourceRef,
  type AudioTimelineEntry,
  type ShotAudioField,
  type StoryboardAudioShot,
} from "./storyboard-audio-bridge";
import { effectiveNarrationVoice } from "./project-narration";
import { storyboardShotsOfEpisode } from "./storyboard-episode-batch";
import { shotNumberOf } from "./storyboard-shots";
import type { CanvasNode, CanvasProject } from "./types";

// ─────────────────────────────────────────── 成本

/**
 * 站內 TTS 單價（幣/字），＝上游 `'tts-zh'.per_char`。**唯一真源已收攏到**
 * `@/lib/generation-model-catalog/tts-pricing`（站內三處消費點全吃那一顆）；
 * 本別名保留舊名供本檔內外引用（`estimatedCoins` 報價與實際扣費同一口徑）。
 */
export const VOICEOVER_TTS_PER_CHAR_COINS = TTS_COINS_PER_CHAR;

/**
 * 台詞表總字數 → 預估花費（幣）。精度收斂到 1e-6（與 `task-response.resolveTaskCostCoins`
 * 的 `Math.round(x * 1e6) / 1e6` 同一把尺）。默認走站內唯一真源 `ttsCoinsForChars`。
 */
export function estimateVoiceoverCoins(
  totalChars: number,
  perChar: number = VOICEOVER_TTS_PER_CHAR_COINS,
): number {
  if (perChar === VOICEOVER_TTS_PER_CHAR_COINS) return ttsCoinsForChars(totalChars);
  if (!Number.isFinite(totalChars) || totalChars <= 0) return 0;
  return Math.round(totalChars * perChar * 1e6) / 1e6;
}

// ─────────────────────────────────────────── 資料形狀

/** 台詞表的一行（對外報備口徑＝路由的 `lines[]`）。 */
export interface StoryboardVoiceoverLine {
  shotNumber: string;
  field: ShotAudioField;
  /** 送去合成的文本（逐字，未切分）。 */
  text: string;
  /** 字數（`String.length`；中文在 BMP 內，一字＝1）。 */
  chars: number;
}

/** 分鏡節點 → 扁平分鏡的投影結果（`nodeId` 供回寫時對回節點）。 */
export interface StoryboardVoiceoverShotEntry {
  nodeId: string;
  shot: StoryboardAudioShot;
}

/** 具名拒（整批不續作）。 */
export interface StoryboardVoiceoverRefusal {
  code: StoryboardVoiceoverRefusalCode;
  note: string;
}

/**
 * 本層會回的拒絕碼：
 *   · `episode_not_found`     —— 指定集不存在於 `project.episodes`（不猜、不按節點序切段）
 *   · `too_many_lines`        —— 橋接層硬上限 50 行（具名拒，不截斷）
 *   · `batch_size_over_tool_max_lines` —— 呼叫端要求的分批大小超過工具硬上限 50
 *   · `no_lines`              —— 專案／該集沒有任何可分句的台詞（不假裝成功寫入空集）
 *   · `tts_line_failed`       —— 某行 TTS 失敗（**立即停手**，不省下續行的錢、也不部分寫入）
 *   · 橋接層回寫拒絕碼（長度不符／URL 缺失／不可用／未知鏡號／source 非法）——原樣透傳
 */
export type StoryboardVoiceoverRefusalCode =
  | "episode_not_found"
  | "too_many_lines"
  | "batch_size_over_tool_max_lines"
  | "no_lines"
  | "tts_line_failed"
  | AudioApplyRefusalCode;

/** 分批邊界（**具名**：21..50 行絕不落在工具默認 20 的靜默截斷裡）。 */
export interface StoryboardVoiceoverBatch {
  /** 批號（0 起）。 */
  index: number;
  /** 起始行（含）。 */
  fromLine: number;
  /** 結束行（不含）。 */
  toLine: number;
  lineCount: number;
}

/** 分批計畫：每批的行數上限與每批請求應顯式帶上的 `maxLines`。 */
export interface StoryboardVoiceoverBatchPlan {
  batches: StoryboardVoiceoverBatch[];
  /** 本計畫每批的行數上限（＝呼叫端指定值；> 工具硬上限時具名拒）。 */
  maxLinesPerBatch: number;
}

/** dryRun 計畫（付費前的報備口徑）。 */
export interface StoryboardVoiceoverDryRunPlan {
  ok: true;
  dryRun: true;
  lines: StoryboardVoiceoverLine[];
  totalChars: number;
  estimatedCoins: number;
  /** 本次會用的旁白音色（專案綁定失效時＝`DEFAULT_TTS_VOICE`，見 `resolveVoiceoverVoice`）。 */
  voice: string;
  /** 分批計畫（具名邊界；供報備與分批型 client 對帳）。 */
  batches: StoryboardVoiceoverBatch[];
  /** 每一行請求應顯式帶上的 `maxLines`（逐批值，永遠 ≥ 該批行數；見 `planVoiceoverBatches`）。 */
  maxLinesByLine: number[];
  refused?: StoryboardVoiceoverRefusal;
}

/** 真跑結果（對外報備口徑＝路由的凍結契約）。 */
export interface StoryboardVoiceoverRunResult {
  ok: boolean;
  applied: boolean;
  lines: StoryboardVoiceoverLine[];
  totalChars: number;
  /**
   * 本次實際花費（幣）：全部執行行都有上游回報才給總和；有任何一行查不到＝`null`
   * （不填 0 假裝免費）；一行都沒執行＝`0`（真的沒花）。
   */
  costCoins: number | null;
  drift: AudioDurationDrift[];
  refused?: StoryboardVoiceoverRefusal;
  unmeasuredDurations?: string[];
}

/** 真跑結果 ＋ 回寫後的分鏡（後者只在 `applied:true` 時可落盤）＋ 投影溯源（回寫節點時對回 nodeId）。 */
export interface StoryboardVoiceoverExecution {
  result: StoryboardVoiceoverRunResult;
  shots: StoryboardAudioShot[];
  /** 與 `shots` 同索引的節點溯源（`applyVoiceoverShotsToNodes` 的唯一輸入）。 */
  entries: StoryboardVoiceoverShotEntry[];
}

/** 逐行 TTS 請求（**一行一次呼叫**；禁並發、禁 retry、禁迴圈試探由呼叫端保證）。 */
export interface StoryboardVoiceoverLineRequest {
  /** 台詞表行序（＝ `source` 索引）。 */
  index: number;
  shotNumber: string;
  field: ShotAudioField;
  /** 逐字照送的文本（本層不改寫）。 */
  text: string;
  voice: string;
  /**
   * 本批次的行數上限。**必須顯式帶上且 ≥ 本批行數**：上游工具默認 20、硬上限 50，
   * 不顯式覆蓋就會把 21..50 行靜默截斷（＝後半段沒聲，使用者看不出來）。
   */
  maxLines: number;
  batchIndex: number;
  batchCount: number;
}

/** 逐行 TTS 回應（真實來源由注入 client 決定；站點無 ffprobe ⇒ `durationMs` 可為 null）。 */
export interface StoryboardVoiceoverLineResult {
  /** 合成音檔 URL；空／不可用＝該行失敗（整批拒寫）。 */
  audioUrl?: string | null;
  /** ffprobe 實測時長（ms）；站點無此能力＝`null`（誠實缺，不估算冒充）。 */
  durationMs?: number | null;
  /** 該行上游花費（幣）；上游未回報＝`null`（不填 0）。 */
  costCoins?: number | null;
  /** 該行失敗原因（有值＝該行失敗）。 */
  error?: string;
}

/** 逐行 TTS client（真實現＝站點既有 TTS 路徑；測試＝假 client）。 */
export type StoryboardVoiceoverTtsClient = (
  request: StoryboardVoiceoverLineRequest,
) => Promise<StoryboardVoiceoverLineResult>;

// ─────────────────────────────────────────── ① 專案 → 扁平分鏡

/**
 * 專案 → 目標集（或全專案）的分鏡投影。
 *
 *   · 指定 `episode`（＝`CanvasEpisode.episodeNo`，1 起）：查得到集 ⇒ 走既有輪子
 *     `storyboardShotsOfEpisode`（只認 `episodeId` 逐字相符）；查不到 ⇒ 具名拒
 *     `episode_not_found`（**不**退回全專案、**不**按節點序切段）。
 *   · 未指定 ⇒ 全專案分鏡（`storyboardShot.shotNumber` 非空），按鏡號 numeric 排序。
 *   · 每鏡的四欄逐字照橋接層規則投影；既有音軌只收 `usableAudioUrl` 認可的值
 *     （判準與 `storyboard-shots.readAudioTracks` 同一把尺）。
 *
 * `durationSeconds` **刻意不填**：站點側 `CanvasNodeMetadata` 沒有分鏡計畫秒數欄
 * （21 欄契約是編劇階段口徑，`storyboardShot` 無此欄；`duration_ms` 是 Blender 卡的欄位）。
 * ⇒ 缺席＝drift 無計畫值可比（誠實回 null），不從別處推導、不編造。
 */
export function projectStoryboardShots(
  project: Pick<CanvasProject, "nodes" | "episodes">,
  episode?: number,
): { entries: StoryboardVoiceoverShotEntry[]; episodeId: string | null; refused?: StoryboardVoiceoverRefusal } {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  let episodeId: string | null = null;
  let targets: readonly CanvasNode[];

  if (episode !== undefined) {
    const match = (project.episodes ?? []).find((item) => item?.episodeNo === episode);
    if (!match) {
      return {
        entries: [],
        episodeId: null,
        refused: {
          code: "episode_not_found",
          note: `专案里没有第 ${episode} 集（CanvasEpisode.episodeNo 查无）；不退回全专案、不按节点序切段。`,
        },
      };
    }
    episodeId = match.id;
    targets = storyboardShotsOfEpisode(nodes, match.id);
  } else {
    targets = nodes
      .filter((node) => shotNumberOf(node) !== undefined)
      .slice()
      .sort((a, b) =>
        (shotNumberOf(a) ?? "").localeCompare(shotNumberOf(b) ?? "", undefined, { numeric: true }),
      );
  }

  const entries: StoryboardVoiceoverShotEntry[] = [];
  for (const node of targets) {
    const shotNumber = shotNumberOf(node);
    if (!shotNumber) continue;
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    const storyboardShot = metadata.storyboardShot as { dialogue?: unknown } | undefined;
    const dialogue = storyboardShot?.dialogue;
    const narration = metadata.narration;
    const dialogueAudioId = usableAudioUrl(metadata.dialogueAudioId);
    const narrationAudioId = usableAudioUrl(metadata.narrationAudioId);
    entries.push({
      nodeId: node.id,
      shot: {
        shotNumber,
        ...(typeof dialogue === "string" && dialogue.trim() ? { dialogue } : {}),
        ...(typeof narration === "string" && narration.trim() ? { narration } : {}),
        ...(dialogueAudioId ? { dialogueAudioId } : {}),
        ...(narrationAudioId ? { narrationAudioId } : {}),
      },
    });
  }
  return { entries, episodeId };
}

// ─────────────────────────────────────────── ② 音色

/**
 * 本次逐鏡配音實際會用的音色。
 *
 * 來源＝專案級旁白音色（`CanvasProject.narrationVoice`，值域＝`voice-library` 的語音庫，
 * 見 `types.ts` 該欄註釋），經既有輪子 `effectiveNarrationVoice` 判「此刻真的生效」——
 * 該輪子逐字規定旁白音色只在解說劇（`scriptType === "monologue"`）時生效。
 * 未綁定／不生效 ⇒ `DEFAULT_TTS_VOICE`（既有常數，＝上游 proxy 的 `DEFAULT_VOICE`）。
 * **不自己造預設音色**（禁造輪子）。
 */
export function resolveVoiceoverVoice(project: Pick<CanvasProject, "scriptType" | "narrationVoice">): string {
  return effectiveNarrationVoice(project) ?? DEFAULT_TTS_VOICE;
}

// ─────────────────────────────────────────── ③ 分批（max_lines 陷阱）

/**
 * 台詞表分批計畫。**這一段是本層對上游 `max_lines` 陷阱的正面處理**：
 *
 *   · 上游工具默認 `max_lines = 20`、硬上限 50，超過即**截斷**（`AUDIO_TOOL_DEFAULT_MAX_LINES`
 *     / `AUDIO_TOOL_MAX_LINES`，逐字讀自橋接層檔頭）。本層**永不**讓任何一批的行數上限落在
 *     默認值上：每一批請求都帶顯式 `maxLines = 該批實際行數`（見 `buildLinesAndPlan`）。
 *   · 21..50 行**不會**被靜默截斷：它們是「一批、具名邊界、顯式 maxLines = 行數」，
 *     或被呼叫端用 `maxLinesPerBatch` 切成多批（每批具名 index/fromLine/toLine）。
 *   · `maxLinesPerBatch` 超過工具硬上限 50 ⇒ **具名拒** `batch_size_over_tool_max_lines`
 *     （不悄悄夾到 50——那會讓呼叫端以為自己設的大小生效了）。
 *   · 行數為 0 ⇒ 空批次（呼叫端自行決定是否為錯誤，本函式不對 0 行造假）。
 */
export function planVoiceoverBatches(
  lineCount: number,
  maxLinesPerBatch: number = AUDIO_TOOL_MAX_LINES,
): StoryboardVoiceoverBatchPlan | { refused: StoryboardVoiceoverRefusal } {
  if (!Number.isInteger(maxLinesPerBatch) || maxLinesPerBatch < 1) {
    return {
      refused: {
        code: "batch_size_over_tool_max_lines",
        note: `maxLinesPerBatch 必须是 ≥1 的整数，收到 ${String(maxLinesPerBatch)}。`,
      },
    };
  }
  if (maxLinesPerBatch > AUDIO_TOOL_MAX_LINES) {
    return {
      refused: {
        code: "batch_size_over_tool_max_lines",
        note: `maxLinesPerBatch ${maxLinesPerBatch} 超过上游 TTS 工具硬上限 ${AUDIO_TOOL_MAX_LINES}（默認 ${AUDIO_TOOL_DEFAULT_MAX_LINES}）；不悄悄夹小，请显式指定 ≤ ${AUDIO_TOOL_MAX_LINES}。`,
      },
    };
  }
  const batches: StoryboardVoiceoverBatch[] = [];
  const total = Math.max(0, Math.floor(lineCount));
  for (let from = 0; from < total; from += maxLinesPerBatch) {
    const toLine = Math.min(total, from + maxLinesPerBatch);
    batches.push({ index: batches.length, fromLine: from, toLine, lineCount: toLine - from });
  }
  return { batches, maxLinesPerBatch };
}

/** 台詞表 + 分批（本層內部；`lines` 對外報備、`maxLinesByLine` 逐行帶給 client）。 */
function buildLinesAndPlan(
  entries: readonly StoryboardVoiceoverShotEntry[],
  maxLinesPerBatch: number,
):
  | {
      lines: StoryboardVoiceoverLine[];
      source: AudioSourceRef[];
      batches: StoryboardVoiceoverBatch[];
      maxLinesByLine: number[];
    }
  | { refused: StoryboardVoiceoverRefusal } {
  const plan = shotsToAudioScript(entries.map((entry) => entry.shot));
  // 文本逐字取自橋接層吐出的 `script`（唯一真源＝它的欄位序與 trim 規則）；
  // 不在此重寫「哪一欄進哪一行」的第二套邏輯。
  const rows = JSON.parse(plan.script) as Array<{ role?: string; text?: string }>;
  const lines: StoryboardVoiceoverLine[] = plan.source.map((ref, i) => {
    const text = typeof rows[i]?.text === "string" ? (rows[i]!.text as string) : "";
    return { shotNumber: ref.shotNumber, field: ref.field, text, chars: text.length };
  });
  // 硬上限 50：橋接層已具名拒（`source` 仍是完整未截斷的內容）——原樣透傳，不代為截斷。
  if (plan.refused) {
    return { refused: { code: "too_many_lines", note: plan.refused.note } };
  }
  const batchPlan = planVoiceoverBatches(lines.length, maxLinesPerBatch);
  if ("refused" in batchPlan) return { refused: batchPlan.refused };
  const maxLinesByLine = lines.map((_, index) => {
    const batch = batchPlan.batches.find((item) => index >= item.fromLine && index < item.toLine);
    return batch?.lineCount ?? Math.max(1, lines.length);
  });
  return {
    lines,
    source: plan.source,
    batches: batchPlan.batches,
    maxLinesByLine,
  };
}

// ─────────────────────────────────────────── ④ dryRun（付費前報備）

/**
 * dryRun：只算行數／字數／預估幣，**不碰上游**（呼叫端保證不呼叫 TTS）。
 * 具名拒（>50 行／集不存在／分批大小非法）也在此回報，但 `ok` 仍為 true——dryRun 是
 * 「報備口徑」：報備的內容就是「會有多少行、要花多少、以及為何拒」。
 */
export function planStoryboardVoiceoverDryRun(
  project: Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice">,
  options: { episode?: number; maxLinesPerBatch?: number } = {},
): StoryboardVoiceoverDryRunPlan {
  const projection = projectStoryboardShots(project, options.episode);
  const voice = resolveVoiceoverVoice(project);
  if (projection.refused) {
    return {
      ok: true,
      dryRun: true,
      lines: [],
      totalChars: 0,
      estimatedCoins: 0,
      voice,
      batches: [],
      maxLinesByLine: [],
      refused: projection.refused,
    };
  }
  const built = buildLinesAndPlan(projection.entries, options.maxLinesPerBatch ?? AUDIO_TOOL_MAX_LINES);
  if ("refused" in built) {
    return {
      ok: true,
      dryRun: true,
      lines: [],
      totalChars: 0,
      estimatedCoins: 0,
      voice,
      batches: [],
      maxLinesByLine: [],
      refused: built.refused,
    };
  }
  const totalChars = built.lines.reduce((sum, line) => sum + line.chars, 0);
  return {
    ok: true,
    dryRun: true,
    lines: built.lines,
    totalChars,
    estimatedCoins: estimateVoiceoverCoins(totalChars),
    voice,
    batches: built.batches,
    maxLinesByLine: built.maxLinesByLine,
  };
}

// ─────────────────────────────────────────── ⑤ 真跑（逐行序列）

/**
 * 逐行序列呼叫既有 TTS，成功才整批回寫分鏡。
 *
 * 序列與停手規則（**不並發、不 retry、不迴圈試探**）：
 *   · 逐行 for 迴圈，等一行完成才送下一行。
 *   · 任一行回 `error` 或拿不出可用 `audioUrl` ⇒ **立即停手**：不再送後續行（省下續行的錢），
 *     且**整批拒寫**（不部分寫入——部分寫入＝分鏡半數有聲、使用者以為完成）。
 *   · 上游不回 `duration_ms` ⇒ 照 `null` 傳給橋接層（它會把該鏡收進 `unmeasuredDurations`）。
 *
 * 成本：全部執行行都有有限 `costCoins` ⇒ 總和；任一查不到 ⇒ `null`；一行未執行 ⇒ `0`。
 * 回寫：一律經橋接層 `applyAudioTimelineToShots`（不接受任何自拼 patch）。
 * 漂移：`audioDurationDrift` 只回報不改秒數；未成功寫入時 `drift` 回空陣列。
 */
export async function runStoryboardVoiceover(
  project: Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice">,
  options: {
    client: StoryboardVoiceoverTtsClient;
    episode?: number;
    maxLinesPerBatch?: number;
    voice?: string;
  },
): Promise<StoryboardVoiceoverExecution> {
  const projection = projectStoryboardShots(project, options.episode);
  const fallbackShots = projection.entries.map((entry) => entry.shot);
  const voice = options.voice ?? resolveVoiceoverVoice(project);
  const refuse = (refusal: StoryboardVoiceoverRefusal): StoryboardVoiceoverExecution => ({
    result: {
      ok: false,
      applied: false,
      lines: [],
      totalChars: 0,
      costCoins: 0,
      drift: [],
      refused: refusal,
    },
    shots: fallbackShots,
    entries: projection.entries,
  });

  if (projection.refused) return refuse(projection.refused);

  const built = buildLinesAndPlan(projection.entries, options.maxLinesPerBatch ?? AUDIO_TOOL_MAX_LINES);
  if ("refused" in built) return refuse(built.refused);

  if (built.lines.length === 0) {
    return refuse({
      code: "no_lines",
      note: "该专案／该集没有任何可分句的台詞（dialogue／narration 皆空或不存在）；不假裝写入空集。",
    });
  }

  const batchCount = built.batches.length;
  const timeline: AudioTimelineEntry[] = [];
  let costSum = 0;
  let costAllKnown = true;
  for (let index = 0; index < built.lines.length; index++) {
    const line = built.lines[index];
    const source = built.source[index];
    const batch = built.batches.find((item) => index >= item.fromLine && index < item.toLine) ?? built.batches[0];
    const response = await options.client({
      index,
      shotNumber: line.shotNumber,
      field: line.field,
      text: line.text,
      voice,
      maxLines: built.maxLinesByLine[index],
      batchIndex: batch?.index ?? 0,
      batchCount,
    });
    const audioUrl = usableAudioUrl(response?.audioUrl);
    if (response?.error || !audioUrl) {
      const reason = response?.error ?? "未回可用音檔 URL";
      return {
        result: {
          ok: false,
          applied: false,
          lines: built.lines,
          totalChars: built.lines.reduce((sum, item) => sum + item.chars, 0),
          costCoins: costAllKnown ? Math.round(costSum * 1e6) / 1e6 : null,
          drift: [],
          refused: {
            code: "tts_line_failed",
            note: `第 ${index + 1} 行（镜 ${line.shotNumber}·${line.field}）TTS 失败：${reason}；已立即停手，后续行未送，整批拒写（分镜原样）。`,
          },
        },
        shots: fallbackShots,
        entries: projection.entries,
      };
    }
    const rawCost = response?.costCoins;
    const costKnown = typeof rawCost === "number" && Number.isFinite(rawCost);
    if (costKnown) costSum += rawCost as number;
    else costAllKnown = false;
    timeline.push({
      index,
      role: source.field,
      text: line.text,
      audio_url: audioUrl,
      duration_ms: typeof response?.durationMs === "number" && Number.isFinite(response.durationMs)
        ? response.durationMs
        : null,
      ...(costKnown ? { cost_coins: rawCost as number } : {}),
    });
  }

  const totalChars = built.lines.reduce((sum, item) => sum + item.chars, 0);
  const applied = applyAudioTimelineToShots(fallbackShots, timeline, built.source);
  if (!applied.applied) {
    return {
      result: {
        ok: false,
        applied: false,
        lines: built.lines,
        totalChars,
        costCoins: costAllKnown ? Math.round(costSum * 1e6) / 1e6 : null,
        drift: [],
        refused: {
          code: applied.refused?.code ?? "invalid_source",
          note: applied.refused?.note ?? "回写被拒（桥接层未给原因）。",
        },
      },
      shots: applied.shots,
      entries: projection.entries,
    };
  }

  return {
    result: {
      ok: true,
      applied: true,
      lines: built.lines,
      totalChars,
      costCoins: costAllKnown ? Math.round(costSum * 1e6) / 1e6 : null,
      drift: audioDurationDrift(fallbackShots, timeline, built.source),
      unmeasuredDurations: applied.unmeasuredDurations,
    },
    shots: applied.shots,
    entries: projection.entries,
  };
}

// ─────────────────────────────────────────── ⑥ dryRun／真跑 分派

export type StoryboardVoiceoverOutcome =
  | { kind: "dryRun"; plan: StoryboardVoiceoverDryRunPlan }
  | { kind: "run"; execution: StoryboardVoiceoverExecution };

/**
 * `dryRun`／真跑的**唯一分派**（路由只調這支，分支語義只此一份）。
 *
 * 命門：`dryRun === true` ⇒ **保證一次都不呼叫 `client`**（呼叫端仍必須傳一個 client——
 * 傳個 tripwire 就能在測試裡把這條保證斷言出來；本函式的 dryRun 分支在結構上不碰它）。
 */
export async function storyboardVoiceover(
  project: Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice">,
  options: {
    dryRun: boolean;
    /** dryRun=true 時保證不被呼叫；dryRun=false 時為逐行 TTS 的唯一出口。 */
    client: StoryboardVoiceoverTtsClient;
    episode?: number;
    maxLinesPerBatch?: number;
    voice?: string;
  },
): Promise<StoryboardVoiceoverOutcome> {
  if (options.dryRun) {
    return {
      kind: "dryRun",
      plan: planStoryboardVoiceoverDryRun(project, {
        episode: options.episode,
        maxLinesPerBatch: options.maxLinesPerBatch,
      }),
    };
  }
  return { kind: "run", execution: await runStoryboardVoiceover(project, options) };
}

// ─────────────────────────────────────────── ⑦ 回寫分鏡節點

/** 音軌四鍵（介面凍結，逐字照 `storyboard-shots.StoryboardShotAudioMetadata`）；本層只投影這三支音軌鍵。 */
const AUDIO_PATCH_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const;

/**
 * 把逐鏡配音結果回寫到分鏡節點 metadata（純函式，回新陣列，**不動輸入**）。
 *
 * patch 的來源是**橋接層回寫後的扁平分鏡**（`applyAudioTimelineToShots` 的 `shots`），
 * 本層只把它投影成三支凍結欄位——**不重算錨、不重判 URL**（那些仍由橋接層唯一決定）。
 * 缺席的鍵**不刪既有值**（與 `bindShotAudioTrack` 的 patch 語義一致：只寫不刪）。
 *
 * `missingNodeIds`：entries 指向的節點在傳入 `nodes` 裡找不到（例如寫入前節點被刪）。
 * **非空＝整批不可落盤**（呼叫端據此拒寫，不做部分寫入）。
 */
export function applyVoiceoverShotsToNodes(
  nodes: readonly CanvasNode[],
  entries: readonly StoryboardVoiceoverShotEntry[],
  appliedShots: readonly StoryboardAudioShot[],
): { nodes: CanvasNode[]; missingNodeIds: string[] } {
  const copy = [...nodes];
  if (entries.length !== appliedShots.length) {
    return { nodes: copy, missingNodeIds: entries.map((entry) => entry.nodeId) };
  }
  const known = new Set(copy.map((node) => node.id));
  const missingNodeIds = entries.filter((entry) => !known.has(entry.nodeId)).map((entry) => entry.nodeId);
  if (missingNodeIds.length) return { nodes: copy, missingNodeIds };

  const patchByNodeId = new Map<string, Record<string, string>>();
  entries.forEach((entry, index) => {
    const shot = appliedShots[index];
    const bag = shot as unknown as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const key of AUDIO_PATCH_KEYS) {
      const value = bag[key];
      if (typeof value === "string" && value) patch[key] = value;
    }
    patchByNodeId.set(entry.nodeId, patch);
  });

  return {
    nodes: copy.map((node) => {
      const patch = patchByNodeId.get(node.id);
      if (!patch) return node;
      return { ...node, metadata: { ...node.metadata, ...patch } };
    }),
    missingNodeIds: [],
  };
}