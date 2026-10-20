export const MEMORY_CATALOG_VERSION = 1;
/**
 * G7 配额（契约 §3.1）：单批 shared ≤20；单 ownerKey private ≤60/日；
 * private 单 domain ≤50/日、shared 单 domain ≤8/日。
 *
 * 两个域额的取向不同：private 是用户自己的库，项目记忆一天写几十条是合理需求，
 * 故放开到 50/日（单 owner 总量另由 60/日兜底）；shared 会注入所有用户的上下文，
 * 保持严格的 8/日/域。两者都可用 env 覆盖（正整数，坏值回落默认）。
 */
export const MEMORY_QUOTA_SHARED_PER_BATCH = positiveIntEnv(
  "MEMORY_QUOTA_SHARED_PER_BATCH",
  20,
);
export const MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY = positiveIntEnv(
  "MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY",
  60,
);
/** private 单 domain 日配额（放宽侧）。 */
export const MEMORY_QUOTA_PER_DOMAIN_DAY = positiveIntEnv(
  "MEMORY_QUOTA_PER_DOMAIN_DAY",
  50,
);
/** shared 单 domain 日配额（严格侧：共享库进所有人上下文）。 */
export const MEMORY_QUOTA_SHARED_PER_DOMAIN_DAY = positiveIntEnv(
  "MEMORY_QUOTA_SHARED_PER_DOMAIN_DAY",
  8,
);
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
/** 正整数 env 旋钮：未设定／格式坏／<1 一律回落默认值，读取永不抛错。
 *  （函数声明会提升，允许被上方配额常量提前引用。） */
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
/** 逐文档 catalog 日志（每条目一个文件；并发写不同 doc 不共享文件）。 */
const CATALOG_JOURNAL_PREFIX = `${AGENT_MEMORY_BLOB_PREFIX}/catalog/`;

export { MEMORY_SEED_PROMPT_VERSION, CATALOG_JOURNAL_PREFIX };
