import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

// Synchronous user admission barrier: background delivery must yield before any user request awaits.
export const generationUserAdmissions = new Map<string, number>()

// Same durable state directory as sessions, outside release symlinks. No credentials.
let connection: Database | undefined
function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS generation_consumers (
    child_oc TEXT PRIMARY KEY, parent_gw TEXT NOT NULL, parent_oc TEXT NOT NULL, created_at INTEGER NOT NULL, consumer_agent TEXT);
    CREATE TABLE IF NOT EXISTS generation_receipts (
      task_id TEXT PRIMARY KEY, parent_gw TEXT NOT NULL, producer_oc TEXT NOT NULL,
      consumer_oc TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', artifacts TEXT NOT NULL DEFAULT '[]',
      observed_at INTEGER, downloaded_at INTEGER, notified_at INTEGER, rendered_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subagent_durable_runs (run_id TEXT PRIMARY KEY, parent_gw TEXT NOT NULL, child_oc TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_owner_identities (parent_gw TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_project_authorizations (owner_scope TEXT NOT NULL, project TEXT NOT NULL, cap_coins REAL NOT NULL CHECK(cap_coins>=0), version INTEGER NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_scope,project));
    CREATE TABLE IF NOT EXISTS generation_runtime_control (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS generation_receipts_parent ON generation_receipts(parent_gw);
    CREATE INDEX IF NOT EXISTS generation_receipts_pending ON generation_receipts(status,observed_at);`)
  if (!(next.query("PRAGMA table_info(generation_consumers)").all() as any[]).some((c) => c.name === "consumer_agent")) next.exec("ALTER TABLE generation_consumers ADD COLUMN consumer_agent TEXT")
  // intent_version：当前无业务读者（generationProducerVersion 已删），保留列不保留读者——既有库兼容。
  if (!(next.query("PRAGMA table_info(generation_consumers)").all() as any[]).some((c) => c.name === "intent_version")) next.exec("ALTER TABLE generation_consumers ADD COLUMN intent_version INTEGER NOT NULL DEFAULT 0")
  if (!(next.query("PRAGMA table_info(generation_receipts)").all() as any[]).some((c) => c.name === "notify_count")) next.exec("ALTER TABLE generation_receipts ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0")
  connection = next
  return next
}

/** 测试钩子：关掉当前连接，下次按当时的 SESSIONS_DB_PATH 重开。不删除数据库文件。生产路径不调用。 */
export function reopenSessionsDbForTest(): void {
  if (!connection) return
  connection.close()
  connection = undefined
}

export function bindGenerationConsumer(child: string, parentGw: string, parentOc: string, agent?: string): void {
  // intent_version：当前无业务读者，保留列不保留读者（既有库兼容）。
  db().query("INSERT INTO generation_consumers(child_oc,parent_gw,parent_oc,created_at,consumer_agent,intent_version) VALUES (?,?,?,?,?,?) ON CONFLICT(child_oc) DO NOTHING")
    .run(child, parentGw, parentOc, Date.now(), agent || null, generationWorkControl(parentGw).version)
  const binding = generationParent(child)
  if (binding?.parent_gw !== parentGw || binding.parent_oc !== parentOc) throw new Error("consumer ownership is immutable")
  if (agent) db().query("UPDATE generation_consumers SET consumer_agent=COALESCE(consumer_agent,?) WHERE child_oc=?").run(agent, child)
  db().query("UPDATE generation_receipts SET parent_gw=? WHERE producer_oc=? AND parent_gw=''").run(parentGw, child)
}
export function queueLegacyGenerationWake(session: string, content: string, parentGw = "", consumer = session): GenerationReceipt {
  const task_id = `wake:${createHash("sha256").update(session + "\0" + content).digest("hex")}`
  const row = registerGenerationReceipt({ task_id, parent_gw: parentGw, producer_oc: session, consumer_oc: consumer,
    kind: "message", content })
  if (row.status === "queued") return completeGenerationReceipt(task_id, "succeeded", [], { content })
  return row
}
export function generationParent(child: string): { parent_gw: string; parent_oc: string; consumer_agent?: string } | undefined {
  return db().query("SELECT parent_gw,parent_oc,consumer_agent FROM generation_consumers WHERE child_oc=?").get(child) as any ?? undefined
}

// 工作控制与既有生成回执共用一个耐久数据库。停止模型不等于撤销外部副作用。
export function generationWorkControl(parentGw: string): { version: number; cancelled: boolean; reason?: string; changed_mono?: string } {
  const row = db().query("SELECT value FROM generation_runtime_control WHERE name=?").get(`intent:${parentGw}`) as { value: string } | null
  return row ? JSON.parse(row.value) : { version: 0, cancelled: false }
}
export function setGenerationWorkCancelled(parentGw: string, cancelled: boolean, reason: string): void {
  db().transaction(() => {
    const current = generationWorkControl(parentGw)
    if (current.cancelled === cancelled) return
    db().query("INSERT INTO generation_runtime_control(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
      .run(`intent:${parentGw}`, JSON.stringify({ version: current.version + 1, cancelled, reason, changed_at: Date.now(), changed_mono: process.hrtime.bigint().toString() }))
  }).immediate()
}
export function cancelGenerationProducer(producer: string): void {
  const revision = generationProducerRevision(producer) + 1
  db().query("INSERT INTO generation_runtime_control(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
    .run(`producer-revision:${producer}`, String(revision))
  db().query("INSERT INTO generation_runtime_control(name,value) VALUES(?,?) ON CONFLICT(name) DO NOTHING")
    .run(`producer-cancel:${producer}`, String(Date.now()))
}
/** 续跑同一 producer（沿用同一 opencodeSessionId）＝新工作代：删掉 hard stop 留下的封条，
 *  否则该子会话恢复后所有新提交都会被 assertGenerationWorkActive 永久挡成 409。 */
export function clearGenerationProducerCancel(producer: string, newWork = false): void {
  db().query("DELETE FROM generation_runtime_control WHERE name=?").run(`producer-cancel:${producer}`)
  const parent = generationParent(producer)
  if (newWork && parent) db().query("UPDATE generation_consumers SET intent_version=? WHERE child_oc=?")
    .run(generationWorkControl(parent.parent_gw).version, producer)
}
function generationProducerRevision(producer: string): number {
  return Number((db().query("SELECT value FROM generation_runtime_control WHERE name=?").get(`producer-revision:${producer}`) as any)?.value || 0)
}
function musicOperationKey(producer: string, operation: string): string {
  return `music-operation:${createHash("sha256").update(producer + "\0" + operation).digest("hex")}`
}
export function captureMusicOperation(parent: string, producer: string, operation: string, invocation: string, startedMono?: string): any {
  return db().transaction(() => {
    const key = musicOperationKey(producer, operation)
    const existing = db().query("SELECT value FROM generation_runtime_control WHERE name=?").get(key) as any
    if (existing) {
      const value = JSON.parse(existing.value)
      const result = generationReceipt(key)?.result
      if (result) return { ...value, result }
      if (value.invocation !== invocation) throw new Error("music_submission_unknown: 原调用尚无完成回执，禁止重放生成")
      return value
    }
    assertGenerationWorkActive(parent, producer)
    const changedMono = generationWorkControl(parent).changed_mono
    if (changedMono && startedMono && BigInt(startedMono) <= BigInt(changedMono))
      throw new Error("generation_work_cancelled: 原调用开始后工作代已改变")
    const version = generationWorkControl(parent).version
    const binding = db().query("SELECT intent_version FROM generation_consumers WHERE child_oc=?").get(producer) as any
    if (binding && binding.intent_version !== version) throw new Error("generation_work_cancelled: 旧 producer 不得继承新工作代")
    const value = { parent, producer, operation, invocation, version, producer_revision: generationProducerRevision(producer) }
    db().query("INSERT INTO generation_runtime_control(name,value) VALUES(?,?)").run(key, JSON.stringify(value))
    registerGenerationReceipt({ task_id: key, parent_gw: parent, producer_oc: producer,
      consumer_oc: generationParent(producer)?.parent_oc || producer, kind: "audio",
      operation_id: operation, work_version: version, result_source: "runtime_music", submission_state: "admitted" })
    return value
  }).immediate()
}
export function checkMusicOperation(parent: string, producer: string, operation: string, invocation: string): void {
  const row = db().query("SELECT value FROM generation_runtime_control WHERE name=?").get(musicOperationKey(producer, operation)) as any
  if (!row) throw new Error("music_operation_missing")
  const value = JSON.parse(row.value)
  if (value.parent !== parent || value.invocation !== invocation) throw new Error("music_operation_owner_mismatch")
  assertGenerationWorkActive(parent, producer)
  if (value.version !== generationWorkControl(parent).version || value.producer_revision !== generationProducerRevision(producer))
    throw new Error("generation_work_cancelled: 原调用的工作代已撤销，不能继承后续新工作")
  completeGenerationReceipt(musicOperationKey(producer, operation), "unknown", [], { submission_state: "dispatch_requested" })
}
export function completeMusicOperation(parent: string, producer: string, operation: string, invocation: string, result: any): void {
  const key = musicOperationKey(producer, operation)
  const row = db().query("SELECT value FROM generation_runtime_control WHERE name=?").get(key) as any
  if (!row) throw new Error("music_operation_missing")
  const value = JSON.parse(row.value)
  if (value.parent !== parent || value.invocation !== invocation) throw new Error("music_operation_owner_mismatch")
  // Runtime audio operation ID is not a platform job ID. Preserve the actual
  // result and billing receipt even when its model run has been cancelled.
  const body = JSON.parse(result.output)
  const urls = new Set<string>([body.url, ...(Array.isArray(body.audios) ? body.audios.map((a: any) => a.url) : [])].filter((url) => typeof url === "string" && /^https?:\/\//.test(url)))
  const artifacts = [...urls].map((url) => ({ url, ...(body.mime_type ? { mimeType: body.mime_type } : {}) }))
  completeGenerationReceipt(key, body.ok === false ? "failed" : artifacts.length ? "succeeded" : "unknown", artifacts,
    { result, cost_coins: body.cost_coins, reason: body.message || body.code, submission_state: "completed" })
}
/** 封条 TTL：封条只封停止当时那批工作，不封会话终身。 */
export const PRODUCER_CANCEL_TTL_MS = 6 * 3600 * 1000
/**
 * 提交新生成前的工作控制闸：只判「用户已撤销当前工作」这一件事。
 * 不比较 version——用户取消再恢复后 version 永久前移，比较 version 会把合法生成永久封死。
 * 已提交的任务不走这里，仍按真实回执处理。
 * producer-cancel 封条带 TTL：6 小时前的停止不拦后续新工作（过期顺手 DELETE）；
 * 值不可解析时按存在处理（fail-closed），值可信缺失时宁可多拦一次。
 */
export function assertGenerationWorkActive(parentGw: string, producer: string): void {
  const cancelled = generationWorkControl(parentGw).cancelled === true
  let producerCancelled = false
  const seal = db().query("SELECT value FROM generation_runtime_control WHERE name=?")
    .get(`producer-cancel:${producer}`) as { value: string } | null
  if (seal) {
    const raw = String(seal.value).trim()
    const sealedAt = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (Number.isFinite(sealedAt) && Date.now() - sealedAt > PRODUCER_CANCEL_TTL_MS) {
      clearGenerationProducerCancel(producer)
    } else {
      producerCancelled = true
    }
  }
  if (cancelled || producerCancelled) {
    throw new Error("generation_work_cancelled: 原工作已撤销，未提交新生成；已提交任务仍按真实回执处理")
  }
}
export type GenerationReceipt = {
  task_id: string; parent_gw: string; producer_oc: string; consumer_oc: string; kind: string;
  status: string; artifacts: Array<{ url: string; [key: string]: unknown }>;
  observed_at: number | null; downloaded_at: number | null; notified_at: number | null;
  created_at: number; updated_at: number; [key: string]: any
}
function decode(row: any): GenerationReceipt {
  return { ...JSON.parse(row.data), ...row, data: undefined, artifacts: JSON.parse(row.artifacts), submitted_at: row.created_at,
    url: JSON.parse(row.artifacts)[0]?.url }
}
export function generationReceipt(id: string): GenerationReceipt | undefined {
  const row = db().query("SELECT * FROM generation_receipts WHERE task_id=?").get(id)
  return row ? decode(row) : undefined
}
/** S5：工程会话（ProjectGraph）标记。持久化在 generation_runtime_control，重启不丢；未标记的会话行为逐字不变。 */
export function markProjectSession(parentGw: string): void {
  db().query("INSERT INTO generation_runtime_control(name,value) VALUES(?,?) ON CONFLICT(name) DO NOTHING").run(`project-mode:${parentGw}`, "1")
}
export function isProjectSession(parentGw: string): boolean {
  return !!db().query("SELECT 1 FROM generation_runtime_control WHERE name=?").get(`project-mode:${parentGw}`)
}
/** 工程会话里无 node_id 的图/视频登记＝绕过工程图的直接生成，一律 409（路由层应把 status 透出，见 S5 回报）。 */
export class ProjectNodeRequiredError extends Error {
  readonly status = 409
  readonly code = "project_node_required"
  constructor() { super("project_node_required: 工程会话的图片/视频生成必须经 project_run 绑定 node_id；未登记。") }
}
export function registerGenerationReceipt(input: Record<string, any>): GenerationReceipt {
  if ((input.kind === "image" || input.kind === "video") && !input.node_id && input.parent_gw && isProjectSession(input.parent_gw)) throw new ProjectNodeRequiredError()
  const now = Date.now()
  db().query("INSERT INTO generation_receipts(task_id,parent_gw,producer_oc,consumer_oc,kind,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING")
    .run(input.task_id, input.parent_gw, input.producer_oc, input.consumer_oc || input.producer_oc, input.kind, JSON.stringify(input), now, now)
  const receipt = generationReceipt(input.task_id)!
  if (receipt.parent_gw !== input.parent_gw || receipt.producer_oc !== input.producer_oc) throw new Error("job ownership conflict")
  return receipt
}
export function completeGenerationReceipt(id: string, status: string, artifacts: Array<{ url: string }>, extra: Record<string, any>): GenerationReceipt {
  const row = generationReceipt(id)
  if (!row) throw new Error("unregistered job")
  // 退款是已核实的财务终态；后续poll timeout/失败观察不能撤销退款或重新打开消费。
  // failed仍可由后来真实success/refund推进，queued进度ACK也不代替最终产物消费。
  if (row.status === "refunded" && status !== "refunded") return row
  // 已取消同理：poller超时只是观察失败，不能把cancelled改写成failed并清掉已消费标记；真实退款/晚到成功仍可推进。
  if (row.status === "cancelled" && status === "failed") return row
  if (status === "succeeded" && row.kind !== "message" && artifacts.length < (row.requested_count || 1)) throw new Error("authoritative batch is incomplete; retain task for recovery")
  // A previous failed observation must never hide a later real success.
  if (row.status === "succeeded" && status !== "succeeded") return row
  const changed = row.status !== status || JSON.stringify(row.artifacts) !== JSON.stringify(artifacts)
  const data = { ...row, ...extra, artifacts: undefined }
  db().query(`UPDATE generation_receipts SET status=?,artifacts=?,data=?,updated_at=?,
    observed_at=CASE WHEN ? THEN NULL ELSE observed_at END,
    downloaded_at=CASE WHEN ? THEN NULL ELSE downloaded_at END,
    notified_at=CASE WHEN ? AND kind<>'message' THEN NULL ELSE notified_at END,
    rendered_at=CASE WHEN ? THEN NULL ELSE rendered_at END WHERE task_id=?`)
    .run(status, JSON.stringify(artifacts), JSON.stringify(data), Date.now(), changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, id)
  return generationReceipt(id)!
}
/** 介质证据与登记 kind 不一致时纠正收件箱分类；不动 artifacts、时间戳与其它栏位。 */
export function reclassifyGenerationKind(id: string, kind: string): void {
  const row = generationReceipt(id)
  if (!row) throw new Error("unregistered job")
  db().query("UPDATE generation_receipts SET kind=?,data=?,updated_at=? WHERE task_id=?")
    .run(kind, JSON.stringify({ ...row, kind, data: undefined, artifacts: undefined }), Date.now(), id)
}
export function generationReceipts(parentGw?: string, pendingOnly = false): GenerationReceipt[] {
  const rows = parentGw
    ? db().query("SELECT * FROM generation_receipts WHERE parent_gw=? ORDER BY created_at").all(parentGw)
    : db().query("SELECT * FROM generation_receipts ORDER BY created_at").all()
  return rows.map(decode).filter((r) => !pendingOnly || (r.kind !== "message" && r.result_source !== "runtime_music" && r.status !== "succeeded" && r.status !== "refunded"))
}
export function acknowledgeGeneration(id: string, stage: string, extra: Record<string, any>): void {
  const row = generationReceipt(id)
  if (!row) throw new Error("unregistered job")
  if (stage === "downloaded") {
    const list = Array.isArray(extra.artifact_urls) ? extra.artifact_urls : []
    const urls = new Set(list)
    if (!["succeeded", "failed", "refunded", "cancelled"].includes(row.status) || !row.artifacts.length || urls.size !== list.length || list.length !== row.artifacts.length || !row.artifacts.every((a) => urls.has(a.url)))
      throw new Error("download ACK must cover exactly every authoritative artifact")
  }
  // S5：下载 ACK 的实算 sha256 按 url 留存（data.artifact_sha256）。不写回 artifacts 列：completeGenerationReceipt
  // 用列内容判 changed，列里混入 sha256 会让重复终态回调清掉 downloaded_at 而重复通知。
  const hashes: Record<string, string> = {}
  if (stage === "downloaded" && Array.isArray(extra.downloaded_artifacts))
    for (const a of extra.downloaded_artifacts) if (typeof a?.url === "string" && typeof a?.sha256 === "string") hashes[a.url] = a.sha256
  const artifactSha256 = Object.keys(hashes).length ? { artifact_sha256: { ...(row.artifact_sha256 ?? {}), ...hashes } } : {}
  db().query(`UPDATE generation_receipts SET observed_at=COALESCE(observed_at,?),
    downloaded_at=CASE WHEN ? THEN COALESCE(downloaded_at,?) ELSE downloaded_at END,
    data=?,updated_at=? WHERE task_id=?`)
    .run(Date.now(), stage === "downloaded" ? 1 : 0, Date.now(), JSON.stringify({ ...row, ...extra, ...artifactSha256, artifacts: undefined }), Date.now(), id)
}
export function generationArtifactSha256(id: string): Record<string, string> {
  return (generationReceipt(id)?.artifact_sha256 as Record<string, string> | undefined) ?? {}
}
export function notifyGeneration(ids: string[]): void {
  const update = db().query("UPDATE generation_receipts SET notified_at=?,notify_count=COALESCE(notify_count,0)+1 WHERE task_id=?")
  db().transaction(() => { for (const id of ids) update.run(Date.now(), id) })()
}
/** 消息唤醒提交前耐久占位；超时是提交结果未知，不能再盲投。真实消费 ACK 另记。 */
export function claimGenerationMessages(ids: string[], consumer: string): string[] {
  const claim = db().query(`UPDATE generation_receipts SET notified_at=?,updated_at=?
    WHERE task_id=? AND consumer_oc=? AND kind='message' AND observed_at IS NULL
      AND notified_at IS NULL AND status IN ('succeeded','failed','refunded','cancelled')`)
  return db().transaction(() => {
    const claimed: string[] = []
    const now = Date.now()
    for (const id of ids) if (claim.run(now, now, id, consumer).changes === 1) claimed.push(id)
    return claimed
  })()
}
export function transferGeneration(id: string, consumer: string, reason = "same-owner collector accepted receipt"): void {
  const row = generationReceipt(id)
  if (!row) throw new Error("unregistered job")
  db().query(`UPDATE generation_receipts SET consumer_oc=?,
    observed_at=CASE WHEN kind='message' THEN observed_at ELSE NULL END,
    notified_at=CASE WHEN kind='message' THEN notified_at ELSE NULL END,data=?,updated_at=? WHERE task_id=?`)
    .run(consumer, JSON.stringify({ ...row, artifacts: undefined, previous_consumer_oc: row.consumer_oc, transfer_reason: reason }), Date.now(), id)
}
export function renderedGeneration(id: string): void {
  db().query("UPDATE generation_receipts SET rendered_at=? WHERE task_id=?").run(Date.now(), id)
}

export function generationMaintenanceEnabled(): boolean {
  return (db().query("SELECT value FROM generation_runtime_control WHERE name='maintenance'").get() as any)?.value === '1'
}
export function setGenerationMaintenance(enabled: boolean): void {
  db().query("INSERT INTO generation_runtime_control VALUES('maintenance',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(enabled ? '1' : '0')
}
export function durableSubagentRun(id: string): any | undefined {
  const row: any = db().query("SELECT * FROM subagent_durable_runs WHERE run_id=?").get(id)
  return row ? { ...JSON.parse(row.data), status: row.status, result: row.result ? JSON.parse(row.result) : undefined, updated_at: row.updated_at } : undefined
}
export function durableSubagentRuns(): any[] {
  return (db().query("SELECT run_id FROM subagent_durable_runs").all() as any[]).map((r) => durableSubagentRun(r.run_id))
}
export function saveDurableSubagentRun(run: any, result?: any): void {
  const payload = JSON.stringify(run, (key, value) => /Timer$/.test(key) ? undefined : value instanceof Map ? { __map: [...value] } : value instanceof Set ? { __set: [...value] } : value)
  db().transaction(() => {
    const existing = durableSubagentRun(run.id)
    if (existing?.parentGatewaySessionId && existing.parentGatewaySessionId !== run.parentGatewaySessionId) throw new Error("subagent ownership is immutable")
    if (existing?.result) return // First terminal and its ACK/content win atomically; stale events cannot rewrite.
    db().query(`INSERT INTO subagent_durable_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      child_oc=excluded.child_oc,status=excluded.status,data=excluded.data,result=COALESCE(excluded.result,subagent_durable_runs.result),updated_at=excluded.updated_at
      WHERE subagent_durable_runs.status='running' OR excluded.status<>'running'`)
      .run(run.id, run.parentGatewaySessionId, run.opencodeSessionId, run.status, payload, result ? JSON.stringify(result) : null, Date.now())
    if (result && run.asyncMode && run.status !== "stopped") {
      const id = `subagent:${run.id}`
      const content = `子任务结果（run_id: ${run.id}，无需重新执行）：${JSON.stringify(result)}`
      registerGenerationReceipt({ task_id: id, parent_gw: run.parentGatewaySessionId, producer_oc: run.opencodeSessionId,
        consumer_oc: run.parentOpencodeSessionId, kind: 'message', content, run_id: run.id })
      completeGenerationReceipt(id, 'succeeded', [], { content })
      // finishRun 仍走既有 wakeParent 单一出口。先占位防 drain 再投；
      // 这里只证明开始提交，不伪造消费者已读，真实取件才写 observed_at。
      claimGenerationMessages([id], run.parentOpencodeSessionId)
    }
  })()
}
export function acknowledgeDurableSubagentRun(id: string): void {
  if (generationReceipt(`subagent:${id}`)) acknowledgeGeneration(`subagent:${id}`, 'observed', {})
}

// Only a trusted human-confirmed configuration writer may populate this table. Tool inputs never write caps.
export function generationProjectAuthorization(ownerScope: string, project: string): any | undefined {
  return db().query("SELECT cap_coins,version,source FROM generation_project_authorizations WHERE owner_scope=? AND project=?").get(ownerScope, project) ?? undefined
}

export function knownGenerationOwner(parentGw: string, userId?: number): number | undefined {
  if (userId && Number.isInteger(userId) && userId > 0) {
    db().query("INSERT INTO generation_owner_identities VALUES(?,?) ON CONFLICT(parent_gw) DO NOTHING").run(parentGw,userId)
  }
  const known = (db().query("SELECT user_id FROM generation_owner_identities WHERE parent_gw=?").get(parentGw) as any)?.user_id
  if (known && userId && known !== userId) throw new Error("session owner identity changed")
  return known
}
