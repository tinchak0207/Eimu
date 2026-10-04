// 生成历史的统一数据模型。
//
// 历史记录来自三个互不相同的源头，字段和 id 规则都不一样：
//   - "local"   浏览器 localStorage 缓存，id = `${userId}-${客户端 Date.now()}`
//   - "server"  Vercel Blob 持久化记录，id = `${userId}-${服务端 Date.now()}`
//   - "billing" 上游 New API 计费日志，只有 model_name / quota / created_at，没有提示词和图
// 同一次生成会同时出现在三处，但三个 id 互不相等，时间戳也差几百毫秒到几秒。
// 因此这里既按 id 精确去重，也按「提示词 + 模型 + 邻近时间」模糊归并，
// 把服务端的图、本地的工作流参数、计费日志的真实消耗合并成同一条记录。
//
// 本模块只用 `import type` 跨文件引用，保证可以在 `node --test` 下直接导入做单元测试。
// 唯一运行时依赖是 ./lineage（REQ-D1 血统清洗，零依赖纯函数档，不破坏上面这条）。

import type { GenerationWorkflowMetadata } from "./image-types";
import { QUOTA_PER_COIN } from "./quota-constants";
import { normalizeLineageLinks } from "./lineage";
import type { LineageLink } from "./lineage";
// 交付物种类真源（./deliverable-kind，零依赖纯函数档）：
// 历史侧的种类型别、mediaType 白名单、结果推断、hasImage 全由注册表推导。
import {
  DELIVERABLE_KINDS,
  deliverableKindsByDetectPriority,
  deliverableKindsOfResult,
  isDeliverableKind,
} from "./deliverable-kind";
import type { DeliverableKind } from "./deliverable-kind";

export { QUOTA_PER_COIN };

/** 当前实体的 schema 版本，写入 Blob 与 localStorage，便于日后迁移。 */
export const HISTORY_SCHEMA_VERSION = 3;

/** 服务端每页返回的默认条数。 */
export const HISTORY_PAGE_SIZE = 24;

/** 单个用户在服务端保留的历史上限。旧实现是 20，这里放大到能真正当作素材库用。 */
export const MAX_HISTORY_ENTRIES_PER_USER = 500;

/** 模糊归并的时间容差：两条记录相差在此之内、且提示词与模型相同，视为同一次生成。 */
export const HISTORY_MERGE_TOLERANCE_MS = 120_000;

/** POST /api/history 的输入上限，防止有人拿这个端点当免费对象存储。 */
export const HISTORY_MAX_PROMPT_LENGTH = 8_000;
export const HISTORY_MAX_RESULTS_PER_ENTRY = 8;
export const HISTORY_MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * 记录来源。三个既有值都描述「这条记录是从哪个存储面读出来的」；
 * `"workflow"` 不同——它描述「这条记录是 gateway 跑批完成推送落盘的」，
 * 值本身也带信息（前端要据它把工作流记录从图片列表里分流）。
 * 读路径上它只会以 server 面出现（推送端点写的 history/{userId}/ 索引），
 * 但 source 是记录自身的身份，不该为了迁就存储面而丢掉。
 */
export type HistorySource = "local" | "server" | "billing" | "workflow";

/**
 * 非交付物的记录种类。`"workflow"` 描述的是一次 DAG 跑批，不是某件可交付的媒体，
 * 因此不进交付物注册表；UI 需要「非交付种类有哪些」时取这份清单，不手写字串。
 */
export const NON_DELIVERABLE_ENTRY_KINDS = ["workflow"] as const;
export type NonDeliverableEntryKind = (typeof NON_DELIVERABLE_ENTRY_KINDS)[number];

/**
 * 记录类型：一条记录交付的是「一张图 / 一支视频 / 一段音频 / 一次工作流跑批」。
 *
 * 为什么要有这个字段而不是直接看 source：source 是存储面（同一条记录在 local
 * 与 server 两个面各有一份），entryKind 是内容种类，两者正交。工作流记录在
 * 归并时可能以 server 面为主记录，那时只看 source 会把「有 DAG 的工作流记录」
 * 与「单张图」混为一谈。缺省时用 inferEntryKind 推。
 *
 * 值域＝交付物种类（由 ./deliverable-kind 注册表推导）∪ 非交付种类（workflow）。
 * 新增一种交付物＝在注册表加一行，这里自动跟上，不再手写字串联集。
 */
export type HistoryEntryKind = DeliverableKind | NonDeliverableEntryKind;

export interface HistoryResult {
  provider: string;
  modelId: string;
  image: string | null;
  imageUrl: string | null;
  endpointLabel?: string;
  resultId?: string;
  taskId?: string;
  videoUrl?: string | null;
  /** 音频产物 URL（音乐/TTS）；与 videoUrl 并列的第四类产物。 */
  audioUrl?: string | null;
  /** 媒体种类；值域＝交付物注册表（./deliverable-kind）。image 也会显式写入。 */
  mediaType?: DeliverableKind;
}

export interface HistoryEntry {
  id: string;
  prompt: string;
  /** 毫秒时间戳。计费日志的 created_at 是秒，读入时必须 ×1000。 */
  generatedAt: number;
  results: HistoryResult[];
  source: HistorySource;
  /**
   * 记录类型。写入方（gateway 推送 / 生成路由）显式给值，历史读路径只认它；
   * 旧记录没有这个字段 → inferEntryKind 按 source / DAG / results 推。
   */
  entryKind?: HistoryEntryKind;
  workflow?: GenerationWorkflowMetadata;
  /** 上游计费日志里的原始配额消耗；只有 billing 源才有，归并后会带到主记录上。 */
  quota?: number;
  /** 主模型，用于筛选与分面统计。缺省时取第一个结果的 modelId。 */
  modelId?: string;
  starred?: boolean;
  schemaVersion?: number;
  taskId?: string;
  generationId?: string;
  primaryResultId?: string;
  retryOfTaskId?: string;
  taskStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded" | "unknown";
  errorCode?: string;
  /**
   * REQ-D1 资产血统：这条记录的直接来源链（生成时带的参考图／重跑源／存卡来源）。
   * 只存在历史记录本体，供人看的「溯源」抽屉用——严禁补进 compactMetadataForAgent
   * 或 canvas 节点 metadata（agent 不读血统是裁决，不是遗漏）。缺省＝来源不明。
   */
  lineage?: LineageLink[];
  /** parents 曾超上限被截尾的显式标记（读时据此显示「仅保留最近 N 个」）。 */
  lineageTruncated?: boolean;
}

/** 服务端存储实体：比 HistoryEntry 多一个 userId。 */
export interface ServerHistoryEntry extends HistoryEntry {
  userId: number;
}

export type HistorySortOrder = "newest" | "oldest";

export interface HistoryQuery {
  /** 自由文本，匹配提示词与模型名。 */
  keyword?: string;
  /** 模型精确筛选。 */
  modelId?: string;
  /** 出图尺寸筛选，取自 workflow.imageSize。 */
  imageSize?: string;
  /** 只看已收藏。 */
  starredOnly?: boolean;
  /** 只看带图的记录（计费日志没有图）。 */
  withImageOnly?: boolean;
  /** 只看某一类记录（图片 / 视频 / 音频 / 工作流）。缺省不限。 */
  entryKind?: HistoryEntryKind;
  /** 闭区间，毫秒时间戳。 */
  since?: number;
  until?: number;
  sort?: HistorySortOrder;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** 下一页游标；为 null 表示已到末尾。 */
  cursor: string | null;
  total: number;
}

export interface HistoryPatch {
  starred?: boolean;
}

export interface HistoryFacetBucket {
  value: string;
  label: string;
  count: number;
}

export interface HistoryFacets {
  models: HistoryFacetBucket[];
  imageSizes: HistoryFacetBucket[];
  starredCount: number;
  withImageCount: number;
  total: number;
}

export interface HistoryStats {
  /** 记录条数。 */
  entries: number;
  /** 出图张数。 */
  images: number;
  /** 累计消耗的配额单位。 */
  quota: number;
  /** 已收藏条数。 */
  starred: number;
  /** 最早与最近一条的时间戳；无数据时为 null。 */
  firstAt: number | null;
  lastAt: number | null;
}

export type HistoryDayBucket = "today" | "yesterday" | "week" | "earlier";

export interface HistoryGroup {
  bucket: HistoryDayBucket;
  label: string;
  entries: HistoryEntry[];
}

const DAY_BUCKET_LABELS: Record<HistoryDayBucket, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "本周",
  earlier: "更早",
};

/** 归并时谁当主记录：服务端记录字段最全，计费日志最贫瘠。 */
const SOURCE_PRIORITY: Record<HistorySource, number> = {
  // workflow 与 server 同级：两者都是服务端落盘的完整记录，同 id 时留哪条都比
  // local/billing 强；不给更高优先级，避免抢掉同一 id 的 server 面记录。
  server: 3,
  workflow: 3,
  local: 2,
  billing: 1,
};

// ─────────────────────────────────────────────────────────── 基础工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** entryKind 白名单判定。写入口（POST /api/history）与推送端点共用同一把尺。 */
function isEntryKind(value: unknown): value is HistoryEntryKind {
  return (
    isDeliverableKind(value) ||
    (NON_DELIVERABLE_ENTRY_KINDS as readonly unknown[]).includes(value)
  );
}

/**
 * 把配额单位换算成「张」。返回数字，调用方自己决定怎么格式化。
 * 旧代码里有两个互相打架的实现（一个 toFixed(3) 返回字符串、一个 Math.floor 返回数字），
 * 这里统一成一个。
 */
export function coinsFromQuota(quota: number | undefined | null): number {
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0) return 0;
  return quota / QUOTA_PER_COIN;
}

/** 展示用的消耗文案：不足一张时保留三位小数，否则最多一位。 */
export function formatCoins(quota: number | undefined | null): string {
  const coins = coinsFromQuota(quota);
  if (coins === 0) return "0";
  if (coins < 1) return coins.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(1);
}

/**
 * 清洗要拼进 Blob 路径的片段。
 * 旧实现把 entryId 和 provider 直接拼进 `history/{userId}/{entryId}-{provider}.png`，
 * 而 POST /api/history 的 body 是完全未校验的客户端输入 —— 传个 `../123/x` 就能写到别人的目录下。
 */
export function sanitizeBlobSegment(value: string, fallback = "item"): string {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** 提示词指纹：用于跨源模糊归并，忽略空白与大小写差异。 */
export function promptFingerprint(prompt: string): string {
  return String(prompt ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** 一条记录的主模型。 */
export function primaryModelId(entry: HistoryEntry): string {
  return entry.modelId ?? entry.results[0]?.modelId ?? "";
}

/**
 * 记录类型推断（导出给前端用：列表分流「图片／视频／工作流」三档 chip）。
 *
 * 优先级从「最可信」到「最将就」：
 *   1. entry.entryKind —— 写入方显式声明的，永远最准；
 *   2. source === "workflow" —— gateway 推送落盘的记录，source 即身份；
 *   3. workflow 带 dagNodes —— 老工作流记录可能没有 entryKind 也没有
 *      workflow 这个 source（归并后主记录可能是 server 面），但 DAG 结构在，
 *      它就是工作流记录；
 *   4. results 的媒体种类与产物 URL（由注册表 resultField 驱动）判 media kind，
 *      优先序由注册表 detectPriority 决定（现况 video > audio > image）；
 *      新增种类自动纳入，不再硬编；一条记录同时带影音时，视频是主产物；
 *   5. 其余（含无 results 的空记录）→ "image"。
 *
 * 第 5 条刻意兜底成 "image"：历史页绝大多数记录是图，把无结果记录判成
 * "video" 会让默认列表被空记录淹掉。没有任何一条分支会抛错。
 */
export function inferEntryKind(entry: HistoryEntry): HistoryEntryKind {
  if (isEntryKind(entry.entryKind)) {
    return entry.entryKind;
  }
  if (entry.source === "workflow") return "workflow";
  if (Array.isArray(entry.workflow?.dagNodes) && entry.workflow.dagNodes.length > 0) return "workflow";

  // 媒体分支：逐 result 收集种类（媒体宣告 mediaType ＋ 产物 URL 推断），再按
  // **注册表 detectPriority 升序**取最高者（现况 video > audio > image）——
  // 注意这与注册表宣告序（image → video → audio）不同，因为同录带影音时视频
  // 是主产物（既有语义）；deliverableKindOfResult 只是「单一结果 → 单一 URL
  // 种类」的投影，这里跨所有结果取并集，确保 videoUrl 落在任一结果都能胜出。
  // 没有任何媒体种类命中时落到第 5 条的 "image" 兜底。
  const mediaKinds = new Set<DeliverableKind>();
  for (const result of entry.results) {
    if (isDeliverableKind(result.mediaType)) mediaKinds.add(result.mediaType);
    // 逐栏位收集「这个 result 所有命中的种类」，而不是取单一投影
    // （deliverableKindOfResult 按宣告序 image 先扫，会盖掉同一 result 的 videoUrl）。
    for (const kind of deliverableKindsOfResult(result)) mediaKinds.add(kind);
  }
  for (const kind of deliverableKindsByDetectPriority()) {
    if (mediaKinds.has(kind)) return kind;
  }
  return "image";
}

/**
 * 是否带「可留存媒体」。计费日志永远没有媒体。
 *
 * 判定：results 里任一结果带了 image 或注册表任一 resultField（imageUrl /
 * videoUrl / audioUrl）。栏位清单由 ./deliverable-kind 推导，新增交付物种类时
 * 这里自动纳入，不再手写栏位名。
 * 注意它早就不只认「图」——videoUrl 从视频能力上线起就在里面，因此函数名
 * 是历史遗留；实际语义是「有产物可看/可播」（UI 上「有图」chip 的用意也是
 * 「不把无媒体的计费日志混进来」）。audioUrl 与 videoUrl 同级计入，保持同一
 * 语义，否则音乐记录会在「有图」筛选下整批消失。
 */
export function hasImage(entry: HistoryEntry): boolean {
  return entry.results.some(
    (result) =>
      Boolean(result.image) ||
      DELIVERABLE_KINDS.some((kind) => Boolean(result[kind.resultField])),
  );
}

/** 精确去重键。 */
export function historyEntryKey(entry: HistoryEntry): string {
  return entry.taskId ?? entry.id;
}

// ─────────────────────────────────────────────────────────── 规范化

/** 把任意来源的原始对象规范化成 HistoryEntry；无法识别时返回 null。 */
export function normalizeHistoryEntry(raw: unknown, source: HistorySource): HistoryEntry | null {
  if (!isRecord(raw)) return null;

  const id = nonEmptyString(raw.id);
  const generatedAt = finiteNumber(raw.generatedAt);
  if (!id || generatedAt === undefined || generatedAt <= 0) return null;

  const results = Array.isArray(raw.results)
    ? raw.results.flatMap((item): HistoryResult[] => {
        if (!isRecord(item)) return [];
        const modelId = nonEmptyString(item.modelId);
        if (!modelId) return [];
        // mediaType 白名单由交付物注册表判定：image / video / audio 都放行
        // （image 也显式写入 mediaType；未知值丢弃）。image 旧行为刻意不写是
        // 为不新增字段，现改由注册表统一——见 deliverable-kind.ts。
        const mediaType = isDeliverableKind(item.mediaType) ? item.mediaType : undefined;
        return [{
          provider: nonEmptyString(item.provider) ?? "image_tinchak",
          modelId,
          image: typeof item.image === "string" && item.image ? item.image : null,
          imageUrl: nonEmptyString(item.imageUrl) ?? null,
          ...(nonEmptyString(item.endpointLabel) ? { endpointLabel: nonEmptyString(item.endpointLabel) } : {}),
          ...(nonEmptyString(item.resultId) ? { resultId: nonEmptyString(item.resultId) } : {}),
          ...(nonEmptyString(item.taskId) ? { taskId: nonEmptyString(item.taskId) } : {}),
          ...(nonEmptyString(item.videoUrl) ? { videoUrl: nonEmptyString(item.videoUrl) } : {}),
          ...(nonEmptyString(item.audioUrl) ? { audioUrl: nonEmptyString(item.audioUrl) } : {}),
          ...(mediaType ? { mediaType } : {}),
        }];
      }).slice(0, HISTORY_MAX_RESULTS_PER_ENTRY)
    : [];

  const quota = finiteNumber(raw.quota);
  const modelId = nonEmptyString(raw.modelId) ?? results[0]?.modelId;

  // REQ-D1：血统栏位走纯函数白名单清洗（复用 ./lineage 收口），非法条目丢弃、
  // 超上限截尾并显式标记。缺栏＝来源不明，不捏造 parents。
  const lineageRaw = Array.isArray(raw.lineage) ? normalizeLineageLinks(raw.lineage) : null;

  return {
    id,
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, HISTORY_MAX_PROMPT_LENGTH) : "",
    generatedAt,
    results,
    source,
    ...(isEntryKind(raw.entryKind) ? { entryKind: raw.entryKind } : source === "workflow" ? { entryKind: "workflow" as const } : {}),
    // workflow 字段维持整体 passthrough（只验是 record，不逐栏白名单）：
    // 生成路由写的六槽 + 本片新增的 DAG 四栏（dagNodes/dagConnections/
    // dagThumbnailUrl/totalCostCoins）都挂在这里，白名单化会把未来新增的
    // 栏位静默砍掉，而这些栏位只被前端读来展示、不参与任何写回。
    // 反过来，entryKind 必须白名单：它是查询条件（matchesHistoryQuery），
    // 放任客户端塞任意字串会让「类型」筛选出现无法命中的值。
    ...(isRecord(raw.workflow) ? { workflow: raw.workflow as GenerationWorkflowMetadata } : {}),
    ...(quota !== undefined ? { quota } : {}),
    ...(modelId ? { modelId } : {}),
    ...(raw.starred === true ? { starred: true } : {}),
    ...(nonEmptyString(raw.taskId) ? { taskId: nonEmptyString(raw.taskId) } : {}),
    ...(nonEmptyString(raw.generationId) ? { generationId: nonEmptyString(raw.generationId) } : {}),
    ...(nonEmptyString(raw.primaryResultId) ? { primaryResultId: nonEmptyString(raw.primaryResultId) } : {}),
    ...(nonEmptyString(raw.retryOfTaskId) ? { retryOfTaskId: nonEmptyString(raw.retryOfTaskId) } : {}),
    ...(["queued", "running", "succeeded", "failed", "cancelled", "refunded", "unknown"].includes(String(raw.taskStatus))
      ? { taskStatus: raw.taskStatus as HistoryEntry["taskStatus"] }
      : {}),
    ...(nonEmptyString(raw.errorCode) ? { errorCode: nonEmptyString(raw.errorCode) } : {}),
    ...(lineageRaw && lineageRaw.parents.length
      ? {
          lineage: lineageRaw.parents,
          ...(lineageRaw.truncated || raw.lineageTruncated === true ? { lineageTruncated: true } : {}),
        }
      : {}),
    schemaVersion: finiteNumber(raw.schemaVersion) ?? HISTORY_SCHEMA_VERSION,
  };
}

/**
 * 把上游计费日志行转成 HistoryEntry。
 *
 * 上游字段是 `model_name` / `quota` / `created_at`（秒），
 * 旧的 HistoryClient 读的是 `model` / `prompt` / `image`，全都不存在 ——
 * 这正是历史页提示词一直为空、搜索一搜就崩的根因。
 */
export function normalizeBillingLogEntry(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw)) return null;

  const createdAt = finiteNumber(raw.created_at);
  if (createdAt === undefined || createdAt <= 0) return null;

  const modelName = nonEmptyString(raw.model_name) ?? "";
  const rawId = finiteNumber(raw.id);
  // 上游把 id 重写成了每页序号，跨页并不唯一，所以拼上时间戳与模型名保证稳定。
  const id = `billing-${createdAt}-${modelName || "unknown"}-${rawId ?? 0}`;

  return {
    id,
    prompt: nonEmptyString(raw.content) ?? "",
    generatedAt: createdAt * 1000,
    results: [],
    source: "billing",
    quota: finiteNumber(raw.quota) ?? 0,
    ...(modelName ? { modelId: modelName } : {}),
    schemaVersion: HISTORY_SCHEMA_VERSION,
  };
}

// ─────────────────────────────────────────────────────────── 归并

/** 把 b 的信息补进 a，不覆盖 a 已有的有效值。 */
function enrich(base: HistoryEntry, extra: HistoryEntry): HistoryEntry {
  const merged: HistoryEntry = { ...base };

  if (!merged.prompt && extra.prompt) merged.prompt = extra.prompt;
  if (!merged.results.length && extra.results.length) merged.results = extra.results;
  // entryKind 不在这里补：它是「内容种类」，由 inferEntryKind 现场推；
  // 若把 extra 的值搬过来，一条 local 面推断为 image 的记录会覆盖 server 面的
  // workflow 判定。归并只需保证 DAG 结构不丢（workflow 整体补）。
  if (!merged.workflow && extra.workflow) merged.workflow = extra.workflow;
  if (merged.quota === undefined && extra.quota !== undefined) merged.quota = extra.quota;
  if (!merged.modelId && extra.modelId) merged.modelId = extra.modelId;
  if (!merged.taskId && extra.taskId) merged.taskId = extra.taskId;
  if (!merged.generationId && extra.generationId) merged.generationId = extra.generationId;
  if (!merged.primaryResultId && extra.primaryResultId) merged.primaryResultId = extra.primaryResultId;
  if (!merged.retryOfTaskId && extra.retryOfTaskId) merged.retryOfTaskId = extra.retryOfTaskId;
  if (!merged.taskStatus && extra.taskStatus) merged.taskStatus = extra.taskStatus;
  if (!merged.errorCode && extra.errorCode) merged.errorCode = extra.errorCode;
  // REQ-D1：血统栏位两面取较全的一份（local 面一般为空，server 面带登记）。
  if (!merged.lineage?.length && extra.lineage?.length) {
    merged.lineage = extra.lineage;
    if (extra.lineageTruncated) merged.lineageTruncated = true;
  }
  if (extra.starred) merged.starred = true;
  // 取更早的那个时间戳：客户端在所有出图落地后才记录，服务端在单个出图成功时就记录。
  if (extra.generatedAt < merged.generatedAt) merged.generatedAt = extra.generatedAt;

  return merged;
}

/** 模型是否可视为同一个：两边相同，或其中一边缺失。 */
function modelsCompatible(a: HistoryEntry, b: HistoryEntry): boolean {
  const ma = primaryModelId(a);
  const mb = primaryModelId(b);
  return !ma || !mb || ma === mb;
}

/**
 * 判断两条生成记录是否同一次生成。
 *
 * 只在提示词指纹完全一致时才归并 —— 本地缓存与服务端 Blob 记录的是同一段提示词，
 * 而它们的 id 分别由客户端与服务端各自取 Date.now() 生成，永远不会相等。
 */
function isSameGeneration(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.taskId && b.taskId) return a.taskId === b.taskId;
  if (a.source === b.source) return false;
  if (Math.abs(a.generatedAt - b.generatedAt) > HISTORY_MERGE_TOLERANCE_MS) return false;
  if (!modelsCompatible(a, b)) return false;

  const pa = promptFingerprint(a.prompt);
  const pb = promptFingerprint(b.prompt);
  return Boolean(pa) && pa === pb;
}

/**
 * 合并多组生成记录（local 与 server），先按 id 精确去重，再按「提示词 + 模型 + 邻近时间」归并。
 * 输入顺序不影响结果：主记录始终由 SOURCE_PRIORITY 决定。
 * 返回按时间倒序排列的数组。
 *
 * 计费日志不参与这里的归并 —— 它没有提示词也没有图，无法可靠对应到具体某一次生成，
 * 单价信息改由 attachBillingCosts 在能唯一确定时才附加。
 */
export function mergeHistoryEntries(...groups: HistoryEntry[][]): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>();

  for (const group of groups) {
    for (const entry of group) {
      if (!entry) continue;
      const key = historyEntryKey(entry);
      const existing = byId.get(key);
      if (!existing) {
        byId.set(key, entry);
        continue;
      }
      // id 相同：留下源优先级更高的那条，另一条补充字段。
      const [primary, secondary] = SOURCE_PRIORITY[entry.source] > SOURCE_PRIORITY[existing.source]
        ? [entry, existing]
        : [existing, entry];
      byId.set(key, enrich(primary, secondary));
    }
  }

  // 按时间正序扫描，把落在容差窗口内的同一次生成合并到已保留的记录上。
  const sorted = [...byId.values()].sort((a, b) => a.generatedAt - b.generatedAt);
  const kept: HistoryEntry[] = [];

  for (const entry of sorted) {
    let mergedInto = false;
    // 只需回看容差窗口内的记录；数组按时间正序，越靠后越新。
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const candidate = kept[i];
      if (entry.generatedAt - candidate.generatedAt > HISTORY_MERGE_TOLERANCE_MS) break;
      if (!isSameGeneration(candidate, entry)) continue;

      const [primary, secondary] = SOURCE_PRIORITY[entry.source] > SOURCE_PRIORITY[candidate.source]
        ? [entry, candidate]
        : [candidate, entry];
      kept[i] = enrich(primary, secondary);
      mergedInto = true;
      break;
    }
    if (!mergedInto) kept.push(entry);
  }

  return sortHistoryEntries(kept, "newest");
}

/**
 * 把计费日志里的真实消耗附加到对应的生成记录上。
 *
 * 上游日志只有 model_name / quota / created_at，没有提示词也没有图，
 * 因此只在「同模型 + 时间容差内 + 候选唯一」时才认定配对成功。
 * 存在歧义（比如同一分钟内用同一模型生成了多次）时宁可不附加，也不显示一个猜出来的数字。
 * 页面顶部的累计消耗仍旧直接取上游统计接口，不受这里影响。
 */
export function attachBillingCosts(
  entries: HistoryEntry[],
  billingEntries: HistoryEntry[],
  toleranceMs: number = HISTORY_MERGE_TOLERANCE_MS,
): HistoryEntry[] {
  if (!billingEntries.length) return entries;

  const claimed = new Set<number>();

  return entries.map((entry) => {
    if (entry.quota !== undefined) return entry;

    const model = primaryModelId(entry);
    if (!model) return entry;

    const matches: number[] = [];
    for (let i = 0; i < billingEntries.length; i += 1) {
      if (claimed.has(i)) continue;
      const log = billingEntries[i];
      if (primaryModelId(log) !== model) continue;
      if (Math.abs(log.generatedAt - entry.generatedAt) > toleranceMs) continue;
      matches.push(i);
      if (matches.length > 1) break;
    }

    if (matches.length !== 1) return entry;

    claimed.add(matches[0]);
    return { ...entry, quota: billingEntries[matches[0]].quota };
  });
}

// ─────────────────────────────────────────────────────────── 查询

export function sortHistoryEntries(entries: HistoryEntry[], order: HistorySortOrder = "newest"): HistoryEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => (order === "newest" ? b.generatedAt - a.generatedAt : a.generatedAt - b.generatedAt));
  return sorted;
}

export function matchesHistoryQuery(entry: HistoryEntry, query: HistoryQuery): boolean {
  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    const haystack = `${entry.prompt} ${primaryModelId(entry)} ${entry.workflow?.workflowPresetLabel ?? ""}`.toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  if (query.entryKind && inferEntryKind(entry) !== query.entryKind) return false;
  if (query.modelId && primaryModelId(entry) !== query.modelId) return false;
  if (query.imageSize && entry.workflow?.imageSize !== query.imageSize) return false;
  if (query.starredOnly && !entry.starred) return false;
  if (query.withImageOnly && !hasImage(entry)) return false;
  if (query.since !== undefined && entry.generatedAt < query.since) return false;
  if (query.until !== undefined && entry.generatedAt > query.until) return false;
  return true;
}

export function filterHistoryEntries(entries: HistoryEntry[], query: HistoryQuery): HistoryEntry[] {
  return entries.filter((entry) => matchesHistoryQuery(entry, query));
}

// ─────────────────────────────────────────────────────────── 分面与统计

export function buildHistoryFacets(entries: HistoryEntry[]): HistoryFacets {
  const models = new Map<string, number>();
  const imageSizes = new Map<string, number>();
  let starredCount = 0;
  let withImageCount = 0;

  for (const entry of entries) {
    const model = primaryModelId(entry);
    if (model) models.set(model, (models.get(model) ?? 0) + 1);

    const size = entry.workflow?.imageSize;
    if (size) imageSizes.set(size, (imageSizes.get(size) ?? 0) + 1);

    if (entry.starred) starredCount += 1;
    if (hasImage(entry)) withImageCount += 1;
  }

  const toBuckets = (map: Map<string, number>, label: (value: string) => string): HistoryFacetBucket[] =>
    [...map.entries()]
      .map(([value, count]) => ({ value, label: label(value), count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    models: toBuckets(models, formatModelLabel),
    imageSizes: toBuckets(imageSizes, (value) => value),
    starredCount,
    withImageCount,
    total: entries.length,
  };
}

/** 模型名去掉路径前缀，只留最后一段，和 imageHelpers.formatModelId 保持一致。 */
export function formatModelLabel(modelId: string): string {
  const segments = String(modelId ?? "").split("/");
  return segments[segments.length - 1] || modelId;
}

export function buildHistoryStats(entries: HistoryEntry[]): HistoryStats {
  let images = 0;
  let quota = 0;
  let starred = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const entry of entries) {
    images += entry.results.filter((result) => result.image || result.imageUrl).length;
    quota += entry.quota ?? 0;
    if (entry.starred) starred += 1;
    if (firstAt === null || entry.generatedAt < firstAt) firstAt = entry.generatedAt;
    if (lastAt === null || entry.generatedAt > lastAt) lastAt = entry.generatedAt;
  }

  return { entries: entries.length, images, quota, starred, firstAt, lastAt };
}

// ─────────────────────────────────────────────────────────── 分组

/** 取本地时区当天 00:00 的时间戳。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 按「今天 / 昨天 / 本周 / 更早」分组。
 * 使用本地时区的自然日边界，而不是「距今 24 小时」，否则凌晨看会全部落进「昨天」。
 * now 作为参数传入，便于测试。
 */
export function groupHistoryByDay(entries: HistoryEntry[], now: number = Date.now()): HistoryGroup[] {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = startOfLocalDay(todayStart - 1);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const order: HistoryDayBucket[] = ["today", "yesterday", "week", "earlier"];
  const grouped = new Map<HistoryDayBucket, HistoryEntry[]>();

  for (const entry of sortHistoryEntries(entries, "newest")) {
    let bucket: HistoryDayBucket;
    if (entry.generatedAt >= todayStart) bucket = "today";
    else if (entry.generatedAt >= yesterdayStart) bucket = "yesterday";
    else if (entry.generatedAt >= weekStart) bucket = "week";
    else bucket = "earlier";

    const list = grouped.get(bucket);
    if (list) list.push(entry);
    else grouped.set(bucket, [entry]);
  }

  return order
    .filter((bucket) => grouped.has(bucket))
    .map((bucket) => ({
      bucket,
      label: DAY_BUCKET_LABELS[bucket],
      entries: grouped.get(bucket) as HistoryEntry[],
    }));
}

// ─────────────────────────────────────────────────────────── 游标分页

/**
 * 游标编码为 `${generatedAt}:${id}`。
 * 只按时间戳翻页会在同毫秒的多条记录处漏数据，所以带上 id 做二级排序键。
 */
export function encodeHistoryCursor(entry: HistoryEntry): string {
  return `${entry.generatedAt}:${entry.id}`;
}

export function decodeHistoryCursor(cursor: string | null | undefined): { generatedAt: number; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.indexOf(":");
  if (separator <= 0) return null;
  const generatedAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(generatedAt) || !id) return null;
  return { generatedAt, id };
}

/**
 * 从已排序（倒序）的数组中切出一页。
 * 游标是「上一页最后一条」，本页从严格小于它的位置开始，因此不会重复也不会跳过。
 */
export function paginateHistoryEntries(
  entries: HistoryEntry[],
  cursor: string | null | undefined,
  pageSize: number = HISTORY_PAGE_SIZE,
): HistoryPage {
  const size = Math.max(1, Math.min(100, Math.floor(pageSize) || HISTORY_PAGE_SIZE));
  const sorted = sortHistoryEntries(entries, "newest");
  const decoded = decodeHistoryCursor(cursor);

  let startIndex = 0;
  if (decoded) {
    const anchor = sorted.findIndex(
      (entry) => entry.generatedAt === decoded.generatedAt && entry.id === decoded.id,
    );
    if (anchor >= 0) {
      startIndex = anchor + 1;
    } else {
      // 游标指向的记录已被删除：退化为按时间戳定位，保证翻页不中断。
      const fallback = sorted.findIndex((entry) => entry.generatedAt < decoded.generatedAt);
      startIndex = fallback >= 0 ? fallback : sorted.length;
    }
  }

  const slice = sorted.slice(startIndex, startIndex + size);
  const hasMore = startIndex + size < sorted.length;

  return {
    entries: slice,
    cursor: hasMore && slice.length ? encodeHistoryCursor(slice[slice.length - 1]) : null,
    total: sorted.length,
  };
}

// ─────────────────────────────────────────────────────────── 时间展示

/** 相对时间文案，供列表使用。 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 0) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/** 绝对时间文案，供详情与导出使用。 */
export function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
