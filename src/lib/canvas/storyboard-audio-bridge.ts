// 分鏡 → 配音台詞表 → 回寫分鏡（橋接純函式層；2026-09-30）。
//
// 結構修因（病歷 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s 音軌
// ——TTS 工具（VPS `audio_first_timeline.ts`）本身沒問題，缺的是**逐鏡組台詞表**與
// **把結果寫回分鏡**這兩跳。本檔只補這兩跳，全部零 IO、零網路、不呼叫上游（也不是
// TTS 工具本身：本檔只產出它要吃的 `script` 字串，呼叫與否由呼叫端決定）。
//
// 三支函式（每支都用同一條「本地平行 `source` 陣列」把中間產物對回鏡號）：
//   ① `shotsToAudioScript`   分鏡 → 台詞表（每鏡每欄位恰好一行）
//   ② `applyAudioTimelineToShots`  timeline + source → 回寫分鏡音軌（多重失敗閘，整批或全不寫）
//   ③ `audioDurationDrift`   逐鏡比「實測配音時長」vs「分鏡計畫秒數」（只回報）
//
// ── 上游工具的真實契約（VPS 活本逐字讀完後照抄，不猜；本檔不對它做任何假設外的加工）──
//   · 輸入 `script`：JSON 行陣列字串 `[{"role":"…","text":"…"}]`，或純文字每行一句。
//   · `max_lines`：**默認 20、硬上限 50**，超出**截斷**並回 `truncated`。
//     ⇒ 呼叫端送本檔產出的 `script` 時，**必須把 `max_lines` 設為 ≥ `source.length`**，
//       否則 21..50 行會被默認值 20 靜默截斷（＝後半段沒聲，使用者看不出來）。本檔
//       >50 直接具名拒，不代為分批、不代為截斷（分批是產品決策，不在本層）。
//   · `speed` 上游未支持語速控制、傳入不生效 ⇒ 本檔**不在 `speed` 上做任何文章**。
//   · 每行回 `{index, role, text, offset_ms, audio_url, duration_ms, cost_coins?, error?,
//     duration_note?}`；`duration_ms` 由 ffprobe **實測**，單行 ffprobe 失敗回 `null`
//     （不冒充），`tts_unavailable` 整批 fail（不返半成品）。
//
// ── 為何用「本地平行 `source`」而不把鏡號塞進 `role`/`text` ──
//   `role`/`text` 是**送去合成**的內容，會進上游 prompt／被唸出來；把鏡號塞進去＝兩種污染：
//   ① `text` 塞鏡號 → 配音真的把鏡號唸出來；② `role` 塞鏡號 → 冒充說話者角色。
//   且上游只保證「回傳陣列與送入行序一一對應」，**不保證**把 role 逐字回傳。故鏡號只留在
//   本地的 `source`（與 timeline 同索引的平行陣列），回寫／比對時 `timeline[i]` ↔ `source[i]`。
//
// ── 不做的加工（附理由，避免下游誤以為漏做）──
//   · **不切分 `dialogue` 的 `[角色]：「…」` 標記**：`storyboard-contract.ts` 已裁定該格式
//     **無契約文件**，硬套等於自造轉換（同 `durationSeconds` 的病灶）；故 text **逐字照送**，
//     本層不扮演「把標記翻成台詞」的第二套轉換器。
//   · **不從 `dialogue` 猜旁白**（同檔裁定逐字）：旁白只有 `narration` 欄，沒有就沒有，
//     不從對白推導。
//   · **不自造音頻 URL 判準**：回寫的可用性判準走既有輪子 `usableAudioUrl`
//     （`@/lib/agent-output-cards`），`audioAnchorId` 的重算走既有輪子 `bindShotAudioTrack`
//     （`./storyboard-shots`）——鍵名與錨規則只准一份。

import { usableAudioUrl } from "@/lib/agent-output-cards";
import { bindShotAudioTrack, type ShotAudioTrackRole } from "./storyboard-shots";
import type { CanvasNodeMetadata } from "./types";

// ─────────────────────────────────────────── 上限與門檻

/**
 * 上游工具 `audio_first_timeline` 的**硬上限**（行）。超過＝不產出台詞表（具名拒），
 * **不代為截斷**：截斷＝後半段沒聲、且使用者看不出來（假成功）。
 */
export const AUDIO_TOOL_MAX_LINES = 50;

/**
 * 上游工具的**默認** `max_lines`。它不是失敗，是陷阱：呼叫端不顯式覆蓋就會被截到 20。
 * 本檔導出它只為讓呼叫端能在同一處讀到這個數字（`max_lines = Math.max(默認, source.length)`）。
 */
export const AUDIO_TOOL_DEFAULT_MAX_LINES = 20;

/**
 * 逐鏡時長漂移門檻（秒）。選 0.5 的理由：本 repo **找不到**既有同類門檻
 * （`shortdrama-domain` 的 `duration_bounds` 是 2–30s 值域，不是計畫/實測差值；
 * `storyboard-contract.ts` 只自陳「時長兩把尺互相衝突」而未定差額門檻），故此值由本層定：
 * 取 0.5s ＝上游 TTS 多以句為單位、單句長度抖動在數百毫秒量級，0.5s 已足以把「整段沒合成」
 * （分鐘級落差）與「逐句正常抖動」分開；再收緊會把正常斷句判成漂移。
 */
export const DURATION_DRIFT_THRESHOLD_SEC = 0.5;

/** 每鏡輪詢兩欄位的固定順序（決定台詞表行序＝偏移序）。對白先於旁白，對齊錨優先序。 */
const AUDIO_FIELD_ORDER = ["dialogue", "narration"] as const;

// ─────────────────────────────────────────── 資料形狀

/** 台詞表可承載的兩欄位（鍵名逐字照 `STORYBOARD_SHOT_FIELDS` 的 `dialogue` 與 metadata 的 `narration`）。 */
export type ShotAudioField = "dialogue" | "narration";

/**
 * 分鏡（本層的輸入投影；**不綁 CanvasNode 形狀**，呼叫端把節點映到此形即可）：
 *   · `shotNumber`  ← `node.metadata.storyboardShot.shotNumber`（鏡唯一鍵，契約保證非空）
 *   · `dialogue`    ← `node.metadata.storyboardShot.dialogue`（**單一字串**，可能含 `[角色]：「…」`）
 *   · `narration`   ← `node.metadata.narration`（2026-09-30 落地的旁白文本鍵；**不從 dialogue 猜**）
 *   · `durationSeconds` ← 分鏡**計畫**秒數（成片階段口徑；21 欄無此欄，缺席＝無計畫值可比）
 *   · 三個音軌鍵    ← 同名 metadata 鍵（回寫的落點；錨＝`dialogueAudioId || narrationAudioId`）
 */
export interface StoryboardAudioShot {
  /** 鏡號（唯一鍵；空＝不是鏡，本層不臆造）。 */
  shotNumber: string;
  /** 對白（單一字串；可能含 `[角色]：「…」` 標記，本層**逐字照送**不切分）。 */
  dialogue?: string;
  /** 旁白文本（單鏡旁白；缺席＝本鏡無旁白，不從對白推導）。 */
  narration?: string;
  /** 計畫秒數（分鏡口徑）；非有限數／缺席＝無計畫值可比（drift 誠實回 null）。 */
  durationSeconds?: number | null;
  /** 該鏡對白音檔資產 id（回寫落點）。 */
  dialogueAudioId?: string;
  /** 該鏡旁白音檔資產 id（回寫落點）。 */
  narrationAudioId?: string;
  /** 音軌錨（相容鍵）＝`dialogueAudioId || narrationAudioId`（回寫時由輪子重算）。 */
  audioAnchorId?: string;
}

/**
 * 台詞表的**本地平行陣列**一項：第 i 行屬於哪一鏡的哪一欄位。
 * 這是回寫／比對時對回鏡號的唯一依據（鏡號**不進** `role`/`text`）。
 */
export interface AudioSourceRef {
  shotNumber: string;
  field: ShotAudioField;
}

/** `shotsToAudioScript` 的結果：上游要吃的 `script` 字串 ＋ 本地溯源 `source`。 */
export interface AudioScriptPlan {
  /** 送上游 `audio_first_timeline` 的 `script`（JSON 行陣列字串 `[{"role","text"}]`）。 */
  script: string;
  /** 與 `script` 行**同索引**的溯源陣列（回寫時逐行對回鏡號）。 */
  source: AudioSourceRef[];
  /** 具名拒（`source`/`script` 仍是**完整未截斷**的內容，交還呼叫端自行處置）。 */
  refused?: { code: "too_many_lines"; note: string };
}

/** 回寫被整體拒絕的原因（**任一發生＝整批不寫**，不部分寫入）。 */
export type AudioApplyRefusalCode =
  | "length_mismatch"
  | "missing_audio_url"
  | "unusable_audio_url"
  | "unknown_shot"
  | "invalid_source";

/** `applyAudioTimelineToShots` 的結果。 */
export interface AudioApplyResult {
  /** 回寫後的新陣列（拒絕時＝輸入的**等值新物件**，分鏡原樣、呼叫端拿不到突變舊參考）。 */
  shots: StoryboardAudioShot[];
  applied: boolean;
  /** 未被接受的原因（`applied=true` 時缺席）。 */
  refused?: { code: AudioApplyRefusalCode; note: string };
  /** 已寫回但**時長未實測**（`duration_ms` 非有限數）的鏡號（回報用，不阻擋寫入）。 */
  unmeasuredDurations: string[];
}

/** 單鏡時長漂移（**只回報不修正**——不改分鏡秒數）。 */
export interface AudioDurationDrift {
  shotNumber: string;
  /** 分鏡計畫秒數；缺席／非有限數＝`null`（無從比對，不編造）。 */
  plannedSec: number | null;
  /** 本批實測配音秒數（該鏡各行 `duration_ms` 之和）；無法實測＝`null`；本批無行＝`0`。 */
  actualSec: number | null;
  /** `actualSec - plannedSec`（兩者皆非 null 才給值）。 */
  deltaSec: number | null;
  /** `|deltaSec| > DURATION_DRIFT_THRESHOLD_SEC`（無法比對時恆 `false`）。 */
  overThreshold: boolean;
  /** 誠實註記（無法比對的原因等；可讀時缺席）。 */
  note?: string;
}

// ─────────────────────────────────────────── ① 分鏡 → 台詞表

/**
 * 分鏡 → 上游 TTS 要吃的台詞表。
 *
 * 契約（本任務的命門）：
 *   · **每鏡每欄位恰好一行**：6 鏡各有旁白 → 6 行，**不摺成 1 行**（病灶本體）。
 *   · 空白／純空白的 `dialogue`/`narration` **不產生行**（不送空行燒錢）。
 *   · 行序＝分鏡陣列序 × 欄位序（`dialogue` → `narration`）；`source[i]` 與 `script` 第 i 行同索引。
 *   · 行數 **> `AUDIO_TOOL_MAX_LINES`（50）→ 具名拒**，`note` 寫明「硬上限 50，請縮集數或分批」，
 *     **不默默截斷**（截斷＝後半段沒聲＝使用者看不出來的假成功）。
 *   · 無鏡號的項**略過**（不是鏡，不臆造鏡號）。
 *   · text **逐字照送**（不切 `[角色]：「…」` 標記、不改寫）。
 */
export function shotsToAudioScript(shots: readonly StoryboardAudioShot[]): AudioScriptPlan {
  const rows: { role: ShotAudioField; text: string }[] = [];
  const source: AudioSourceRef[] = [];
  for (const shot of shots) {
    const shotNumber = typeof shot?.shotNumber === "string" ? shot.shotNumber.trim() : "";
    if (!shotNumber) continue;
    for (const field of AUDIO_FIELD_ORDER) {
      const raw = shot[field];
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) continue;
      rows.push({ role: field, text });
      source.push({ shotNumber, field });
    }
  }
  const script = JSON.stringify(rows);
  if (source.length > AUDIO_TOOL_MAX_LINES) {
    return {
      script,
      source,
      refused: {
        code: "too_many_lines",
        note: `共 ${source.length} 行，超過 TTS 工具硬上限 ${AUDIO_TOOL_MAX_LINES}（工具默認 ${AUDIO_TOOL_DEFAULT_MAX_LINES}、超出即截斷）→ 具名拒，請縮集數或分批，本層不代為截斷。`,
      },
    };
  }
  return { script, source };
}

// ─────────────────────────────────────────── ② timeline → 回寫分鏡

/**
 * 把 TTS timeline 依 `source` 回寫到分鏡音軌。
 *
 * 落點（鍵名逐字照用）：`field === "dialogue"` → `dialogueAudioId`；`"narration"` → `narrationAudioId`；
 * `audioAnchorId` 由既有輪子 `bindShotAudioTrack` 依規則 `dialogueAudioId || narrationAudioId` 重算
 * （既有另一軌不動）。
 *
 * **多重失敗閘（任一即整批拒寫，回 `{applied:false, refused}`，分鏡原樣）**：
 *   `timeline.length !== source.length`（含上游截斷）／`source[i].field` 非兩值／
 *   `source[i].shotNumber` 不在輸入分鏡內／`timeline[i].audio_url` **空**（missing）或
 *   不是**可用音頻**（`usableAudioUrl` 不收，unusable）。**不准部分寫入**——部分寫入＝
 *   分鏡半數有聲、使用者以為完成。
 *
 * `duration_ms` 為 `null`（單行 ffprobe 失敗，上游誠實語義）**不阻擋寫入**（URL 仍有效），
 * 但該鏡號被收進 `unmeasuredDurations` 回報，避免「已綁定」被誤讀成「時長已驗」。
 */
export function applyAudioTimelineToShots(
  shots: readonly StoryboardAudioShot[],
  timeline: readonly AudioTimelineEntry[],
  source: readonly AudioSourceRef[],
): AudioApplyResult {
  const copy = shots.map((shot) => ({ ...shot }));
  const refuse = (code: AudioApplyRefusalCode, note: string): AudioApplyResult => ({
    shots: copy,
    applied: false,
    refused: { code, note },
    unmeasuredDurations: [],
  });

  if (timeline.length !== source.length) {
    return refuse(
      "length_mismatch",
      `timeline ${timeline.length} 行、source ${source.length} 行（含上游截斷）→ 整批拒寫，不部分寫入。`,
    );
  }

  const indexByShotNumber = new Map<string, number>();
  copy.forEach((shot, index) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : "";
    if (shotNumber) indexByShotNumber.set(shotNumber, index);
  });

  // 先全量驗證（純檢查，**不動 copy**）——全部合規才落盤，杜絕部分寫入。
  // patch **不在這裡算**：同一鏡的對白＋旁白兩行必須**序接**地以「上一行寫入後的狀態」為基底
  // 重算錨（先算好再合併會讓後一行的錨蓋掉前一行的對白優先序）。
  const planned: { index: number; role: ShotAudioTrackRole; url: string; shotNumber: string; measured: boolean }[] = [];
  const unmeasuredDurations: string[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const ref = source[i];
    const field = ref?.field;
    if (field !== "dialogue" && field !== "narration") {
      return refuse("invalid_source", `source[${i}].field 不是 dialogue/narration → 整批拒寫。`);
    }
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : "";
    const index = indexByShotNumber.get(shotNumber);
    if (index === undefined) {
      return refuse("unknown_shot", `source[${i}] 的鏡號「${shotNumber || "(空)"}」不在輸入分鏡內 → 整批拒寫。`);
    }
    const rawUrl = timeline[i]?.audio_url;
    const url = usableAudioUrl(rawUrl);
    if (!url) {
      return refuse(
        rawUrl ? "unusable_audio_url" : "missing_audio_url",
        `timeline[${i}]（鏡 ${shotNumber}）${rawUrl ? "的 audio_url 不是可用音頻" : "缺 audio_url"} → 整批拒寫。`,
      );
    }
    const measured = typeof timeline[i]?.duration_ms === "number" && Number.isFinite(timeline[i]!.duration_ms);
    if (!measured) unmeasuredDurations.push(shotNumber);
    planned.push({ index, role: field as ShotAudioTrackRole, url, shotNumber, measured });
  }

  // 驗證全過才落盤；逐行以「當前 copy 狀態」呼叫既有輪子 `bindShotAudioTrack`（鍵名與
  // `audioAnchorId` 重算的唯一實作），故同鏡兩行序接後錨仍為 `dialogueAudioId || narrationAudioId`。
  for (const row of planned) {
    const target = copy[row.index];
    const bag: CanvasNodeMetadata = {};
    if (target.dialogueAudioId) bag.dialogueAudioId = target.dialogueAudioId;
    if (target.narrationAudioId) bag.narrationAudioId = target.narrationAudioId;
    const mutation = bindShotAudioTrack(bag, row.role, row.url);
    copy[row.index] = { ...target, ...(mutation.patch as CanvasNodeMetadata) };
  }
  return { shots: copy, applied: true, unmeasuredDurations };
}

/** timeline 的一項（**只取本層要用的欄位**；上游實際回傳更寬，多餘欄位本層忽略）。 */
export interface AudioTimelineEntry {
  index?: number;
  role?: string;
  text?: string;
  offset_ms?: number | null;
  /** 合成音檔 URL（上游實測後回填；空/非音頻＝該批不可用）。 */
  audio_url?: string | null;
  /** ffprobe **實測**時長（ms）；上游單行失敗時為 `null`（不冒充）。 */
  duration_ms?: number | null;
  cost_coins?: number;
  error?: string;
  duration_note?: string;
}

// ─────────────────────────────────────────── ③ 逐鏡時長漂移

/** 秒值收斂到毫秒精度（避免浮點尾數噪音）。 */
function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 逐鏡比「實測配音時長」與「分鏡計畫秒數（`durationSeconds`）」。**只回報不修正**。
 *
 * 語義（照抄，勿改）：
 *   · 某鏡實際秒數＝本批 `source` 中屬於該鏡的所有行 `duration_ms` **之和** ÷ 1000
 *     （同一鏡的對白＋旁白視為**序接**、不假設重疊；這是本層明示的假設，非上游保證）。
 *   · 該鏡在本批**沒有行** → `actualSec = 0`（＝本批完全沒有它的配音，正是 P2 病灶的長相）。
 *   · 該鏡**有行但任一行 `duration_ms` 未實測** → `actualSec = null`（無法比對，不冒充）。
 *   · `plannedSec` 缺席／非有限數 → `null`。
 *   · `overThreshold` ＝兩者皆非 null 且 `|delta| > 0.5s`（見 `DURATION_DRIFT_THRESHOLD_SEC`）。
 *   · 回傳**輸入分鏡的每一鏡**（順序照輸入）。
 *
 * 這是對手 `duration_mismatch` 的等價物，也對上 `storyboard-contract.ts` 自陳的
 * 「時長兩把尺互相衝突」；本函式只把衝突擺出來，裁決（改分鏡秒數／改配音）不在本層。
 */
export function audioDurationDrift(
  shots: readonly StoryboardAudioShot[],
  timeline: readonly AudioTimelineEntry[],
  source: readonly AudioSourceRef[],
): AudioDurationDrift[] {
  const buckets = new Map<string, { totalMs: number; lines: number; unmeasured: boolean }>();
  const pairCount = Math.min(timeline.length, source.length);
  for (let i = 0; i < pairCount; i++) {
    const ref = source[i];
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : "";
    if (!shotNumber) continue;
    const bucket = buckets.get(shotNumber) ?? { totalMs: 0, lines: 0, unmeasured: false };
    bucket.lines += 1;
    const duration = timeline[i]?.duration_ms;
    if (typeof duration === "number" && Number.isFinite(duration)) bucket.totalMs += duration;
    else bucket.unmeasured = true;
    buckets.set(shotNumber, bucket);
  }

  return shots.map((shot) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : "";
    const rawPlanned = shot.durationSeconds;
    const plannedSec =
      typeof rawPlanned === "number" && Number.isFinite(rawPlanned) ? rawPlanned : null;
    const bucket = shotNumber ? buckets.get(shotNumber) : undefined;

    let actualSec: number | null;
    let note: string | undefined;
    if (!bucket || bucket.lines === 0) {
      actualSec = 0;
      note = "本批 timeline 無此鏡的配音行（可能無聲；準確性只到本批輸入）";
    } else if (bucket.unmeasured) {
      actualSec = null;
      note = "此鏡有 duration_ms 未實測的行，無法比對時長";
    } else {
      actualSec = bucket.totalMs / 1000;
    }
    if (plannedSec === null) {
      note = note ? `${note}；且分鏡無 durationSeconds 計畫值可比` : "分鏡無 durationSeconds 計畫值可比";
    }

    const deltaSec = plannedSec !== null && actualSec !== null ? roundSec(actualSec - plannedSec) : null;
    const overThreshold = deltaSec !== null && Math.abs(deltaSec) > DURATION_DRIFT_THRESHOLD_SEC;
    return {
      shotNumber,
      plannedSec,
      actualSec: actualSec === null ? null : roundSec(actualSec),
      deltaSec,
      overThreshold,
      ...(note ? { note } : {}),
    };
  });
}