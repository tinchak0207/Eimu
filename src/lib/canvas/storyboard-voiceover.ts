// 逐镜配音：分镜 → 台词表 → 逐行既有 TTS → 回写分镜双音轨与锚（服务层）。
//
// 结构修因（病历 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s。TTS 本身
// 没问题，缺的是**逐镜组台词表**与**把结果写回分镜**这两跳。桥接纯函式层
// （`./storyboard-audio-bridge.ts`）已补上「分镜 ↔ 台词表 ↔ timeline」的纯转换；本档是
// **站点服务层**：把专案读成扁平分镜、决定台词表上限／分批、**逐行序列**呼叫注入的 TTS
// client、再用桥接层回写，最后回报逐镜时长漂移。
//
// ── 职责边界（照本 repo 的既有分工，不越界）─────────────────────────────────
//   · 本档**不碰网路、不碰 DB、不自己拼音频 patch**：TTS 由上层注入
//     （`StoryboardVoiceoverTtsClient`，真实现由路由提供、测试给假 client）；
//     回写一律走桥接层 `applyAudioTimelineToShots`（音频判准与锚重算的唯一实作）。
//   · 本档**不量时长**：`duration_ms` 由注入 client 提供；站点侧没有 ffprobe
//     （`music-tools.ts` 的 ffprobe 是 harness 沙箱工具，不是 Next 服务端；见
//     `video-frames` 档头「Vercel 无 ffmpeg」）⇒ client 回 null 就照 null 传下去，
//     **不估算冒充实测**。
//   · 本档**不切 `dialogue` 的 `[角色]：「…」` 标记、不从 `dialogue` 猜旁白**：逐字照
//     桥接层档头的三条裁定（该格式无契约、旁白只认 `metadata.narration`）。
//
// ── 四个栏位的读取规则（逐字照 `storyboard-audio-bridge.ts` 档头）──────────────
//   · `shotNumber`  ← `node.metadata.storyboardShot.shotNumber`（非空＝这颗是分镜）
//   · `dialogue`    ← `node.metadata.storyboardShot.dialogue`
//   · `narration`   ← `node.metadata.narration`（2026-09-30 落地的旁白文本键）
//   · 既有两轨／锚  ← `node.metadata.dialogueAudioId` / `narrationAudioId` /
//                     `audioAnchorId`；**必须一起投影进扁平分镜**，否则回写时桥接层
//                     依 `dialogueAudioId || narrationAudioId` 重算的锚会漏掉另一轨。
//
// ── 「集」的读取────复用既有轮子 `storyboard-episode-batch.storyboardShotsOfEpisode`
//   （只认「分镜节点 ＋ `metadata.episodeId` 逐字相符」，不按节点序切段、不臆造归属）。
//   未指定 `episode` ＝ 全专案分镜（按镜号 numeric 排序，与既有轮子同序）。

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
 * 站内 TTS 单价（币/字），＝上游 `'tts-zh'.per_char`。**唯一真源已收拢到**
 * `@/lib/generation-model-catalog/tts-pricing`（站内三处消费点全吃那一颗）；
 * 本别名保留旧名供本档内外引用（`estimatedCoins` 报价与实际扣费同一口径）。
 */
export const VOICEOVER_TTS_PER_CHAR_COINS = TTS_COINS_PER_CHAR;

/**
 * 台词表总字数 → 预估花费（币）。精度收敛到 1e-6（与 `task-response.resolveTaskCostCoins`
 * 的 `Math.round(x * 1e6) / 1e6` 同一把尺）。默认走站内唯一真源 `ttsCoinsForChars`。
 */
export function estimateVoiceoverCoins(
  totalChars: number,
  perChar: number = VOICEOVER_TTS_PER_CHAR_COINS,
): number {
  if (perChar === VOICEOVER_TTS_PER_CHAR_COINS) return ttsCoinsForChars(totalChars);
  if (!Number.isFinite(totalChars) || totalChars <= 0) return 0;
  return Math.round(totalChars * perChar * 1e6) / 1e6;
}

// ─────────────────────────────────────────── 资料形状

/** 台词表的一行（对外报备口径＝路由的 `lines[]`）。 */
export interface StoryboardVoiceoverLine {
  shotNumber: string;
  field: ShotAudioField;
  /** 送去合成的文本（逐字，未切分）。 */
  text: string;
  /** 字数（`String.length`；中文在 BMP 内，一字＝1）。 */
  chars: number;
}

/** 分镜节点 → 扁平分镜的投影结果（`nodeId` 供回写时对回节点）。 */
export interface StoryboardVoiceoverShotEntry {
  nodeId: string;
  shot: StoryboardAudioShot;
}

/** 具名拒（整批不续作）。 */
export interface StoryboardVoiceoverRefusal {
  code: StoryboardVoiceoverRefusalCode;
  note: string;
}

/**
 * 本层会回的拒绝码：
 *   · `episode_not_found`     —— 指定集不存在于 `project.episodes`（不猜、不按节点序切段）
 *   · `too_many_lines`        —— 桥接层硬上限 50 行（具名拒，不截断）
 *   · `batch_size_over_tool_max_lines` —— 呼叫端要求的分批大小超过工具硬上限 50
 *   · `no_lines`              —— 专案／该集没有任何可分句的台词（不假装成功写入空集）
 *   · `tts_line_failed`       —— 某行 TTS 失败（**立即停手**，不省下续行的钱、也不部分写入）
 *   · 桥接层回写拒绝码（长度不符／URL 缺失／不可用／未知镜号／source 非法）——原样透传
 */
export type StoryboardVoiceoverRefusalCode =
  | "episode_not_found"
  | "too_many_lines"
  | "batch_size_over_tool_max_lines"
  | "no_lines"
  | "tts_line_failed"
  | AudioApplyRefusalCode;

/** 分批边界（**具名**：21..50 行绝不落在工具默认 20 的静默截断里）。 */
export interface StoryboardVoiceoverBatch {
  /** 批号（0 起）。 */
  index: number;
  /** 起始行（含）。 */
  fromLine: number;
  /** 结束行（不含）。 */
  toLine: number;
  lineCount: number;
}

/** 分批计画：每批的行数上限与每批请求应显式带上的 `maxLines`。 */
export interface StoryboardVoiceoverBatchPlan {
  batches: StoryboardVoiceoverBatch[];
  /** 本计画每批的行数上限（＝呼叫端指定值；> 工具硬上限时具名拒）。 */
  maxLinesPerBatch: number;
}

/** dryRun 计画（付费前的报备口径）。 */
export interface StoryboardVoiceoverDryRunPlan {
  ok: true;
  dryRun: true;
  lines: StoryboardVoiceoverLine[];
  totalChars: number;
  estimatedCoins: number;
  /** 本次会用的旁白音色（专案绑定失效时＝`DEFAULT_TTS_VOICE`，见 `resolveVoiceoverVoice`）。 */
  voice: string;
  /** 分批计画（具名边界；供报备与分批型 client 对帐）。 */
  batches: StoryboardVoiceoverBatch[];
  /** 每一行请求应显式带上的 `maxLines`（逐批值，永远 ≥ 该批行数；见 `planVoiceoverBatches`）。 */
  maxLinesByLine: number[];
  refused?: StoryboardVoiceoverRefusal;
}

/** 真跑结果（对外报备口径＝路由的冻结契约）。 */
export interface StoryboardVoiceoverRunResult {
  ok: boolean;
  applied: boolean;
  lines: StoryboardVoiceoverLine[];
  totalChars: number;
  /**
   * 本次实际花费（币）：全部执行行都有上游回报才给总和；有任何一行查不到＝`null`
   * （不填 0 假装免费）；一行都没执行＝`0`（真的没花）。
   */
  costCoins: number | null;
  drift: AudioDurationDrift[];
  refused?: StoryboardVoiceoverRefusal;
  unmeasuredDurations?: string[];
}

/** 真跑结果 ＋ 回写后的分镜（后者只在 `applied:true` 时可落盘）＋ 投影溯源（回写节点时对回 nodeId）。 */
export interface StoryboardVoiceoverExecution {
  result: StoryboardVoiceoverRunResult;
  shots: StoryboardAudioShot[];
  /** 与 `shots` 同索引的节点溯源（`applyVoiceoverShotsToNodes` 的唯一输入）。 */
  entries: StoryboardVoiceoverShotEntry[];
}

/** 逐行 TTS 请求（**一行一次呼叫**；禁并发、禁 retry、禁回圈试探由呼叫端保证）。 */
export interface StoryboardVoiceoverLineRequest {
  /** 台词表行序（＝ `source` 索引）。 */
  index: number;
  shotNumber: string;
  field: ShotAudioField;
  /** 逐字照送的文本（本层不改写）。 */
  text: string;
  voice: string;
  /**
   * 本批次的行数上限。**必须显式带上且 ≥ 本批行数**：上游工具默认 20、硬上限 50，
   * 不显式覆盖就会把 21..50 行静默截断（＝后半段没声，使用者看不出来）。
   */
  maxLines: number;
  batchIndex: number;
  batchCount: number;
}

/** 逐行 TTS 回应（真实来源由注入 client 决定；站点无 ffprobe ⇒ `durationMs` 可为 null）。 */
export interface StoryboardVoiceoverLineResult {
  /** 合成音档 URL；空／不可用＝该行失败（整批拒写）。 */
  audioUrl?: string | null;
  /** ffprobe 实测时长（ms）；站点无此能力＝`null`（诚实缺，不估算冒充）。 */
  durationMs?: number | null;
  /** 该行上游花费（币）；上游未回报＝`null`（不填 0）。 */
  costCoins?: number | null;
  /** 该行失败原因（有值＝该行失败）。 */
  error?: string;
}

/** 逐行 TTS client（真实现＝站点既有 TTS 路径；测试＝假 client）。 */
export type StoryboardVoiceoverTtsClient = (
  request: StoryboardVoiceoverLineRequest,
) => Promise<StoryboardVoiceoverLineResult>;

// ─────────────────────────────────────────── ① 专案 → 扁平分镜

/**
 * 专案 → 目标集（或全专案）的分镜投影。
 *
 *   · 指定 `episode`（＝`CanvasEpisode.episodeNo`，1 起）：查得到集 ⇒ 走既有轮子
 *     `storyboardShotsOfEpisode`（只认 `episodeId` 逐字相符）；查不到 ⇒ 具名拒
 *     `episode_not_found`（**不**退回全专案、**不**按节点序切段）。
 *   · 未指定 ⇒ 全专案分镜（`storyboardShot.shotNumber` 非空），按镜号 numeric 排序。
 *   · 每镜的四栏逐字照桥接层规则投影；既有音轨只收 `usableAudioUrl` 认可的值
 *     （判准与 `storyboard-shots.readAudioTracks` 同一把尺）。
 *
 * `durationSeconds` **刻意不填**：站点侧 `CanvasNodeMetadata` 没有分镜计画秒数栏
 * （21 栏契约是编剧阶段口径，`storyboardShot` 无此栏；`duration_ms` 是 Blender 卡的栏位）。
 * ⇒ 缺席＝drift 无计画值可比（诚实回 null），不从别处推导、不编造。
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
 * 本次逐镜配音实际会用的音色。
 *
 * 来源＝专案级旁白音色（`CanvasProject.narrationVoice`，值域＝`voice-library` 的语音库，
 * 见 `types.ts` 该栏注释），经既有轮子 `effectiveNarrationVoice` 判「此刻真的生效」——
 * 该轮子逐字规定旁白音色只在解说剧（`scriptType === "monologue"`）时生效。
 * 未绑定／不生效 ⇒ `DEFAULT_TTS_VOICE`（既有常数，＝上游 proxy 的 `DEFAULT_VOICE`）。
 * **不自己造预设音色**（禁造轮子）。
 */
export function resolveVoiceoverVoice(project: Pick<CanvasProject, "scriptType" | "narrationVoice">): string {
  return effectiveNarrationVoice(project) ?? DEFAULT_TTS_VOICE;
}

// ─────────────────────────────────────────── ③ 分批（max_lines 陷阱）

/**
 * 台词表分批计画。**这一段是本层对上游 `max_lines` 陷阱的正面处理**：
 *
 *   · 上游工具默认 `max_lines = 20`、硬上限 50，超过即**截断**（`AUDIO_TOOL_DEFAULT_MAX_LINES`
 *     / `AUDIO_TOOL_MAX_LINES`，逐字读自桥接层档头）。本层**永不**让任何一批的行数上限落在
 *     默认值上：每一批请求都带显式 `maxLines = 该批实际行数`（见 `buildLinesAndPlan`）。
 *   · 21..50 行**不会**被静默截断：它们是「一批、具名边界、显式 maxLines = 行数」，
 *     或被呼叫端用 `maxLinesPerBatch` 切成多批（每批具名 index/fromLine/toLine）。
 *   · `maxLinesPerBatch` 超过工具硬上限 50 ⇒ **具名拒** `batch_size_over_tool_max_lines`
 *     （不悄悄夹到 50——那会让呼叫端以为自己设的大小生效了）。
 *   · 行数为 0 ⇒ 空批次（呼叫端自行决定是否为错误，本函式不对 0 行造假）。
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
        note: `maxLinesPerBatch ${maxLinesPerBatch} 超过上游 TTS 工具硬上限 ${AUDIO_TOOL_MAX_LINES}（默认 ${AUDIO_TOOL_DEFAULT_MAX_LINES}）；不悄悄夹小，请显式指定 ≤ ${AUDIO_TOOL_MAX_LINES}。`,
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

/** 台词表 + 分批（本层内部；`lines` 对外报备、`maxLinesByLine` 逐行带给 client）。 */
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
  // 文本逐字取自桥接层吐出的 `script`（唯一真源＝它的栏位序与 trim 规则）；
  // 不在此重写「哪一栏进哪一行」的第二套逻辑。
  const rows = JSON.parse(plan.script) as Array<{ role?: string; text?: string }>;
  const lines: StoryboardVoiceoverLine[] = plan.source.map((ref, i) => {
    const text = typeof rows[i]?.text === "string" ? (rows[i]!.text as string) : "";
    return { shotNumber: ref.shotNumber, field: ref.field, text, chars: text.length };
  });
  // 硬上限 50：桥接层已具名拒（`source` 仍是完整未截断的内容）——原样透传，不代为截断。
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

// ─────────────────────────────────────────── ④ dryRun（付费前报备）

/**
 * dryRun：只算行数／字数／预估币，**不碰上游**（呼叫端保证不呼叫 TTS）。
 * 具名拒（>50 行／集不存在／分批大小非法）也在此回报，但 `ok` 仍为 true——dryRun 是
 * 「报备口径」：报备的内容就是「会有多少行、要花多少、以及为何拒」。
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
 * 逐行序列呼叫既有 TTS，成功才整批回写分镜。
 *
 * 序列与停手规则（**不并发、不 retry、不回圈试探**）：
 *   · 逐行 for 回圈，等一行完成才送下一行。
 *   · 任一行回 `error` 或拿不出可用 `audioUrl` ⇒ **立即停手**：不再送后续行（省下续行的钱），
 *     且**整批拒写**（不部分写入——部分写入＝分镜半数有声、使用者以为完成）。
 *   · 上游不回 `duration_ms` ⇒ 照 `null` 传给桥接层（它会把该镜收进 `unmeasuredDurations`）。
 *
 * 成本：全部执行行都有有限 `costCoins` ⇒ 总和；任一查不到 ⇒ `null`；一行未执行 ⇒ `0`。
 * 回写：一律经桥接层 `applyAudioTimelineToShots`（不接受任何自拼 patch）。
 * 漂移：`audioDurationDrift` 只回报不改秒数；未成功写入时 `drift` 回空阵列。
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
      note: "该专案／该集没有任何可分句的台词（dialogue／narration 皆空或不存在）；不假装写入空集。",
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
      const reason = response?.error ?? "未回可用音档 URL";
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
 * `dryRun`／真跑的**唯一分派**（路由只调这支，分支语义只此一份）。
 *
 * 命门：`dryRun === true` ⇒ **保证一次都不呼叫 `client`**（呼叫端仍必须传一个 client——
 * 传个 tripwire 就能在测试里把这条保证断言出来；本函式的 dryRun 分支在结构上不碰它）。
 */
export async function storyboardVoiceover(
  project: Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice">,
  options: {
    dryRun: boolean;
    /** dryRun=true 时保证不被呼叫；dryRun=false 时为逐行 TTS 的唯一出口。 */
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

// ─────────────────────────────────────────── ⑦ 回写分镜节点

/** 音轨四键（介面冻结，逐字照 `storyboard-shots.StoryboardShotAudioMetadata`）；本层只投影这三支音轨键。 */
const AUDIO_PATCH_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const;

/**
 * 把逐镜配音结果回写到分镜节点 metadata（纯函式，回新阵列，**不动输入**）。
 *
 * patch 的来源是**桥接层回写后的扁平分镜**（`applyAudioTimelineToShots` 的 `shots`），
 * 本层只把它投影成三支冻结栏位——**不重算锚、不重判 URL**（那些仍由桥接层唯一决定）。
 * 缺席的键**不删既有值**（与 `bindShotAudioTrack` 的 patch 语义一致：只写不删）。
 *
 * `missingNodeIds`：entries 指向的节点在传入 `nodes` 里找不到（例如写入前节点被删）。
 * **非空＝整批不可落盘**（呼叫端据此拒写，不做部分写入）。
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