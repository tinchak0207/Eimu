p = "/opt/agent-harness/gateway/persistence.ts"
s = open(p).read()
anchor = "export function deleteSessionRow(id: string): void {"
assert s.count(anchor) == 1, "deleteSessionRow not found"
func = """
// 會話目錄：當前 key 的全部會話 row（按 updated_at 降序）。給
// GET /agent/v1/sessions 列表端點用；data 只解 lastActivityAt 一個字段，
// 不做完整 hydrate（目錄不需要整包狀態）。
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

"""
s = s.replace(anchor, func + "\n" + anchor)
open(p, "w").write(s)
print("PERSISTENCE PATCHED")
