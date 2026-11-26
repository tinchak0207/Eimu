import { Database } from "bun:sqlite"
import { DRAIN_TOMBSTONE_RETENTION_MS, type AgentMessage, type AgentMessageType, type TeamRow, type TeamMemberRow, type MessageRow } from "./agent-mailbox-types"
let connection: Database | undefined

export function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    team TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'message',
    text TEXT NOT NULL,
    summary TEXT,
    color TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(session_id,msg_id));
    CREATE TABLE IF NOT EXISTS agent_teams (
      team TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      lead_agent TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_team_members (
      team TEXT NOT NULL,
      agent TEXT NOT NULL,
      agent_type TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(team,agent));
    CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(session_id,to_agent,read);`)
  migrateMsgIdScope(next)
  ensureTombstoneColumn(next)
  connection = next
  return next
}

/**
 * read=2 是 drain tombstone（不再物理删行）：唯一键在保留窗口内继续保证
 * 同一 msg_id 重试不重投。老库补 delivered_at 列；无该列时旧语义仍然成立。
 */
function ensureTombstoneColumn(conn: Database): void {
  const columns = conn.query("PRAGMA table_info(agent_messages)").all() as Array<{ name?: string }>
  if (!columns.some((column) => column.name === "delivered_at")) {
    conn.exec("ALTER TABLE agent_messages ADD COLUMN delivered_at INTEGER")
  }
  conn.exec(
    "CREATE INDEX IF NOT EXISTS agent_messages_drained ON agent_messages(read, delivered_at);" +
      "CREATE INDEX IF NOT EXISTS agent_messages_agent_inbox ON agent_messages(session_id,to_agent,read,id);",
  )
  cleanupDrainedMessages(conn)
}

/** 清理策略：drain tombstone 超过 7 天物理删除（只在开库/写入时跑，成本 O(过期行数)）。 */
export function cleanupDrainedMessages(conn: Database): void {
  const cutoff = Date.now() - DRAIN_TOMBSTONE_RETENTION_MS
  conn.query("DELETE FROM agent_messages WHERE read=2 AND delivered_at IS NOT NULL AND delivered_at < ?").run(cutoff)
}

/**
 * H1 迁移：旧表是 msg_id 全局 UNIQUE；新语义是 (session_id,msg_id) 唯一。
 * SQLite 不能就地改约束，只能在 IMMEDIATE 事务里重建表（保留 id 与全部行）。
 * 多进程同时启动时事务串行化，第二个进程在事务内重读 schema 后直接跳过。
 */
function migrateMsgIdScope(conn: Database): void {
  const readSql = (): string => {
    const row = conn
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_messages'")
      .get() as { sql?: string } | null
    return typeof row?.sql === "string" ? row.sql : ""
  }
  const current = readSql()
  if (!current || /unique\s*\(\s*session_id\s*,\s*msg_id\s*\)/i.test(current)) return
  conn.exec("BEGIN IMMEDIATE")
  try {
    if (/unique\s*\(\s*session_id\s*,\s*msg_id\s*\)/i.test(readSql())) {
      conn.exec("COMMIT")
      return
    }
    conn.exec(`DROP TABLE IF EXISTS agent_messages_legacy;
      ALTER TABLE agent_messages RENAME TO agent_messages_legacy;
      CREATE TABLE agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        team TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        text TEXT NOT NULL,
        summary TEXT,
        color TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(session_id,msg_id));
      INSERT INTO agent_messages(id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at)
        SELECT id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at FROM agent_messages_legacy;
      DROP TABLE agent_messages_legacy;
      CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(session_id,to_agent,read);`)
    conn.exec("COMMIT")
    console.warn("[gateway] mailbox: migrated agent_messages to UNIQUE(session_id,msg_id)")
  } catch (e) {
    try {
      conn.exec("ROLLBACK")
    } catch {
      // 已经回滚或连接已失效：保留原始错误。
    }
    throw e
  }
}

// ── 事务：BEGIN IMMEDIATE + 3 次退避重试（M3）─────────────────────────────
const BUSY_RETRY_DELAYS_MS = [25, 75, 150]

function sleepSync(ms: number): void {
  // bun:sqlite 是同步 API；这里也用同步睡眠，避免事务跨 await 变成多线程竞争。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms)
}

function isBusyError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return /SQLITE_BUSY|database (?:table )?is locked/i.test(text)
}

/** 立即事务（写锁一开始就拿到），SQLITE_BUSY 最多重试 3 次。 */
export function withImmediate<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      db().exec("BEGIN IMMEDIATE")
    } catch (e) {
      if (attempt < BUSY_RETRY_DELAYS_MS.length && isBusyError(e)) {
        sleepSync(BUSY_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
    try {
      const result = fn()
      db().exec("COMMIT")
      return result
    } catch (e) {
      try {
        db().exec("ROLLBACK")
      } catch {
        // 事务可能已被 SQLite 自动回滚。
      }
      if (attempt < BUSY_RETRY_DELAYS_MS.length && isBusyError(e)) {
        sleepSync(BUSY_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
  }
}
export function decodeMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    msg_id: row.msg_id,
    session_id: row.session_id,
    team: row.team,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type as AgentMessageType,
    text: row.text,
    summary: row.summary,
    color: row.color,
    read: row.read === 1,
    timestamp: new Date(row.created_at).toISOString(),
    created_at: row.created_at,
  }
}

export function primaryTeam(sessionId: string): TeamRow | null {
  return (
    (db()
      .query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE session_id=? ORDER BY created_at ASC, team ASC LIMIT 1")
      .get(sessionId) as TeamRow | null) ?? null
  )
}

export function teamMembers(team: string): TeamMemberRow[] {
  return db()
    .query("SELECT team,agent,agent_type,joined_at FROM agent_team_members WHERE team=? ORDER BY joined_at ASC, agent ASC")
    .all(team) as TeamMemberRow[]
}
