/**
 * memory-batch.ts — VPS gateway 侧批次器（契约 §3.1/§6/§8；PRD §5.2）。
 *
 * 依赖注入、可单测：index.ts 接线（opencode 一次性 session、/internal 路由、
 * 定时器、sk-biz hashKey 适配）由后续片执行，本档只汇出 `createMemoryBatch(deps)`。
 *
 * 【本地决定 — 契约 §2 路径表之外的唯一例外（2026-09-15 本片签字）】
 * 契约 §2 把 cursor/pending/batches 都列在 blob 路径（`agent-memory/cursor.json`
 * 等），但契约 §0 实测「VPS .env 没有 IMAGE_DATA_*，gateway 不能直读写 blob」。
 * 故批次状态一律落 gateway 进程本地档（stateDir 旁，无凭证、可审计）：
 *   - 游标      `memory-cursor.json`
 *   - 待重试    `memory-pending/{batch_id}.json`
 *   - 死信      `memory-failed/{batch_id}.json`（attempts≥5，记日志不含正文）
 *   - 批次报告  `memory-batches/{batch_id}.json`（镜像 §2 batches 路径语义）
 * 真正的存储权威写入仍只经 HMAC 端点（§3），本档不碰 blob。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
// 2026-10-19 批次审计：逐会话记 stored/no_docs（只记事件元资料，不改筛选/门禁/LLM 判定；
// 审计失败只 warn，绝不影响批次）。
// 2026-10-19 B1：批次同时是「该写记忆」信号队列的消费者——队列优先并入候选、
// 会话产出后 markSignalDone、零产出则 attempts+1（≥5 次移入 failed/）。
import { applyMemoryGates, stripJsonFence, type CuratorCandidate, type GateContext } from "./memory-gate.ts"
import { appendMemoryAudit, listPendingSignals, markSignalDone, recordSignalNoDocs, type MemoryQueueRecord } from "./memory-queue.ts"
import { MEMORY_SIGNATURE_HEADER, signMemoryBytes } from "./memory-batch-http.ts"
import { MEMORY_PROMPT_VERSION, CURATOR_PROMPT_V1, VERIFIER_PROMPT_V1, ORACLE_PROMPT_V1, type IngestDocInput, type MemoryAcceptedRef, type MemorySessionRecord, type MemoryBatchEnv, type MemoryBatchDeps, type MemoryBatchOptions, type MemorySamplingReport, type MemoryBatchReport, type PendingEnvelope, type CursorState } from "./memory-batch-types.ts"
import { INGEST_PATH, REVIEW_PATH, CONCURRENCY, MAX_ATTEMPTS, DEFAULT_MAX_SESSIONS, DEFAULT_MAX_LLM, CURSOR_FILE, PENDING_DIR, FAILED_DIR, REPORTS_DIR, BADCASES_DIR, SAMPLING_AVG_TRIGGER, DEFAULTS, envInt, envBool, isoDateOf, epochOf, mapPool, sampleSize, shuffleSample, safeFileSegment, roundAvg, acceptedRefInputIdentity, parseAcceptedRefs, memoryIdentityKey } from "./memory-batch-store.ts"

// ─────────────────────────── 工厂

export function createMemoryBatch(deps: MemoryBatchDeps) {
  const stateDir = String(deps.env.MEMORY_STATE_DIR ?? "").trim() || "."
  const cursorPath = join(stateDir, CURSOR_FILE)
  const pendingDir = join(stateDir, PENDING_DIR)
  const failedDir = join(stateDir, FAILED_DIR)
  const reportsDir = join(stateDir, REPORTS_DIR)
  const badcasesDir = join(stateDir, BADCASES_DIR)

  // ---- 本地状态档 IO（无凭证；见档头「本地决定」） ----

  function readJsonFile<T>(path: string): T | null {
    try {
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, "utf8")) as T
    } catch {
      return null
    }
  }

  function writeJsonFile(path: string, value: unknown): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value, null, 2), "utf8")
    } catch (err) {
      // 只记档名层级，不记内容。
      console.error(`[memory-batch] state write failed: ${dirname(path)}`, (err as Error)?.name ?? "Error")
    }
  }

  function loadCursor(): CursorState {
    const loaded = readJsonFile<CursorState>(cursorPath)
    if (loaded && typeof loaded === "object" && loaded.processed && typeof loaded.processed === "object") {
      return { processed: loaded.processed }
    }
    return { processed: {} }
  }

  // ---- 端点送出与重试 ----

  /**
   * HMAC 端点通用送出（ingest 与 review 同一签名通道，契约 §3 头部纪律）：
   * 对「将送出的精确 raw bytes」签名；非 2xx／网路失败 → ok:false，不落 log 正文。
   */
  async function postSigned(path: string, rawBody: string): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
    const secret = String(deps.env.MEMORY_INGEST_SECRET ?? "").trim()
    if (!secret) {
      // 凭证纪律：只报缺配置事实，不印任何密钥派生物。
      console.error("[memory-batch] MEMORY_INGEST_SECRET 未配置，HMAC 端点拒绝送出。")
      return { ok: false, json: null }
    }
    try {
      const res = await deps.postIngest(path, rawBody, {
        "Content-Type": "application/json",
        [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, secret),
      })
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, json: (res.json ?? null) as Record<string, unknown> | null }
      }
      return { ok: false, json: null }
    } catch {
      return { ok: false, json: null }
    }
  }

  async function attemptPost(rawBody: string): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
    const result = await postSigned(INGEST_PATH, rawBody)
    if (result.ok) {
      // 仅 ingest 成功（批次首送与 pending 重放都经此处）：通知语料快取失效。异常吞掉。
      try {
        deps.onIngestSuccess?.()
      } catch {
        /* 快取失效失败不影响批次结果与账本 */
      }
    }
    return result
  }

  function writePending(env: PendingEnvelope): void {
    writeJsonFile(join(pendingDir, `${env.batch_id}.json`), env)
  }

  function listPendingFiles(): string[] {
    try {
      if (!existsSync(pendingDir)) return []
      return readdirSync(pendingDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(pendingDir, f))
    } catch {
      return []
    }
  }

  /**
   * 跨 run 重试 pending 档：指数退避（next_retry_at 由 attempts 推），
   * attempts ≥ MAX_ATTEMPTS → 移入 memory-failed/ 并记日志（只记 batch_id，不含正文）。
   */
  async function drainPending(): Promise<void> {
    const nowMs = deps.now().getTime()
    for (const file of listPendingFiles()) {
      const env = readJsonFile<PendingEnvelope>(file)
      if (!env || typeof env.raw_body !== "string" || !env.batch_id) continue
      if (nowMs < Number(env.next_retry_at ?? 0)) continue
      if (Number(env.attempts ?? 0) >= MAX_ATTEMPTS) {
        try {
          mkdirSync(failedDir, { recursive: true })
          renameSync(file, join(failedDir, `${env.batch_id}.json`))
        } catch {
          /* 搬移失败留待下轮 */
        }
        console.error(`[memory-batch] pending exhausted after ${MAX_ATTEMPTS} attempts → failed/: batch=${env.batch_id}`)
        continue
      }
      const { ok } = await attemptPost(env.raw_body)
      if (ok) {
        try {
          unlinkSync(file)
        } catch {
          /* 删除失败：下轮再试，幂等由端点 G5 兜 */
        }
        console.log(`[memory-batch] pending replayed: batch=${env.batch_id}`)
        continue
      }
      const attempts = Number(env.attempts ?? 0) + 1
      writePending({
        ...env,
        attempts,
        // 指数退避：2^attempts 分钟（32→64→128→256 分钟级），跨 run/排程自然生效。
        next_retry_at: nowMs + Math.min(2 ** attempts, 240) * 60_000,
      })
      try {
        if (join(pendingDir, `${env.batch_id}.json`) !== file) unlinkSync(file)
      } catch {
        /* noop */
      }
    }
  }

  // ---- 主批次 ----

  async function runBatch(options: MemoryBatchOptions = {}): Promise<MemoryBatchReport> {
    const dryRun = options.dryRun === true
    const nowDate = deps.now()

    if (!dryRun && !envBool(deps.env.MEMORY_BATCH_ENABLED, false)) {
      // 总开关（§8 默认 false）：未明确开启时手动跑要 dryRun 或设 true，避免误写生产。
      throw new Error("MEMORY_BATCH_ENABLED=false（总开关未开启；先用 dryRun，或设 MEMORY_BATCH_ENABLED=true）")
    }

    const date =
      typeof options.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.date)
        ? options.date
        : nowDate.toISOString().slice(0, 10)
    const batchId = date // §3.1 例：batch_id 用日期（稳定可追溯；id=${batchId}-${slug} 由服务端拼）
    const maxSessions = envInt(deps.env.MEMORY_BATCH_MAX_SESSIONS, DEFAULTS.maxSessions)
    const maxLlm = envInt(deps.env.MEMORY_BATCH_MAX_LLM, DEFAULTS.maxLlm)
    const sharedEnabled = envBool(deps.env.MEMORY_SHARED_ENABLED, true)
    // G8/抽检模型（§8 新增 env）：未配置＝该闸跳过，诚实记数（不放过不误杀）。
    const verifierModel = String(deps.env.MEMORY_VERIFIER_MODEL ?? "").trim()
    const oracleModel = String(deps.env.MEMORY_ORACLE_MODEL ?? "").trim()

    const report: MemoryBatchReport = {
      batch_id: batchId,
      date,
      dry_run: dryRun,
      candidates: 0,
      passed: 0,
      stored: 0,
      noop: 0,
      superseded: 0,
      accepted_refs_fallback: 0,
      accepted_refs_unmatched: 0,
      rejected_refs_unmatched: 0,
      rejected: {},
      truncations: { sessions: 0, llm_budget_hit: false },
      g8_skipped: 0,
      sampling: { sampled: 0, avg: null, triggered: false, errors: 0, skipped: 0, private_badged: 0 },
      queue: { pending: 0, consumed: 0, no_docs: 0, failed: 0 },
      ledger: {
        sessions_selected: 0,
        sessions_processed: 0,
        llm_calls: 0,
        docs_proposed: 0,
        docs_stored: 0,
        docs_rejected: 0,
        budget_hit: false,
        errors: [],
      },
    }
    const bump = (key: string, n = 1) => {
      report.rejected[key] = (report.rejected[key] ?? 0) + n
    }

    if (!dryRun) {
      await drainPending()
    }

    const cursor = loadCursor()
    const all = await deps.listSessions()

    // 条件⑤：剔除 subagent 子会话（parent_id 非空即剔）——含手动指定 sessionIds 的场合。
    const eligible = all.filter((s) => s && typeof s.id === "string" && !s.parentId)

    // B1：收盘信号队列（memory-trigger 入队）必须有人消费。先读队列，
    // 其 sessionId/kinds 并入候选并排在正常选择之前；这批会话天然绕过当日 updated／
    // 计数门槛／游标去重（失败过的会话即使“处理过”也要重新提炼）。
    // 队列 IO 失败只 warn（listPendingSignals 已兜底回空阵列），不影响批次。
    const queued = await listPendingSignals()
    const queuedById = new Map<string, MemoryQueueRecord>()
    for (const rec of queued) {
      if (rec && typeof rec.sessionId === "string" && rec.sessionId && !queuedById.has(rec.sessionId)) {
        queuedById.set(rec.sessionId, rec)
      }
    }
    report.queue.pending = queuedById.size
    const queuedKindsById = new Map<string, MemoryQueueRecord["kinds"]>()
    for (const [id, rec] of queuedById) queuedKindsById.set(id, rec.kinds)
    // 队列会话的元资料：优先取目录列出的本尊；目录已无该会话（被删）仍以最小记录尝试，
    // transcript 取不到时走 no_docs 重试上限，最终自然落 failed/。
    const queuedSessions: MemorySessionRecord[] = []
    const eligibleById = new Map(eligible.map((s) => [s.id, s]))
    for (const id of queuedById.keys()) {
      const known = eligibleById.get(id)
      if (known) queuedSessions.push(known)
      else if (!all.some((s) => s && s.id === id)) queuedSessions.push({ id })
      // else：会话存在但是 subagent（parentId 非空）→ 尊重条件⑤，不入候选。
    }
    const queuedIdSet = new Set(queuedSessions.map((s) => s.id))

    let candidates: MemorySessionRecord[]
    if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
      // 手动指定：以调用方清单为准，不擅自塞入队列会话（信号仍在队列里等下次排程）。
      const wanted = new Set(options.sessionIds.map(String))
      candidates = eligible.filter((s) => wanted.has(s.id))
    } else {
      const normal = eligible.filter(
        // 条件①当日 updated；条件②用户消息≥3 或有成功工具呼叫；条件④游标去重（含已处理无产出）。
        (s) =>
          !queuedIdSet.has(s.id) &&
          isoDateOf(s.updatedAt) === date &&
          ((s.userMessages ?? 0) >= 3 || (s.successfulToolCalls ?? 0) >= 1) &&
          !cursor.processed[s.id],
      )
      // 条件③：知识型工具加权排序（降序；同权取较新）。
      normal.sort(
        (a, b) =>
          (b.knowledgeToolCalls ?? 0) - (a.knowledgeToolCalls ?? 0) ||
          epochOf(b.updatedAt) - epochOf(a.updatedAt),
      )
      // 队列优先：先处理失败/纠正信号，再跑常规当日扫描。
      candidates = [...queuedSessions, ...normal]
      // 预算：会话数截断入报告（队列在前，溢出先砍常规候选）。
      if (candidates.length > maxSessions) {
        report.truncations.sessions = candidates.length - maxSessions
        candidates = candidates.slice(0, maxSessions)
      }
    }
    report.candidates = candidates.length
    report.ledger.sessions_selected = candidates.length

    const docs: IngestDocInput[] = []
    // 审计（2026-10-19）：逐会话记录本轮产出的文档身份键，供 ingest 回执后换算 stored 数。
    // 只影响审计，不参与筛选、门禁、预算或入库决策。身份键＝scope|ownerKey|domain|slug：
    // 同 slug 不同 domain / owner 必须分别计数（旧 slug Set 会少计）。
    const sessionDocKeys = new Map<string, Set<string>>()
    // B3 账本：真正进入处理（transcript/LLM）的会话集合；预算跳过的不算。
    const processedSessions = new Set<string>()
    let llmUsed = 0
    const gateCtxBase: Omit<GateContext, "ownerKeyHint"> = { sharedEnabled }

    /**
     * G8 双模型一致闸（契约 §5、PRD §5.4，仅 shared、postIngest 前逐条）：
     * 三布尔全 true 才过；收到非 JSON／栏位非 true → 丢弃（g8_rejected）。
     * 模型未配置／LLM 预算耗尽／verifier 呼叫失败 → skip（g8_skipped 诚实旗标：
     * 不静默放过——报告留痕；不误杀——基础设施失败不判候选有罪）。
     * dryRun 不启动闸 LLM（curator 是预览主体照跑，但抽检／验证属「会等的钱」不花）。
     */
    async function g8Check(doc: IngestDocInput): Promise<"pass" | "reject" | "skip"> {
      if (!verifierModel) return "skip"
      if (llmUsed >= maxLlm) return "skip"
      llmUsed += 1
      let text = ""
      try {
        text = await deps.callVerifierLlm(
          `${VERIFIER_PROMPT_V1}\n\n${JSON.stringify(doc)}`,
          verifierModel,
        )
      } catch {
        return "skip"
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        return "reject" // 有回应但不可信 → 丢弃（spec：非 JSON→丢弃）。
      }
      const v = parsed as { transferable?: unknown; evidenced?: unknown; clean?: unknown }
      return v && v.transferable === true && v.evidenced === true && v.clean === true
        ? "pass"
        : "reject"
    }

    type OracleOutcome =
      | { kind: "score"; score: number; reason: string }
      | { kind: "error" }
      | { kind: "budget" }

    /**
     * §5.6 oracle 逐条判分（0/1/2）。呼叫失败＝error（不计入 avg）；预算耗尽＝budget
     * （sampling.skipped）；收到畸形输出（非 JSON／score 非 0/1/2）→ fail-closed 记 0
     * （抽检的终态是人工可 activate 放行，误伤可逆，宁可送复核）。
     */
    async function oracleOf(doc: IngestDocInput): Promise<OracleOutcome> {
      if (llmUsed >= maxLlm) return { kind: "budget" }
      llmUsed += 1
      let text = ""
      try {
        text = await deps.callOracleLlm(`${ORACLE_PROMPT_V1}\n\n${JSON.stringify(doc)}`, oracleModel)
      } catch {
        return { kind: "error" }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        return { kind: "score", score: 0, reason: "oracle_unparseable" }
      }
      const record = parsed as { score?: unknown; reason?: unknown }
      if (record?.score !== 0 && record?.score !== 1 && record?.score !== 2) {
        return { kind: "score", score: 0, reason: "oracle_unparseable" }
      }
      return {
        kind: "score",
        score: record.score,
        reason: typeof record.reason === "string" ? record.reason.slice(0, 200) : "",
      }
    }

    /** 抽检样本逐条落 badcase 集（【本地决定】比照 pending 目录系 → `memory-badcases/`）。 */
    function writeBadcase(docId: string, doc: IngestDocInput, score: number, reason: string): void {
      writeJsonFile(join(badcasesDir, `${safeFileSegment(docId)}.json`), {
        doc_id: docId,
        batch_id: batchId,
        date,
        sampled_at: deps.now().toISOString(),
        scope: doc.scope,
        domain: doc.domain,
        slug: doc.slug,
        description: doc.description,
        type: doc.type,
        body: doc.body,
        evidence: doc.evidence ?? "",
        evidence_kind: doc.evidenceKind,
        self_score: doc.selfScore,
        oracle_score: score,
        oracle_reason: reason,
      })
    }

    /**
     * 入库后抽检（只认端点回执 accepted＝「真写入」权威）：
     * shared 随机 30%（最少 3、不足全抽）→ oracle；平均 <1.5 或任一 0 分 →
     * POST `/api/agent/memory/review` {batch_id, action:"pending_review"}（同一 HMAC
     * 签名通道；repo 端预设只翻 shared，见 store reviewMemoryDocs）。
     * private 同机制判分但只记 badge 不翻转（PRD §5.6）。
     */
    async function runSampling(acceptedIds: string[], acceptedRefs: MemoryAcceptedRef[] = []): Promise<void> {
      const sampling = report.sampling
      const acceptedSet = new Set(acceptedIds)
      // 2026-10-19：store 改用确定性 id `mem-<hash>`，旧 `${batchId}-${slug}` 匹配会全部落空
      // （stored=1 / sampled=0 / skipped=0，审计 no_docs）。优先按 refs 的
      // scope|ownerKey|domain|slug 映射；同 key 取最后一条（与回执顺序一致）。
      const refByKey = new Map<string, MemoryAcceptedRef>()
      // 旧端点/部分回执可能不带 ownerKey（private 亦然）：记录 scope|domain|slug 组，
      // 仅在「唯一」时作为弱匹配兜底，避免跨 owner 同名 slug 误配。
      const weakByKey = new Map<string, MemoryAcceptedRef[]>()
      for (const ref of acceptedRefs) {
        if (!acceptedSet.has(ref.id)) continue
        // shared 近重复合并：ref.domain/slug 是落盘 target（已存在），候选身份在 input*；
        // 建映射时优先 input，缺 input 才用 target，确保抽检命中本批候选。
        const identity = acceptedRefInputIdentity(ref)
        refByKey.set(memoryIdentityKey({ scope: ref.scope, ownerKey: ref.ownerKey, ...identity }), ref)
        const weakKey = `${ref.scope}|${identity.domain}|${identity.slug}`
        const list = weakByKey.get(weakKey)
        if (list) list.push(ref)
        else weakByKey.set(weakKey, [ref])
      }
      const pairs: Array<{ id: string; doc: IngestDocInput }> = []
      for (const doc of docs) {
        let ref = refByKey.get(memoryIdentityKey(doc))
        if (!ref) {
          const weak = weakByKey.get(`${doc.scope}|${doc.domain}|${doc.slug}`)
          if (weak && weak.length === 1) ref = weak[0]
        }
        if (ref) {
          pairs.push({ id: ref.id, doc })
          continue
        }
        // fallback（refs 缺失/未覆盖该条时）：旧 `${batchId}-${slug}` 精确 id + 唯一后缀。
        // 纯后缀兜底仅在唯一命中时采用，避免跨会话同名 slug 命中别人的 accepted id。
        const expected = `${batchId}-${doc.slug}`
        if (acceptedSet.has(expected)) {
          pairs.push({ id: expected, doc })
          report.accepted_refs_fallback = (report.accepted_refs_fallback ?? 0) + 1
          continue
        }
        const suffixMatches = acceptedIds.filter((id) => id.endsWith(`-${doc.slug}`))
        if (suffixMatches.length === 1) {
          pairs.push({ id: suffixMatches[0], doc })
          report.accepted_refs_fallback = (report.accepted_refs_fallback ?? 0) + 1
        }
      }
      // 3) 报告可见性：accepted id 既没有被 refs 命中、旧 fallback 也未命中 → 计数。
      // 不计入 skipped（skipped 的语义固定为「无 oracle 模型/预算」），也绝不静默吞掉。
      const matchedIds = new Set(pairs.map((pair) => pair.id))
      let unmatched = 0
      for (const id of acceptedIds) {
        if (!matchedIds.has(id)) unmatched += 1
      }
      if (unmatched > 0) report.accepted_refs_unmatched = (report.accepted_refs_unmatched ?? 0) + unmatched
      const sharedPairs = pairs.filter((pair) => pair.doc.scope === "shared")
      const privatePairs = pairs.filter((pair) => pair.doc.scope === "private")
      if (!oracleModel) {
        sampling.skipped = sharedPairs.length + privatePairs.length
        return
      }
      const scores: number[] = []
      for (const pair of shuffleSample(sharedPairs, sampleSize(sharedPairs.length))) {
        const outcome = await oracleOf(pair.doc)
        if (outcome.kind === "error") {
          sampling.errors += 1
          continue
        }
        if (outcome.kind === "budget") {
          sampling.skipped += 1
          continue
        }
        scores.push(outcome.score)
        writeBadcase(pair.id, pair.doc, outcome.score, outcome.reason)
      }
      sampling.sampled = scores.length
      const avg = scores.length > 0 ? roundAvg(scores.reduce((a, b) => a + b, 0), scores.length) : null
      sampling.avg = avg
      sampling.triggered =
        avg !== null && (scores.some((s) => s === 0) || avg < SAMPLING_AVG_TRIGGER)
      if (sampling.triggered) {
        const reviewRaw = JSON.stringify({ batch_id: batchId, action: "pending_review" })
        const { ok } = await postSigned(REVIEW_PATH, reviewRaw)
        if (!ok) bump("review_post_failed") // 翻转请求送出失败：留痕，不假装已转。
      }
      for (const pair of shuffleSample(privatePairs, sampleSize(privatePairs.length))) {
        const outcome = await oracleOf(pair.doc)
        if (outcome.kind === "error") {
          sampling.errors += 1
          continue
        }
        if (outcome.kind === "budget") {
          sampling.skipped += 1
          continue
        }
        writeBadcase(pair.id, pair.doc, outcome.score, outcome.reason)
        if (outcome.score < 2) sampling.private_badged += 1
      }
    }

    await mapPool(candidates, CONCURRENCY, async (session) => {
      if (llmUsed >= maxLlm) {
        report.truncations.llm_budget_hit = true
        return // 预算截断：不标已处理，留给下批。
      }
      // 预算槽在进入处理时立即占用：并发 3 下若等到 transcript 之后才 +1，
      // 多个 worker 会同时通过上面的检查而超发（B3 账本 llm_calls ≤ 上限的保证）。
      llmUsed += 1
      // 进入逐会话处理（含后续 transcript/LLM 失败路径）才计入审计；预算跳过的不算「处理过」。
      processedSessions.add(session.id)
      const sessionKeys = new Set<string>()
      sessionDocKeys.set(session.id, sessionKeys)
      const mark = (produced: boolean) => {
        cursor.processed[session.id] = { at: nowDate.toISOString(), produced }
      }
      let transcript = ""
      try {
        transcript = await deps.transcriptOf(session.id)
      } catch {
        bump("transcript_error")
        mark(false)
        return
      }
      if (!transcript || transcript.trim().length === 0) {
        bump("empty_transcript")
        mark(false)
        return
      }
      // 回环形状比照轮子 handleExtractLessons：prompt + \n\n<transcript>\n…\n</transcript>。
      // B1：队列会话额外在**用户内容**加一段收盘信号提示（只带 kinds，不带 sample 正文，
      // 避免把失败样本原样塞进 prompt 挤占预算）；CURATOR_PROMPT_V1 契约骨架不变。
      const signalKinds = queuedKindsById.get(session.id)
      const signalNote =
        signalKinds && signalKinds.length > 0
          ? `\n\n<close_out_signal>\nThis session was flagged at close-out for: ${signalKinds.join(", ")}. Extract only transferable long-term lessons from the failure or correction. Do not store the specific task answer, this request's output spec, or details of a single incident.\n</close_out_signal>`
          : ""
      const prompt = `${CURATOR_PROMPT_V1}${signalNote}\n\n<transcript>\n${transcript}\n</transcript>`
      let text = ""
      try {
        text = await deps.callLlm(prompt)
      } catch {
        bump("llm_error")
        mark(false)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        bump("g1_structure")
        mark(false)
        return
      }
      const rawList = (parsed as { candidates?: unknown })?.candidates
      if (!Array.isArray(rawList)) {
        bump("g1_structure")
        mark(false)
        return
      }
      const ctx: GateContext = { ...gateCtxBase, ownerKeyHint: session.ownerKey, sourceSessionId: session.id }
      let produced = false
      for (const raw of rawList) {
        const gated = applyMemoryGates(raw as CuratorCandidate, ctx)
        if (gated.action === "drop" || !gated.doc) {
          bump(gated.reason)
          continue
        }
        const doc: IngestDocInput = { ...gated.doc, promptVersion: MEMORY_PROMPT_VERSION }
        if (doc.scope === "private") {
          if (!doc.ownerKey && session.ownerKey) doc.ownerKey = session.ownerKey
          // 无 ownerKey 的 private 无处安放（§2 私有正文路径需要它）→ 丢弃计数。
          if (!doc.ownerKey) {
            bump("g4_no_owner")
            continue
          }
        }
        // G8（契约 §5，仅 shared、postIngest 前逐条）；dryRun 不启动闸 LLM。
        if (doc.scope === "shared" && !dryRun) {
          const verdict = await g8Check(doc)
          if (verdict === "reject") {
            bump("g8_rejected")
            continue
          }
          if (verdict === "skip") report.g8_skipped += 1
        }
        report.passed += 1
        docs.push(doc)
        sessionKeys.add(memoryIdentityKey(doc))
        produced = true
      }
      mark(produced)
    })

    // 写入：只认端点回执 accepted（§3.1「真写入」）；非 dryRun 才发。
    const acceptedIds: string[] = []
    /** store 确定性 id 回执（2026-10-19）；旧端点不返回时为空，后续走 legacy fallback。 */
    let acceptedRefs: MemoryAcceptedRef[] = []
    // 服务端拒绝的身份键集合（审计归属用；旧 rejected 形状只有 {slug, reason}）。
    const rejectedKeys = new Set<string>()
    if (!dryRun && docs.length > 0) {
      const body = {
        batch_id: batchId,
        prompt_version: MEMORY_PROMPT_VERSION,
        docs,
      }
      const rawBody = JSON.stringify(body) // 签名与送出共用同一串 raw bytes。
      const { ok, json } = await attemptPost(rawBody)
      if (ok) {
        const accepted = Array.isArray(json?.accepted) ? (json?.accepted as unknown[]) : []
        // 2026-10-19：确定性 id 回执（snake/camel 均可）；解析失败/缺省 → 空，保留旧匹配。
        acceptedRefs = parseAcceptedRefs(json?.accepted_refs ?? json?.acceptedRefs)
        // proposals＝未提升的正文提案（live 未变），不是真写入：不计 stored、不进
        // acceptedIds、不参与抽检，也不参与 stored/no_docs 审计归属。
        const proposals = Array.isArray(json?.proposals) ? (json?.proposals as unknown[]) : []
        // noop＝端点判定与既有记忆重复、已合并确认但未重复写入（不是 rejected，也不是 stored）。
        // superseded＝端点判定旧记忆被新文档取代（对应新文档通常已 accepted，不重复扣）。
        const noop = Array.isArray(json?.noop) ? (json?.noop as unknown[]) : []
        const superseded = Array.isArray(json?.superseded) ? (json?.superseded as unknown[]) : []
        report.stored = accepted.length
        report.noop = noop.length
        report.superseded = superseded.length
        for (const id of accepted) acceptedIds.push(String(id))
        const rejected = Array.isArray(json?.rejected)
          ? (json?.rejected as Array<{
              slug?: unknown
              reason?: unknown
              scope?: unknown
              domain?: unknown
              ownerKey?: unknown
              owner_key?: unknown
            }>)
          : []
        for (const r of rejected) {
          const slug = typeof r?.slug === "string" ? r.slug : ""
          if (slug) {
            // 1) 新回执带 scope+domain（+ownerKey）→ 直接组完整身份键（权威归属）。
            const rScope = typeof r?.scope === "string" ? r.scope : ""
            const rDomain = typeof r?.domain === "string" ? r.domain : ""
            const rOwner =
              typeof r?.ownerKey === "string"
                ? r.ownerKey
                : typeof r?.owner_key === "string"
                  ? r.owner_key
                  : undefined
            if (rScope && rDomain) {
              rejectedKeys.add(memoryIdentityKey({ scope: rScope, ownerKey: rOwner, domain: rDomain, slug }))
            } else {
              // 2) 旧形状（只有 slug）：仅当该 slug 在本批是**唯一身份**时才标 rejected。
              // 同 slug 多身份（含 mda accepted + mdb rejected）无法唯一确定 → 不标任何一条，
              // 宁可少标不可误标（稍后 accepted 键还会从 rejectedKeys 中剔除），并计数可见。
              const identityKeys = new Set(docs.filter((doc) => doc.slug === slug).map((doc) => memoryIdentityKey(doc)))
              if (identityKeys.size === 1) {
                rejectedKeys.add([...identityKeys][0])
              } else {
                report.rejected_refs_unmatched = (report.rejected_refs_unmatched ?? 0) + 1
              }
            }
          }
          bump(`server_${typeof r?.reason === "string" ? r.reason : "unknown"}`)
        }
        if (accepted.length + proposals.length + noop.length < docs.length && rejected.length === 0) {
          bump("server_silent_loss") // 回执不齐：端点没给逐条原因（G7 截断除外），记帐不吞。
        }
        // §5.6：端点回执 accepted 之后才抽检（未写入的没有品质可审）。
        await runSampling(accepted.map((id) => String(id)), acceptedRefs)
      } else {
        // 非 2xx／网路失败 → 写 pending 档（指数退避重试由 drainPending 接手）。
        writePending({
          batch_id: batchId,
          created_at: nowDate.toISOString(),
          attempts: 1,
          next_retry_at: deps.now().getTime() + 2 * 60_000,
          raw_body: rawBody,
        })
        bump("ingest_pending")
      }
    }

    // B1：消费收盘信号队列（只在真跑批次时动队列；dryRun 只读预览）。
    //   - 有候选 → 已提交 ingest（accepted/pending 都算），markSignalDone 出队 + drained 审计；
    //   - 零候选 → recordSignalNoDocs（attempts+1）；≥5 次原子移入 failed/ 并审计
    //     dropped_after_attempts，避免信号永久滞留、每批重复烧 LLM。
    // 队列 IO 全部只 warn（函数内已兜底），绝不影响批次结果。
    if (!dryRun) {
      for (const sessionId of processedSessions) {
        const kinds = queuedKindsById.get(sessionId)
        if (!kinds) continue // 非队列会话：不碰队列。
        const keys = sessionDocKeys.get(sessionId)
        if (keys && keys.size > 0) {
          if (await markSignalDone(sessionId)) {
            report.queue.consumed += 1
            void appendMemoryAudit({ event: "drained", sessionId, kinds })
          }
        } else {
          report.queue.no_docs += 1
          const outcome = await recordSignalNoDocs(sessionId)
          if (outcome.dropped) {
            report.queue.failed += 1
            void appendMemoryAudit({ event: "dropped_after_attempts", sessionId, kinds })
            console.error(
              `[memory-batch] signal dropped after ${outcome.attempts} no-doc attempts: session=${sessionId}`,
            )
          }
        }
      }
    }

    // 2026-10-19 批次审计（工单任务 4）：逐会话处理结束处落 stored/no_docs。
    // 只在非 dryRun 且真的处理过该会话时写；`appendMemoryAudit` 永不 throw，
    // 审计失败不影响批次（也不算进批次报告，不改变任何既有统计口径）。
    if (!dryRun) {
      // stored 归属只按 accepted（真写入）计：proposals（未提升提案）不在 acceptedIds，
      // 天然不计入。G5 更新可能沿用旧批次 id：仅当该 id 在本批 docs 中对应唯一 slug
      // 后缀时才归属；跨会话同名后缀有歧义则不归属（宁缺勿错）。
      const acceptedKeys = new Set<string>()
      // 2026-10-19：优先按 accepted_refs 归属（确定性 id `mem-<hash>` 不含 slug）。
      // 近重复合并时 ref.domain/slug 是已存在的 target，必须用 input*（候选身份）归属本批。
      // 只认 acceptedSet 内的 ref；refs 未覆盖的 accepted id 才走旧前缀/唯一后缀匹配。
      const acceptedSet = new Set(acceptedIds)
      const refCoveredIds = new Set<string>()
      for (const ref of acceptedRefs) {
        if (!acceptedSet.has(ref.id)) continue
        const identity = acceptedRefInputIdentity(ref)
        acceptedKeys.add(memoryIdentityKey({ scope: ref.scope, ownerKey: ref.ownerKey, ...identity }))
        // refs 未带 ownerKey：用本批候选唯一匹配补精确身份键（与抽检弱匹配同规则）。
        // 两 owner 同 slug 时匹配不唯一 → 不归属（宁缺勿错，抽检侧另有 unmatched 计数）。
        if (ref.ownerKey === undefined) {
          const matches = docs.filter(
            (doc) => doc.scope === ref.scope && doc.domain === identity.domain && doc.slug === identity.slug,
          )
          if (matches.length === 1) acceptedKeys.add(memoryIdentityKey(matches[0]))
        }
        refCoveredIds.add(ref.id)
      }
      for (const id of acceptedIds) {
        if (refCoveredIds.has(id)) continue
        const exact = docs.find((doc) => `${batchId}-${doc.slug}` === id)
        if (exact) {
          acceptedKeys.add(memoryIdentityKey(exact))
          continue
        }
        const suffixMatches = docs.filter((doc) => id.endsWith(`-${doc.slug}`))
        if (suffixMatches.length === 1) acceptedKeys.add(memoryIdentityKey(suffixMatches[0]))
      }
      // accepted 优先：同批同 slug／同身份既有 accepted 又有 rejected 回执时（如 mda 写入、
      // mdb time_range 被拒），不能因 rejected 键把已写入身份排除出 stored。
      for (const key of acceptedKeys) rejectedKeys.delete(key)
      for (const [sessionId, keys] of sessionDocKeys) {
        // 精确归属（P2-5）：只看本会话产出的身份键里真正出现在 accepted 的条目；
        // 未写入（含 proposals）与 rejected 一律不算 stored。同 slug 不同 domain 分别计数。
        let stored = 0
        for (const key of keys) {
          if (acceptedKeys.has(key) && !rejectedKeys.has(key)) stored += 1
        }
        if (stored > 0) void appendMemoryAudit({ event: "stored", sessionId, stored })
        else void appendMemoryAudit({ event: "no_docs", sessionId })
      }
    }

    // B3 账本：应处理 vs 实处理、LLM 次数、候选/入库/拒绝数；结束时做两条断言式自检，
    // 违反只记 error（报告 errors＋console），绝不 throw——账本观察失败不能杀死批次。
    report.ledger.sessions_processed = processedSessions.size
    report.ledger.llm_calls = llmUsed
    report.ledger.docs_proposed = docs.length
    report.ledger.docs_stored = report.stored
    // 未入库的候选：服务端 rejected／ingest pending（dryRun 下未送，全部计入未入库）。
    // noop（重复已合并确认）不算 rejected；superseded 对应的新文档通常已 accepted，不重复扣。
    report.ledger.docs_rejected = Math.max(0, docs.length - report.stored - report.noop)
    report.ledger.budget_hit = report.truncations.llm_budget_hit
    if (report.ledger.docs_stored > report.ledger.docs_proposed) {
      report.ledger.errors.push("stored_exceeds_proposed")
    }
    if (report.ledger.llm_calls > maxLlm) {
      report.ledger.errors.push(`llm_calls_exceeds_budget:${report.ledger.llm_calls}>${maxLlm}`)
    }
    for (const ledgerError of report.ledger.errors) {
      console.error(`[memory-batch] ledger assertion failed: ${ledgerError}`)
    }

    writeJsonFile(cursorPath, cursor)
    report.report_path = join(REPORTS_DIR, `${batchId}.json`)
    writeJsonFile(join(reportsDir, `${batchId}.json`), report)
    return report
  }

  return { runBatch, drainPending }
}
export { MEMORY_SIGNATURE_HEADER, signMemoryBody, signMemoryBytes, signEmptyMemoryBody } from "./memory-batch-http.ts"
export { MEMORY_PROMPT_VERSION, CURATOR_PROMPT_V1, VERIFIER_PROMPT_V1, ORACLE_PROMPT_V1 } from "./memory-batch-types.ts"
export type { IngestDocInput, MemoryAcceptedRef, MemorySessionRecord, MemoryBatchEnv, MemoryBatchDeps, MemoryBatchOptions, MemorySamplingReport, MemoryBatchReport } from "./memory-batch-types.ts"
