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
