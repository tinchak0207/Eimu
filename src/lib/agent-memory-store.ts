// AI 助理全局记忆库：私有库（账户级）+ 共享库（平台级）的持久化与索引。
//
// 本档以 src/lib/agent-profile-store.ts 为**逐行基底复制**（2026-09-15），只改
// 白名单栏位：blob key 路径、资料形状（AgentMemoryDoc）、函式名、业务逻辑
// （去重／配额／索引重建）。以下骨架一行未改，逐字沿用基底：
//   - readBlobText 双后端兼容（Vercel 回 { blob }、VPS 回 { stream }）
//   - dbAvailable() 探测（getGenerationSql 包 try/catch）
//   - Blob 失败 → 进程内 Map 兜底
//   - 错误吞噬策略（catch {} 吞掉，不把内部错误抛给调用方）
//   - blob 超时处理（由 blob-backend.ts 统一 10s 硬超时）
//
// Postgres 路径**未启用**（契约 §0 / PRD D4）：生产 `GENERATION_DATABASE_URL`
// 未配置，Vercel 与本地皆无 agent 记忆表，**blob 是唯一现实真源**。本档不建表、
// 不写 migration；dbAvailable() 仅保留同构探测供诊断，读写一律走 blob/Map。
//
// 闸门分工（契约 §5）：G1 结构／G2 证据／G3 敏感／G4 身份泄漏／G6 分数／G8 双模型
// 一致 = **gateway 职责**，repo 端**不重复拦**；本档只负责 **G5 去重**与 **G7 配额**。
// 因此含 `sk-`／`AIza`／邮箱的 doc 若已通过 gateway 闸门送达，本端点仍会写入
// （R6 尺：这是契约分工，不是漏洞）。
//
// 写入纪律：唯一入口是 HMAC 端点（ingest / retract），LLM 不得直触存储。
//
// 共享库收证纪律（2026-10-19）：shared 是平台级（全服可见），单个账号的幻觉或误判
// 若直接 active，会污染所有用户的上下文，因此 shared 新文档必须有**跨账号佐证**：
// 提出者 `contributorKey`（gateway 的 ownerKeyHint/hashKey）计入 `contributors`，
// 去重后人数 < `corroborationMin`（缺省 `MEMORY_SHARED_CORROBORATION_MIN`＝2）只能
// 落在 `pending_review`（不注入、不进 INDEX）；缺 `contributorKey` 一律 fail-closed
// 进 `pending_review`，绝不静默当 active。同 scope+slug 再入库时合并佐证名单；不同
// slug 的近重复（同 domain、description 近重复）只有在**正文也兼容**时才视为对同一
// 主张的佐证（见 `MEMORY_CORROBORATION_BODY_JACCARD`），否则按两条独立知识分别落盘，
// 绝不「接受后丢弃正文」。待审文档达到门槛才升 active；人工放行
// （review action="activate"）同样受平台容量上限约束。
//
// 提案制（active 文档的内容变更）：active shared 文档的内容四元组
// （body/description/domain/type）**只能由跨账号佐证推进**。单账号提交不同内容时
// 绝不覆盖 live 字段，只写入 `proposed` 提案；同一提案再获 ≥ corroborationMin 个
// 不同账号（同一 ownerKey 只算一人）支持后才提升为 live 内容并清空提案。内容完全
// 相同的重复提交是幂等操作，只把提出者并入 live `contributors`。提案永不进入
// INDEX／导出／召回语料。
//
// 入库回执区分「实写」与「提案」：只有真正写入新文档或把内容提升为 live 的才进
// `accepted`；active 文档仅新增／累积未达门槛的提案时进 `proposals`（live 一字未变），
// 避免工具与审计把未发布的提案误报为「已入库」。
//
// 状态机（shared）：
//   - 新文档：达门槛且容量允许 → active，否则 pending_review（fail-closed）。
//   - active：内容同 → 合并佐证、live 不动；内容异 → 提案（或达门槛提升）。
//   - pending_review：未发布态，可直接更新 live；**内容一变就重置 contributors**，
//     重新收证；内容同（或近重复且正文兼容）则合并；合并后达门槛且容量允许才 active。
//   - retracted：留证终态，再入库一律 rejected "retracted"，正文冻结不改。
//
// 容量是真不变量：**所有进入 active 的路径**（新建达门槛、pending 合并达门槛、
// proposed 提升、人工 review activate）统一走 `canActivateShared()`；catalog 中 active
// shared 达到 `MEMORY_SHARED_MAX_ACTIVE_DOCS`（400）时保持 pending_review（提案保留、
// 不丢数据；人工 activate 被挡的 id 进回执 `blocked`）。
// pending shared 另设 `MEMORY_SHARED_MAX_PENDING_DOCS`（1000）上限，满了拒绝新
// pending（reason 沿用既有 `quota_scope`，不新增枚举以免上层对帐断裂）；提案附着在
// 既有文档上，不占新 pending 名额。单 domain ≤8/日 配额按 scope 隔离计数（shared
// 只数 shared；private 只数该 ownerKey），避免别的租户的 private `general` 吃光全服
// shared `general` 的配额。
// **private 按 ownerKey 隔离、影响面只到自己，上述规则完全不作用于 private。**
//
// 契约：`.gateway-work/prod-20260915/MEMORY-INTERFACES.md` §1 §2 §3.1 §3.2。

import { createHash } from "node:crypto";

import { get, list, put } from "@/lib/blob-backend";
import { getGenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────── 类型

export type MemoryScope = "private" | "shared";
export type MemoryType = "user" | "feedback" | "project" | "domain" | "workflow";
export type EvidenceKind = "tool_result" | "user_confirmed" | "verbatim";
export type MemoryStatus = "active" | "retracted" | "pending_review" | "superseded";

/**
 * active shared 文档的内容提案：单账号提交与 live 不同的内容时落在里，
 * 达到跨账号门槛后才提升为 live。提案永不进入 INDEX／召回。
 */
export interface MemoryProposal {
  body: string;
  description: string;
  domain: string;
  type: MemoryType;
  /** 支持该提案的不同账号（去重保序）；同一 ownerKey 只算一人。 */
  contributors: string[];
  updatedAt: string;
}

export interface AgentMemoryDoc {
  id: string;
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
  description: string;
  type: MemoryType;
  body: string;
  links: string[];
  evidence: string;
  evidenceKind: EvidenceKind;
  selfScore: number;
  promptVersion: string;
  batchId: string;
  status: MemoryStatus;
  revision: number;
  /**
   * shared 的跨账号佐证名单（提出者 ownerKey/hashKey，去重保序）。
   * 旧档没有此栏时读取容错为 `[]`；private 恒为 `[]`。
   */
  contributors: string[];
  /**
   * active shared 文档的待佐证内容提案（旧档没有此栏时读取为 undefined）。
   * 只有提升为 live 后才会出现在 INDEX／召回语料中。
   */
  proposed?: MemoryProposal;
  /** 事实开始为真的时间（ISO）；旧档缺栏时读取回落 createdAt。 */
  validFrom?: string;
  /** 事实不再为真的时间（ISO）；未给＝当前仍有效。 */
  validTo?: string;
  /** 观察到该事实的时间（对话／工具结果时间）；旧档缺栏时回落 createdAt。 */
  observedAt?: string;
  /** 来源会话的参考时间（ISO）。 */
  referenceTime?: string;
  /** 被本事实取代的旧 slug 或旧事实文本（最多 5 条）。 */
  supersedes?: string[];
  /** 来源会话 id（审计用，不注入）。 */
  sourceSessionId?: string;
  /** 来源消息 id（可选，审计用，不注入）。 */
  sourceMessageIds?: string[];
  /** 最近一次被确认／重提的时间（ISO）；旧档缺栏时回落 updatedAt。 */
  lastConfirmedAt?: string;
  /** 最近一次被召回使用的时间（ISO；本片只写栏位，不做每回合回写）。 */
  lastUsedAt?: string;
  /** 最近一次写入操作的性质。 */
  lastOperation?: "add" | "update" | "noop" | "supersede";
  createdAt: string;
  updatedAt: string;
}

/** gateway 送来的 doc：id/status/revision/createdAt/updatedAt 由服务端生成。 */
export interface AgentMemoryDocInput {
  scope: MemoryScope;
  ownerKey?: string;
  /** shared 文档的提出者身份（= gateway hashKey），用于跨账号佐证；private 不携带。 */
  contributorKey?: string;
  domain: string;
  slug: string;
  description: string;
  type: MemoryType;
  body: string;
  links?: string[];
  evidence?: string;
  evidenceKind: EvidenceKind;
  selfScore: number;
  promptVersion?: string;
  /** 以下时间／来源栏位均可选；坏类型由 store 宽松清洗为 undefined，不拒绝整条。 */
  validFrom?: string;
  validTo?: string;
  observedAt?: string;
  referenceTime?: string;
  supersedes?: string[];
  sourceSessionId?: string;
  sourceMessageIds?: string[];
}

export type MemoryRejectReason =
  | "duplicate"
  | "quota_scope"
  | "quota_domain"
  | "structure"
  | "retracted"
  | "time_range";

export interface MemoryIngestInput {
  batchId: string;
  promptVersion?: string;
  /**
   * shared 跨账号佐证门槛（不同 contributorKey 数）。缺省
   * `MEMORY_SHARED_CORROBORATION_MIN`；只作用于 shared，private 忽略。
   */
  corroborationMin?: number;
  /**
   * 受控种子导入（仅服务端可信批次）：`true` 且候选自带 `contributorKey` 时，
   * shared 文档的有效佐证门槛视为 1，且允许在 active 已满容量时激活。
   * private 一律忽略（不得绕过任何闸门）；结构校验／G5 去重／slug 冲突更新／
   * retracted 拒绝等其余闸门全部照旧。
   */
  seedMode?: boolean;
  docs: AgentMemoryDocInput[];
  /** 测试注入，生产走当前时间。 */
  now?: Date;
}

export interface MemoryIngestResult {
  /** 真正写入新文档、或把内容提升为 live 的文档 id（「已入库」的唯一口径）。 */
  accepted: string[];
  /**
   * accepted 的可定位引用（id 已改为确定性身份 id，batch 不能用 `${batchId}-${slug}` 推算）。
   * 只有真正进 accepted 的新写入／更新会 push；noop／proposal 不 push。
   */
  acceptedRefs?: Array<{
    id: string;
    batchId?: string;
    scope: MemoryScope;
    ownerKey?: string;
    /** 实际落盘身份（shared 近重复合并时是 target 的 domain/slug）。 */
    domain: string;
    slug: string;
    /** 输入候选的原始身份（未经近重复改写）；batch 抽检／归属应优先用它。 */
    inputDomain: string;
    inputSlug: string;
  }>;
  /**
   * live 内容未变、只新增／累积了未达门槛提案的文档 id（active shared 提案制）。
   * 这些 id 绝不进 `accepted`：提案未发布，不能对外报「已入库」。
   * （可选：旧调用方构造回执时可省略；`ingestMemoryDocs` 恒返回空数组或实名单。）
   */
  proposals?: string[];
  /** 近重复被判定为「已确认同一事实」而只刷新 lastConfirmedAt 的文档 id。 */
  noop?: string[];
  /** 被本次写入取代（status=superseded）的旧文档 slug。 */
  superseded?: string[];
  /**
   * 拒绝明细。能确定候选身份时附带 scope/ownerKey/domain，供 batch 审计按
   * (scope, ownerKey, domain, slug) 精确对帐；早期非候选拒绝可只带 slug。
   */
  rejected: Array<{
    slug: string;
    reason: MemoryRejectReason;
    scope?: MemoryScope;
    ownerKey?: string;
    domain?: string;
  }>;
  /**
   * `seed_accepted`：种子模式下真正实写的文档数（审计用；普通批次恒 0）。
   * `ingestMemoryDocs` 恒返回；可选仅为兼容旧调用方自造回执（同 `proposals` 约定）。
   */
  stats: { received: number; accepted: number; index_lines: number; seed_accepted?: number };
}

export interface MemoryRetractInput {
  batchId?: string;
  docIds?: string[];
}

/** 品质复核翻转动作（PRD §5.6）：pending_review＝转待人工复核；activate＝人工放行回 active。 */
export type MemoryReviewAction = "pending_review" | "activate";

export interface MemoryReviewInput {
  batchId?: string;
  docIds?: string[];
  action: MemoryReviewAction;
  /**
   * 可选 scope 过滤。缺省时：pending_review 默认**只动 shared**（PRD §5.6「private
   * 不自动转 pending，只记 badge」——自动翻转永不碰私有库）；activate 不过滤
   * （人工复核放行，谁是 pending_review 就放谁）。
   */
  scope?: MemoryScope;
}

export interface MemoryReviewResult {
  reviewed: string[];
  action: MemoryReviewAction;
  /**
   * 因平台容量上限未激活的文档 id（仅 activate 动作可能非空）：保持 pending_review，
   * 人工放行不绕过 `MEMORY_SHARED_MAX_ACTIVE_DOCS`。
   */
  blocked?: string[];
}

export interface MemoryScopeInput {
  scope: MemoryScope;
  ownerKey?: string;
  /** 历史查询时点（ISO 或 Date）；给出时按 validFrom/validTo 过滤。 */
  asOf?: string | Date;
  /** 取该 scope 全部非 retracted 文档（含 superseded／过期）。 */
  includeHistory?: boolean;
}

/** catalog：G5 去重与 G7 配额的唯一计数来源（契约 §2 `agent-memory/catalog.json`）。 */
export interface MemoryCatalogEntry {
  id: string;
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
  description: string;
  status: MemoryStatus;
  revision: number;
  /** 跨账号佐证名单（旧 catalog 缺失此栏时读取容错为 `[]`）。 */
  contributors: string[];
  batchId: string;
  createdAt: string;
  updatedAt: string;
  /** 便于索引过滤的时间有效性栏位（旧 catalog 缺省 undefined）。 */
  validFrom?: string;
  validTo?: string;
  lastConfirmedAt?: string;
  /** 合并同 identity 不同 id 时保留的旧 id（history／retract／review 兼容用）。 */
  aliases?: string[];
}

export interface MemoryCatalog {
  version: number;
  /** 目录写入代数；旧档缺省 0（仅审计／兼容，正确性由逐文档日志保证）。 */
  revision?: number;
  /** 聚合快照生成时间（ISO）。 */
  generatedAt?: string;
  /** 上次聚合时已并入快照的日志上传时间上界（epoch ms）。 */
  journalSyncedAt?: number;
  entries: MemoryCatalogEntry[];
}

export const MEMORY_CATALOG_VERSION = 1;
/** G7 配额（契约 §3.1）：单批 shared ≤20；单 ownerKey private ≤10/日；单 domain ≤8/日。 */
export const MEMORY_QUOTA_SHARED_PER_BATCH = 20;
export const MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY = 10;
export const MEMORY_QUOTA_PER_DOMAIN_DAY = 8;
/** G5 去重门槛（契约 §3.1）：description token Jaccard > 0.8 → duplicate。 */
export const MEMORY_DUPLICATE_JACCARD = 0.8;
/**
 * 近重复佐证的**正文兼容**门槛（仅 shared）：description 只用于找候选，正文兼容才是
 * 合并门槛。内容四元组完全相同、或正文 token Jaccard ≥ 0.5 才允许把候选并入既有
 * 文档作为佐证；0.5 是措辞差异容忍度，低于它视为两条独立知识，候选按新文档落盘
 * （绝不「接受后丢弃正文」）。
 */
export const MEMORY_CORROBORATION_BODY_JACCARD = 0.5;
/** shared 跨账号佐证门槛：同一 slug 至少 2 个不同账号提出，才自动 active。 */
export const MEMORY_SHARED_CORROBORATION_MIN = 2;
/** 正整数 env 旋钮：未设定／格式坏／<1 一律回落默认值，读取永不抛错。 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}
/**
 * shared active 文档容量硬线：共享 INDEX 注入每个用户上下文，不能无限膨胀。
 * 缺省 400；可用 env `MEMORY_SHARED_MAX_ACTIVE_DOCS` 覆盖（正整数，坏值回落 400）。
 * 之所以做成旋钮：现网实证 399/400 时所有新 shared 文档只能落 pending，运营侧与
 * 受控种子导入需要不改代码即可调整容量；普通写入路径仍严格受此上限约束。
 */
export const MEMORY_SHARED_MAX_ACTIVE_DOCS = positiveIntEnv(
  "MEMORY_SHARED_MAX_ACTIVE_DOCS",
  400,
);
/** shared pending_review 文档容量硬线：防止跨日累积后批量升级穿透 active 上限。 */
export const MEMORY_SHARED_MAX_PENDING_DOCS = 1000;

/** 小数 env 旋钮：未设定／格式坏／非正数一律回落默认值，读取永不抛错。 */
function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * private 写入时对账（ADD／NOOP／SUPERSEDE）阈值。全部可用 env 覆盖；
 * 故意保持纯确定性（不调 LLM），宁可漏判不误判。
 */
export const MEMORY_RECONCILE_NOOP_JACCARD = positiveNumberEnv(
  "MEMORY_RECONCILE_NOOP_JACCARD",
  0.8,
);
export const MEMORY_RECONCILE_NOOP_BODY_JACCARD = positiveNumberEnv(
  "MEMORY_RECONCILE_NOOP_BODY_JACCARD",
  0.6,
);
export const MEMORY_RECONCILE_CANDIDATE_JACCARD = positiveNumberEnv(
  "MEMORY_RECONCILE_CANDIDATE_JACCARD",
  0.55,
);
export const MEMORY_RECONCILE_SUPERSEDE_JACCARD = positiveNumberEnv(
  "MEMORY_RECONCILE_SUPERSEDE_JACCARD",
  0.35,
);
/** Blob 路径前缀（与 agent-profile-store 同款约定）。 */
export const AGENT_MEMORY_BLOB_PREFIX = "agent-memory";
/** 种子文档缺 promptVersion 时的落盘标记（便于审计区分受控导入与正常批次）。 */
const MEMORY_SEED_PROMPT_VERSION = "seed-local-mem-v1";

// ─────────────────────────── 进程内兜底

const docsMemory = new Map<string, AgentMemoryDoc>();
const catalogMemory = new Map<string, MemoryCatalog>();
const CATALOG_MEMORY_KEY = "catalog";
/** 旧世代正文的进程内副本（纯 Map 模式下 history 仍有数据）。 */
const revisionsMemory = new Map<string, AgentMemoryDoc>();
/** catalog 内存缓存时间戳（毫秒）；TTL 到期才重新 list 日志。 */
let catalogCachedAt = 0;
/** catalog 缓存 TTL：60s（写入路径会立即刷新本进程缓存，不用等 TTL）。 */
const CATALOG_CACHE_TTL_MS = 60_000;
/** 日志 list 分页硬上限（每页 1000；防御性终止，避免病态回圈）。 */
const CATALOG_JOURNAL_MAX_PAGES = 50;

// ─────────────────────────── helper

/** 路径片段净化：只去路径跳脱与分隔符，**保留 CJK**（domain 如「日本动漫」）。 */
function safeSegment(value: string, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[/\\]/g, "-")
    .replace(/\.{2,}/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function sha256Short(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * 文档身份（跨批次／跨进程稳定）：shared 不含 ownerKey；private 含 ownerKey。
 * domain 参与身份，同 slug 不同 domain 视为不同事实。
 */
function memoryIdentity(input: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  const owner = input.scope === "private" ? String(input.ownerKey ?? "") : "";
  return `${input.scope}|${owner}|${input.domain}|${input.slug}`;
}

/** 确定性文档 id：同 identity 在任何进程／批次都得到同一个 id（历史锚定不靠批次号）。 */
function deterministicDocId(input: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  return `mem-${sha256Short(memoryIdentity(input), 16)}`;
}

/**
 * 长键安全化：先净化路径片段并截断 64 字，再追加完整原值的 8 字 hash，
 * 避免「70 个 a 的 batchId」这类超长 docId 截断后撞名（路径逃逸净化保留）。
 */
function hashedSegment(value: string): string {
  const full = String(value ?? "");
  return `${safeSegment(full, "doc").slice(0, 64)}-${sha256Short(full, 8)}`;
}

/** contributors 正规化：去空、去重、保持既有顺序；非阵列（旧档缺栏）视为 `[]`。 */
function normalizeContributors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const key = String(item ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 合并佐证名单：既有顺序在前，新提出者追加（并集、稳定顺序）。next 可为单个 key。 */
function mergeContributors(previous: unknown, next: unknown): string[] {
  const incoming =
    typeof next === "string" ? normalizeContributors([next]) : normalizeContributors(next);
  return normalizeContributors([...normalizeContributors(previous), ...incoming]);
}

/** 内容四元组完全相同才算「幂等重提」；任一不同都视为一次内容变更。 */
function sameContent(
  a: { body: string; description: string; domain: string; type: MemoryType },
  b: { body: string; description: string; domain: string; type: MemoryType },
): boolean {
  return (
    a.body === b.body &&
    a.description === b.description &&
    a.domain === b.domain &&
    a.type === b.type
  );
}

/** 旧档／坏档的 proposed 容错：结构不完整即视为没有提案，不因缺栏报错。 */
function normalizeProposed(value: unknown): MemoryProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<MemoryProposal>;
  if (
    typeof parsed.body !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.domain !== "string" ||
    !TYPES.includes(parsed.type as MemoryType)
  ) {
    return undefined;
  }
  return {
    body: parsed.body,
    description: parsed.description,
    domain: parsed.domain,
    type: parsed.type as MemoryType,
    contributors: normalizeContributors(parsed.contributors),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  };
}

// ─────────────────────────── 时间有效性／审计栏位清洗

/** 时间栏位上限：ISO 字串远短于此，超长视为坏值。 */
const MEMORY_DATE_FIELD_MAX_CHARS = 40;
/** `supersedes` 上限（契约：最多 5 条、每条 ≤200 字）。 */
const MEMORY_SUPERSEDES_MAX = 5;
const MEMORY_SUPERSEDES_MAX_CHARS = 200;
/** 审计 id 上限：会话 id 实际可超过 40 字，故放宽到 200 仍不落大字段进 catalog。 */
const MEMORY_AUDIT_ID_MAX_CHARS = 200;
const MEMORY_AUDIT_IDS_MAX = 20;

/**
 * 日期栏位宽松清洗：只接受可 parse 的字符串；坏值回 undefined（**不拒绝整条**）。
 * 读取旧档时同款调用，确保 Date.parse 不会拿到非字符串。
 */
function normalizeIsoField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MEMORY_DATE_FIELD_MAX_CHARS) return undefined;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
}

function normalizeAuditString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MEMORY_AUDIT_ID_MAX_CHARS) return undefined;
  return text;
}

function normalizeAuditIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = normalizeAuditString(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MEMORY_AUDIT_IDS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/** `supersedes`：接受字串或字串阵列；去重、截断 200 字、最多 5 条。 */
function normalizeSupersedes(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    const capped = text.length > MEMORY_SUPERSEDES_MAX_CHARS
      ? text.slice(0, MEMORY_SUPERSEDES_MAX_CHARS)
      : text;
    if (seen.has(capped)) continue;
    seen.add(capped);
    out.push(capped);
    if (out.length >= MEMORY_SUPERSEDES_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeLastOperation(value: unknown): AgentMemoryDoc["lastOperation"] {
  return value === "add" || value === "update" || value === "noop" || value === "supersede"
    ? value
    : undefined;
}

// ─────────────────────────── 矛盾／替换启发式（纯确定性，不调 LLM）

/** 否定词：任一出现即视为该侧带否定语义（宁可漏判不误判）。 */
const MEMORY_NEGATION_WORDS = [
  "不",
  "没",
  "别",
  "勿",
  "无",
  "非",
  "never",
  "not",
  "don't",
  "doesn't",
  "dislike",
  "hate",
  "avoid",
  "stop",
];
/** 替换词：出现即表示新事实替代旧事实。 */
const MEMORY_REPLACEMENT_WORDS = [
  "改成",
  "改为",
  "换成",
  "不再",
  "改用",
  "instead",
  "from now on",
  "更新为",
  "替换",
];
const MEMORY_RATIO_PATTERN = /比例|宽高比|\d{1,4}[:：]\d{1,4}/;
const MEMORY_RATIO_VALUE_PATTERN = /(\d{1,4})\s*[:：]\s*(\d{1,4})/;

function hasAnyWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function stripWords(text: string, words: string[]): string {
  let out = text.toLowerCase();
  for (const word of words) out = out.split(word).join(" ");
  return out;
}

function ratioValue(text: string): string | null {
  const match = text.match(MEMORY_RATIO_VALUE_PATTERN);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * 事实矛盾判定：否定极性相异、带替换词、或宽高比数值不同且其余内容相近。
 * 只在 token Jaccard ≥ 0.35 时才算——阈值刻意保守，避免把措辞差异误判成矛盾。
 */
function looksContradictory(a: string, b: string): boolean {
  const negA = hasAnyWord(a, MEMORY_NEGATION_WORDS);
  const negB = hasAnyWord(b, MEMORY_NEGATION_WORDS);
  if (
    negA !== negB &&
    memoryJaccard(
      stripWords(a, MEMORY_NEGATION_WORDS),
      stripWords(b, MEMORY_NEGATION_WORDS),
    ) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  ) {
    return true;
  }
  if (
    (hasAnyWord(a, MEMORY_REPLACEMENT_WORDS) || hasAnyWord(b, MEMORY_REPLACEMENT_WORDS)) &&
    memoryJaccard(a, b) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  ) {
    return true;
  }
  if (MEMORY_RATIO_PATTERN.test(a) && MEMORY_RATIO_PATTERN.test(b)) {
    const ratioA = ratioValue(a);
    const ratioB = ratioValue(b);
    if (
      ratioA !== null &&
      ratioB !== null &&
      ratioA !== ratioB &&
      memoryJaccard(
        a.replace(MEMORY_RATIO_VALUE_PATTERN, " "),
        b.replace(MEMORY_RATIO_VALUE_PATTERN, " "),
      ) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
    ) {
      return true;
    }
  }
  return false;
}

/** 新正文带替换词且两正文相近 → 新事实取代旧事实。 */
function looksReplacement(a: string, b: string): boolean {
  return (
    hasAnyWord(b, MEMORY_REPLACEMENT_WORDS) &&
    memoryJaccard(a, b) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  );
}

function bodyKey(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/${safeSegment(domain, "general")}/${safeSegment(slug, "doc")}.json`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/${safeSegment(domain, "general")}/${safeSegment(slug, "doc")}.json`;
}

/** 旧版 private 正文路径（不含 domain）：只读兼容，写入一律走 `bodyKey`。 */
function legacyPrivateBodyKey(ownerKey: string | undefined, slug: string): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/${safeSegment(slug, "doc")}.json`;
}

function indexKey(scope: MemoryScope, ownerKey?: string): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/INDEX.md`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/INDEX.md`;
}

function catalogKey(): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/catalog.json`;
}

/** 逐文档 catalog 日志（每条目一个文件；并发写不同 doc 不共享文件）。 */
const CATALOG_JOURNAL_PREFIX = `${AGENT_MEMORY_BLOB_PREFIX}/catalog/`;

function catalogEntryKey(entry: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  // 按 identity 落文件：两个进程并发写同一 slug 时写的是同一个文件（最后写者胜），
  // 不会产生两个同 identity 的条目文件。
  return `${CATALOG_JOURNAL_PREFIX}${sha256Short(memoryIdentity(entry), 16)}.json`;
}

/** 旧世代正文存档键（docId 加短 hash，避免超长 id 截断后撞名）。 */
function revisionKey(docId: string, revision: number): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/revisions/${hashedSegment(docId)}-r${revision}.json`;
}

/** 旧版存档键（无短 hash）：只用于读取兼容，不用于新写入。 */
function legacyRevisionKey(docId: string, revision: number): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/revisions/${safeSegment(docId, "doc")}-r${revision}.json`;
}

/** 兼容两条 blob 后端读文本：Vercel 返回 { blob }，VPS 返回 { stream }。 */
async function readBlobText(
  result: Awaited<ReturnType<typeof get>> | null,
): Promise<string | null> {
  if (!result) return null;
  const anyResult = result as unknown as { blob?: Blob; stream?: ReadableStream<Uint8Array> | null };
  if (anyResult.blob) return await anyResult.blob.text();
  if (anyResult.stream) {
    const reader = anyResult.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(new Uint8Array(Buffer.concat(chunks as Buffer[])));
  }
  return null;
}

/** 读 blob 文本；任何失败回 null（由调用方回退 Map）。 */
async function readBlobTextAt(key: string): Promise<string | null> {
  try {
    const result = await get(key, { access: "private" }).catch(() => null);
    if (!result) return null;
    // VPS adapter 的 get() 在 404 时仍回非空结果（statusCode=404，stream 是错误响应体）。
    // 非 2xx 一律视为不存在，绝不把错误 JSON 当正文解析。Vercel 结果无此栏 → 照旧。
    const statusCode = (result as unknown as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) {
      return null;
    }
    return await readBlobText(result);
  } catch {
    return null;
  }
}

async function readBlobJson<T>(key: string): Promise<T | null> {
  const text = await readBlobTextAt(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 写文本到 blob；失败静默（调用方另有 Map 兜底）。 */
async function writeBlobText(key: string, text: string): Promise<boolean> {
  try {
    await put(key, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── 文本切分与 Jaccard（契约 §7，零依赖）

/** token 化：ASCII 词按空白+标点切；CJK 按 bigram。 */
export function memoryTokens(text: string): string[] {
  const source = String(text ?? "");
  const tokens: string[] = [];
  tokens.push(...(source.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const runs =
    source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens;
}

/** token Jaccard 相似度；任一侧无 token 时回 0（不视为重复）。 */
export function memoryJaccard(a: string, b: string): number {
  const setA = new Set(memoryTokens(a));
  const setB = new Set(memoryTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

// ─────────────────────────── Postgres 路径（未启用）

/** 探测 Postgres 是否可用（沿用基底：getGenerationSql 抛错即视为不可用）。 */
function dbAvailable(): boolean {
  try {
    getGenerationSql();
    return true;
  } catch {
    return false;
  }
}

/** 诊断用：本进程是否探测到 Postgres。写入一律 blob/Map（契约 §0）。 */
export function memoryStoreDbBackendAvailable(): boolean {
  return dbAvailable();
}

// ─────────────────────────── catalog

/**
 * catalog 写入串行化（进程内 promise 链）：blob 的 read-modify-write 天然有竞态，
 * `revision` 只是跨进程检测手段；同一进程内由本锁保证三个写入口（ingest／retract／
 * review）不会互相覆盖。锁任何时刻只包「整个函数体」，不把锁泄漏给调用方。
 */
let catalogLock: Promise<unknown> = Promise.resolve();

function withCatalogLock<T>(work: () => Promise<T>): Promise<T> {
  // 前一个任务失败也要继续跑下一个；链上只保留已吞错的 promise，避免 unhandled rejection。
  const run = catalogLock.then(work, work);
  catalogLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** catalog 条目正规化（snapshot 与逐文档日志共用；旧档缺栏不报错）。 */
function normalizeCatalogEntry(raw: MemoryCatalogEntry): MemoryCatalogEntry {
  const entry = (raw ?? {}) as MemoryCatalogEntry;
  return {
    ...entry,
    revision:
      typeof entry.revision === "number" && Number.isFinite(entry.revision)
        ? entry.revision
        : 0,
    contributors: normalizeContributors(
      (entry as unknown as { contributors?: unknown })?.contributors,
    ),
    validFrom: normalizeIsoField((entry as unknown as { validFrom?: unknown })?.validFrom),
    validTo: normalizeIsoField((entry as unknown as { validTo?: unknown })?.validTo),
    lastConfirmedAt: normalizeIsoField(
      (entry as unknown as { lastConfirmedAt?: unknown })?.lastConfirmedAt,
    ),
    aliases: normalizeAuditIdList((entry as unknown as { aliases?: unknown })?.aliases),
  };
}

interface CatalogJournalRead {
  entries: MemoryCatalogEntry[];
  maxUploadedAt: number;
  ok: boolean;
}

/**
 * 分页读逐文档 catalog 日志：只 get `uploadedAt > sinceMs` 的条目（无快照时 sinceMs=0
 * 即全量）。list 失败返回 ok=false，调用方保留缓存／快照，绝不把失败当「目录为空」。
 */
async function readCatalogJournal(sinceMs: number): Promise<CatalogJournalRead> {
  const entries: MemoryCatalogEntry[] = [];
  let maxUploadedAt = 0;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < CATALOG_JOURNAL_MAX_PAGES; page += 1) {
      const result = await list({
        prefix: CATALOG_JOURNAL_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
      for (const blob of blobs) {
        const uploadedMs =
          blob.uploadedAt instanceof Date
            ? blob.uploadedAt.getTime()
            : Date.parse(String(blob.uploadedAt));
        if (Number.isFinite(uploadedMs)) maxUploadedAt = Math.max(maxUploadedAt, uploadedMs);
        // 只用不早于快照水位的日志；用 `>=` 是为了避免「list 快照同毫秒写入」
        // 被水位线永久跳过（边界条目每次刷新重读一次，合并按 identity 幂等）。
        if (!(uploadedMs >= sinceMs)) continue;
        const pathname = typeof blob.pathname === "string" ? blob.pathname : "";
        if (!pathname) continue;
        const parsed = await readBlobJson<MemoryCatalogEntry>(pathname);
        if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") continue;
        entries.push(normalizeCatalogEntry(parsed));
      }
      if (!result?.hasMore || !result?.cursor) {
        return { entries, maxUploadedAt, ok: true };
      }
      cursor = result.cursor;
    }
    // 分页上限内仍未列完：**不推进 watermark**（ok=false），避免把未读条目永久跳过。
    return { entries, maxUploadedAt: 0, ok: false };
  } catch {
    return { entries: [], maxUploadedAt: 0, ok: false };
  }
}

/**
 * 按 **identity** 合并去重：同 scope/ownerKey/domain/slug 只保留一条，
 * `updatedAt` 较新者胜（同值取后写入者，保留其 id）。旧数据里同 identity 不同 id 的
 * 重复条目会合并成一条；被淘汰的旧 id 进入 `aliases`，旧 id 仍可查 history/retract/review。
 */
function mergeCatalogEntries(
  groups: Array<MemoryCatalogEntry[]>,
): MemoryCatalogEntry[] {
  const byIdentity = new Map<string, MemoryCatalogEntry>();
  const order: string[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (!entry || typeof entry.id !== "string") continue;
      const identity = memoryIdentity(entry);
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, entry);
        order.push(identity);
        continue;
      }
      const winner =
        String(entry.updatedAt) >= String(existing.updatedAt) ? entry : existing;
      const loser = winner === entry ? existing : entry;
      const aliases = normalizeAuditIdList([
        ...(winner.aliases ?? []),
        ...(loser.aliases ?? []),
        loser.id,
      ])?.filter((id) => id !== winner.id);
      byIdentity.set(
        identity,
        aliases && aliases.length > 0 ? { ...winner, aliases } : winner,
      );
    }
  }
  return order
    .map((identity) => byIdentity.get(identity))
    .filter((entry): entry is MemoryCatalogEntry => Boolean(entry));
}

/** 按 id 或 aliases 找条目（合并后旧 id 仍可定位）。 */
function findCatalogEntryByIdOrAlias(
  catalog: MemoryCatalog,
  id: string,
): MemoryCatalogEntry | null {
  return (
    catalog.entries.find(
      (entry) => entry.id === id || (entry.aliases ?? []).includes(id),
    ) ?? null
  );
}

/** 条目是否被指定的 docIds 命中（含旧 id alias）。 */
function entryMatchesIds(
  entry: MemoryCatalogEntry,
  docIds: Set<string>,
): boolean {
  if (docIds.has(entry.id)) return true;
  return (entry.aliases ?? []).some((alias) => docIds.has(alias));
}

/**
 * 读目录：内存缓存 60s TTL；刷新时以 `catalog.json` 聚合快照为底，再分页 list
 * `agent-memory/catalog/` 逐文档日志，只 get 比快照 `journalSyncedAt` 更新的条目，
 * 按 id（updatedAt 较新者胜）合并。合并后 journalSyncedAt 推进到本次 list 的最大
 * uploadedAt，并把聚合快照 best-effort 写回。
 *
 * 正确性不依赖快照：并发进程各写自己的条目文件，任何一次刷新都能把两边合起来。
 */
async function loadCatalog(): Promise<MemoryCatalog> {
  const cached = catalogMemory.get(CATALOG_MEMORY_KEY);
  const now = Date.now();
  if (cached && now - catalogCachedAt < CATALOG_CACHE_TTL_MS) return cached;

  const snapshotRaw = await readBlobJson<MemoryCatalog>(catalogKey());
  const snapshotEntries =
    snapshotRaw && Array.isArray(snapshotRaw.entries)
      ? snapshotRaw.entries.map(normalizeCatalogEntry)
      : [];
  const snapshotSyncedAt =
    snapshotRaw &&
    typeof snapshotRaw.journalSyncedAt === "number" &&
    Number.isFinite(snapshotRaw.journalSyncedAt)
      ? Math.max(0, Math.floor(snapshotRaw.journalSyncedAt))
      : 0;
  const journal = await readCatalogJournal(snapshotSyncedAt);

  // 后端完全不可达且本进程已有缓存：保留缓存（Map 兜底），只续 TTL。
  if (!snapshotRaw && !journal.ok && cached && journal.entries.length === 0) {
    catalogCachedAt = now;
    return cached;
  }

  const snapshotRevision =
    snapshotRaw && typeof snapshotRaw.revision === "number" && Number.isFinite(snapshotRaw.revision)
      ? Math.max(0, Math.floor(snapshotRaw.revision))
      : 0;
  const next: MemoryCatalog = {
    version: MEMORY_CATALOG_VERSION,
    revision: Math.max(snapshotRevision, cached?.revision ?? 0),
    journalSyncedAt: journal.ok
      ? Math.max(snapshotSyncedAt, journal.maxUploadedAt)
      : snapshotSyncedAt,
    generatedAt: new Date().toISOString(),
    // 缓存条目也并入：本进程写入但 blob 落盘失败／快照被覆盖时仍可保留（journal 较新者胜）。
    entries: mergeCatalogEntries([
      snapshotEntries,
      journal.entries,
      cached?.entries ?? [],
    ]),
  };
  catalogMemory.set(CATALOG_MEMORY_KEY, next);
  catalogCachedAt = now;
  // 聚合快照 best-effort：失败不影响真相（逐文档日志仍在）。
  if (journal.ok) void writeBlobText(catalogKey(), JSON.stringify(next));
  return next;
}

/**
 * 保存聚合快照（best-effort）。正确性由逐文档日志保证，这里的 revision 只作审计／
 * 兼容；不再依赖 re-read+merge 防覆盖。`expectedRevision` 保留为签名兼容。
 *
 * 写失败只 console.error（不回显正文、不 throw）并照旧更新进程缓存。
 */
async function saveCatalog(
  catalog: MemoryCatalog,
  expectedRevision?: number,
): Promise<void> {
  const currentRevision =
    typeof catalog.revision === "number" && Number.isFinite(catalog.revision)
      ? Math.max(0, Math.floor(catalog.revision))
      : 0;
  const expected =
    typeof expectedRevision === "number" && Number.isFinite(expectedRevision)
      ? Math.max(0, Math.floor(expectedRevision))
      : currentRevision;

  const next: MemoryCatalog = {
    version: MEMORY_CATALOG_VERSION,
    revision: Math.max(currentRevision, expected) + 1,
    journalSyncedAt:
      typeof catalog.journalSyncedAt === "number" &&
      Number.isFinite(catalog.journalSyncedAt)
        ? Math.max(0, Math.floor(catalog.journalSyncedAt))
        : 0,
    generatedAt: new Date().toISOString(),
    // 快照也按 identity 去重，避免并发／旧数据把重复条目写回快照。
    entries: mergeCatalogEntries([catalog.entries]),
  };
  const ok = await writeBlobText(catalogKey(), JSON.stringify(next));
  if (!ok) {
    console.error("[agent-memory-store] catalog 写入失败（已用进程内缓存兜底）");
  }
  catalogMemory.set(CATALOG_MEMORY_KEY, next);
  catalogCachedAt = Date.now();
}

/** 条目变化时写它自己的日志文件（并发写不同 doc 不共享文件）。失败静默。 */
async function writeCatalogEntry(entry: MemoryCatalogEntry): Promise<void> {
  await writeBlobText(catalogEntryKey(entry), JSON.stringify(entry));
}

/** 仅测试：重置进程内状态。 */
export function __resetAgentMemoryStoreForTests(): void {
  docsMemory.clear();
  catalogMemory.clear();
  revisionsMemory.clear();
  catalogCachedAt = 0;
}

// ─────────────────────────── 读写正文

/**
 * blob 读回正文的形状防线：后端错误响应体（如 404 JSON）也可能被 JSON.parse 成普通
 * 对象。只有「普通对象 + 身份三件套（scope/domain/slug）全对 + 合法 status」才算真
 * 文档，任一不符一律当不存在（调用方据此回退，绝不把错误体当 live 文档）。
 */
function isDocShapeValid(
  value: unknown,
  scope: MemoryScope,
  domain: string,
  slug: string,
): value is AgentMemoryDoc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    doc.slug === slug &&
    doc.domain === domain &&
    doc.scope === scope &&
    (doc.status === "active" ||
      doc.status === "pending_review" ||
      doc.status === "retracted" ||
      doc.status === "superseded")
  );
}

async function readDoc(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): Promise<AgentMemoryDoc | null> {
  const key = bodyKey(scope, ownerKey, domain, slug);
  const cached = docsMemory.get(key);
  if (cached) return cached;
  // 先读新 key（private 已含 domain）；不存在再回落旧路径（只读兼容）。
  let parsed = await readBlobJson<AgentMemoryDoc>(key);
  if (!parsed && scope === "private") {
    parsed = await readBlobJson<AgentMemoryDoc>(legacyPrivateBodyKey(ownerKey, slug));
  }
  if (parsed) {
    if (!isDocShapeValid(parsed, scope, domain, slug)) {
      // 错误体不得进入进程缓存（避免后续读取继续被污染）。
      docsMemory.delete(key);
      return null;
    }
    // 旧档没有 contributors 栏：读取容错为 []，且**不因缺栏降级既有 status**。
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const doc: AgentMemoryDoc = {
      ...parsed,
      contributors: normalizeContributors(
        (parsed as unknown as { contributors?: unknown })?.contributors,
      ),
      // 旧档没有 proposed：保持 undefined；坏形状视为无提案（不丢 live 内容）。
      proposed: normalizeProposed((parsed as unknown as { proposed?: unknown })?.proposed),
      // 时间栏位读取容错（不因缺栏改 status）：validFrom／observedAt 回落 createdAt，
      // lastConfirmedAt 回落 updatedAt；坏值视为 undefined 交给有效性判定。
      validFrom: normalizeIsoField(parsed.validFrom) ?? (createdAt || undefined),
      validTo: normalizeIsoField(parsed.validTo),
      observedAt: normalizeIsoField(parsed.observedAt) ?? (createdAt || undefined),
      referenceTime: normalizeIsoField(parsed.referenceTime),
      lastConfirmedAt: normalizeIsoField(parsed.lastConfirmedAt) ?? (updatedAt || undefined),
      lastUsedAt: normalizeIsoField(parsed.lastUsedAt),
      supersedes: normalizeSupersedes(parsed.supersedes),
      sourceSessionId: normalizeAuditString(parsed.sourceSessionId),
      sourceMessageIds: normalizeAuditIdList(parsed.sourceMessageIds),
      lastOperation: normalizeLastOperation(parsed.lastOperation),
    };
    docsMemory.set(key, doc);
    return doc;
  }
  return null;
}

async function writeDoc(doc: AgentMemoryDoc): Promise<void> {
  const key = bodyKey(doc.scope, doc.ownerKey, doc.domain, doc.slug);
  await writeBlobText(key, JSON.stringify(doc));
  docsMemory.set(key, doc);
}

/** 旧世代正文存档（契约 §2 `agent-memory/revisions/{id}-r{n}.json`）。 */
async function writeRevision(previous: AgentMemoryDoc): Promise<void> {
  const key = revisionKey(previous.id, previous.revision);
  // 纯 Map 模式（本机无 blob 凭证）下 history 也要有资料。
  revisionsMemory.set(key, previous);
  await writeBlobText(key, JSON.stringify(previous));
}

// ─────────────────────────── 结构校验（形状防线；G1 在 gateway）

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const SCOPES: MemoryScope[] = ["private", "shared"];
const TYPES: MemoryType[] = ["user", "feedback", "project", "domain", "workflow"];
const EVIDENCE_KINDS: EvidenceKind[] = ["tool_result", "user_confirmed", "verbatim"];

function isStructurallyValid(input: AgentMemoryDocInput): boolean {
  if (!SCOPES.includes(input?.scope)) return false;
  if (!SLUG_PATTERN.test(String(input?.slug ?? ""))) return false;
  const domain = String(input?.domain ?? "");
  if (!domain.trim()) return false;
  // INDEX 是「一行一条」：domain/description 含换行会造成伪造行注入，直接拒绝。
  if (/[\r\n]/.test(domain)) return false;
  if (typeof input?.description !== "string") return false;
  if (input.description.length === 0 || input.description.length > 120) return false;
  if (/[\r\n]/.test(input.description)) return false;
  if (typeof input?.body !== "string") return false;
  if (input.body.length === 0 || input.body.length > 2000) return false;
  if (!TYPES.includes(input?.type)) return false;
  if (!EVIDENCE_KINDS.includes(input?.evidenceKind)) return false;
  if (typeof input?.selfScore !== "number" || !Number.isFinite(input.selfScore)) return false;
  if (input.scope === "private" && !String(input.ownerKey ?? "").trim()) return false;
  return true;
}

// ─────────────────────────── 索引

/** 单行字段清洗：换行→空格、连续空白折叠、trim（兼容历史脏数据，防伪造行）。 */
function lineSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 索引文本（契约 §2，一行一条）：
 * `- [domain] slug — description （v{revision}）`
 */
export function buildMemoryIndexMd(
  scope: MemoryScope,
  docs: AgentMemoryDoc[],
  ownerKey?: string,
): string {
  const scoped =
    scope === "private" && ownerKey ? docs.filter((doc) => doc.ownerKey === ownerKey) : docs;
  return [...scoped]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug))
    .map(
      (doc) =>
        `- [${lineSafe(doc.domain)}] ${lineSafe(doc.slug)} — ${lineSafe(doc.description)} （v${doc.revision}）`,
    )
    .join("\n");
}

/**
 * 领域摘要（可选前置到 INDEX，默认关闭）：按 domain 分组输出
 * `- [domain] 共N条 — desc1；desc2；desc3`；每条 desc 截 60 字、最多 3 条，
 * 总长不超过 maxChars。只做确定性字符串拼接，不调 LLM。
 */
export function buildMemoryDomainDigestMd(
  docs: AgentMemoryDoc[],
  maxChars = 600,
): string {
  const groups = new Map<string, AgentMemoryDoc[]>();
  for (const doc of docs) {
    // 分组也按清洗后的 domain，避免脏数据把同一领域拆成多行。
    const domain = lineSafe(doc.domain);
    const list = groups.get(domain);
    if (list) list.push(doc);
    else groups.set(domain, [doc]);
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 600;
  const lines: string[] = [];
  let used = 0;
  for (const domain of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = groups.get(domain) ?? [];
    const descriptions = group
      .slice(0, 3)
      .map((doc) => {
        const safe = lineSafe(doc.description);
        const chars = Array.from(safe);
        return chars.length > 60 ? chars.slice(0, 60).join("") : safe;
      })
      .join("；");
    const line = `- [${domain}] 共${group.length}条 — ${descriptions}`;
    if (used + line.length > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  const text = lines.join("\n");
  return text.length > limit ? text.slice(0, limit) : text;
}

function sameScope(
  entry: { scope: MemoryScope; ownerKey?: string },
  scope: MemoryScope,
  ownerKey: string | undefined,
): boolean {
  return entry.scope === scope && (scope === "shared" || entry.ownerKey === ownerKey);
}

function activeSharedCount(catalog: MemoryCatalog): number {
  return catalog.entries.filter(
    (entry) => entry.scope === "shared" && entry.status === "active",
  ).length;
}

/** catalog 中当前 pending_review shared 文档数（pending 上限的唯一计数来源）。 */
function pendingSharedCount(catalog: MemoryCatalog): number {
  return catalog.entries.filter(
    (entry) => entry.scope === "shared" && entry.status === "pending_review",
  ).length;
}

/**
 * 近重复佐证候选（仅 shared）：精确 slug 未命中时，为「同一知识的不同措辞」找既有
 * 文档作为本次写入目标。条件：shared、active|pending_review、同 domain、
 * description token Jaccard > `MEMORY_DUPLICATE_JACCARD`（0.8）。
 *
 * 取舍：0.8 直接复用既有 G5 去重门槛，代价是「相似但不同」的知识可能被并成同一条
 * （误合并面）；domain 必须完全相同是第二道约束，把误合并面收窄到同一知识域。多命中
 * 时取相似度最高者，避免 catalog 顺序影响结果。
 */
function findCorroborationEntry(
  entries: MemoryCatalogEntry[],
  candidate: AgentMemoryDocInput,
): MemoryCatalogEntry | null {
  let best: MemoryCatalogEntry | null = null;
  let bestScore = MEMORY_DUPLICATE_JACCARD;
  for (const entry of entries) {
    if (entry.scope !== "shared") continue;
    if (entry.status !== "active" && entry.status !== "pending_review") continue;
    if (entry.domain !== candidate.domain) continue;
    const score = memoryJaccard(entry.description, candidate.description);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 进入 active 的唯一容量闸（**所有路径**共用：新建达门槛、pending 合并达门槛、
 * proposed 提升、人工 review activate）。`alreadyActive`＝该文档本来就在 active，提案
 * 提升不增加 active 数，故直接放行；其余情况必须 activeSharedCount <
 * MEMORY_SHARED_MAX_ACTIVE_DOCS。人工放行不绕过此上限。
 */
function canActivateShared(catalog: MemoryCatalog, alreadyActive = false): boolean {
  if (alreadyActive) return true;
  return activeSharedCount(catalog) < MEMORY_SHARED_MAX_ACTIVE_DOCS;
}

// ─────────────────────────── 时间有效性（单一真源）

/** 时间栏位 → epoch ms；不可 parse 回 undefined（调用方视为「无边界」）。 */
function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 当前有效性：status=active 且 validFrom<=now 且（无 validTo 或 validTo>now）。 */
export function isMemoryCurrentlyValid(doc: AgentMemoryDoc, nowMs: number): boolean {
  if (doc.status !== "active") return false;
  const fromMs = timeMs(doc.validFrom) ?? timeMs(doc.createdAt);
  if (fromMs !== undefined && fromMs > nowMs) return false;
  if (doc.validTo) {
    const toMs = timeMs(doc.validTo);
    if (toMs !== undefined && toMs <= nowMs) return false;
  }
  return true;
}

/** 历史时点有效性：validFrom<=asOf 且（无 validTo 或 validTo>asOf）。 */
function isMemoryValidAt(doc: AgentMemoryDoc, asOfMs: number): boolean {
  const fromMs = timeMs(doc.validFrom) ?? timeMs(doc.createdAt);
  if (fromMs !== undefined && fromMs > asOfMs) return false;
  if (doc.validTo) {
    const toMs = timeMs(doc.validTo);
    if (toMs !== undefined && toMs <= asOfMs) return false;
  }
  return true;
}

/** 时间区间自检：两端都可 parse 且 validTo <= validFrom 视为空区间／非法。 */
function hasInvalidTimeRange(fromIso?: string, toIso?: string): boolean {
  if (!fromIso || !toIso) return false;
  const fromMs = timeMs(fromIso);
  const toMs = timeMs(toIso);
  return fromMs !== undefined && toMs !== undefined && toMs <= fromMs;
}

interface ScopedDocsOptions {
  asOf?: number;
  includeHistory?: boolean;
}

/**
 * 按 scope 取文档的唯一入口（listMemoryDocs／activeDocs／读索引共用）：
 * - 默认：只取 status=active 且当前有效的文档。
 * - `asOf`：取该时点有效的文档（validFrom <= asOf < validTo）；retracted 排除，
 *   superseded 可包含（它是历史事实）；pending_review 从未发布，不进入历史索引。
 * - `includeHistory`：取该 scope 全部非 retracted 文档（含 superseded／过期／pending）。
 */
async function scopedDocs(
  scope: MemoryScope,
  ownerKey?: string,
  opts: ScopedDocsOptions = {},
): Promise<AgentMemoryDoc[]> {
  const catalog = await loadCatalog();
  const nowMs = Date.now();
  const asOfMs = typeof opts.asOf === "number" && Number.isFinite(opts.asOf) ? opts.asOf : undefined;
  const includeHistory = opts.includeHistory === true;
  const docs: AgentMemoryDoc[] = [];
  for (const entry of catalog.entries) {
    if (!sameScope(entry, scope, ownerKey)) continue;
    if (includeHistory) {
      if (entry.status === "retracted") continue;
    } else if (asOfMs !== undefined) {
      if (entry.status === "retracted" || entry.status === "pending_review") continue;
    } else if (entry.status !== "active") {
      continue;
    }
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc) continue;
    if (includeHistory) {
      if (doc.status === "retracted") continue;
      docs.push(doc);
      continue;
    }
    if (asOfMs !== undefined) {
      if (doc.status === "retracted" || doc.status === "pending_review") continue;
      if (!isMemoryValidAt(doc, asOfMs)) continue;
      docs.push(doc);
      continue;
    }
    if (!isMemoryCurrentlyValid(doc, nowMs)) continue;
    docs.push(doc);
  }
  return docs;
}

/** 读某 scope 的全部 active 正文（由 catalog 驱动，不依赖 blob list）。 */
async function activeDocs(scope: MemoryScope, ownerKey?: string): Promise<AgentMemoryDoc[]> {
  return scopedDocs(scope, ownerKey);
}

/** catalog 条目级有效性（不读正文）：用于 INDEX 集合对账。 */
function isCatalogEntryCurrentlyValid(entry: MemoryCatalogEntry, nowMs: number): boolean {
  if (entry.status !== "active") return false;
  const fromMs = timeMs(entry.validFrom) ?? timeMs(entry.createdAt);
  if (fromMs !== undefined && fromMs > nowMs) return false;
  if (entry.validTo) {
    const toMs = timeMs(entry.validTo);
    if (toMs !== undefined && toMs <= nowMs) return false;
  }
  return true;
}

function indexEntryKey(domain: string, slug: string): string {
  return `${domain}\u0000${slug}`;
}

/** 当前应出现在 INDEX 里的条目集合（status=active 且时间有效；按 domain+slug 去重）。 */
function expectedIndexKeys(
  entries: MemoryCatalogEntry[],
  scope: MemoryScope,
  ownerKey: string | undefined,
  nowMs: number,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!sameScope(entry, scope, ownerKey)) continue;
    if (!isCatalogEntryCurrentlyValid(entry, nowMs)) continue;
    keys.add(indexEntryKey(entry.domain, entry.slug));
  }
  return keys;
}

/** 从持久化 INDEX 行解析 `- [domain] slug — …`；兼容行尾 `（vN）`。 */
function persistedIndexKeys(md: string): Set<string> {
  const keys = new Set<string>();
  for (const line of md.split("\n")) {
    const match = line.match(/^- \[(.*?)\] (\S+) —/);
    if (match) keys.add(indexEntryKey(match[1], match[2]));
  }
  return keys;
}

function sameIndexKeySet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** 重建 INDEX.md（active docs）。回传重建后的行数。 */
async function rebuildIndex(scope: MemoryScope, ownerKey?: string): Promise<number> {
  const docs = await activeDocs(scope, ownerKey);
  const md = buildMemoryIndexMd(scope, docs, ownerKey);
  await writeBlobText(indexKey(scope, ownerKey), md);
  return docs.length;
}

// ─────────────────────────── 对外 API

/**
 * 列出某 scope 的文档。默认＝当前有效的 active docs；`asOf` 给定时按该时点过滤；
 * `includeHistory` 取全部非 retracted（含 superseded／过期）。private 缺 ownerKey 回空。
 */
export async function listMemoryDocs(input: MemoryScopeInput): Promise<AgentMemoryDoc[]> {
  const scope: MemoryScope = input?.scope === "private" ? "private" : "shared";
  if (scope === "private" && !String(input?.ownerKey ?? "").trim()) return [];
  const asOfMs = timeMs(input?.asOf);
  const docs = await scopedDocs(scope, input?.ownerKey, {
    asOf: asOfMs,
    includeHistory: input?.includeHistory === true,
  });
  return docs.sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug));
}

/**
 * 读某 scope 的索引文本；无索引时空字符串。
 * - 默认：沿用既有 INDEX.md（写入时由 rebuildIndex 维护），但先做**集合对账**——
 *   用 catalog 条目算「当前应出现的 active 集合（domain+slug）」与持久化 INDEX 解析出的
 *   集合比较，不等就即时从正文重建。这样未来 `validFrom` 到点、`validTo` 过期、
 *   或同一刻一进一出（行数不变但集合变了）时索引都能自愈。
 * - `asOf`：按该时点从正文即时构建（历史索引，不读当前 INDEX.md）。
 * - env `MEMORY_INDEX_DIGEST === "1"`：口径不同，直接重建并前置领域摘要。
 */
export async function readMemoryIndexMd(
  scope: MemoryScope,
  ownerKey?: string,
  asOf?: string | Date,
): Promise<string> {
  const asOfMs = timeMs(asOf);
  const digestEnabled = process.env.MEMORY_INDEX_DIGEST === "1";
  if (asOfMs === undefined && !digestEnabled) {
    const fromBlob = await readBlobTextAt(indexKey(scope, ownerKey));
    if (fromBlob !== null) {
      // 集合对账（不是行数）：同一刻「一条过期 + 一条生效」行数不变，但集合不同。
      const catalog = await loadCatalog();
      const expected = expectedIndexKeys(catalog.entries, scope, ownerKey, Date.now());
      if (sameIndexKeySet(expected, persistedIndexKeys(fromBlob))) return fromBlob;
    }
  }
  const docs = await scopedDocs(scope, ownerKey, asOfMs === undefined ? {} : { asOf: asOfMs });
  const md = buildMemoryIndexMd(scope, docs, ownerKey);
  if (!digestEnabled) return md;
  const digest = buildMemoryDomainDigestMd(docs);
  return digest ? `${digest}\n${md}` : md;
}

/**
 * promptVersion 落盘值：普通文档保持既有 `candidate ?? input ?? "v1"` 语义不变；
 * 种子文档在两者都为空（含空字符串）时落 `seed-local-mem-v1`，便于审计区分。
 */
function resolvePromptVersion(
  candidate: AgentMemoryDocInput,
  input: MemoryIngestInput,
  seedDoc: boolean,
): string {
  if (seedDoc) {
    const explicit = candidate.promptVersion ?? input?.promptVersion;
    const value = typeof explicit === "string" ? explicit.trim() : "";
    return value !== "" ? value : MEMORY_SEED_PROMPT_VERSION;
  }
  return String(candidate.promptVersion ?? input?.promptVersion ?? "v1");
}

/**
 * private 写入对账候选（仅同一 ownerKey 的 active 文档）：
 * - 候选自带 `supersedes`：先按 slug 精确命中，再按 body/description Jaccard ≥0.6 找。
 * - 否则按 description Jaccard ≥0.55 且 body Jaccard ≥0.35 取 top-1，再用纯启发式
 *   判断「矛盾／替换」是否成立；成立＝SUPERSEDE，不成立再看是否 NOOP。
 * 返回 null 表示正常 ADD。全程不调 LLM，宁可漏判不误判。
 */
interface PrivateReconcileMatch {
  entry: MemoryCatalogEntry;
  doc: AgentMemoryDoc;
  mode: "supersede" | "noop";
}

async function findPrivateReconcileMatch(
  entries: MemoryCatalogEntry[],
  candidate: AgentMemoryDocInput,
  ownerKey: string,
): Promise<PrivateReconcileMatch | null> {
  const activeEntries = entries.filter(
    (entry) =>
      entry.scope === "private" &&
      entry.ownerKey === ownerKey &&
      entry.status === "active" &&
      // 跨 domain 不 supersede（同 slug 不同 domain 是两条独立事实）。
      entry.domain === candidate.domain,
  );
  if (activeEntries.length === 0) return null;
  const loaded: Array<{ entry: MemoryCatalogEntry; doc: AgentMemoryDoc }> = [];
  for (const entry of activeEntries) {
    const doc = await readDoc("private", ownerKey, entry.domain, entry.slug);
    if (doc && doc.status === "active") loaded.push({ entry, doc });
  }
  if (loaded.length === 0) return null;

  // 显式 supersedes：只走这条路，找不到就正常 ADD（不再做隐式推断）。
  const explicit = normalizeSupersedes(candidate.supersedes);
  if (explicit) {
    for (const token of explicit) {
      const bySlug = loaded.find((item) => item.entry.slug === token);
      if (bySlug) return { ...bySlug, mode: "supersede" };
      let best: { entry: MemoryCatalogEntry; doc: AgentMemoryDoc } | null = null;
      let bestScore = 0;
      for (const item of loaded) {
        const score = Math.max(
          memoryJaccard(item.doc.body, token),
          memoryJaccard(item.doc.description, token),
        );
        if (score >= 0.6 && (!best || score > bestScore)) {
          best = item;
          bestScore = score;
        }
      }
      if (best) return { ...best, mode: "supersede" };
    }
    return null;
  }

  // 隐式：description 找候选（≥0.55），正文相似度 ≥0.35 才有资格被判为同一事实。
  let top: { entry: MemoryCatalogEntry; doc: AgentMemoryDoc } | null = null;
  let topDesc = -1;
  let topBody = 0;
  for (const item of loaded) {
    const descScore = memoryJaccard(item.doc.description, candidate.description);
    const bodyScore = memoryJaccard(item.doc.body, candidate.body);
    if (descScore > topDesc) {
      top = item;
      topDesc = descScore;
      topBody = bodyScore;
    }
  }
  if (!top || topDesc < MEMORY_RECONCILE_CANDIDATE_JACCARD) return null;
  if (topBody < MEMORY_RECONCILE_SUPERSEDE_JACCARD) return null;

  if (looksContradictory(top.doc.body, candidate.body) || looksReplacement(top.doc.body, candidate.body)) {
    return { ...top, mode: "supersede" };
  }
  // NOOP 门槛：description 近重复（>0.8）且正文高度一致（≥0.6）。
  if (topDesc > MEMORY_RECONCILE_NOOP_JACCARD && topBody >= MEMORY_RECONCILE_NOOP_BODY_JACCARD) {
    return { ...top, mode: "noop" };
  }
  return null;
}

/**
 * 对账命中后的旧文档更新：整篇写回并同步 catalog（revision+1，旧世代存档）。
 * supersede：status=superseded、validTo=nowIso；noop：只刷新 lastConfirmedAt。
 */
async function applyPrivateReconcileUpdate(
  entry: MemoryCatalogEntry,
  doc: AgentMemoryDoc,
  mode: "supersede" | "noop",
  nowIso: string,
): Promise<void> {
  await writeRevision(doc);
  const revision = Math.max(entry.revision ?? 0, doc.revision ?? 0) + 1;
  const next: AgentMemoryDoc =
    mode === "supersede"
      ? {
          ...doc,
          status: "superseded",
          validTo: nowIso,
          lastOperation: "supersede",
          revision,
          updatedAt: nowIso,
        }
      : {
          ...doc,
          lastConfirmedAt: nowIso,
          lastOperation: "noop",
          revision,
          updatedAt: nowIso,
        };
  await writeDoc(next);
  entry.status = next.status;
  entry.revision = revision;
  entry.updatedAt = nowIso;
  entry.validFrom = next.validFrom;
  entry.validTo = next.validTo;
  entry.lastConfirmedAt = next.lastConfirmedAt;
  // 逐文档日志：supersede／noop 都是条目变化，必须单独落盘。
  await writeCatalogEntry(entry);
}

/**
 * 摄入状态机（**仅 shared 生效**；private 恒 active）：
 * - 新文档：缺 `contributorKey` → `pending_review`（fail-closed，不静默当 active）；
 *   有提出者但去重人数 < `corroborationMin` → `pending_review`。
 * - 既有 `active`：内容不变 → 保持 active 并合并佐证；内容变更 → 走 `proposed` 提案
 *   （live 一字不动），提案达门槛才提升。
 * - `pending_review`：可直接改 live，但内容一变就重置佐证名单（重新收证）。
 * - `retracted`：留证终态，再入库一律 rejected "retracted"（人工 activate 另行放行）。
 *
 * private 额外在写入时对账（同一 ownerKey、精确 slug 未命中时）：矛盾／替换 → 旧事实
 * SUPERSEDE；近重复且正文一致 → NOOP（只刷新 lastConfirmedAt）；其余 ADD。
 *
 * 入库：G5 去重 + G7 配额 + 写正文 + 重建 INDEX.md + 更新 catalog.json。
 */
async function ingestMemoryDocsLocked(input: MemoryIngestInput): Promise<MemoryIngestResult> {
  const batchId = String(input?.batchId ?? "").trim();
  const now = input?.now ?? new Date();
  const nowIso = now.toISOString();
  const todayKey = nowIso.slice(0, 10);
  const candidates = Array.isArray(input?.docs) ? input.docs : [];
  const accepted: string[] = [];
  const acceptedRefs: NonNullable<MemoryIngestResult["acceptedRefs"]> = [];
  /** live 未变、只累积了未达门槛提案的 id（不进 accepted，避免误报「已入库」）。 */
  const proposals: string[] = [];
  /** 近重复被判定为已确认同一事实、只刷新 lastConfirmedAt 的 id。 */
  const noop: string[] = [];
  /** 被本批写入取代的旧 slug。 */
  const superseded: string[] = [];
  const rejected: MemoryIngestResult["rejected"] = [];

  if (!batchId) {
    for (const doc of candidates) {
      // 还没进入候选处理循环，只能按可读到的原始栏位保守补身份。
      const docScope = doc?.scope;
      rejected.push({
        slug: String(doc?.slug ?? ""),
        reason: "structure",
        ...(docScope === "private" || docScope === "shared" ? { scope: docScope } : {}),
        ...(docScope === "private" && doc?.ownerKey ? { ownerKey: doc.ownerKey } : {}),
        ...(typeof doc?.domain === "string" && doc.domain ? { domain: doc.domain } : {}),
      });
    }
    return {
      accepted,
      acceptedRefs,
      proposals,
      rejected,
      stats: { received: candidates.length, accepted: 0, index_lines: 0, seed_accepted: 0 },
    };
  }

  const catalog = await loadCatalog();
  const entries = catalog.entries;
  // 跨账号佐证门槛：坏值回退常量；至少 1（0 等价于只要有提出者即放行）。
  const corroborationMin =
    typeof input?.corroborationMin === "number" && Number.isFinite(input.corroborationMin)
      ? Math.max(1, Math.floor(input.corroborationMin))
      : MEMORY_SHARED_CORROBORATION_MIN;
  // 受控种子导入总开关；每个候选再用 scope/contributorKey 收窄（private 永不放宽）。
  const seedMode = input?.seedMode === true;
  const touchedPrivateOwners = new Set<string>();
  let sharedAcceptedThisBatch = 0;
  let touchedShared = false;
  /** 种子模式下实写的文档数（只计真正进 accepted 的 shared 种子文档）。 */
  let seedAccepted = 0;

  for (const candidate of candidates) {
    const slug = String(candidate?.slug ?? "");
    // 输入候选的原始身份：近重复合并会把 docSlug/docDomain 改写成 target，
    // 但审计／batch 抽检必须能用候选自己的 slug 找到这条回执。
    const inputDomain = String(candidate?.domain ?? "");
    const inputSlug = String(candidate?.slug ?? "");
    // 拒绝回执的候选身份：batch 审计按 (scope, ownerKey, domain, slug) 归属，
    // 否则同 slug 跨 domain 的 accepted/rejected 混合会被整条误标。
    const rejectIdentity = {
      scope:
        candidate?.scope === "private" || candidate?.scope === "shared"
          ? candidate.scope
          : undefined,
      ownerKey: candidate?.scope === "private" ? candidate.ownerKey : undefined,
      domain: typeof candidate?.domain === "string" ? candidate.domain : undefined,
    };
    if (!isStructurallyValid(candidate)) {
      rejected.push({ slug, reason: "structure", ...rejectIdentity });
      continue;
    }
    // 本候选是否只写入了未达门槛的提案（live 未变）：决定它进 proposals 而不是 accepted。
    let proposalOnly = false;
    // 同 slug 同内容＝只做确认（没有写新正文）：进 noop，不进 accepted。
    let reconfirmOnly = false;
    const scope = candidate.scope;
    const ownerKey = scope === "private" ? candidate.ownerKey : undefined;
    const contributorKey =
      scope === "shared" && typeof candidate.contributorKey === "string"
        ? candidate.contributorKey.trim()
        : "";
    // 种子模式只对「带 contributorKey 的 shared 文档」生效；private 与匿名 shared
    // 一律走普通闸门（有效门槛／容量上限都不放宽）。
    const docSeedMode = seedMode && scope === "shared" && contributorKey !== "";
    const effectiveCorroborationMin = docSeedMode ? 1 : corroborationMin;
    let existingIndex = entries.findIndex(
      (entry) =>
        sameScope(entry, scope, ownerKey) &&
        entry.domain === candidate.domain &&
        entry.slug === candidate.slug,
    );
    let existingEntry = existingIndex >= 0 ? entries[existingIndex] : null;

    // 近重复佐证入口（仅 shared，**只在精确 slug 未命中时启用**；精确命中优先级不变）：
    // 两个账号几乎不可能生成相同 slug（廉价通道用 note-<hash>、批次 curator 各自取名），
    // 若只按 scope+slug 精确匹配，shared 文档会永远停在 pending_review。这里把「同
    // domain + description 近重复」的既有文档当作**候选**，再以正文兼容作为合并门槛：
    // description 只负责找候选（措辞可能完全不同），正文才是「是否同一知识」的判据。
    // 正文不兼容 → **不采用该 target**，候选按新文档路径落盘成两条独立知识，绝不把
    // 候选正文并进目标后丢弃。private 完全不走这条路。
    let nearDuplicateTarget = false;
    // 正文兼容判定的显式结果：只有它为 true，pending 分支才允许把候选并进目标文档。
    let bodyCompatible = false;
    if (!existingEntry && scope === "shared" && contributorKey !== "") {
      const target = findCorroborationEntry(entries, candidate);
      if (target) {
        const targetDoc = await readDoc("shared", undefined, target.domain, target.slug);
        // 正文兼容门槛：内容四元组相同，或正文 token Jaccard ≥ 0.5（措辞差异容忍度）。
        // 目标正文读不到时无法证明兼容，fail-closed 视为不兼容（不拿它当合并目标）。
        bodyCompatible =
          targetDoc !== null &&
          (sameContent(targetDoc, candidate) ||
            memoryJaccard(targetDoc.body, candidate.body) >= MEMORY_CORROBORATION_BODY_JACCARD);
        if (bodyCompatible && targetDoc) {
          // 同一账号不得靠「换个 slug + 近重复描述」给自己补票：已在 live 或 proposed
          // 佐证名单里的一律按既有 duplicate 语义拒绝。
          const endorsers = mergeContributors(
            targetDoc.contributors,
            targetDoc.proposed?.contributors,
          );
          if (endorsers.includes(contributorKey)) {
            rejected.push({ slug, reason: "duplicate", ...rejectIdentity });
            continue;
          }
          existingIndex = entries.indexOf(target);
          existingEntry = target;
          nearDuplicateTarget = true;
        }
        // 不兼容：不使用 target，existingEntry 保持 null，候选走新文档落盘路径。
      }
    }

    // 文档身份一律用目标条目的 slug/domain（近重复命中时），绝不用候选自己生成的
    // 新 slug，否则又会分叉成新文档。精确命中时两者本来就相同。
    const docSlug = nearDuplicateTarget && existingEntry ? existingEntry.slug : candidate.slug;
    const docDomain =
      nearDuplicateTarget && existingEntry ? existingEntry.domain : candidate.domain;

    // 先读既有正文（shared 用 catalog 记的 domain 定位，避免候选改了 domain 时读不到
    // 本体）：状态判定与「内容同／异」比较都必须基于它，而不是基于 candidate。
    const previous = await readDoc(
      scope,
      ownerKey,
      scope === "shared" ? (existingEntry?.domain ?? candidate.domain) : candidate.domain,
      docSlug,
    );
    const previousStatus: MemoryStatus | undefined = previous?.status ?? existingEntry?.status;

    // retracted 是留证终态：shared 拒绝写入，正文一格不动（人工 activate 另行放行）。
    if (scope === "shared" && previousStatus === "retracted") {
      rejected.push({ slug, reason: "retracted", ...rejectIdentity });
      continue;
    }

    // L1：时间区间自检（必须在配额／对账之前——被拒候选不写文档、不消耗配额）。
    // 同 slug 更新时按「合并后的有效区间」判断：幂等重提保留旧 validFrom。
    const requestedFrom =
      normalizeIsoField(candidate.validFrom) ?? normalizeIsoField(candidate.observedAt);
    const requestedTo = normalizeIsoField(candidate.validTo);
    const sameContentAsPrevious = previous ? sameContent(previous, candidate) : false;
    const nowMs = timeMs(nowIso) ?? Date.now();
    const previousExpired =
      previous?.validTo !== undefined &&
      (timeMs(previous.validTo) ?? Infinity) <= nowMs;
    // 只有「active 且未过期」的同内容重提才是真 noop；retracted/superseded/过期
    // 同内容重提是**重新生效**，按新事实从 now 起算。
    const reconfirmEligible =
      previous !== null &&
      previous.status === "active" &&
      !previousExpired &&
      sameContentAsPrevious;
    const effectiveRangeFrom = reconfirmEligible
      ? previous.validFrom ?? previous.createdAt
      : // 非幂等写入会按新事实落 validFrom：未显式给 from 时默认 now，
        // 因此不能用旧 validFrom 校验（否则过去时刻的 validTo 会漏检）。
        requestedFrom ?? nowIso;
    const effectiveRangeTo = requestedTo ?? (reconfirmEligible ? previous.validTo : undefined);
    if (hasInvalidTimeRange(effectiveRangeFrom, effectiveRangeTo)) {
      rejected.push({ slug, reason: "time_range", ...rejectIdentity });
      continue;
    }

    // private 写入时对账（仅精确 slug 未命中时）。必须放在 G5 duplicate 之前：
    // 「同一事实被改写／否定」的候选天然是近重复，让它先有机会 SUPERSEDE 旧事实，
    // 而不是被 duplicate 直接丢掉。shared 不走这条路（保持既有佐证／提案状态机）。
    //
    // 决策与落盘分离：NOOP 不新增文档，可立即落盘；SUPERSEDE 只记决策，必须等本候选
    // 通过全部配额／结构检查、且新文档 writeDoc 成功后才置旧事实失效——否则配额拒绝
    // 会先杀掉旧事实，留下「旧的没了、新的没进来」的空洞。
    let supersededTargets: string[] = [];
    let supersedeMatch: PrivateReconcileMatch | null = null;
    if (!existingEntry && scope === "private" && ownerKey) {
      const match = await findPrivateReconcileMatch(entries, candidate, ownerKey);
      if (match?.mode === "noop") {
        await applyPrivateReconcileUpdate(match.entry, match.doc, "noop", nowIso);
        // NOOP：不写新文档、不进 accepted，只确认既有事实；revision 变了要重建索引。
        noop.push(match.entry.id);
        touchedPrivateOwners.add(ownerKey);
        continue;
      }
      if (match) {
        supersedeMatch = match;
        supersededTargets = [match.entry.slug];
      }
    }

    // G5（其二）：description 与既有 active 条目 token Jaccard > 0.8 → duplicate。
    // SUPERSEDE 是「替换同一事实」而非重复：本候选跳过此拒收。
    if (!existingEntry && !supersedeMatch) {
      const duplicate = entries.find(
        (entry) =>
          entry.status === "active" &&
          sameScope(entry, scope, ownerKey) &&
          // 同 slug／近重复只在同一 domain 内算重复；跨 domain 是两条独立事实。
          entry.domain === candidate.domain &&
          memoryJaccard(entry.description, candidate.description) > MEMORY_DUPLICATE_JACCARD,
      );
      if (duplicate) {
        rejected.push({ slug, reason: "duplicate", ...rejectIdentity });
        continue;
      }
    }

    const previousContributors = normalizeContributors(
      previous?.contributors ?? existingEntry?.contributors,
    );
    // 时间／来源栏位（宽松清洗；坏值视为 undefined，绝不拒绝整条）。
    // 新事实默认：validFrom = 显式值 ?? observedAt ?? now；validTo 空则视为仍有效。
    const timeFields = {
      validFrom:
        normalizeIsoField(candidate.validFrom) ??
        normalizeIsoField(candidate.observedAt) ??
        nowIso,
      validTo: normalizeIsoField(candidate.validTo),
      observedAt: normalizeIsoField(candidate.observedAt),
      referenceTime: normalizeIsoField(candidate.referenceTime),
      sourceSessionId: normalizeAuditString(candidate.sourceSessionId),
      sourceMessageIds: normalizeAuditIdList(candidate.sourceMessageIds),
    };
    // supersede 命中时把旧 slug 并入本事实的 supersedes（去重，最多 5 条）。
    const mergedSupersedes = normalizeSupersedes([
      ...supersededTargets,
      ...(normalizeSupersedes(candidate.supersedes) ?? []),
    ]);

    if (!existingEntry) {
      // G7：单批 shared ≤20（只计新增文档）。种子模式按批导入不受此限。
      if (
        scope === "shared" &&
        !docSeedMode &&
        sharedAcceptedThisBatch >= MEMORY_QUOTA_SHARED_PER_BATCH
      ) {
        rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
        continue;
      }
      // G7：单 domain ≤8/日。**按 scope 隔离计数**：shared 只数 shared，private 只数
      // 该 ownerKey，避免别的租户的 private `general` 吃光全服 shared `general`。
      const domainCount = entries.filter(
        (entry) =>
          sameScope(entry, scope, ownerKey) &&
          entry.domain === candidate.domain &&
          entry.createdAt.slice(0, 10) === todayKey,
      ).length;
      // 种子模式按批导入不受单 domain 日配额限制；private 与普通 shared 不变。
      if (!docSeedMode && domainCount >= MEMORY_QUOTA_PER_DOMAIN_DAY) {
        rejected.push({ slug, reason: "quota_domain", ...rejectIdentity });
        continue;
      }
      // G7：单 ownerKey private ≤10/日。
      if (scope === "private") {
        const ownerCount = entries.filter(
          (entry) =>
            entry.scope === "private" &&
            entry.ownerKey === ownerKey &&
            entry.createdAt.slice(0, 10) === todayKey,
        ).length;
        if (ownerCount >= MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY) {
          rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
          continue;
        }
      }
      // shared 新增若只能落 pending，而 pending 已满 → 拒绝（防跨日累积后批量升级）。
      if (scope === "shared" && !previous) {
        const wouldBeContributors = mergeContributors([], contributorKey);
        const wouldActivate =
          contributorKey !== "" &&
          wouldBeContributors.length >= effectiveCorroborationMin &&
          (docSeedMode || canActivateShared(catalog));
        if (!wouldActivate && pendingSharedCount(catalog) >= MEMORY_SHARED_MAX_PENDING_DOCS) {
          rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
          continue;
        }
      }
    }

    // G5（其一）：同 scope+ownerKey+slug 已存在 → 更新（revision+1，旧 body 存档）。
    const revision = existingEntry
      ? Math.max(existingEntry.revision, previous?.revision ?? 0) + 1
      : 1;
    if (previous) await writeRevision(previous);

    let doc: AgentMemoryDoc;

    if (scope === "private") {
      // active 且未过期的同内容重提＝幂等 noop（保留原 validFrom/validTo）；
      // retracted／superseded／已过期同内容重提＝重新生效：复用原 id、active、
      // validFrom 从 now（或候选显式值）起算、清空旧 validTo、进 accepted。
      const reconfirmSame = existingEntry !== null && reconfirmEligible;
      const reactivating =
        existingEntry !== null && previous !== null && sameContentAsPrevious && !reconfirmSame;
      if (reconfirmSame) reconfirmOnly = true;
      doc = {
        id:
          existingEntry?.id ??
          deterministicDocId({
            scope,
            ownerKey,
            domain: candidate.domain,
            slug: candidate.slug,
          }),
        scope,
        ownerKey,
        domain: candidate.domain,
        slug: candidate.slug,
        description: candidate.description,
        type: candidate.type,
        body: candidate.body,
        links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
        evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
        evidenceKind: candidate.evidenceKind,
        selfScore: candidate.selfScore,
        promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
        batchId: existingEntry?.batchId ?? batchId,
        status: "active",
        revision,
        contributors: [],
        ...timeFields,
        ...(reconfirmSame && previous
          ? {
              validFrom: previous.validFrom ?? previous.createdAt,
              validTo: timeFields.validTo ?? previous.validTo,
            }
          : {}),
        // 重新生效时不继承旧的 supersedes 指向（旧覆盖关系已经结束）。
        supersedes: reactivating
          ? mergedSupersedes
          : mergedSupersedes ?? previous?.supersedes,
        lastConfirmedAt: nowIso,
        lastOperation: reconfirmSame
          ? "noop"
          : reactivating
            ? "add"
            : existingEntry
              ? "update"
              : "add",
        createdAt: existingEntry?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
    } else if (!existingEntry && !previous) {
      // 新 shared 文档：达到跨账号门槛 **且** 容量允许才 active，否则 fail-closed 进 pending。
      const contributors = mergeContributors([], contributorKey);
      const reachable =
        contributorKey !== "" &&
        contributors.length >= effectiveCorroborationMin &&
        (docSeedMode || canActivateShared(catalog));
      doc = {
        id: deterministicDocId({ scope, ownerKey, domain: docDomain, slug: docSlug }),
        scope,
        ownerKey,
        domain: docDomain,
        slug: docSlug,
        description: candidate.description,
        type: candidate.type,
        body: candidate.body,
        links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
        evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
        evidenceKind: candidate.evidenceKind,
        selfScore: candidate.selfScore,
        promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
        batchId,
        status: reachable ? "active" : "pending_review",
        revision,
        contributors,
        ...timeFields,
        supersedes: mergedSupersedes,
        lastConfirmedAt: nowIso,
        lastOperation: "add",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    } else if (previousStatus === "active") {
      if (!previous) {
        // catalog 说 active 但正文读不到：绝不拿单账号候选覆盖 live（fail-closed）。
        rejected.push({ slug, reason: "structure", ...rejectIdentity });
        continue;
      }
      if (sameContent(previous, candidate)) {
        // 幂等重提：只并入佐证，live 内容与 validFrom/validTo 一字不动。
        doc = {
          ...previous,
          contributors: mergeContributors(previous.contributors, contributorKey),
          status: "active",
          revision,
          lastConfirmedAt: nowIso,
          lastOperation: "update",
          updatedAt: nowIso,
        };
      } else {
        // 内容变更：单账号不得覆盖 live，只能提交／累积提案。
        const liveProposal = normalizeProposed(previous.proposed);
        let proposed: MemoryProposal;
        if (!liveProposal) {
          proposed = {
            body: candidate.body,
            description: candidate.description,
            domain: candidate.domain,
            type: candidate.type,
            contributors: normalizeContributors([contributorKey]),
            updatedAt: nowIso,
          };
        } else if (sameContent(liveProposal, candidate)) {
          // 同一提案再获佐证（同一 ownerKey 去重后仍只算一人）。
          proposed = {
            ...liveProposal,
            contributors: mergeContributors(liveProposal.contributors, contributorKey),
            updatedAt: nowIso,
          };
        } else {
          // 提案内容又变了：新提案重新收证，旧提案作废。
          proposed = {
            body: candidate.body,
            description: candidate.description,
            domain: candidate.domain,
            type: candidate.type,
            contributors: normalizeContributors([contributorKey]),
            updatedAt: nowIso,
          };
        }

        if (
          proposed.contributors.length >= effectiveCorroborationMin &&
          (docSeedMode || canActivateShared(catalog, true))
        ) {
          // 提案达到跨账号门槛：提升为 live（该文档本就在 active，不增加 active 数）。
          doc = {
            ...previous,
            body: proposed.body,
            description: proposed.description,
            domain: proposed.domain,
            type: proposed.type,
            links: Array.isArray(candidate.links)
              ? candidate.links.map((link) => String(link))
              : previous.links,
            evidence:
              typeof candidate.evidence === "string"
                ? candidate.evidence.slice(0, 200)
                : previous.evidence,
            evidenceKind: candidate.evidenceKind,
            selfScore: candidate.selfScore,
            promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
            status: "active",
            revision,
            contributors: mergeContributors(previous.contributors, proposed.contributors),
            proposed: undefined,
            // live 内容被跨账号佐证推进：按新事实刷新时间字段。
            ...timeFields,
            supersedes: mergedSupersedes ?? previous.supersedes,
            lastConfirmedAt: nowIso,
            lastOperation: "update",
            updatedAt: nowIso,
          };
        } else {
          // 未达门槛：live 内容与对外状态保持原样，只更新提案（提案版本 revision+1）。
          // 该 id 只进 proposals：没有任何 live 内容变化，不能对外报「已入库」。
          proposalOnly = true;
          doc = {
            ...previous,
            status: "active",
            revision,
            proposed,
            updatedAt: nowIso,
          };
        }
      }
    } else if (previousStatus === "pending_review") {
      // 未发布态可直接改 live；**内容一变就重置佐证名单**（重新收证）。
      // 例外：近重复佐证——只有正文兼容判定（bodyCompatible）通过的候选才算对同一主张
      // 的独立佐证，措辞微调不算内容变更，保留既有正文，只并入新账号，达门槛才升
      // active。description 近重复本身不是合并理由；未通过正文兼容的候选已在上面放弃
      // 该 target，走新文档落盘，绝不接受后丢弃正文。
      const contentSame = previous ? sameContent(previous, candidate) : false;
      const contributors =
        contentSame || bodyCompatible
          ? mergeContributors(previousContributors, contributorKey)
          : normalizeContributors([contributorKey]);
      const reachable =
        contributors.length >= effectiveCorroborationMin &&
        (docSeedMode || canActivateShared(catalog));
      doc =
        nearDuplicateTarget && bodyCompatible && previous
          ? {
              // 正文兼容的近重复命中：身份与 live 正文沿用目标条目，候选取到的只是
              // 「一票佐证」；候选正文与目标正文兼容（Jaccard ≥ 0.5 或完全相同）。
              ...previous,
              domain: docDomain,
              slug: docSlug,
              status: reachable ? "active" : "pending_review",
              revision,
              contributors,
              // 措辞微调是对同一事实的佐证：不刷新 validFrom，只记确认时间。
              lastConfirmedAt: nowIso,
              lastOperation: "update",
              proposed: undefined,
              updatedAt: nowIso,
            }
          : {
              id:
                existingEntry?.id ??
                previous?.id ??
                deterministicDocId({ scope, ownerKey, domain: docDomain, slug: docSlug }),
              scope,
              ownerKey,
              domain: docDomain,
              slug: docSlug,
              description: candidate.description,
              type: candidate.type,
              body: candidate.body,
              links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
              evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
              evidenceKind: candidate.evidenceKind,
              selfScore: candidate.selfScore,
              promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
              batchId: existingEntry?.batchId ?? previous?.batchId ?? batchId,
              status: reachable ? "active" : "pending_review",
              revision,
              contributors,
              // 内容未变才保留既有提案；live 被直接改写时旧提案作废。
              proposed: contentSame ? previous?.proposed : undefined,
              // live 内容被直接改写：按新事实刷新时间字段。
              ...timeFields,
              supersedes: mergedSupersedes ?? previous?.supersedes,
              lastConfirmedAt: nowIso,
              lastOperation: "update",
              createdAt: existingEntry?.createdAt ?? previous?.createdAt ?? nowIso,
              updatedAt: nowIso,
            };
    } else {
      // retracted 已在上面拦截；走到这里表示 catalog 状态损坏，拒绝写入。
      rejected.push({ slug, reason: "structure", ...rejectIdentity });
      continue;
    }
    await writeDoc(doc);

    // 新事实已落盘成功，才把旧事实置为 superseded（失败路径不会走到这里，
    // 因此配额／结构拒绝时候选旧事实保持 active、仍在 INDEX）。
    if (supersedeMatch) {
      await applyPrivateReconcileUpdate(
        supersedeMatch.entry,
        supersedeMatch.doc,
        "supersede",
        nowIso,
      );
      superseded.push(supersedeMatch.entry.slug);
      if (ownerKey) touchedPrivateOwners.add(ownerKey);
    }

    const entry: MemoryCatalogEntry = {
      id: doc.id,
      scope: doc.scope,
      ownerKey: doc.ownerKey,
      domain: doc.domain,
      slug: doc.slug,
      description: doc.description,
      status: doc.status,
      revision: doc.revision,
      contributors: doc.contributors,
      batchId: doc.batchId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      validFrom: doc.validFrom,
      validTo: doc.validTo,
      lastConfirmedAt: doc.lastConfirmedAt,
      // 同 identity 的原条目若带旧 id aliases，必须保留（旧 id 的 history/retract 兼容）。
      aliases: existingEntry?.aliases,
    };
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else {
      entries.push(entry);
      if (scope === "shared") sharedAcceptedThisBatch += 1;
    }
    // 逐文档日志：条目新建／更新都写自己的文件（跨进程并发不再共享一个 catalog.json）。
    await writeCatalogEntry(entry);
    if (scope === "shared") touchedShared = true;
    else if (ownerKey) touchedPrivateOwners.add(ownerKey);
    // 实写（新文档／内容提升为 live）才进 accepted；提案-only 进 proposals；
    // 同 slug 同内容的确认（没有写新正文）进 noop。
    if (proposalOnly) proposals.push(doc.id);
    else if (reconfirmOnly) noop.push(doc.id);
    else {
      accepted.push(doc.id);
      acceptedRefs.push({
        id: doc.id,
        batchId: doc.batchId,
        scope: doc.scope,
        ownerKey: doc.ownerKey,
        domain: doc.domain,
        slug: doc.slug,
        inputDomain,
        inputSlug,
      });
      if (docSeedMode) seedAccepted += 1;
    }
  }

  // 进入时的 catalog.revision 作为并发检测基线：别的进程若已写入，saveCatalog 会按 id 合并。
  await saveCatalog(catalog, catalog.revision ?? 0);

  let indexLines = 0;
  if (accepted.length > 0 || superseded.length > 0 || noop.length > 0) {
    if (touchedShared) indexLines += await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) {
      indexLines += await rebuildIndex("private", ownerKey);
    }
  }

  return {
    accepted,
    acceptedRefs,
    proposals,
    ...(noop.length > 0 ? { noop } : {}),
    ...(superseded.length > 0 ? { superseded } : {}),
    rejected,
    stats: {
      received: candidates.length,
      accepted: accepted.length,
      index_lines: indexLines,
      seed_accepted: seedAccepted,
    },
  };
}

/** 导出入口：整段函数体持锁，避免同进程内 read-modify-write catalog 互相覆盖。 */
export function ingestMemoryDocs(input: MemoryIngestInput): Promise<MemoryIngestResult> {
  return withCatalogLock(() => ingestMemoryDocsLocked(input));
}

/**
 * 撤回：status=retracted + validTo=now + 清空未发布提案 + 从 INDEX 移除；**不删文件**
 * （留证只留 live 正文，不保留 proposed，避免人工 activate 后旧提案被后续佐证意外提升）。
 * superseded 是历史终态，不重复撤回（跳过）。
 */
async function retractMemoryDocsLocked(
  input: MemoryRetractInput,
): Promise<{ retracted: string[] }> {
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { retracted: [] };
  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const retracted: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? entryMatchesIds(entry, docIds) : entry.batchId === batchId;
    if (!matches || entry.status === "retracted") continue;
    // superseded 已是历史终态：不重复撤回，也不改它的 validTo。
    if (entry.status === "superseded") continue;
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc || doc.status === "superseded") continue;
    await writeDoc({
      ...doc,
      status: "retracted",
      validTo: nowIso,
      proposed: undefined,
      updatedAt: nowIso,
    });
    entry.status = "retracted";
    entry.updatedAt = nowIso;
    entry.validFrom = doc.validFrom;
    entry.validTo = nowIso;
    await writeCatalogEntry(entry);
    retracted.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (retracted.length > 0) {
    await saveCatalog(catalog, catalog.revision ?? 0);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { retracted };
}

/** 导出入口：整段函数体持锁。 */
export function retractMemoryDocs(
  input: MemoryRetractInput,
): Promise<{ retracted: string[] }> {
  return withCatalogLock(() => retractMemoryDocsLocked(input));
}

/**
 * 品质复核翻转（PRD §5.6 抽检判据；【契约外新增】，比照 §3.2 retract 的目录＋正文同步纪律）：
 * active↔pending_review 双向翻转，INDEX 重建沿用 rebuildIndex（pending_review 不在
 * activeDocs → 索引行自动消失）；retracted 永不翻转（留证不动，两个方向都不是它的来源态）。
 * activate 到 shared 与其他进入 active 的路径同受 `canActivateShared()` 约束：满 400 时
 * 保持 pending_review 并进回执 `blocked`——人工放行不绕过平台容量上限。
 */
async function reviewMemoryDocsLocked(
  input: MemoryReviewInput,
): Promise<MemoryReviewResult> {
  const action = input?.action;
  if (action !== "pending_review" && action !== "activate") {
    return { reviewed: [], action, blocked: [] };
  }
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { reviewed: [], action, blocked: [] };

  const fromStatus: MemoryStatus = action === "pending_review" ? "active" : "pending_review";
  const toStatus: MemoryStatus = action === "pending_review" ? "pending_review" : "active";  const scopeFilter: MemoryScope | undefined =
    input?.scope === "private" || input?.scope === "shared"
      ? input.scope
      : action === "pending_review"
        ? "shared" // PRD §5.6：自动翻转仅限 shared；私有库要翻得显式带 scope
        : undefined;

  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const reviewed: string[] = [];
  /** 人工 activate 撞上 active 容量上限而保持 pending_review 的 id。 */
  const blocked: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? entryMatchesIds(entry, docIds) : entry.batchId === batchId;
    if (!matches || entry.status !== fromStatus) continue;
    if (scopeFilter && entry.scope !== scopeFilter) continue;
    // 人工放行不绕过平台容量上限：shared 且当前不是 active 时，必须过 canActivateShared。
    // 满 400 就保持 pending_review（不写正文、不改 catalog），并把 id 回报给调用方。
    // private 与本就 active 的文档不受此限（后者由 fromStatus 过滤，不会被处理）。
    if (action === "activate" && entry.scope === "shared" && entry.status !== "active") {
      if (!canActivateShared(catalog, false)) {
        blocked.push(entry.id);
        continue;
      }
    }
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc || doc.status !== fromStatus) continue;
    await writeDoc({ ...doc, status: toStatus, updatedAt: nowIso });
    entry.status = toStatus;
    entry.updatedAt = nowIso;
    entry.validFrom = doc.validFrom;
    await writeCatalogEntry(entry);
    reviewed.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (reviewed.length > 0) {
    await saveCatalog(catalog, catalog.revision ?? 0);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { reviewed, action, blocked };
}

/** 导出入口：整段函数体持锁。 */
export function reviewMemoryDocs(input: MemoryReviewInput): Promise<MemoryReviewResult> {
  return withCatalogLock(() => reviewMemoryDocsLocked(input));
}

/**
 * 读某文档的最近 50 个历史世代（start=max(1, revision-49) 到 revision）。读不到／
 * 形状不符的世代直接跳过（不抛）。`current` 是当前正文（可能已是 superseded／retracted）。
 */
export async function listMemoryRevisions(
  docId: string,
): Promise<{ current: AgentMemoryDoc | null; revisions: AgentMemoryDoc[] }> {
  const id = String(docId ?? "").trim();
  if (!id) return { current: null, revisions: [] };
  const catalog = await loadCatalog();
  const entry = findCatalogEntryByIdOrAlias(catalog, id);
  if (!entry) return { current: null, revisions: [] };
  const current = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
  // 只取最近 50 代（不是最早 50 代）：revision=56 → 7..56。
  const latestRevision = Math.max(
    0,
    Math.floor(entry.revision ?? 0),
    Math.floor(current?.revision ?? 0),
  );
  const startRevision = Math.max(1, latestRevision - 49);
  // entry.id 与合并前的旧 id（aliases）都可能是历史文件的键。
  const sourceIds = [entry.id, ...(entry.aliases ?? [])];
  const byRevision = new Map<number, AgentMemoryDoc>();
  // current 先补位：当前代可能只存在于正文／catalog，还没落 revision 文件。
  // 只有落在「最近 50 代」窗口内才补位（revision=56 时不能把 revision=1 也塞进去）。
  if (
    current &&
    Number.isFinite(current.revision) &&
    current.revision >= startRevision &&
    current.revision <= latestRevision
  ) {
    byRevision.set(current.revision, current);
  }
  outer: for (let revision = startRevision; revision <= latestRevision; revision += 1) {
    for (const sourceId of sourceIds) {
      // 新键（带短 hash）优先，再回落旧版无 hash 键（升级前历史）。
      for (const key of [revisionKey(sourceId, revision), legacyRevisionKey(sourceId, revision)]) {
        const parsed = revisionsMemory.get(key) ?? (await readBlobJson<AgentMemoryDoc>(key));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (
          parsed.slug !== entry.slug ||
          parsed.domain !== entry.domain ||
          parsed.scope !== entry.scope
        ) {
          continue;
        }
        // blob／Map 找到的世代覆盖 current 补位（blob 优先），按 revision 去重。
        byRevision.set(revision, parsed);
        continue outer;
      }
    }
  }
  const revisions = [...byRevision.values()].sort((a, b) => a.revision - b.revision);
  return { current, revisions };
}

/** 批次报告落盘（契约 §2 `agent-memory/batches/{batchId}.json`）。 */
export async function saveBatchReport(batchId: string, report: unknown): Promise<void> {
  await writeBlobText(
    `${AGENT_MEMORY_BLOB_PREFIX}/batches/${safeSegment(batchId, "batch")}.json`,
    JSON.stringify(report),
  );
}
