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

export { MEMORY_CATALOG_VERSION, MEMORY_QUOTA_SHARED_PER_BATCH, MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY, MEMORY_QUOTA_PER_DOMAIN_DAY, MEMORY_DUPLICATE_JACCARD, MEMORY_CORROBORATION_BODY_JACCARD, MEMORY_SHARED_CORROBORATION_MIN, MEMORY_SHARED_MAX_ACTIVE_DOCS, MEMORY_SHARED_MAX_PENDING_DOCS, MEMORY_RECONCILE_NOOP_JACCARD, MEMORY_RECONCILE_NOOP_BODY_JACCARD, MEMORY_RECONCILE_CANDIDATE_JACCARD, MEMORY_RECONCILE_SUPERSEDE_JACCARD, AGENT_MEMORY_BLOB_PREFIX } from "./agent-memory-store/constants";
export { memoryTokens, memoryJaccard } from "./agent-memory-store/text";
export { memoryStoreDbBackendAvailable } from "./agent-memory-store/db";
export { __resetAgentMemoryStoreForTests } from "./agent-memory-store/store";
export { buildMemoryIndexMd, buildMemoryDomainDigestMd } from "./agent-memory-store/index-md";
export { isMemoryCurrentlyValid } from "./agent-memory-store/validity";
export { listMemoryDocs, readMemoryIndexMd } from "./agent-memory-store/read-api";
export { ingestMemoryDocs } from "./agent-memory-store/ingest";
export { retractMemoryDocs, reviewMemoryDocs } from "./agent-memory-store/mutate";
export { listMemoryRevisions } from "./agent-memory-store/history";
export { saveBatchReport } from "./agent-memory-store/reports";
export type { MemoryScope, MemoryType, EvidenceKind, MemoryStatus, MemoryProposal, AgentMemoryDoc, AgentMemoryDocInput, MemoryRejectReason, MemoryIngestInput, MemoryIngestResult, MemoryRetractInput, MemoryReviewAction, MemoryReviewInput, MemoryReviewResult, MemoryScopeInput, MemoryCatalogEntry, MemoryCatalog } from "./agent-memory-store/types";
