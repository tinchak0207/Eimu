// 分镜 → 配音台词表 → 回写分镜（桥接纯函式层；2026-09-30）。
//
// 结构修因（病历 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s 音轨
// ——TTS 工具（VPS `audio_first_timeline.ts`）本身没问题，缺的是**逐镜组台词表**与
// **把结果写回分镜**这两跳。本档只补这两跳，全部零 IO、零网路、不呼叫上游（也不是
// TTS 工具本身：本档只产出它要吃的 `script` 字串，呼叫与否由呼叫端决定）。
//
// 三支函式（每支都用同一条「本地平行 `source` 阵列」把中间产物对回镜号）：
//   ① `shotsToAudioScript`   分镜 → 台词表（每镜每栏位恰好一行）
//   ② `applyAudioTimelineToShots`  timeline + source → 回写分镜音轨（多重失败闸，整批或全不写）
//   ③ `audioDurationDrift`   逐镜比「实测配音时长」vs「分镜计画秒数」（只回报）
//
// ── 上游工具的真实契约（VPS 活本逐字读完后照抄，不猜；本档不对它做任何假设外的加工）──
//   · 输入 `script`：JSON 行阵列字串 `[{"role":"…","text":"…"}]`，或纯文字每行一句。
//   · `max_lines`：**默认 20、硬上限 50**，超出**截断**并回 `truncated`。
//     ⇒ 呼叫端送本档产出的 `script` 时，**必须把 `max_lines` 设为 ≥ `source.length`**，
//       否则 21..50 行会被默认值 20 静默截断（＝后半段没声，使用者看不出来）。本档
//       >50 直接具名拒，不代为分批、不代为截断（分批是产品决策，不在本层）。
//   · `speed` 上游未支持语速控制、传入不生效 ⇒ 本档**不在 `speed` 上做任何文章**。
//   · 每行回 `{index, role, text, offset_ms, audio_url, duration_ms, cost_coins?, error?,
//     duration_note?}`；`duration_ms` 由 ffprobe **实测**，单行 ffprobe 失败回 `null`
//     （不冒充），`tts_unavailable` 整批 fail（不返半成品）。
//
// ── 为何用「本地平行 `source`」而不把镜号塞进 `role`/`text` ──
//   `role`/`text` 是**送去合成**的内容，会进上游 prompt／被念出来；把镜号塞进去＝两种污染：
//   ① `text` 塞镜号 → 配音真的把镜号念出来；② `role` 塞镜号 → 冒充说话者角色。
//   且上游只保证「回传阵列与送入行序一一对应」，**不保证**把 role 逐字回传。故镜号只留在
//   本地的 `source`（与 timeline 同索引的平行阵列），回写／比对时 `timeline[i]` ↔ `source[i]`。
//
// ── 不做的加工（附理由，避免下游误以为漏做）──
//   · **不切分 `dialogue` 的 `[角色]：「…」` 标记**：`storyboard-contract.ts` 已裁定该格式
//     **无契约文件**，硬套等于自造转换（同 `durationSeconds` 的病灶）；故 text **逐字照送**，
//     本层不扮演「把标记翻成台词」的第二套转换器。
//   · **不从 `dialogue` 猜旁白**（同档裁定逐字）：旁白只有 `narration` 栏，没有就没有，
//     不从对白推导。
//   · **不自造音频 URL 判准**：回写的可用性判准走既有轮子 `usableAudioUrl`
//     （`@/lib/agent-output-cards`），`audioAnchorId` 的重算走既有轮子 `bindShotAudioTrack`
//     （`./storyboard-shots`）——键名与锚规则只准一份。

import { usableAudioUrl } from "@/lib/agent-output-cards";
import { bindShotAudioTrack, type ShotAudioTrackRole } from "./storyboard-shots";
import type { CanvasNodeMetadata } from "./types";

// ─────────────────────────────────────────── 上限与门槛

/**
 * 上游工具 `audio_first_timeline` 的**硬上限**（行）。超过＝不产出台词表（具名拒），
 * **不代为截断**：截断＝后半段没声、且使用者看不出来（假成功）。
 */
export const AUDIO_TOOL_MAX_LINES = 50;

/**
 * 上游工具的**默认** `max_lines`。它不是失败，是陷阱：呼叫端不显式覆盖就会被截到 20。
 * 本档导出它只为让呼叫端能在同一处读到这个数字（`max_lines = Math.max(默认, source.length)`）。
 */
export const AUDIO_TOOL_DEFAULT_MAX_LINES = 20;

/**
 * 逐镜时长漂移门槛（秒）。选 0.5 的理由：本 repo **找不到**既有同类门槛
 * （`shortdrama-domain` 的 `duration_bounds` 是 2–30s 值域，不是计画/实测差值；
 * `storyboard-contract.ts` 只自陈「时长两把尺互相冲突」而未定差额门槛），故此值由本层定：
 * 取 0.5s ＝上游 TTS 多以句为单位、单句长度抖动在数百毫秒量级，0.5s 已足以把「整段没合成」
 * （分钟级落差）与「逐句正常抖动」分开；再收紧会把正常断句判成漂移。
 */
export const DURATION_DRIFT_THRESHOLD_SEC = 0.5;

/** 每镜轮询两栏位的固定顺序（决定台词表行序＝偏移序）。对白先于旁白，对齐锚优先序。 */
const AUDIO_FIELD_ORDER = ["dialogue", "narration"] as const;

// ─────────────────────────────────────────── 资料形状

/** 台词表可承载的两栏位（键名逐字照 `STORYBOARD_SHOT_FIELDS` 的 `dialogue` 与 metadata 的 `narration`）。 */
export type ShotAudioField = "dialogue" | "narration";

/**
 * 分镜（本层的输入投影；**不绑 CanvasNode 形状**，呼叫端把节点映到此形即可）：
 *   · `shotNumber`  ← `node.metadata.storyboardShot.shotNumber`（镜唯一键，契约保证非空）
 *   · `dialogue`    ← `node.metadata.storyboardShot.dialogue`（**单一字串**，可能含 `[角色]：「…」`）
 *   · `narration`   ← `node.metadata.narration`（2026-09-30 落地的旁白文本键；**不从 dialogue 猜**）
 *   · `durationSeconds` ← 分镜**计画**秒数（成片阶段口径；21 栏无此栏，缺席＝无计画值可比）
 *   · 三个音轨键    ← 同名 metadata 键（回写的落点；锚＝`dialogueAudioId || narrationAudioId`）
 */
export interface StoryboardAudioShot {
  /** 镜号（唯一键；空＝不是镜，本层不臆造）。 */
  shotNumber: string;
  /** 对白（单一字串；可能含 `[角色]：「…」` 标记，本层**逐字照送**不切分）。 */
  dialogue?: string;
  /** 旁白文本（单镜旁白；缺席＝本镜无旁白，不从对白推导）。 */
  narration?: string;
  /** 计画秒数（分镜口径）；非有限数／缺席＝无计画值可比（drift 诚实回 null）。 */
  durationSeconds?: number | null;
  /** 该镜对白音档资产 id（回写落点）。 */
  dialogueAudioId?: string;
  /** 该镜旁白音档资产 id（回写落点）。 */
  narrationAudioId?: string;
  /** 音轨锚（相容键）＝`dialogueAudioId || narrationAudioId`（回写时由轮子重算）。 */
  audioAnchorId?: string;
}

/**
 * 台词表的**本地平行阵列**一项：第 i 行属于哪一镜的哪一栏位。
 * 这是回写／比对时对回镜号的唯一依据（镜号**不进** `role`/`text`）。
 */
export interface AudioSourceRef {
  shotNumber: string;
  field: ShotAudioField;
}

/** `shotsToAudioScript` 的结果：上游要吃的 `script` 字串 ＋ 本地溯源 `source`。 */
export interface AudioScriptPlan {
  /** 送上游 `audio_first_timeline` 的 `script`（JSON 行阵列字串 `[{"role","text"}]`）。 */
  script: string;
  /** 与 `script` 行**同索引**的溯源阵列（回写时逐行对回镜号）。 */
  source: AudioSourceRef[];
  /** 具名拒（`source`/`script` 仍是**完整未截断**的内容，交还呼叫端自行处置）。 */
  refused?: { code: "too_many_lines"; note: string };
}

/** 回写被整体拒绝的原因（**任一发生＝整批不写**，不部分写入）。 */
export type AudioApplyRefusalCode =
  | "length_mismatch"
  | "missing_audio_url"
  | "unusable_audio_url"
  | "unknown_shot"
  | "invalid_source";

/** `applyAudioTimelineToShots` 的结果。 */
export interface AudioApplyResult {
  /** 回写后的新阵列（拒绝时＝输入的**等值新物件**，分镜原样、呼叫端拿不到突变旧参考）。 */
  shots: StoryboardAudioShot[];
  applied: boolean;
  /** 未被接受的原因（`applied=true` 时缺席）。 */
  refused?: { code: AudioApplyRefusalCode; note: string };
  /** 已写回但**时长未实测**（`duration_ms` 非有限数）的镜号（回报用，不阻挡写入）。 */
  unmeasuredDurations: string[];
}

/** 单镜时长漂移（**只回报不修正**——不改分镜秒数）。 */
export interface AudioDurationDrift {
  shotNumber: string;
  /** 分镜计画秒数；缺席／非有限数＝`null`（无从比对，不编造）。 */
  plannedSec: number | null;
  /** 本批实测配音秒数（该镜各行 `duration_ms` 之和）；无法实测＝`null`；本批无行＝`0`。 */
  actualSec: number | null;
  /** `actualSec - plannedSec`（两者皆非 null 才给值）。 */
  deltaSec: number | null;
  /** `|deltaSec| > DURATION_DRIFT_THRESHOLD_SEC`（无法比对时恒 `false`）。 */
  overThreshold: boolean;
  /** 诚实注记（无法比对的原因等；可读时缺席）。 */
  note?: string;
}

// ─────────────────────────────────────────── ① 分镜 → 台词表

/**
 * 分镜 → 上游 TTS 要吃的台词表。
 *
 * 契约（本任务的命门）：
 *   · **每镜每栏位恰好一行**：6 镜各有旁白 → 6 行，**不折成 1 行**（病灶本体）。
 *   · 空白／纯空白的 `dialogue`/`narration` **不产生行**（不送空行烧钱）。
 *   · 行序＝分镜阵列序 × 栏位序（`dialogue` → `narration`）；`source[i]` 与 `script` 第 i 行同索引。
 *   · 行数 **> `AUDIO_TOOL_MAX_LINES`（50）→ 具名拒**，`note` 写明「硬上限 50，请缩集数或分批」，
 *     **不默默截断**（截断＝后半段没声＝使用者看不出来的假成功）。
 *   · 无镜号的项**略过**（不是镜，不臆造镜号）。
 *   · text **逐字照送**（不切 `[角色]：「…」` 标记、不改写）。
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
        note: `共 ${source.length} 行，超过 TTS 工具硬上限 ${AUDIO_TOOL_MAX_LINES}（工具默认 ${AUDIO_TOOL_DEFAULT_MAX_LINES}、超出即截断）→ 具名拒，请缩集数或分批，本层不代为截断。`,
      },
    };
  }
  return { script, source };
}

// ─────────────────────────────────────────── ② timeline → 回写分镜

/**
 * 把 TTS timeline 依 `source` 回写到分镜音轨。
 *
 * 落点（键名逐字照用）：`field === "dialogue"` → `dialogueAudioId`；`"narration"` → `narrationAudioId`；
 * `audioAnchorId` 由既有轮子 `bindShotAudioTrack` 依规则 `dialogueAudioId || narrationAudioId` 重算
 * （既有另一轨不动）。
 *
 * **多重失败闸（任一即整批拒写，回 `{applied:false, refused}`，分镜原样）**：
 *   `timeline.length !== source.length`（含上游截断）／`source[i].field` 非两值／
 *   `source[i].shotNumber` 不在输入分镜内／`timeline[i].audio_url` **空**（missing）或
 *   不是**可用音频**（`usableAudioUrl` 不收，unusable）。**不准部分写入**——部分写入＝
 *   分镜半数有声、使用者以为完成。
 *
 * `duration_ms` 为 `null`（单行 ffprobe 失败，上游诚实语义）**不阻挡写入**（URL 仍有效），
 * 但该镜号被收进 `unmeasuredDurations` 回报，避免「已绑定」被误读成「时长已验」。
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
      `timeline ${timeline.length} 行、source ${source.length} 行（含上游截断）→ 整批拒写，不部分写入。`,
    );
  }

  const indexByShotNumber = new Map<string, number>();
  copy.forEach((shot, index) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : "";
    if (shotNumber) indexByShotNumber.set(shotNumber, index);
  });

  // 先全量验证（纯检查，**不动 copy**）——全部合规才落盘，杜绝部分写入。
  // patch **不在这里算**：同一镜的对白＋旁白两行必须**序接**地以「上一行写入后的状态」为基底
  // 重算锚（先算好再合并会让后一行的锚盖掉前一行的对白优先序）。
  const planned: { index: number; role: ShotAudioTrackRole; url: string; shotNumber: string; measured: boolean }[] = [];
  const unmeasuredDurations: string[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const ref = source[i];
    const field = ref?.field;
    if (field !== "dialogue" && field !== "narration") {
      return refuse("invalid_source", `source[${i}].field 不是 dialogue/narration → 整批拒写。`);
    }
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : "";
    const index = indexByShotNumber.get(shotNumber);
    if (index === undefined) {
      return refuse("unknown_shot", `source[${i}] 的镜号「${shotNumber || "(空)"}」不在输入分镜内 → 整批拒写。`);
    }
    const rawUrl = timeline[i]?.audio_url;
    const url = usableAudioUrl(rawUrl);
    if (!url) {
      return refuse(
        rawUrl ? "unusable_audio_url" : "missing_audio_url",
        `timeline[${i}]（镜 ${shotNumber}）${rawUrl ? "的 audio_url 不是可用音频" : "缺 audio_url"} → 整批拒写。`,
      );
    }
    const measured = typeof timeline[i]?.duration_ms === "number" && Number.isFinite(timeline[i]!.duration_ms);
    if (!measured) unmeasuredDurations.push(shotNumber);
    planned.push({ index, role: field as ShotAudioTrackRole, url, shotNumber, measured });
  }

  // 验证全过才落盘；逐行以「当前 copy 状态」呼叫既有轮子 `bindShotAudioTrack`（键名与
  // `audioAnchorId` 重算的唯一实作），故同镜两行序接后锚仍为 `dialogueAudioId || narrationAudioId`。
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

/** timeline 的一项（**只取本层要用的栏位**；上游实际回传更宽，多余栏位本层忽略）。 */
export interface AudioTimelineEntry {
  index?: number;
  role?: string;
  text?: string;
  offset_ms?: number | null;
  /** 合成音档 URL（上游实测后回填；空/非音频＝该批不可用）。 */
  audio_url?: string | null;
  /** ffprobe **实测**时长（ms）；上游单行失败时为 `null`（不冒充）。 */
  duration_ms?: number | null;
  cost_coins?: number;
  error?: string;
  duration_note?: string;
}

// ─────────────────────────────────────────── ③ 逐镜时长漂移

/** 秒值收敛到毫秒精度（避免浮点尾数噪音）。 */
function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 逐镜比「实测配音时长」与「分镜计画秒数（`durationSeconds`）」。**只回报不修正**。
 *
 * 语义（照抄，勿改）：
 *   · 某镜实际秒数＝本批 `source` 中属于该镜的所有行 `duration_ms` **之和** ÷ 1000
 *     （同一镜的对白＋旁白视为**序接**、不假设重叠；这是本层明示的假设，非上游保证）。
 *   · 该镜在本批**没有行** → `actualSec = 0`（＝本批完全没有它的配音，正是 P2 病灶的长相）。
 *   · 该镜**有行但任一行 `duration_ms` 未实测** → `actualSec = null`（无法比对，不冒充）。
 *   · `plannedSec` 缺席／非有限数 → `null`。
 *   · `overThreshold` ＝两者皆非 null 且 `|delta| > 0.5s`（见 `DURATION_DRIFT_THRESHOLD_SEC`）。
 *   · 回传**输入分镜的每一镜**（顺序照输入）。
 *
 * 这是对手 `duration_mismatch` 的等价物，也对上 `storyboard-contract.ts` 自陈的
 * 「时长两把尺互相冲突」；本函式只把冲突摆出来，裁决（改分镜秒数／改配音）不在本层。
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
      note = "本批 timeline 无此镜的配音行（可能无声；准确性只到本批输入）";
    } else if (bucket.unmeasured) {
      actualSec = null;
      note = "此镜有 duration_ms 未实测的行，无法比对时长";
    } else {
      actualSec = bucket.totalMs / 1000;
    }
    if (plannedSec === null) {
      note = note ? `${note}；且分镜无 durationSeconds 计画值可比` : "分镜无 durationSeconds 计画值可比";
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