// 正常制作运行时：提交收据、项目硬预算与冻结版本在 SQLite 同一事务内持久化。
// 不保存 API key、cookie、参考图字节或完整 prompt；未知提交绝不自动释放预算。
import { Database } from "bun:sqlite"
import { mkdirSync, lstatSync, chmodSync, chownSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { createHash } from "node:crypto"

/** Gateway 的共同生成预算端口只加载这份实现；不复制第二份 SQLite 写入器。 */
export const IMAGE_JOURNAL_CONTRACT_VERSION = 1

let store: Database | undefined
let openedPath: string | undefined
function sharedJournalPermissions(path: string): void {
  const dir = dirname(path)
  const d = lstatSync(dir)
  const uid = process.getuid?.()
  if (d.isSymbolicLink()) throw new Error("shared_journal_permissions: journal目录不能是符号链接")
  if (d.uid === uid) {
    // 照 project/store.ts scratch 与 exec-bridge outDir：已是2770就不再chmod。
    // 2026-10-29 16:42 owner在某执行上下文里chmod 2770被内核静默去掉setgid（落成770且不报错），
    // 网关（非owner）随后在新进程首次开库时于下方else分支拒绝，视频/图片全部未提交。
    if ((d.mode & 0o2770) !== 0o2770) chmodSync(dir, 0o2770)
    if ((lstatSync(dir).mode & 0o7777) !== 0o2770) throw new Error("shared_journal_permissions: journal目录chmod 2770未生效（setgid被丢弃），需owner在服务外初始化")
    // 默认ACL只作用该journal目录的新DB/WAL/SHM，避免UMask0022在WAL重建后再次阻断另一服务。
    const acl = spawnSync("setfacl", ["-m", "d:u::rwx,d:g::rwx,d:o::---,d:m::rwx", "--", dir], { encoding: "utf8" })
    if (acl.status !== 0) throw new Error("shared_journal_permissions: 无法设置journal目录默认ACL，需owner初始化acl依赖")
  } else {
    const acl = spawnSync("getfacl", ["-cp", "--", dir], { encoding: "utf8" })
    if ((d.mode & 0o7777) !== 0o2770 || acl.status !== 0 || !acl.stdout.includes("default:group::rwx") || !acl.stdout.includes("default:mask::rwx") || !acl.stdout.includes("default:other::---")) throw new Error("shared_journal_permissions: journal尚未由owner初始化2770/默认ACL，禁止新DB回退")
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    let s
    try { s = lstatSync(file) } catch (error: any) { if (error.code === "ENOENT") continue; throw error }
    if (s.isSymbolicLink() || !s.isFile()) throw new Error("shared_journal_permissions: journal目标不是普通文件")
    if (s.uid === uid) {
      if (s.gid !== d.gid) chownSync(file, -1, d.gid)
      chmodSync(file, 0o660)
    } else if ((s.mode & 0o777) !== 0o660 || s.gid !== d.gid) throw new Error("shared_journal_permissions: 既有DB/WAL/SHM需其owner修为同组0660，禁止新DB回退")
  }
}
function db(): Database {
  // 默认落点必须在 opencode 服务**可写**的根内：该服务以 agentsvc 运行且 systemd 只授权
  // ReadWritePaths=/opt/agent-harness/workspace（ProtectSystem=strict），写
  // /opt/agent-harness/state/** 会 SQLITE_CANTOPEN（unable to open database file）
  // 并连带打死 image_quote／workflow_write 等所有走本档的路径（2026-10-14 生产事故）。
  const path =
    process.env.EIMU_TASK_JOURNAL_PATH ||
    "/opt/agent-harness/workspace/.local/share/eimu/tool-journal/tool-jobs.sqlite"
  if (store && openedPath === path) return store
  // 路径只由进程组合根配置。独立测试实例换路径时不能沿用另一实例的余额连接。
  if (store) { store.close(); store = undefined }
  openedPath = path
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  sharedJournalPermissions(path)
  store = new Database(path, { create: true })
  store.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS tool_submission (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, reservation REAL NOT NULL, state TEXT NOT NULL,
      task_id TEXT, registration_json TEXT, metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id));
    CREATE TABLE IF NOT EXISTS tool_rate (account TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tool_rate_account_time ON tool_rate(account,sent_at);
    CREATE TABLE IF NOT EXISTS tool_artifact (scope TEXT NOT NULL, task_id TEXT NOT NULL, records_json TEXT NOT NULL, PRIMARY KEY(scope,task_id));
    CREATE TABLE IF NOT EXISTS tool_project (
      scope TEXT PRIMARY KEY, cap REAL, lock_hash TEXT NOT NULL);
  `)
  const columns=store.query("PRAGMA table_info(tool_project)").all() as any[]
  for(const name of ["budget_version","budget_source"])if(!columns.some(c=>c.name===name))store.exec(`ALTER TABLE tool_project ADD COLUMN ${name} TEXT`)
  sharedJournalPermissions(path)
  return store
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export interface SubmissionIdentity {
  bridge_operation?: string; media_kind?: "music" | "voice"
  graph_scope?: string; graph_cap?: number; graph_signature?: string;
  scope: string; budget_version?:string; budget_source?:string; submitted_image?:string; size?: string; input_signature?: string; submitted_references?: string[]; reference_fingerprints?: string[]; request_id: string; session_id: string; project?: string; frame?: number;
  reference_version?: string; style_version?: string; model: string; cost_coins: number;
}
export function getSubmission(scope: string, requestID: string): any {
  return db().query("SELECT * FROM tool_submission WHERE scope=? AND request_id=?").get(scope, requestID)
}
export function lockedProjectBudget(scope:string): number | null {
  const project:any=db().query("SELECT cap FROM tool_project WHERE scope=?").get(scope)
  return typeof project?.cap==="number" && Number.isFinite(project.cap) ? project.cap : null
}
export function prepareSubmission(input: SubmissionIdentity, payload: unknown, lock: unknown, cap?: number): { created: boolean } {
  const d = db()
  return d.transaction(() => {
    const hash = contentHash(payload)
    const existing: any = getSubmission(input.scope, input.request_id)
    if (existing) {
      const restored = existing.payload_hash === `restored:${input.input_signature}` && !!input.input_signature
      if (existing.payload_hash !== hash && !restored) throw new Error("idempotency_key_reused: 同一 request_id 的模型、帧、提示词或参考版本已改变；未提交。")
      if (existing.state !== "rejected") return { created: false }
    }
    const lockHash = contentHash(lock)
    const project: any = d.query("SELECT * FROM tool_project WHERE scope=?").get(input.scope)
    if (project && input.project && lock != null && project.lock_hash!=="__unfrozen" && project.lock_hash !== lockHash) throw new Error("project_lock_changed: 同项目模型、尺寸、canonical或STYLE LOCK版本不一致；未提交。")
    if (typeof cap === "number" && (!Number.isFinite(cap) || cap < 0)) throw new Error("invalid_budget: 预算必须为非负有限币值。")
    const humanVersionChanged=project&&input.budget_version&&input.budget_version!==project.budget_version&&!["no_extra_cap","agent_constraint"].includes(input.budget_source??"agent_constraint")
    if (!humanVersionChanged && project?.cap != null && cap != null && cap > project.cap) throw new Error("budget_locked: 不允许工具扩大已有项目预算。")
    const effectiveCap = humanVersionChanged ? cap : cap == null ? project?.cap : project?.cap == null ? cap : Math.min(cap, project.cap)
    const used: any = d.query("SELECT COALESCE(SUM(reservation),0) AS total FROM tool_submission WHERE scope=? AND state NOT IN ('refunded','rejected')").get(input.scope)
    if (effectiveCap != null && used.total + input.cost_coins > effectiveCap + 1e-8) throw new Error(`task_budget_exceeded: 已保留 ${used.total} 币，本次 ${input.cost_coins} 币，硬预算 ${effectiveCap} 币；未提交。`)
    if (input.graph_scope && input.graph_cap != null) {
      if (!Number.isFinite(input.graph_cap) || input.graph_cap < 0) throw new Error("invalid_graph_budget")
      const graphUsed: any = d.query("SELECT COALESCE(SUM(reservation),0) AS total FROM tool_submission WHERE json_extract(metadata_json,'$.graph_scope')=? AND state NOT IN ('refunded','rejected')").get(input.graph_scope)
      if (graphUsed.total + input.cost_coins > input.graph_cap + 1e-8) throw new Error(`task_budget_exceeded: 工程已保留/实扣 ${graphUsed.total} 币，本次 ${input.cost_coins} 币，工程硬预算 ${input.graph_cap} 币；未提交。`)
    }
    d.query("INSERT INTO tool_project(scope,cap,lock_hash,budget_version,budget_source) VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET cap=excluded.cap,lock_hash=excluded.lock_hash,budget_version=excluded.budget_version,budget_source=excluded.budget_source").run(input.scope, effectiveCap ?? null, project?.lock_hash && project.lock_hash!=="__unfrozen" ? project.lock_hash : lock == null ? "__unfrozen" : lockHash,input.budget_version??null,input.budget_source??(effectiveCap==null?"no_extra_cap":"agent_constraint"))
    d.query("INSERT INTO tool_submission(scope,request_id,session_id,payload_hash,reservation,state,metadata_json,created_at) VALUES(?,?,?,?,?,'submitting',?,?) ON CONFLICT(scope,request_id) DO UPDATE SET state='submitting',reservation=excluded.reservation").run(input.scope,input.request_id,input.session_id,hash,input.cost_coins,JSON.stringify(input),Date.now())
    return { created: true }
  }).immediate()
}
export function finishSubmission(scope: string, requestID: string, state: string, taskID?: string): void {
  db().query("UPDATE tool_submission SET state=?,task_id=COALESCE(?,task_id) WHERE scope=? AND request_id=?").run(state,taskID ?? null,scope,requestID)
}
/** 权威实扣替换本次预留；仍在同一余额表，不另加图预算副本。 */
export function settleSubmission(scope: string, requestID: string, actualCoins: number): void {
  if (!Number.isFinite(actualCoins) || actualCoins < 0) throw new Error("invalid_actual_cost")
  db().query("UPDATE tool_submission SET state='completed',reservation=? WHERE scope=? AND request_id=?").run(actualCoins, scope, requestID)
}

/** 仅网关按真实ledger/receipt逐笔核验后调用；导入既有事实，不产生新提交许可或调用上游。 */
export function importVerifiedSubmission(input: SubmissionIdentity, state: "completed" | "accepted" | "submitting" | "refunded", taskId?: string): void {
  if (!input.input_signature || !Number.isFinite(input.cost_coins) || input.cost_coins < 0) throw new Error("invalid_import_evidence")
  const d = db()
  d.transaction(() => {
    const prior = getSubmission(input.scope, input.request_id)
    if (prior) {
      const meta = JSON.parse(prior.metadata_json)
      if ((prior.task_id && taskId && prior.task_id !== taskId) || (meta.input_signature && meta.input_signature !== input.input_signature)) throw new Error("operation_evidence_conflict")
      if (prior.state === "refunded" || (prior.state === "completed" && state !== "refunded")) return
      if (state === "completed" || state === "refunded") d.query("UPDATE tool_submission SET state=?,reservation=?,task_id=COALESCE(task_id,?) WHERE scope=? AND request_id=?").run(state, state === "refunded" ? 0 : input.cost_coins, taskId ?? null, input.scope, input.request_id)
      else if (state === "accepted" && taskId) d.query("UPDATE tool_submission SET state='accepted',task_id=COALESCE(task_id,?) WHERE scope=? AND request_id=? AND state='submitting'").run(taskId,input.scope,input.request_id)
      return
    }
    d.query("INSERT INTO tool_submission(scope,request_id,session_id,payload_hash,reservation,state,task_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(input.scope,input.request_id,input.session_id,`restored:${input.input_signature}`,state === "refunded" ? 0 : input.cost_coins,state,taskId ?? null,JSON.stringify({...input,imported_from:"gateway_ledger_receipt"}),Date.now())
  }).immediate()
}
export function journalRegistration(taskID: string, sessionID: string, payload: Record<string, unknown>): void {
  const d = db()
  const matched: any = d.query("SELECT scope,request_id FROM tool_submission WHERE task_id=? LIMIT 1").get(taskID)
  if (matched) d.query("UPDATE tool_submission SET registration_json=? WHERE scope=? AND request_id=?").run(JSON.stringify(payload),matched.scope,matched.request_id)
  else {
    // image_edit/upscale 等既有工具同样获得耐久注册，不依赖内存 Map。
    d.query("INSERT INTO tool_submission(scope,request_id,session_id,payload_hash,reservation,state,task_id,registration_json,metadata_json,created_at) VALUES(?,?,?,?,?,'accepted',?,?,?,?) ON CONFLICT(scope,request_id) DO UPDATE SET registration_json=excluded.registration_json")
      .run(`registration:${sessionID}`,taskID,sessionID,contentHash(payload),0,taskID,JSON.stringify(payload),JSON.stringify({session_id:sessionID}),Date.now())
  }
}
export function registeredTask(taskID: string): void {
  db().query("UPDATE tool_submission SET registration_json=NULL WHERE task_id=?").run(taskID)
}
export function pendingRegistrations(): Array<{ task_id: string; registration_json: string }> {
  return db().query("SELECT task_id,registration_json FROM tool_submission WHERE registration_json IS NOT NULL ORDER BY created_at LIMIT 1000").all() as any
}
export function reconcileSubmissions(tasks: any[]): void {
  const d = db()
  d.transaction(() => {
    for (const task of tasks) {
      const id = task.task_id ?? task.id
      // 失败不意味着已退款；只有权威 refunded 真释放硬预算保留。
      if (id && task.status === "refunded") d.query("UPDATE tool_submission SET state='refunded' WHERE task_id=?").run(id)
    }
  }).immediate()
}
export function outstandingSubmissions(scope: string): any[] {
  return db().query("SELECT request_id,task_id,state,metadata_json FROM tool_submission WHERE scope=? AND (state='submitting' OR registration_json IS NOT NULL)").all(scope).map((entry:any)=>({request_id:entry.request_id,task_id:entry.task_id,status:entry.state,identity:JSON.parse(entry.metadata_json)}))
}

export function recordArtifacts(scope: string, taskID: string, artifacts: any[]): void {
  db().query("INSERT INTO tool_artifact(scope,task_id,records_json) VALUES(?,?,?) ON CONFLICT(scope,task_id) DO UPDATE SET records_json=excluded.records_json").run(scope,taskID,JSON.stringify(artifacts))
}
export function verifiedArtifactEntries(scope: string, taskID: string): any[] {
  const row:any=db().query("SELECT records_json FROM tool_artifact WHERE scope=? AND task_id=?").get(scope,taskID)
  return row ? JSON.parse(row.records_json) : []
}

/** 跨OC进程共享账户滑窗；返回0表示在事务内真正取得配额。 */
export function acquireSharedRateSlot(account: string, now: number, limit: number, windowMs: number): number {
  const d=db()
  return d.transaction(() => {
    d.query("DELETE FROM tool_rate WHERE sent_at<=?").run(now-windowMs)
    const row:any=d.query("SELECT COUNT(*) AS count,MIN(sent_at) AS oldest FROM tool_rate WHERE account=?").get(account)
    if(row.count>=limit)return Math.max(1,row.oldest+windowMs-now+5)
    d.query("INSERT INTO tool_rate(account,sent_at) VALUES(?,?)").run(account,now)
    return 0
  }).immediate()
}

/** 接受UUID与完整产物收据在同一SQLite事务内提交，退出窗口不会遗失同步成品。 */
export function acceptTaskSubmission(scope:string,requestID:string,taskID:string,payload:Record<string,unknown>):void {
  db().transaction(()=>{
    // 已结算操作恢复收据时不能退回accepted，否则下一次恢复会再次把原费用计为新增。
    if(getSubmission(scope,requestID)?.state!=="completed")finishSubmission(scope,requestID,"accepted",taskID)
    journalRegistration(taskID,String(payload.session_id),payload)
  }).immediate()
}
