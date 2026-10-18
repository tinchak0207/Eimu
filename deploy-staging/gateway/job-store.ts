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
  connection = next
  return next
}

export function bindGenerationConsumer(child: string, parentGw: string, parentOc: string, agent?: string): void {
  db().query("INSERT INTO generation_consumers(child_oc,parent_gw,parent_oc,created_at,consumer_agent) VALUES (?,?,?,?,?) ON CONFLICT(child_oc) DO NOTHING")
    .run(child, parentGw, parentOc, Date.now(), agent || null)
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
export function registerGenerationReceipt(input: Record<string, any>): GenerationReceipt {
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
export function generationReceipts(parentGw?: string, pendingOnly = false): GenerationReceipt[] {
  const rows = parentGw
    ? db().query("SELECT * FROM generation_receipts WHERE parent_gw=? ORDER BY created_at").all(parentGw)
    : db().query("SELECT * FROM generation_receipts ORDER BY created_at").all()
  return rows.map(decode).filter((r) => !pendingOnly || (r.kind !== "message" && r.status !== "succeeded"))
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
  db().query(`UPDATE generation_receipts SET observed_at=COALESCE(observed_at,?),
    downloaded_at=CASE WHEN ? THEN COALESCE(downloaded_at,?) ELSE downloaded_at END,
    data=?,updated_at=? WHERE task_id=?`)
    .run(Date.now(), stage === "downloaded" ? 1 : 0, Date.now(), JSON.stringify({ ...row, ...extra, artifacts: undefined }), Date.now(), id)
}
export function notifyGeneration(ids: string[]): void {
  const update = db().query("UPDATE generation_receipts SET notified_at=? WHERE task_id=?")
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
