// 影片抽帧：浏览器端把影片抽成 JPEG（上传统固定 4 帧；画布节点动作支持截帧/序列帧）。
//
// 设计文档锁定的规格（agent-chat-ux-design.md §3.6）：
//   - 上传路径：均匀 4 帧——第一帧、1/3、2/3、最后一帧（FRAME_COUNT 与 computeFrameTimestamps）。
//   - 上限：时长 600 秒、文件 100 MB，超过就拒收并说明（不静默截断）。
//   - 理由：4 帧够覆盖内容变化，又压得住 Groq 眼睛的成本。
//
// 2026-09-28 取樣語義對齊（照競品 hypit 的實作語義，不自行發明）：
//   - `intervalSamples`（對應 --every）：從 start 起、遞增 every、**不含 end**，every 下限 0.001 秒。
//   - `tileSampleTimes`（對應 --frames）：等距**中點**（不是端點），至少 2 幀。
//   - `tileFrameCount` / `TILE_COLUMNS` / `TILE_CELL_WIDTH`：預設格數與拼板常數逐字照競品。
//   - `frameFileName`：`frame-<秒>_<毫秒>s.jpg`（檔名用請求時間，不是解碼到的真實來源時間）。
//   - 上限政策同競品精神：瀏覽器端因記憶體必須有上限（MAX_SEQUENCE_FRAMES=600），但到頂**明確拒絕**，
//     絕不靜默截斷；競品本身對幀數無上限（它跑在伺服器端）。
//
// 本文件保持纯逻辑（不依赖 DOM/浏览器 API），可用 node:test 测；
// 真正触碰 <video>/<canvas> 的部分放在本文件末尾的 extractVideoFrames()，
// 由 AgentComposer 传入浏览器对象，node 下不会 import 进来执行。
//
// 注释与提示文案统一简体中文。

import type { AgentAttachmentRef } from "./agent-chat-types";

// ─────────────────────────── 上限常量

/** 时长上限（秒）。超过直接拒收。2026-09-28 由 60 提到 600（对齐长镜头参考片场景）。 */
export const MAX_VIDEO_DURATION_SECONDS = 600;

/** 文件大小上限（字节）。超过直接拒收。 */
export const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** 缩略图长边上限（px），够 Groq 看且省上传带宽。 */
export const MAX_FRAME_EDGE_PX = 512;

/** 抽出的帧数：文档锁 4 帧。 */
export const FRAME_COUNT = 4;

/**
 * 最后一帧的回退量（秒）。
 *
 * 为什么不直接 seek 到 duration：多数浏览器在 seek 到末尾（== duration）时
 * 拿不到最后一帧——要么画到黑帧，要么 seeked 事件不触发。留一点回退量
 * （duration - 0.05s）让浏览器落在真正的最后一个可见画面附近。0.05s 对
 * H.264/AAC 的典型 GOP（0.5~1s）来说足够小，不会跳回上一段，但能骗过
 * 播放器对"seek == duration 等于停在 endofstream、无帧可解"的边角处理。
 */
export const LAST_FRAME_SEEK_BACKOFF_S = 0.05;

// ─────────────────────────── 纯函数（可测）

export interface FrameTimestamp {
  /** 命名序号，0 起。 */
  index: number;
  /** 该帧在视频中的时间点（秒）。 */
  time: number;
  /** 该帧位置的文字描述，例如「约 3.4 秒」，用于预览缩图的 alt。 */
  label: string;
}

/**
 * 计算 4 个抽帧时间点：第一帧、1/3、2/3、最后一帧。
 *
 * 严格照文档：t0 = 0，t1 = duration/3，t2 = 2*duration/3，
 * t3 = duration（经回退与边界钳制后）。
 *
 * 边界处理（都怕极短影片撞出非法值）：
 *   - 至少 4 帧：时长极短的 << 0.05 的片段，各时间点钳制到 [0, duration]。
 *   - t3 最后的钳制：完全退化（时长 ≤ 回退量）时回落为第一帧，不依赖 seek 失败兜底。
 */
export function computeFrameTimestamps(duration: number): FrameTimestamp[] {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  // duration 为 NaN/Infinity（未知时长的流）时 safeDuration 归 0，
  // 于是下面所有时间点都落在 0：拿到 4 张首帧，也不会 seek 到 NaN 卡死。

  // 均匀 FRAME_COUNT 帧：i / (FRAME_COUNT - 1) 把 [0,1] 等分，
  // 4 帧正好是 0、1/3、2/3、1，与文档一致；最后一帧减回退量。
  const lastIndex = FRAME_COUNT - 1;
  const timestamps: FrameTimestamp[] = Array.from({ length: FRAME_COUNT }, (_, i) => {
    const time = i === lastIndex ? safeDuration - LAST_FRAME_SEEK_BACKOFF_S : (safeDuration * i) / lastIndex;
    return { index: i, time, label: formatFrameTime(time) };
  });

  // 最后一帧回退后仍必须落在 [0, duration]，
  // 且当 duration ≤ 回退量（极短/退化影片）时直接退回第一帧。
  const maxSeek = timestamps[timestamps.length - 1];
  if (maxSeek) {
    maxSeek.time = Math.min(Math.max(0, maxSeek.time), safeDuration);
    maxSeek.label = formatFrameTime(maxSeek.time);
    if (safeDuration < LAST_FRAME_SEEK_BACKOFF_S) {
      // 时长太短，后面的三个点都坍缩到首帧，没必要 seek / drawImage，直接取首帧。
      for (let i = 1; i < timestamps.length; i++) {
        timestamps[i].time = 0;
        timestamps[i].label = formatFrameTime(0);
      }
    }
  }

  return timestamps;
}

/** 把秒格式成「约 3.4 秒」这类文案（保留一位小数）。导出给节点动作与 API 的帧清单复用同一文案。 */
export function formatFrameTime(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `约 ${rounded} 秒`;
}

/** 文件大小的人类可读文案，用于超限提示。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 校验影片是否符合 D-16 上限，返回拒收原因或 null。
 * 超限必须明确提示（拒收不静默截断），一次列出所有超出的项。
 */
export function validateVideoFile(file: { size: number; duration: number }): string | null {
  const issues: string[] = [];
  if (file.duration > MAX_VIDEO_DURATION_SECONDS) {
    issues.push(
      `时长 ${formatSeconds(file.duration)} 超过上限 ${MAX_VIDEO_DURATION_SECONDS} 秒（超出 ${formatSeconds(
        file.duration - MAX_VIDEO_DURATION_SECONDS,
      )}）`,
    );
  }
  if (file.size > MAX_VIDEO_FILE_BYTES) {
    issues.push(
      `文件 ${formatBytes(file.size)} 超过上限 ${MAX_VIDEO_FILE_BYTES / (1024 * 1024)} MB（超出 ${formatBytes(
        file.size - MAX_VIDEO_FILE_BYTES,
      )}）`,
    );
  }
  return issues.length > 0 ? issues.join("，") : null;
}

function formatSeconds(seconds: number): string {
  return Math.round(seconds * 10) / 10 === 0 ? "0" : `${Math.round(seconds * 10) / 10}`;
}

// ─────────────────────────── 节点动作：截帧 / 序列帧计划（纯函数，可测）

/**
 * 序列帧的帧数上限。
 *
 * 2026-09-28 由 24 提到 600：旧值「24 帧 ≈ 3~7 秒」是我方自订的天花板，逼使用者
 * 与 agent 在 24 帧封顶后无路可走；竞品（hypit `media frames/tiles`）对帧数**没有上限**
 * （它跑在伺服器端）。我方像素抽取只能在浏览器做（每个时间点 seek 一次再 drawImage，
 * seek 是 100~300ms 量级），所以必须保留一个上限，但拉到实用级：
 * 600 帧 ≈ 1~3 分钟等待，且到顶**明确拒绝**（绝不静默截断），讯息里给出提高 step /
 * 改用伺服器端的出口。
 */
export const MAX_SEQUENCE_FRAMES = 600;

/** 拼板列数（照竞品 hypit 的 TILE_COLUMNS）。 */
export const TILE_COLUMNS = 3;

/** 拼板单元格宽度上限（px，照竞品 hypit 的 TILE_CELL_WIDTH）。 */
export const TILE_CELL_WIDTH = 480;

/** 拼板单元格宽度下限（px，照竞品 hypit cell 的下限 80）。 */
export const TILE_MIN_CELL_WIDTH = 80;

/** 抽帧模式：current = 取指定时刻单帧；sequence = 按间隔或帧数抽序列帧；at = 按时间点清单抽帧。 */
export type FrameActionMode = "current" | "sequence" | "at";

export interface FrameExtractionRequest {
  /** 视频总时长（秒）。必须是有限正数。 */
  durationSec: number;
  mode: FrameActionMode;
  /** sequence 用：抽帧间隔（秒，下限 0.001）。与 count 二选一。 */
  intervalSec?: number;
  /** sequence 用：均分帧数（≥ 2，等距中点）。与 intervalSec 二选一。 */
  count?: number;
  /** current 用：要取的那一帧在视频中的时刻（秒）。at 用：时间点清单（至少 1 个、严格递增、全部 < durationSec）。 */
  atSec?: number | readonly number[];
}

/** 计划结果。**任何非法输入都回 ok:false，绝不抛异常**（调用方是路由与 UI，不能靠 try 兜）。 */
export type FrameExtractionPlan =
  | { ok: true; timesSec: number[] }
  | { ok: false; reason: string };

/** 毫秒对齐，杀掉 0.30000000000000004 这类浮点尾巴后再进输出。 */
function alignToMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * 竞品语义的取整：`round(v) = Number(v.toFixed(3))`（逐字照抄 hypit）。
 *
 * 与 alignToMillis 的差别只在极少数浮点半格情形（toFixed 走十进制表示、Math.round 走二进制），
 * 既然竞技取样的输出要逐位对齐对手，序列帧路径就用这一支；`current` 单帧路径维持 alignToMillis
 * 的既有输出不动（契约不变）。
 */
function roundSeconds(seconds: number): number {
  return Number(seconds.toFixed(3));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * ── 竞品取样的逐字复刻 ①：`--every` 的取样子集 ──
 *
 * 竞品原文：
 * ```ts
 * assert(Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start, "a sample range needs 0 <= start < end");
 * assert(Number.isFinite(every) && every >= 0.001, "--every must be at least 0.001 seconds");
 * return Array.from({ length: Math.ceil((end - start) / every) }, (_, index) => round(start + index * every))
 *   .filter((time) => time < end);
 * ```
 * ⇒ 从 start 起（预设 0）、递增 every、**不含 end**；every 下限 0.001 秒。
 *
 * 非法输入照竞品的 assert 抛错（planFrameExtraction 会先自行校验，调用方不会撞到这些 throw 路径）。
 */
export function intervalSamples(start: number, end: number, every: number): number[] {
  if (!(Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start)) {
    throw new Error("a sample range needs 0 <= start < end");
  }
  if (!(Number.isFinite(every) && every >= 0.001)) {
    throw new Error("--every must be at least 0.001 seconds");
  }
  return Array.from({ length: Math.ceil((end - start) / every) }, (_, index) =>
    roundSeconds(start + index * every),
  ).filter((time) => time < end);
}

/**
 * ── 竞品取样的逐字复刻 ②：`--frames` 的取样子集（**等距中点**，不是端点）──
 *
 * 竞品原文：
 * ```ts
 * assert(end > start, ...); assert(Number.isSafeInteger(frameCount) && frameCount >= 2, "a grid needs at least two frames");
 * return Array.from({ length: frameCount }, (_, index) => round(start + (index + 0.5) * (end - start) / frameCount));
 * ```
 * 注意 `(index + 0.5)`：取每等份的**中点**（端点会切在切点上，中点才是这一格的代表画面）。
 */
export function tileSampleTimes(start: number, end: number, frameCount: number): number[] {
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    throw new Error("a sample range needs start < end");
  }
  if (!(Number.isSafeInteger(frameCount) && frameCount >= 2)) {
    throw new Error("a grid needs at least two frames");
  }
  return Array.from({ length: frameCount }, (_, index) =>
    roundSeconds(start + ((index + 0.5) * (end - start)) / frameCount),
  );
}

/**
 * 竞品 `tileFrameCount(seconds) = clamp(Math.round(seconds * 1.5), 4, 9)` 逐字复刻：
 * 影片越长拼板格数越多，但夹在 4~9 格（9 格刚好是 3x3）。
 * 退化输入（NaN / 非正数）竞品会算出 NaN，我方回下限 4（诚实边界：宁少不多，不产生 NaN 格数）。
 */
export function tileFrameCount(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 4;
  return Math.min(Math.max(Math.round(seconds * 1.5), 4), 9);
}

export interface TileLayout {
  columns: number;
  rows: number;
  cellWidth: number;
}

/**
 * 拼板版式（照竞品 `tile` 的 `--columns` / `--cell` 语义）。
 *
 * - `columns`：缺省 3（TILE_COLUMNS），下限 1。
 * - `cellWidth`：显式给了就用它（下限 80）；没给但有 `sourceWidth` → `max(80, min(480, sourceWidth))`
 *   （竞品 `cell` 预设就是这一式，`info.width` = 来源帧宽）；两者都没有 → TILE_CELL_WIDTH=480。
 *   缺省时**不猜来源宽度**：调用端没给 width 就用竞品预设 480。
 * - `rows = ceil(count / columns)`（竞品分页网格 3 行起的分页逻辑同式）。
 */
export function planTileLayout(input: {
  count: number;
  columns?: number;
  cellWidth?: number;
  sourceWidth?: number;
}): TileLayout {
  const count = Math.max(1, Math.floor(Number.isFinite(input?.count) ? input.count : 1));
  const columnsRaw = input?.columns;
  const columns = Number.isFinite(columnsRaw) ? Math.max(1, Math.floor(columnsRaw as number)) : TILE_COLUMNS;

  const explicitCell = input?.cellWidth;
  const source = input?.sourceWidth;
  const cellWidth = Number.isFinite(explicitCell)
    ? Math.max(TILE_MIN_CELL_WIDTH, Math.round(explicitCell as number))
    : Number.isFinite(source)
      ? Math.max(TILE_MIN_CELL_WIDTH, Math.min(TILE_CELL_WIDTH, Math.round(source as number)))
      : TILE_CELL_WIDTH;

  return { columns, rows: Math.ceil(count / columns), cellWidth };
}

/**
 * 帧档名（逐字照竞品）：`frame-${time.toFixed(3).replace(".", "_")}s.jpg` → `frame-2_500s.jpg`。
 *
 * 语义边界（勿混）：竞品档名用**请求时间**，而它回传的 `at` 是**解码到的真实来源时间**；
 * 我方时间点是浏览器 seek 的请求时间，档名同样用它。
 */
export function frameFileName(timeSec: number): string {
  return `frame-${timeSec.toFixed(3).replace(".", "_")}s.jpg`;
}

/**
 * 把「抽帧意图」算成具体时间点列表（节点动作的纯逻辑层，node 可测）。
 *
 * 规则：
 *   - current：atSec 单点。atSec === duration 时回退 LAST_FRAME_SEEK_BACKOFF_S
 *     （seek 到末尾多数浏览器拿不到画面）；atSec > duration 直接拒绝。**既有语义逐字不变**。
 *   - sequence + intervalSec：竞品 `intervalSamples(0, duration, intervalSec)` —— 从 0 起、
 *     递增 intervalSec、不含 duration；intervalSec 下限 0.001 秒；帧数 = ceil(duration/interval)。
 *   - sequence + count：竞品 `tileSampleTimes(0, duration, count)` —— **等距中点**，count ≥ 2。
 *   - at：atSec 清单（≥ 1 个、严格递增、全部 < duration），照竞品 `--at` 的验证。
 *   - intervalSec 与 count 同时给 / 都不给 → 拒绝（不猜用户意图）；at 与二者互斥。
 *   - 时长 > MAX_VIDEO_DURATION_SECONDS → 明确拒绝（不静默只用前 600 秒）。
 *
 * 输出全部毫秒对齐、严格递增、落在 [0, duration)。
 */
export function planFrameExtraction(req: FrameExtractionRequest): FrameExtractionPlan {
  const durationSec = req?.durationSec;
  if (!isPositiveFinite(durationSec)) {
    return { ok: false, reason: "视频时长未知或不是正数，无法计算抽帧时间点。" };
  }
  if (durationSec > MAX_VIDEO_DURATION_SECONDS) {
    return {
      ok: false,
      reason: `视频时长 ${alignToMillis(durationSec)} 秒超过取帧上限 ${MAX_VIDEO_DURATION_SECONDS} 秒，请先裁剪，或改用服务器端抽帧。`,
    };
  }

  if (req.mode === "current") {
    const atSec = req.atSec;
    if (typeof atSec !== "number" || !Number.isFinite(atSec)) {
      return { ok: false, reason: "提取当前帧需要给出 atSec（秒）。" };
    }
    if (atSec < 0) {
      return { ok: false, reason: `提取时刻 ${alignToMillis(atSec)} 秒不能为负。` };
    }
    if (atSec > durationSec) {
      return {
        ok: false,
        reason: `提取时刻 ${alignToMillis(atSec)} 秒超过视频长度 ${alignToMillis(durationSec)} 秒。`,
      };
    }
    const clamped =
      atSec >= durationSec ? Math.max(0, durationSec - LAST_FRAME_SEEK_BACKOFF_S) : atSec;
    return { ok: true, timesSec: [alignToMillis(clamped)] };
  }

  if (req.mode === "at") {
    if (req.intervalSec !== undefined || req.count !== undefined) {
      return { ok: false, reason: "at 模式不能与 intervalSec / count 同时使用（时间点清单与抽样方式互斥）。" };
    }
    const list = req.atSec;
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: false, reason: "at 模式需要给出时间点清单 atSec（至少 1 个）。" };
    }
    if (list.length > MAX_SEQUENCE_FRAMES) {
      return {
        ok: false,
        reason: `时间点清单 ${list.length} 个超过上限 ${MAX_SEQUENCE_FRAMES} 个：请先裁剪分段，或改用服务器端抽帧。`,
      };
    }
    const timesSec: number[] = [];
    let prev: number | null = null;
    for (let i = 0; i < list.length; i++) {
      const time = list[i];
      if (typeof time !== "number" || !Number.isFinite(time)) {
        return { ok: false, reason: `atSec 第 ${i + 1} 个时间点不是有效数字（收到 ${String(time)}）。` };
      }
      if (time < 0) {
        return { ok: false, reason: `时间点 ${alignToMillis(time)} 秒不能为负。` };
      }
      if (time >= durationSec) {
        // 照竞品：a frame time must be before the end of the file
        return {
          ok: false,
          reason: `时间点 ${alignToMillis(time)} 秒必须在视频结束之前（视频时长 ${alignToMillis(durationSec)} 秒）。`,
        };
      }
      if (prev !== null && time <= prev) {
        // 照竞品：sample times must be strictly increasing
        return { ok: false, reason: "时间点清单必须严格递增（sample times must be strictly increasing）。" };
      }
      prev = time;
      timesSec.push(roundSeconds(time));
    }
    return { ok: true, timesSec };
  }

  if (req.mode !== "sequence") {
    return { ok: false, reason: `未知的抽帧模式：${String(req.mode)}。` };
  }

  const hasInterval = req.intervalSec !== undefined;
  const hasCount = req.count !== undefined;
  if (hasInterval && hasCount) {
    return { ok: false, reason: "intervalSec 与 count 只能给一个，不能同时指定。" };
  }
  if (!hasInterval && !hasCount) {
    return { ok: false, reason: "序列帧需要给出 intervalSec（按间隔）或 count（按帧数）。" };
  }

  if (hasInterval) {
    const intervalSec = req.intervalSec;
    // 竞品下限 0.001 秒；这里连 0 / 负数一并收在这条讯息里（同时保留既有「正数」判词）。
    if (!(typeof intervalSec === "number" && Number.isFinite(intervalSec) && intervalSec >= 0.001)) {
      return {
        ok: false,
        reason: `抽帧间隔必须是正数且不小于 0.001 秒，收到 ${String(intervalSec)}。`,
      };
    }
    const expected = Math.ceil(durationSec / intervalSec);
    if (expected > MAX_SEQUENCE_FRAMES) {
      return {
        ok: false,
        reason: `按间隔 ${alignToMillis(intervalSec)} 秒会抽出 ${expected} 帧，超过上限 ${MAX_SEQUENCE_FRAMES} 帧：请把间隔调大，或改用服务器端抽帧。`,
      };
    }
    return { ok: true, timesSec: intervalSamples(0, durationSec, intervalSec) };
  }

  const count = req.count;
  // 竞品 `tileSampleTimes` 要求帧数 ≥ 2（单帧请用 mode:"current"）。
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2) {
    return {
      ok: false,
      reason: `序列帧数必须是不小于 2 的整数，收到 ${String(count)}（单帧请用 mode:"current"）。`,
    };
  }
  if (count > MAX_SEQUENCE_FRAMES) {
    return {
      ok: false,
      reason: `帧数 ${count} 超过上限 ${MAX_SEQUENCE_FRAMES} 帧：请调小，或改用服务器端抽帧（浏览器端一次最多 ${MAX_SEQUENCE_FRAMES} 帧）。`,
    };
  }
  return { ok: true, timesSec: tileSampleTimes(0, durationSec, count) };
}

// ─────────────────────────── 浏览器侧抽帧（AgentComposer 调用）

/** 视频元素（带原样本）的 typed 引用，避免重复拼接标签。 */
export interface VideoElementSample {
  video: HTMLVideoElement;
  sample: AgentAttachmentRef;
}

/**
 * 从 <video> 元素抽出 4 帧 JPEG（纯浏览器，无法在 node 下测试）。
 *
 * 真实的坑，逐个处理（每处都有注释）：
 *   1. 必须等 loadedmetadata 才能读 duration。
 *   2. seek 后必须等 seeked 事件再 drawImage，否则画到的是上一帧。
 *   3. video.muted = true + playsInline，否则部分浏览器不给解码。
 *   4. canvas 按视频原始宽高比缩到长边 MAX_FRAME_EDGE_PX。
 *
 * Object URL 的生命周期归调用方：抽完帧后预览区还要让原片可播（D-16），
 * 这里 revoke 会把预览一起弄哑。调用方在移除／送出附件时自己 revoke。
 *
 * @param sample 由 AgentComposer 用 URL.createObjectURL 建成（含 Object URL）。
 * @param onProgress 每完成一帧回调一次（参数 = 已完成帧数），便于 UI 显示进度。
 *   agent 聊天区不用进度条也可以不传。
 * @returns 4 张 JPEG blob，顺序与 frameTimestamps 一致。
 */
export async function extractVideoFrames(
  sample: VideoElementSample,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const { video, sample: s } = sample;

  // 1) 关键坑：不能依赖 duration 提前可读，必须在 loadedmetadata 之后再动手。
  //
  // 2026-10-04（同 BUG-1 族，就地补硬）：与 `waitForMetadata` 同形——终态快查优先、
  // 事件其次、timeout 兜底、所有出口清监听。此前只有一发式 error/loadedmetadata 监听、
  // 无终态快查也无 timeout：元素若「既不 error 也不 loadedmetadata」，这里会永久 pending。
  // 上传路径的调用端（AgentComposer）靠本函数返回才会推进/降级，故必须有限。
  if (video.readyState < 1) {
    // 终态快查：元素已经死了（error 事件早已被前次消费、不会再发），立即具名失败。
    if (video.error) throw new Error("视频解码失败，无法读取。");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
        if (timer !== undefined) clearTimeout(timer);
      };
      const onLoaded = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("视频解码失败，无法读取。"));
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("读取视频信息超时。"));
      }, METADATA_WAIT_TIMEOUT_MS);
    });
  }

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  // 已传 size/时长到校验层，这里假定通过；再查一遍防御（上限来自同一常量）。
  const rejectReason = validateVideoFile({ size: s.size ?? 0, duration });
  if (rejectReason) throw new Error(`视频超出上限：${rejectReason}`);

  const timestamps = computeFrameTimestamps(duration);
  // 进度分母取实际要跑的帧数，而不是常量：两者一旦不一致，
  // UI 会卡在 3/4 或跳到 5/4，都是假进度。
  const total = timestamps.length;

  // 3) 必须静音 + 内联播放，否则部分浏览器不给解码（seek 无画面可 draw）。
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;

  const frames: Blob[] = [];
  onProgress?.(0, total);
  for (const f of timestamps) {
    await seekTo(video, f.time);
    frames.push(await captureFrame(video));
    onProgress?.(frames.length, total);
  }
  return frames;
}

// ─────────────────────────── 节点动作：按计划抽帧（浏览器侧执行层）

/** 一帧的抽取结果：blob + 时间点，供节点动作落成画布图片。 */
export interface ExtractedFrameAt {
  index: number;
  /** 该帧在视频中的时间点（秒），来自 planFrameExtraction。 */
  timeSec: number;
  /** 预览 alt 用的中文文案（与帧批抽同一格式）。 */
  label: string;
  blob: Blob;
}

/**
 * 按 planFrameExtraction 给出的时间点抽帧（节点动作的执行层）。
 *
 * 复用既有视频抽帧的同一套原语（waitForMetadata / seekTo / captureFrame），
 * **不重写** video→canvas→blob 流程；与 extractVideoFrames 的唯一差别是
 * 时间点由调用方给（支持截帧/序列帧），而不是写死 4 帧。
 *
 * 为什么不在这里调 validateVideoFile：那是**上传统**的时长/文件闸门；节点动作抽的是
 * 已生成视频的帧，时长上限由计划层（planFrameExtraction → MAX_VIDEO_DURATION_SECONDS = 600 秒）
 * 与帧数上限（MAX_SEQUENCE_FRAMES = 600）兜住，不在这里对同一个时长重复拒收一次
 * （也不改上传统的行为：上传统仍额外受 100MB 文件闸门约束）。
 *
 * Object URL 生命周期仍归调用方（同 extractVideoFrames 的注释）。
 *
 * @param timesSec 毫秒对齐、单调递增、落在 [0, duration) 的时间点（plan 的输出）。
 * @returns 与 timesSec 等长、顺序一致的帧。
 */
export async function extractFramesAtTimes(
  sample: VideoElementSample,
  timesSec: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedFrameAt[]> {
  const { video } = sample;
  const total = timesSec.length;
  if (total === 0) return [];

  // 同 extractVideoFrames 的坑：读 duration / seek 前必须等 loadedmetadata。
  await waitForMetadata(video);
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;

  const frames: ExtractedFrameAt[] = [];
  onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    const timeSec = timesSec[i];
    await seekTo(video, timeSec);
    frames.push({ index: i, timeSec, label: formatFrameTime(timeSec), blob: await captureFrame(video) });
    onProgress?.(frames.length, total);
  }
  return frames;
}

/** 判断一个 File 是否要走抽帧路径（MIME 优先，扩展名兜底：部分系统给空 MIME）。 */
export function isVideoFile(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("video/")) return true;
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name ?? "");
}

/** 抽帧结果：4 张 JPEG + 各自的时间点文案（缩图 alt 用）。 */
export interface ExtractedFrames {
  files: File[];
  timestamps: FrameTimestamp[];
}

/**
 * 从一个视频 File 抽出 4 帧 JPEG，直接给成可上传的 File。
 *
 * 调用方负责 objectUrl 的 revoke（预览要留着播原片，见 extractVideoFrames 注释）。
 * 超限（60 秒 / 100 MB）在 metadata 到手后立刻抛错，且错误文案就是拒收原因——
 * 绝不静默截断成前 60 秒。
 */
export async function extractFramesFromFile(
  file: File,
  objectUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedFrames> {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = objectUrl;

  const sample: AgentAttachmentRef = {
    kind: "video",
    url: objectUrl,
    name: file.name,
    mime: file.type || "video/mp4",
    size: file.size,
  };

  const blobs = await extractVideoFrames({ video, sample }, onProgress);
  const timestamps = computeFrameTimestamps(Number.isFinite(video.duration) ? video.duration : 0);
  const base = file.name.replace(/\.[^.]+$/, "") || "video";

  return {
    files: blobs.map(
      (blob, i) => new File([blob], `${base}-frame-${i + 1}.jpg`, { type: "image/jpeg" }),
    ),
    timestamps,
  };
}

/**
 * 读取 metadata 的硬上限（毫秒）。本机 Object URL 的字节就在内存里、metadata 在档首，
 * 正常应近乎即时（远小于 1 秒）；10 秒已远超任何合理的本地解码等待，又短到让
 * 「真的卡住的解码」在可容忍时间内落成失败（chip 不再永久转圈）。
 */
export const METADATA_WAIT_TIMEOUT_MS = 10_000;

/**
 * 等 loadedmetadata（读 duration / seek 前必须）。
 *
 * extractVideoFrames 内联着同一段（上传路径依赖它），本轮（2026-10-04）已就地把内联那份
 * 补成与这里同形（终态快查／事件／timeout／清监听）；这里独立一份给节点动作的
 * extractFramesAtTimes 用。两段语义逐字相同，改动时须同步。
 *
 * 2026-09-28 导出给画布节点动作（video-frames 路由的呼叫方）：节点动作要**先读 duration
 * 再算计划**（planFrameExtraction 需要时长），所以要在自己的离屏 <video> 上等 metadata，
 * 与该函数在 extractFramesAtTimes 内的用途同源，不另写第二份。
 *
 * 2026-10-04（BUG-1）：进入时先看元素是否**已处于终态**——不能只靠事件。
 * `<video>` 的 `error` 事件整个生命周期**只发一次**；若前一次等待已把它消费掉，
 * 第二次再挂监听将永远等不到事件（readyState 停在 0），promise 永久 pending。
 * 因此：已 error → 立即失败；已 HAVE_METADATA 以上 → 立即成功。timeout 只是外层保险。
 */
export async function waitForMetadata(
  video: HTMLVideoElement,
  timeoutMs: number = METADATA_WAIT_TIMEOUT_MS,
): Promise<void> {
  // 终态快查：已解碼就直接成功（不再重挂监听）。
  if (video.readyState >= 1) return;
  // 终态快查：元素已经死了（MEDIA_ERR_* / src 不支援）就直接失败，
  // 不重挂监听——否则第二次等待会永久 pending。
  if (video.error) throw new Error("视频解码失败，无法读取。");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onLoaded = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("视频解码失败，无法读取。"));
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("读取视频信息超时。"));
    }, timeoutMs);
  });
}

/**
 * 单次 seek 的硬上限（毫秒）。
 *
 * 本机 Object URL 的字节就在内存里，正常 seek 是毫秒级；画布节点动作的远端 https
 * 视频（`use-canvas-generation.ts` 直接调用本函数，**没有** `local-media-ingest` 的
 * 总 timeout 兜底）可能要先把目标关键帧拉过网络再解码。15 秒已远超任何合理耗时的
 * 百倍，又短到让「真的卡住的 seek」落成可观测失败——节点动作不会永远停在「取帧中…」。
 * 与 metadata 等待（10 秒）同族同形，只是因远端多给一点网络余量。
 */
export const SEEK_TIMEOUT_MS = 15_000;

/**
 * 等待 video 跳到指定时间（等 seeked，否则 draw 到的是上一帧）。
 *
 * 2026-10-04（同 BUG-1 族）：进入时先看是否**已处于终态**，事件其次，timeout 兜底，
 * 所有出口清监听。此前只等 seeked/error 且 error 也 resolve：元素若「永不 seeked」
 * 且 `readyState < 2`（没有 data 可解码）就**永久 pending**——画布节点动作因此会永远
 * 停在「取帧中…」。现在 error 直接 reject（具名原因），永不 settle 则由 timeout 兜底
 * reject，调用端的 `try/catch → showError` 与 `finally` 才能落到明确终态。
 *
 * 导出：`extractFramesAtTimes` 与上传路径共用同一原语；另供 node:test 直接注入缩短的
 * timeoutMs 复现「永不 seeked」（见同目录测试）。
 */
export async function seekTo(
  video: HTMLVideoElement,
  time: number,
  timeoutMs: number = SEEK_TIMEOUT_MS,
): Promise<void> {
  // 终态快查 1：元素已经死了（解码失败 / src 不支援），立即具名失败，不重挂监听。
  if (video.error) throw new Error("视频解码失败，无法读取。");
  // 终态快查 2：已经停在目标时间且已有当前帧（HAVE_CURRENT_DATA 以上），不必再等
  // seeked（部分浏览器对「已在目标点」的 seek 不触发 seeked）。
  if (video.readyState >= 2 && Math.abs(video.currentTime - time) <= 0.001) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 老 Safari 对「已经在这个时间点」的 seek 不触发 seeked，会给一拍确认后自己 resolve。
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      if (timer !== undefined) clearTimeout(timer);
      if (confirmTimer !== undefined) clearTimeout(confirmTimer);
    };
    const onSeeked = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("视频解码失败，无法读取。"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("视频定位超时，无法读取该时间点的画面。"));
    }, timeoutMs);
    video.currentTime = time;
    // 仍要等这一拍，否则 drawImage 读到上一帧。
    if (video.readyState >= 2) {
      confirmTimer = setTimeout(() => {
        if (!settled && Math.abs(video.currentTime - time) <= 0.001) {
          settled = true;
          cleanup();
          resolve();
        }
      }, 64);
    }
  });
}

/**
 * 单帧 canvas 导出的硬上限（毫秒）。
 *
 * `canvas.toBlob` 是回调式 API，且**没有任何事件或错误通道**：回调不触发就永久
 * pending（不是 reject、不是 resolve）。canvas 节点取帧路径（`extractFramesAtTimes`
 * → `captureFrame`）没有外层的总 timeout 兜底，一旦 toBlob 卡住节点会永远停在
 * 「取帧中…」。画一帧再 JPEG 编码是纯 CPU 工作，正常在毫秒级；10 秒与 metadata
 * 等待同档，远超任何合理耗时又短到让卡死可观测。逾时具名 reject 后，调用端
 * `use-canvas-generation.ts` 的 `try/catch → showError("取帧失败：" + message)` 才能落地。
 */
export const FRAME_CAPTURE_TIMEOUT_MS = 10_000;

/**
 * 单帧 capture：canvas 缩到长边 512、按原始宽高比，导出 JPEG。
 * 真实坑：canvas 只能画同源/可跨域资源，Object URL 是同源的；另外
 * canvas 的尺寸是 CSS 像素，与视频的 internal 分辨率不同时，只要
 * drawImage 用 video element 本身即可拿到完整的解码帧。
 *
 * 导出：供 `extractFramesAtTimes`（含画布节点动作）与上传路径共用；另供 node:test
 * 注入缩短的 timeoutMs 复现「toBlob 永不回调」。
 */
export async function captureFrame(
  video: HTMLVideoElement,
  timeoutMs: number = FRAME_CAPTURE_TIMEOUT_MS,
): Promise<Blob> {
  const raw = video.videoWidth;
  const rawH = video.videoHeight;
  if (!raw || !rawH) throw new Error("取帧失败：视频没有画面尺寸。");

  const scale = Math.min(1, MAX_FRAME_EDGE_PX / Math.max(raw, rawH));
  const width = Math.max(1, Math.round(raw * scale));
  const height = Math.max(1, Math.round(rawH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("取帧失败：浏览器不支持 canvas 2D。");

  // 垫白再画：JPEG 没有 alpha，带透明通道的 WebM 不垫底会导出成黑块。
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(video, 0, 0, width, height);

  // 质量 0.8：视觉模型够看，体积又只有 1.0 的一半左右。
  return await new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("取帧超时，请重试。"));
    }, timeoutMs);
    canvas.toBlob(
      (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!blob) return reject(new Error("取帧失败：无法导出图像。"));
        resolve(blob);
      },
      "image/jpeg",
      0.8,
    );
  });
}

