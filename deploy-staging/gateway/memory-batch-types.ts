import type { AgentMemoryDocInput } from "./memory-gate.ts"
// ─────────────────────────── 契约 §6 prompt（唯一真源，逐字，promptVersion="v1"）

export const MEMORY_PROMPT_VERSION = "v3"

export const CURATOR_PROMPT_V1 = `You are the memory curator for an AI image/video generation assistant.
Input: one conversation transcript. Output: a single JSON object. Nothing else.

You may propose memories of two scopes:
- "private": facts about THIS user that help future sessions serve them (preferences, specs, recurring corrections, working habits). Only these may be private.
- "shared": transferable DOMAIN KNOWLEDGE that any user of this product could benefit from - narrative structures, visual styles, cultural context, prompt techniques, industry conventions, domain facts learned from tool results. It MUST NOT contain anything identifying this user or this conversation.

HARD RULES - a proposal violating any of these is discarded downstream by the system:
- Every proposal MUST cite external evidence: a tool result, an explicit user confirmation, or a verbatim quote. Your own reasoning, inference, or pre-existing general knowledge is NOT evidence. If a statement is supported only by what you already knew, do not propose it.
- "shared" proposals MUST NOT contain: user names, account ids, session ids, emails, URLs, file paths, prices, API keys, tokens, or any detail traceable to one user or one purchase.
- Skip greetings, one-off requests, small talk, and anything derivable from the product itself (pricing tables, model lists, UI text).
- Do not propose anything you cannot state in one sentence.
- Write ONLY transferable long-term knowledge. Do NOT store the specific answer to this task, this request's output spec, or details of a single incident; those are wrong anchors for the next task.
- Only fill valid_to/supersedes when the conversation explicitly shows the old fact stopped being true or was replaced. Never guess. If unsure, leave empty.
- observed_at must come from the conversation/tool result time, not from your own clock.

Output schema (JSON only, no markdown fence):
{"session_id":"<id>","candidates":[{"scope":"private|shared","domain":"<one-level domain>","slug":"<kebab-case>","description":"<one line, <=120 chars>","type":"user|feedback|project|domain|workflow","body":"<=2000 chars; for feedback/project include **Why:** and **How to apply:**","links":["<other-slug>"],"evidence":"<verbatim quote of the tool result or the user's words, <=200 chars>","evidence_kind":"tool_result|user_confirmed|verbatim","observed_at":"<ISO date when this fact was observed, or empty>","valid_from":"<ISO date when it became true, or empty>","valid_to":"<ISO date when it stopped being true, or empty>","supersedes":"<verbatim old fact this new fact replaces, or empty>","self_score":1-5,"self_score_reason":"<one line>"}],"rejected":[{"note":"<what you skipped>","reason":"one_off|greeting|derivable|no_evidence|sensitive"}]}`

/** Verifier prompt（G8，仅 shared、换模型）——契约 §6 逐字；P1-1 本片接线进 runBatch。 */
export const VERIFIER_PROMPT_V1 = `You are an independent fact-checker for a shared knowledge base used by an AI image/video generation assistant.
Input: one candidate knowledge item. Answer three questions about it.

1. TRANSFERABLE: Is this knowledge useful to a different user with a different project, or is it specific to one user's situation?
2. EVIDENCED: Is this knowledge actually supported by the quoted evidence, or is it the model's own inference or general knowledge?
3. CLEAN: Is it free of any user-identifying trace (names, account ids, session ids, emails, URLs, file paths, prices, keys)?

Output JSON only: {"transferable":true|false,"evidenced":true|false,"clean":true|false,"reason":"<one line>"}
A candidate is admitted only if all three are true.`

/**
 * Oracle prompt（PRD §5.6 抽检、换模型）——【契约外新增常量】（§6 只有 curator/verifier），
 * 依 PRD 判据逐字面「准确？可迁移？无用户痕迹？」，每条 0/1/2 分。
 */
export const ORACLE_PROMPT_V1 = `You are an independent quality oracle auditing one item admitted into a shared knowledge base used by an AI image/video generation assistant.
Judge the item on three questions: is it accurate, is it transferable to a different user's project, and is it free of any user-identifying trace (names, account ids, session ids, emails, URLs, file paths, prices, keys)?
Score the item 0, 1, or 2: 2 = passes all three; 1 = minor doubt on one aspect; 0 = fails any aspect decisively.
Output JSON only: {"score":0|1|2,"reason":"<one line>"}`

// ─────────────────────────── 形状

/** 入库 doc：promptVersion 由批次盖章补上。 */
export interface IngestDocInput extends AgentMemoryDocInput {}

/**
 * 2026-10-19 store 确定性 id（`mem-<hash>`）的写入回执条目。
 * 字段接受 snake/camel：batch_id/batchId、owner_key/ownerKey；其余同名字段一致。
 */
export interface MemoryAcceptedRef {
  id: string
  batchId?: string
  scope: string
  ownerKey?: string
  /** 实际落盘 target 身份（近重复合并时可能指向已存在的文档）。 */
  domain: string
  slug: string
  /** 候选原始身份（与落盘 target 不同时用于归属本批候选）。 */
  inputDomain?: string
  inputSlug?: string
}

/** ref 的候选身份：有 input 优先，缺省回退落盘身份（target）。 */
/** 筛选用会话元资料（wiring 适配：opencode 目录行 parentID/time.updated、gateway hashKey(apiKey)、讯息/工具计数）。 */
export interface MemorySessionRecord {
  id: string
  /** 非空即 subagent 子会话 → 剔除（PRD §5.2 条件⑤）。 */
  parentId?: string | null
  /** ISO 字串或 epoch ms（opencode time.*）；「当日 updated」判定用。 */
  updatedAt?: string | number
  /** SHA-256(apiKey) 前 12 bytes hex（契约 §1，与 gateway hashKey 同算法）。 */
  ownerKey?: string
  userMessages?: number
  successfulToolCalls?: number
  /** 知识型工具呼叫数：筛选加权排序用（PRD §5.2 条件③）。 */
  knowledgeToolCalls?: number
}

export interface MemoryBatchEnv {
  [key: string]: string | undefined
  MEMORY_INGEST_SECRET?: string
  MEMORY_BATCH_ENABLED?: string
  MEMORY_BATCH_MAX_SESSIONS?: string
  MEMORY_BATCH_MAX_LLM?: string
  MEMORY_SHARED_ENABLED?: string
  /** G8 verifier 模型（`provider/model`）；未配置 → G8 跳过并诚实记 g8_skipped（不放过不误杀）。 */
  MEMORY_VERIFIER_MODEL?: string
  /** §5.6 oracle 抽检模型；未配置 → 抽检跳过并诚实记 sampling.skipped。 */
  MEMORY_ORACLE_MODEL?: string
  /** 批次状态档目录（默认 "."，即 gateway 进程 cwd 旁）。 */
  MEMORY_STATE_DIR?: string
}

export interface MemoryBatchDeps {
  listSessions(): Promise<MemorySessionRecord[]>
  transcriptOf(sessionId: string): Promise<string>
  /** 一次性 LLM 呼叫（wiring 用 handleExtractLessons 回环：建 session→POST→取 text→finally DELETE，120s 超时）。 */
  callLlm(prompt: string): Promise<string>
  /** G8 verifier（换模型，契约 §5/PRD §5.4）：prompt + `provider/model`；未配置时本档不呼叫。 */
  callVerifierLlm(prompt: string, model: string): Promise<string>
  /** §5.6 oracle 抽检（换模型）：同 verifier 通道形态；未配置时本档不呼叫。 */
  callOracleLlm(prompt: string, model: string): Promise<string>
  /** 送 ingest：rawBody 是即将送出的精确位元组（本档已按其签名，不得在实作端重新序列化）。 */
  postIngest(
    path: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: unknown }>
  env: MemoryBatchEnv
  now(): Date
  /** 2026-10-19：ingest POST 成功（2xx）后回调，用于失效召回语料快取；异常不得影响批次。 */
  onIngestSuccess?: () => void
}

export interface MemoryBatchOptions {
  dryRun?: boolean
  sessionIds?: string[]
  /** YYYY-MM-DD（UTC）；默认取 deps.now() 当日。 */
  date?: string
}

/**
 * §5.6 抽检报告段（**零正文**）。shared 堆为判据主体；private 同机制只记 badge。
 * avg 为有效分数均值；全错时 null（不灌水 0）。
 */
export interface MemorySamplingReport {
  /** shared 抽检样本数（实际拿到 oracle 判分的条数）。 */
  sampled: number
  avg: number | null
  /** true = 平均 <1.5 或任一 0 分 → 该批 shared 已全部转 pending_review。 */
  triggered: boolean
  /** oracle 呼叫失败数（基础设施失败≠候选有罪；不计入 avg，诚实计数）。 */
  errors: number
  /** oracle 未配置／LLM 预算耗尽时「本应抽检而未抽」的条数（shared＋private）；诚实旗标。 */
  skipped: number
  /** private 抽检中得分 <2 的条数（badge only，PRD §5.6 不自动转 pending）。 */
  private_badged: number
}

/** 批次报告（契约 §3.5 形状；**不含任何正文**）。 */
export interface MemoryBatchReport {
  batch_id: string
  date: string
  dry_run: boolean
  candidates: number
  passed: number
  stored: number
  /** 端点判定「与既有记忆重复已合并确认」的条数（noop，不重复写入）；不含在 stored。 */
  noop: number
  /** 端点判定「旧记忆已被新文档取代」的条数（superseded；新文档通常已 accepted）。 */
  superseded: number
  /** accepted_refs 缺失/未覆盖时，用旧 `${batchId}-${slug}`／唯一后缀回退匹配的条数（0＝全走 refs）。 */
  accepted_refs_fallback?: number
  /** accepted id 既没有被 refs 命中、旧 fallback 也未命中而无法归属的条数（0＝全部可归属）。 */
  accepted_refs_unmatched?: number
  /** 旧形 rejected 回执（只有 slug）在本批同 slug 多身份/无候选而无法唯一归属的条数。 */
  rejected_refs_unmatched?: number
  rejected: Record<string, number>
  truncations: { sessions: number; llm_budget_hit: boolean }
  /** G8 诚实旗标：shared 候选因 `MEMORY_VERIFIER_MODEL` 未配置而跳过验证的条数。 */
  g8_skipped: number
  /** G8 抽检段（入库后）；未送 ingest（dryRun／无候选）时各栏为 0／null。 */
  sampling: MemorySamplingReport
  /** B1 信号队列对账：batch 开始时的待处理数 vs 本批实际消费/无产出/丢弃数。 */
  queue: {
    pending: number
    consumed: number
    no_docs: number
    failed: number
  }
  /** B3 账本：应处理 vs 实处理、LLM 次数、候选/入库/拒绝数；errors 为断言式自检结果。 */
  ledger: {
    sessions_selected: number
    sessions_processed: number
    llm_calls: number
    docs_proposed: number
    docs_stored: number
    docs_rejected: number
    budget_hit: boolean
    errors: string[]
  }
  report_path?: string
}

export interface PendingEnvelope {
  batch_id: string
  created_at: string
  attempts: number
  next_retry_at: number
  /** 将送出的精确 raw JSON bytes（string），重试时原位元重发——签名必须对同一串。 */
  raw_body: string
}

export interface CursorState {
  processed: Record<string, { at: string; produced: boolean }>
}
