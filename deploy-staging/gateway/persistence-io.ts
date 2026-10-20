import { MergedReplayFrame } from "./replay-frame.ts"
import type { SteerCommand, SteerLedgerStore } from "./steer-identity.ts"
import type { PersistableState, PersistedData, PersistedRow, UserSettings, ReworkRecord, CriticScoreSource } from "./persistence-types.ts"
import { db, degrade, noteSaveFailure, noteSaveSuccess, textDecoder, textEncoder } from "./persistence-schema.ts"
// ---- 序列化 / 反序列化 ----

/**
 * 持久化 `data` JSON 的栏位全集——**新增栏位必须同步更新的集合式守门清单**。
 * 这份清单与 `serialize()` 的输出键集逐项相等；`hydrateRow()` 对每个键都必须还原
 * （别名映射见 persistence-schema.test.ts）。哪一天有人只改了 serialize 忘了清单/还原，
 * 测试会直接红。完整「新栏位需同步改哪几处」清单见档头 runMigrations 上方注解。
 */
export const PERSISTED_DATA_KEYS = [
  "eventCounter",
  "replayBuffer",
  "lastActivityAt",
  "partTextEmitted",
  "announcedUrls",
  "toolStatusSeen",
  "toolInvokeSeen",
  "stepCostLogged",
  "messageRole",
  "suppressedParts",
  "canvasSummary",
  "canvasSummaryAt",
  "canvasSnapshot",
  "workflowSnapshot",
  "vettingInjected",
  "userMemory",
  "profileOnboardingPending",
  "compact",
  "lastTurnActiveAt",
  "title", // 别名：记忆体 sessionTitle ↔ 落盘 title（见 hydrateRow）
  "tplDeviateToken",
] as const

export function serialize(state: PersistableState): PersistedData {
  return {
    eventCounter: state.eventCounter,
    replayBuffer: state.replayBuffer.map((f) =>
      f instanceof MergedReplayFrame
        ? { id: f.id, frame: textDecoder.decode(f.frame), merge: f.toPersisted() }
        : { id: f.id, frame: textDecoder.decode(f.frame), ...(f.strippable === false ? { strippable: false } : {}) },
    ),
    lastActivityAt: state.lastActivityAt,
    partTextEmitted: [...state.partTextEmitted.entries()],
    announcedUrls: [...state.announcedUrls],
    toolStatusSeen: [...state.toolStatusSeen],
    toolInvokeSeen: [...state.toolInvokeSeen],
    stepCostLogged: [...state.stepCostLogged],
    messageRole: [...state.messageRole.entries()],
    suppressedParts: [...state.suppressedParts],
    canvasSummary: state.canvasSummary,
    canvasSummaryAt: state.canvasSummaryAt,
    canvasSnapshot: state.canvasSnapshot,
    workflowSnapshot: state.workflowSnapshot,
    vettingInjected: state.vettingInjected,
    userMemory: state.userMemory,
    profileOnboardingPending: state.profileOnboardingPending,
    compact: state.compact,
    lastTurnActiveAt: state.lastTurnActiveAt,
    title: state.sessionTitle ?? null,
    tplDeviateToken: state.tplDeviateToken ?? null,
  }
}

/**
 * 从 DB row 重建完整 SessionState（含所有活跃结构的空容器）。
 * 回传物件形状与 index.ts 的 SessionState 完全一致（clients/pending* 为空）。
 */
export function hydrateRow(row: PersistedRow): Record<string, unknown> {
  const d = row.data ?? ({} as PersistedData)
  return {
    sessionId: row.sessionId,
    apiKey: row.apiKey,
    opencodeSessionId: row.opencodeSessionId,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: typeof d.eventCounter === "number" ? d.eventCounter : 0,
    replayBuffer: (d.replayBuffer ?? []).map(
      (f) => (f.merge && MergedReplayFrame.fromPersisted(f.frame, f.merge)) ||
        { id: f.id, frame: textEncoder.encode(f.frame), ...(f.strippable === false ? { strippable: false } : {}) },
    ),
    lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : row.updatedAt,
    partTextEmitted: new Map(d.partTextEmitted ?? []),
    // S2b：出站剥离器状态——回合级 ephemeral，不持久化（重启后新回合重建）。
    partStripState: new Map(),
    announcedUrls: new Set(d.announcedUrls ?? []),
    toolStatusSeen: new Set(d.toolStatusSeen ?? []),
    toolInvokeSeen: new Set(d.toolInvokeSeen ?? []),
    stepCostLogged: new Set(d.stepCostLogged ?? []),
    messageRole: new Map(d.messageRole ?? []),
    suppressedParts: new Set(d.suppressedParts ?? []),
    canvasSummary: d.canvasSummary,
    canvasSummaryAt: d.canvasSummaryAt,
    canvasSnapshot: d.canvasSnapshot,
    workflowSnapshot: d.workflowSnapshot,
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    vettingInjected: d.vettingInjected === true,
    userMemory: d.userMemory,
    profileOnboardingPending: d.profileOnboardingPending === true,
    compact: d.compact,
    lastTurnActiveAt: typeof d.lastTurnActiveAt === "number" ? d.lastTurnActiveAt : 0,
    sessionTitle: typeof d.title === "string" && d.title ? d.title : null,
    // 2026-10-02：模板偏离 token 形状防护——非物件/缺 token 字串 → null；
    // at 非有限数 → 以当下时刻起算（保守：不因坏 at 让 token 永不过期）。
    tplDeviateToken: (() => {
      const t = d.tplDeviateToken
      if (!t || typeof t !== "object") return null
      const token = (t as { token?: unknown }).token
      if (typeof token !== "string" || !token) return null
      const at = (t as { at?: unknown }).at
      return { token, at: typeof at === "number" && Number.isFinite(at) ? at : Date.now() }
    })(),
  }
}

function parseRow(row: { id: string; owner_key: string; opencode_session_id: string; created_at: number; updated_at: number; data: string } | null): PersistedRow | null {
  if (!row) return null
  let data: PersistedData
  try {
    data = JSON.parse(row.data) as PersistedData
  } catch {
    return null
  }
  return {
    sessionId: row.id,
    apiKey: row.owner_key,
    opencodeSessionId: row.opencode_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data,
  }
}

// ---- CRUD ----

export function saveSession(state: PersistableState): boolean {
  if (!db) {
    noteSaveFailure(new Error("persistence not initialized (db is null)"), "save")
    return false
  }
  try {
    const now = Date.now()
    db.query(
      `INSERT INTO sessions (id, owner_key, opencode_session_id, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_key = excluded.owner_key,
         opencode_session_id = excluded.opencode_session_id,
         updated_at = excluded.updated_at,
         data = excluded.data`,
    ).run(state.sessionId, state.apiKey, state.opencodeSessionId, now, now, JSON.stringify(serialize(state)))
    noteSaveSuccess()
    return true
  } catch (e) {
    // UNIQUE(opencode_session_id) 冲突 = 旧 row 残留同 opencode id（如重启竞态），
    // 先删旧 row 再重试一次；再失败才判定本帧写入失败（回传 false，绝不假报成功）。
    try {
      db.query("DELETE FROM sessions WHERE opencode_session_id = ? AND id != ?").run(state.opencodeSessionId, state.sessionId)
      const now = Date.now()
      db.query(
        `INSERT INTO sessions (id, owner_key, opencode_session_id, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_key = excluded.owner_key,
           opencode_session_id = excluded.opencode_session_id,
           updated_at = excluded.updated_at,
           data = excluded.data`,
      ).run(state.sessionId, state.apiKey, state.opencodeSessionId, now, now, JSON.stringify(serialize(state)))
      noteSaveSuccess()
      return true
    } catch (e2) {
      noteSaveFailure(e2, "save")
      return false
    }
  }
}

export function loadSessionById(id: string): PersistedRow | null {
  if (!db) return null
  try {
    return parseRow(db.query("SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE id = ?").get(id) as never)
  } catch (e) {
    degrade(e, "loadById")
    return null
  }
}

export function loadSessionByOpencodeId(opencodeSessionId: string): PersistedRow | null {
  if (!db) return null
  try {
    return parseRow(db.query("SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE opencode_session_id = ?").get(opencodeSessionId) as never)
  } catch (e) {
    degrade(e, "loadByOpencodeId")
    return null
  }
}


// 会话目录：当前 key 的全部会话 row（按 updated_at 降序）。给
// GET /agent/v1/sessions 列表端点用；data 只解 lastActivityAt 一个字段，
// 不做完整 hydrate（目录不需要整包状态）。
export function listSessionRows(apiKey: string): PersistedRow[] {
  if (!db) return []
  try {
    const stmt = db.prepare(
      "SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE owner_key = ? ORDER BY updated_at DESC",
    )
    const rows = stmt.all(apiKey) as Array<{
      id: string
      owner_key: string
      opencode_session_id: string
      created_at: number
      updated_at: number
      data: string
    }>
    return rows.map((r) => ({
      sessionId: r.id,
      apiKey: r.owner_key,
      opencodeSessionId: r.opencode_session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      data: JSON.parse(r.data) as PersistedData,
    }))
  } catch (e) {
    degrade(e, "listSessionRows")
    return []
  }
}


/**
 * 目录回填用：只改 data JSON 的 title 栏（读-改-写同 parseRow/listSessionRows
 * 的 JS 序列化链，不动 updated_at 以免打乱列表排序）。fail-open 同全局策略。
 */
export function setRowTitle(id: string, title: string): void {
  if (!db) return
  try {
    const row = db.query("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null
    if (!row) return
    let data: PersistedData
    try {
      data = JSON.parse(row.data) as PersistedData
    } catch {
      return // data 坏损的行不强写，交由降级路径
    }
    data.title = title
    db.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
  } catch (e) {
    degrade(e, "setRowTitle")
  }
}

export function deleteSessionRow(id: string): void {
  if (!db) return
  try {
    db.query("DELETE FROM sessions WHERE id = ?").run(id)
  } catch (e) {
    degrade(e, "delete")
  }
}

// ---- 用户级 Settings（2026-08-29，key 维度）----
// 存储模式与 canvasSummary/userMemory 同构（JSON data 栏位），但归属维度是
// owner_key（用户级，跨会话共享），重启不丢。shape 校验在 index.ts，这里只存取。


/** 读取 key 维度 settings；无记录回 null（呼叫端套默认值）。fail-open 同全局策略。 */
export function loadUserSettings(ownerKey: string): UserSettings | null {
  if (!db || !ownerKey) return null
  try {
    const row = db.query("SELECT data FROM user_settings WHERE owner_key = ?").get(ownerKey) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data) as UserSettings
  } catch (e) {
    degrade(e, "loadUserSettings")
    return null
  }
}

/** 写入 key 维度 settings（UPSERT）。 */
export function saveUserSettings(ownerKey: string, s: UserSettings): void {
  if (!db || !ownerKey) return
  try {
    db.query(
      `INSERT INTO user_settings (owner_key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(ownerKey, JSON.stringify(s), Date.now())
  } catch (e) {
    degrade(e, "saveUserSettings")
  }
}

// 使用既有 settings 表的独立命名空间，以已鉴权 tenant 绑定模式；短效设备票不作 owner key。
// 明确授权持续有效，只有新的显式 mode 会覆盖它，不能按心跳超时撤销。
const tenantPermissionModes = new Map<string, "off" | "ask" | "auto" | "full">()

export function loadTenantPermissionMode(tenant: string): "off" | "ask" | "auto" | "full" | null {
  const cached = tenantPermissionModes.get(tenant)
  if (cached) return cached
  if (!db || !tenant) return null
  try {
    const row = db.query("SELECT data FROM user_settings WHERE owner_key = ?").get(`tenant-device-permission:${tenant}`) as { data: string } | null
    const mode = row ? JSON.parse(row.data)?.mode : null
    if (mode === "off" || mode === "ask" || mode === "auto" || mode === "full") {
      tenantPermissionModes.set(tenant, mode)
      return mode
    }
  } catch (e) { degrade(e, "loadTenantPermissionMode") }
  return null
}

export function saveTenantPermissionMode(tenant: string, mode: "off" | "ask" | "auto" | "full"): void {
  if (!tenant) return
  tenantPermissionModes.set(tenant, mode)
  if (!db) return
  try {
    db.query(
      `INSERT INTO user_settings (owner_key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(`tenant-device-permission:${tenant}`, JSON.stringify({ mode }), Date.now())
  } catch (e) { degrade(e, "saveTenantPermissionMode") }
}

// ---- 刀 F（2026-09-15）：in-flight rework run 持久化 ----

/** 写入/更新一条 rework run 记录（run_id 主键 UPSERT）。fail-open 同全局策略。 */
export function saveReworkRecord(r: {
  runId: string; parentGw: string; parentOc: string; childOc: string
  agent: string; label: string; beast: boolean; asyncMode: boolean; reworkCount: number
}): void {
  if (!db) return
  try {
    const now = Date.now()
    db.query(
      `INSERT INTO subagent_reworks
        (run_id, parent_gw, parent_oc, child_oc, agent, label, beast, async_mode, rework_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         parent_gw = excluded.parent_gw,
         parent_oc = excluded.parent_oc,
         child_oc = excluded.child_oc,
         agent = excluded.agent,
         label = excluded.label,
         beast = excluded.beast,
         async_mode = excluded.async_mode,
         rework_count = excluded.rework_count,
         updated_at = excluded.updated_at`,
    ).run(
      r.runId, r.parentGw, r.parentOc, r.childOc, r.agent, r.label,
      r.beast ? 1 : 0, r.asyncMode ? 1 : 0, r.reworkCount, now,
    )
  } catch (e) {
    degrade(e, "saveReworkRecord")
  }
}

/** 读取全部 in-flight rework 记录（启动扫描用）。fail-open 回空阵列。 */
export function loadReworkRecords(): ReworkRecord[] {
  if (!db) return []
  try {
    const rows = db.query(
      "SELECT run_id, parent_gw, parent_oc, child_oc, agent, label, beast, async_mode, rework_count, updated_at FROM subagent_reworks",
    ).all() as Array<{
      run_id: string; parent_gw: string; parent_oc: string; child_oc: string
      agent: string; label: string; beast: number; async_mode: number; rework_count: number; updated_at: number
    }>
    return rows.map((x) => ({
      runId: x.run_id, parentGw: x.parent_gw, parentOc: x.parent_oc, childOc: x.child_oc,
      agent: x.agent, label: x.label, beast: x.beast === 1, asyncMode: x.async_mode === 1,
      reworkCount: x.rework_count, updatedAt: x.updated_at,
    }))
  } catch (e) {
    degrade(e, "loadReworkRecords")
    return []
  }
}

/** 删除一条 rework 记录（终态即清；幂等，run 不存在也成功）。fail-open。 */
export function deleteReworkRecord(runId: string): void {
  if (!db || !runId) return
  try {
    db.query("DELETE FROM subagent_reworks WHERE run_id = ?").run(runId)
  } catch (e) {
    degrade(e, "deleteReworkRecord")
  }
}

// ---- 刀 2（2026-09-15）：机器 critic pass 每会话一次性旗标 ----

/** 标记该会话已用掉 machine critic pass（session_id 主键，重复呼叫幂等）。fail-open。 */
export function markCriticPass(sessionId: string): void {
  if (!db || !sessionId) return
  try {
    db.query(
      `INSERT INTO critic_passes (session_id, created_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at`,
    ).run(sessionId, Date.now())
  } catch (e) {
    degrade(e, "markCriticPass")
  }
}

/** 该会话是否已用过 machine critic pass。fail-open 回 false（呼叫端另有内存旗标兜底）。 */
export function hasCriticPass(sessionId: string): boolean {
  if (!db || !sessionId) return false
  try {
    const row = db.query("SELECT session_id FROM critic_passes WHERE session_id = ?").get(sessionId) as { session_id: string } | null
    return row != null
  } catch (e) {
    degrade(e, "hasCriticPass")
    return false
  }
}

/** 清一条 pass 旗标（会话拆除时用；幂等）。fail-open。 */
export function deleteCriticPass(sessionId: string): void {
  if (!db || !sessionId) return
  try {
    db.query("DELETE FROM critic_passes WHERE session_id = ?").run(sessionId)
  } catch (e) {
    degrade(e, "deleteCriticPass")
  }
}

// ---- D7（2026-10-02）：品质量测基座存取。全部 fail-open（量测不得影响交付主流程）----


let d7Seq = 0
function d7Id(prefix: string): string {
  d7Seq = (d7Seq + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}-${d7Seq.toString(36)}`
}

/**
 * 记一笔审核判决（critic_verdicts）。score 未量测时传 null，不得填 0 假值。
 * v3：支援 `scoreSource` 记录分数**来源**。反伪造不变式：
 *   * 有 score 但没标来源 → 来源留 null（不猜，不把自评冒充量测）；
 *   * 标 `measured` 却没有数值 → 来源强制 null（宣告了量测就必须有数值，否则不落 provenance）；
 *   * `model_self` / `human` 允许与 null score 并存（分类判决没有数值），但永不通过数值阈值。
 */
export function saveCriticVerdict(v: {
  sessionId: string
  runId?: string
  agent?: string
  label?: string
  verdict: "pass" | "reject" | "unknown"
  score?: number | null
  scoreSource?: CriticScoreSource | null
  judgeModel?: string
  verdictText?: string
}): void {
  if (!db || !v.sessionId) return
  try {
    const scoreNum = typeof v.score === "number" && Number.isFinite(v.score) ? v.score : null
    const declared = v.scoreSource ?? null
    const scoreSource = declared === "measured" && scoreNum === null ? null : declared
    // 真实审核回执必须完整落库；只截人话，不能切断当前artifact绑定JSON。
    const verdictLines = (v.verdictText ?? "").split("\n")
    const receiptLine = verdictLines.find((line) => line.startsWith("RECEIPT:"))
    const verdictText = receiptLine
      ? `${receiptLine}\n${verdictLines.filter((line) => line !== receiptLine).join("\n").slice(0, 4000)}`
      : (v.verdictText ?? "").slice(0, 4000)
    db.query(
      `INSERT OR REPLACE INTO critic_verdicts (id, session_id, run_id, agent, label, verdict, score, score_source, judge_model, verdict_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.runId ? `cv-${v.runId}` : d7Id("cv"),
      v.sessionId,
      v.runId ?? null,
      v.agent ?? null,
      v.label ?? null,
      v.verdict,
      scoreNum,
      scoreSource,
      v.judgeModel ?? null,
      verdictText,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveCriticVerdict")
  }
}

/** 读一笔审核判决（诊断／验收用；唯读）。查无回 null。 */
export function getCriticVerdictByRun(runId: string): {
  verdict: string
  score: number | null
  score_source: CriticScoreSource | null
  judge_model: string | null
  verdict_text: string | null
} | null {
  if (!db || !runId) return null
  try {
    return (
      (db
        .query("SELECT verdict, score, score_source, judge_model, verdict_text FROM critic_verdicts WHERE run_id = ?")
        .get(runId) as {
        verdict: string
        score: number | null
        score_source: CriticScoreSource | null
        judge_model: string | null
        verdict_text: string | null
      } | null) ?? null
    )
  } catch (e) {
    degrade(e, "getCriticVerdictByRun")
    return null
  }
}

/**
 * 记一笔人工验收标签（human_labels）。`label` ∈ accept|reject。
 * 幂等：同 run_id 重复标注＝INSERT OR REPLACE（最后一次为准，不长第二列）。
 * 这是「评审外生」的落点：人工接受/拒绝 join 进 qualitySignalStats 的 acceptRate。
 */
export function saveHumanLabel(h: {
  sessionId: string
  runId?: string
  agent?: string
  label: "accept" | "reject"
  note?: string
}): void {
  if (!db || !h.sessionId) return
  try {
    db.query(
      `INSERT OR REPLACE INTO human_labels (id, session_id, run_id, agent, label, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      h.runId ? `hl-${h.runId}` : d7Id("hl"),
      h.sessionId,
      h.runId ?? null,
      h.agent ?? null,
      h.label,
      (h.note ?? "").slice(0, 4000),
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveHumanLabel")
  }
}

/** 读某 run 的人工标签（诊断／验收用；唯读）。查无回 null。 */
export function getHumanLabelByRun(
  runId: string,
): { label: string; agent: string | null; note: string | null } | null {
  if (!db || !runId) return null
  try {
    return (
      (db
        .query("SELECT label, agent, note FROM human_labels WHERE run_id = ?")
        .get(runId) as { label: string; agent: string | null; note: string | null } | null) ?? null
    )
  } catch (e) {
    degrade(e, "getHumanLabelByRun")
    return null
  }
}

/** 永久留存一个失败模式（expert_lessons）。 */
export function saveExpertLesson(l: {
  sessionId: string
  agent: string
  runId?: string
  source: string
  failureMode: string
  detail?: string
}): void {
  if (!db || !l.sessionId || !l.agent) return
  try {
    db.query(
      `INSERT INTO expert_lessons (id, session_id, agent, run_id, source, failure_mode, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d7Id("el"),
      l.sessionId,
      l.agent,
      l.runId ?? null,
      l.source,
      (l.failureMode || "").slice(0, 500),
      (l.detail ?? "").slice(0, 4000),
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveExpertLesson")
  }
}

/** 记一笔交付事件（deliveries）。重问率＝同 (session, agent, label) 重复出现的比例。 */
export function saveDelivery(d: {
  sessionId: string
  runId?: string
  agent?: string
  label?: string
  relPath?: string
  contractOk?: boolean
}): void {
  if (!db || !d.sessionId) return
  try {
    db.query(
      `INSERT OR REPLACE INTO deliveries (id, session_id, run_id, agent, label, rel_path, contract_ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.runId ? `dl-${d.runId}` : d7Id("dl"),
      d.sessionId,
      d.runId ?? null,
      d.agent ?? null,
      d.label ?? null,
      d.relPath ?? null,
      d.contractOk === undefined ? null : d.contractOk ? 1 : 0,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveDelivery")
  }
}

/** 同父会话的真实交付记录，研究前置与续跑复用既有产物，不另造准备状态。 */
export function loadSessionDeliveries(sessionId: string): Array<{ runId: string; agent: string; label: string; relPath: string }> {
  if (!db || !sessionId) return []
  try {
    return db.query("SELECT run_id AS runId, agent, label, rel_path AS relPath FROM deliveries WHERE session_id = ? AND run_id IS NOT NULL AND rel_path IS NOT NULL ORDER BY created_at").all(sessionId) as Array<{ runId: string; agent: string; label: string; relPath: string }>
  } catch (e) {
    degrade(e, "loadSessionDeliveries")
    return []
  }
}

/** D7 量测读数：品质讯号数量与重问率（供 EVAL 直接用；唯读）。 */
export function qualitySignalStats(): {
  criticVerdicts: number
  rejects: number
  expertLessons: number
  deliveries: number
  reaskRate: number
  /** 人工标签数（每列 = 一个已标注交付）。 */
  labeledDeliveries: number
  /** accept / labeledDeliveries；零标签时 null（不得回 0 假值——零样本的比例未定义）。 */
  acceptRate: number | null
  /** 有数值分数的样本数（score IS NOT NULL）。 */
  scoreSamples: number
  /** 有分数样本的平均；零样本时 null（不得回 0 假值）。 */
  meanScore: number | null
} {
  const empty = {
    criticVerdicts: 0,
    rejects: 0,
    expertLessons: 0,
    deliveries: 0,
    reaskRate: 0,
    labeledDeliveries: 0,
    acceptRate: null as number | null,
    scoreSamples: 0,
    meanScore: null as number | null,
  }
  if (!db) return empty
  try {
    const cv = (db.query("SELECT COUNT(*) AS n FROM critic_verdicts").get() as { n: number } | null)?.n ?? 0
    const rj = (db.query("SELECT COUNT(*) AS n FROM critic_verdicts WHERE verdict = 'reject'").get() as { n: number } | null)?.n ?? 0
    const el = (db.query("SELECT COUNT(*) AS n FROM expert_lessons").get() as { n: number } | null)?.n ?? 0
    const dl = (db.query("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number } | null)?.n ?? 0
    const dup = (
      db
        .query(
          "SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM deliveries GROUP BY session_id, agent, label HAVING c > 1)",
        )
        .get() as { n: number } | null
    )?.n ?? 0
    // 人工接受/拒绝：一列一交付，比例只在有样本时定义。
    const hl = (db.query("SELECT COUNT(*) AS n FROM human_labels").get() as { n: number } | null)?.n ?? 0
    const acc = (db.query("SELECT COUNT(*) AS n FROM human_labels WHERE label = 'accept'").get() as { n: number } | null)?.n ?? 0
    // score 样本：COUNT(score)/AVG(score) 天然忽略 NULL。零样本 → AVG 为 NULL，不得回 0。
    const sc = db.query("SELECT COUNT(score) AS n, AVG(score) AS avg FROM critic_verdicts").get() as
      | { n: number; avg: number | null }
      | null
    const scoreSamples = sc?.n ?? 0
    const meanScore = scoreSamples > 0 && typeof sc?.avg === "number" ? sc.avg : null
    return {
      criticVerdicts: cv,
      rejects: rj,
      expertLessons: el,
      deliveries: dl,
      reaskRate: dl > 0 ? dup / dl : 0,
      labeledDeliveries: hl,
      acceptRate: hl > 0 ? acc / hl : null,
      scoreSamples,
      meanScore,
    }
  } catch (e) {
    degrade(e, "qualitySignalStats")
    return empty
  }
}

// ---- REQ-D2b（2026-09-23）：steer 命令身份（tombstone）存取 ----
// 纯语义（状态机／payload 冻结／受理判定）在 steer-identity.ts；本节只做 SQLite 存取，
// 实作 SteerLedgerStore 缝（见 steer-identity.createSteerLedger）。
// **刻意不提供删除函数**：终态 row 就是 tombstone，删掉它＝重启后同一条指引又能被投递
// （见 initPersistence 的建表注释）。clear/删会话（deleteSessionRow）与 sweepStaleRows
// 都不碰本表。

interface SteerCommandRow {
  steer_id: string
  session_id: string
  owner_key: string
  alias_ids: string
  payload_hash: string
  payload: string
  state: string
  created_at: number
  dispatched_at: number | null
  settled_at: number | null
  reason: string | null
}

function parseSteerRow(row: SteerCommandRow): SteerCommand {
  let aliases: string[] = []
  try {
    const parsed = JSON.parse(row.alias_ids) as unknown
    if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string")
  } catch {
    aliases = [] // 坏损的别名栏不影响主键身份（宁可少认别名，不可拒真身）
  }
  return {
    steerId: row.steer_id,
    sessionId: row.session_id,
    ownerKey: row.owner_key,
    aliasIds: aliases,
    payloadHash: row.payload_hash,
    payload: row.payload,
    state: row.state as SteerCommand["state"],
    at: row.created_at,
    ...(typeof row.dispatched_at === "number" ? { dispatchedAt: row.dispatched_at } : {}),
    ...(typeof row.settled_at === "number" ? { settledAt: row.settled_at } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
  }
}

const STEER_ROW_COLS =
  "steer_id, session_id, owner_key, alias_ids, payload_hash, payload, state, created_at, dispatched_at, settled_at, reason"

/**
 * 读一条命令：先按主键，再按别名 id（同文去重时第二个 id 是同一个逻辑 steer，
 * 它的重放同样必须命中 tombstone）。
 *
 * D-7b（2026-09-23）修掉的假命中：别名查询原本是 `alias_ids LIKE '%"<id>"%'`，而 steer id
 * 的字元集（steer-core.STEER_ID_PATTERN）**含底线 `_`**——`_` 是 LIKE 的单字元通配符，
 * 于是查 `steer-p_q` 会命中别人的别名 `steer-pXq`：一颗与本请求无关的假 409（不会重复
 * 投递，但把「不存在」说成了「已存在」）。改成 JSON 阵列的元素级**精确等值**比对
 * （json_each）：不靠转义、也不靠「id 不含引号」这类外部假设，任何 id 都不会误命中他人。
 */
export function loadSteerCommand(steerId: string): SteerCommand | null {
  if (!db || !steerId) return null
  try {
    const row = db.query(`SELECT ${STEER_ROW_COLS} FROM steer_commands WHERE steer_id = ?`).get(steerId) as SteerCommandRow | null
    if (row) return parseSteerRow(row)
    const byAlias = db
      .query(
        // CASE 保序：json_valid 为假时不求值 json_each——坏损的别名栏只让「自己」不被认作别名
        // （与 parseSteerRow 同一个政策：宁可少认别名，不可让一行坏资料炸掉整次查询）。
        `SELECT ${STEER_ROW_COLS} FROM steer_commands
          WHERE CASE WHEN json_valid(steer_commands.alias_ids)
                     THEN EXISTS (SELECT 1 FROM json_each(steer_commands.alias_ids) WHERE json_each.value = ?)
                     ELSE 0 END`,
      )
      .get(steerId) as SteerCommandRow | null
    return byAlias ? parseSteerRow(byAlias) : null
  } catch (e) {
    degrade(e, "loadSteerCommand")
    return null
  }
}

/** 读一个会话的命令全表（重启恢复扫描用；按建立时间升序＝投递顺序）。 */
export function loadSteerCommandsForSession(sessionId: string): SteerCommand[] {
  if (!db || !sessionId) return []
  try {
    const rows = db
      .query(`SELECT ${STEER_ROW_COLS} FROM steer_commands WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as SteerCommandRow[]
    return rows.map(parseSteerRow)
  } catch (e) {
    degrade(e, "loadSteerCommandsForSession")
    return []
  }
}

/**
 * 写入/更新一条命令（steer_id 主键 UPSERT）。fail-open 同全局策略。
 * 注意：写入即「身份已冻结」，即使后续流程失败也不回滚——宁可留下未终结的记录
 * （重启恢复会把它落 uncertain），不可留下「查不到＝可重放」的漏洞。
 */
export function saveSteerCommand(c: SteerCommand): void {
  if (!db || !c.steerId) return
  try {
    db.query(
      `INSERT INTO steer_commands
        (steer_id, session_id, owner_key, alias_ids, payload_hash, payload, state, created_at, dispatched_at, settled_at, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(steer_id) DO UPDATE SET
         session_id = excluded.session_id,
         owner_key = excluded.owner_key,
         alias_ids = excluded.alias_ids,
         payload_hash = excluded.payload_hash,
         payload = excluded.payload,
         state = excluded.state,
         dispatched_at = excluded.dispatched_at,
         settled_at = excluded.settled_at,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    ).run(
      c.steerId,
      c.sessionId,
      c.ownerKey,
      JSON.stringify(c.aliasIds ?? []),
      c.payloadHash,
      c.payload,
      c.state,
      c.at,
      c.dispatchedAt ?? null,
      c.settledAt ?? null,
      c.reason ?? null,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveSteerCommand")
  }
}

/** persistence.ts 对 steer-identity 的 SteerLedgerStore 缝实作（生产侧唯一接线）。 */
export const steerCommandStore: SteerLedgerStore = {
  read: loadSteerCommand,
  readBySession: loadSteerCommandsForSession,
  write: saveSteerCommand,
}

/**
 * 清掉长期无活动的 DB rows（gateway 不在内存、updated_at 超过 maxIdleMs）。
 * 回传被删的 { sessionId, opencodeSessionId }，呼叫端负责 best-effort 清理
 * upstream opencode session 与 uploads 目录。
 */
export function sweepStaleRows(maxIdleMs: number): { sessionId: string; opencodeSessionId: string }[] {
  if (!db) return []
  try {
    const cutoff = Date.now() - maxIdleMs
    const rows = db.query("SELECT id, opencode_session_id FROM sessions WHERE updated_at < ?").all(cutoff) as { id: string; opencode_session_id: string }[]
    for (const r of rows) {
      db.query("DELETE FROM sessions WHERE id = ?").run(r.id)
    }
    return rows.map((r) => ({ sessionId: r.id, opencodeSessionId: r.opencode_session_id }))
  } catch (e) {
    degrade(e, "sweep")
    return []
  }
}
