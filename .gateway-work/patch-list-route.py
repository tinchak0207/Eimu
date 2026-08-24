p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
old = "  loadSessionById,\n  loadSessionByOpencodeId,"
new = "  loadSessionById,\n  loadSessionByOpencodeId,\n  listSessionRows,"
assert s.count(old) == 1, "import block not found"
s = s.replace(old, new)
anchor = 'if (req.method === "POST" && pathname === "/agent/v1/sessions") {'
assert s.count(anchor) == 1, "POST sessions route not found"
route = '''
// 會話目錄：當前 key 的歷史會話列表（對話歷史 dropdown 的數據源）。
if (req.method === "GET" && pathname === "/agent/v1/sessions") {
  const rows = listSessionRows(key)
  return Response.json({
    object: "agent.session.list",
    sessions: rows.map((r) => ({
      session_id: r.sessionId,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      last_activity_at: r.data.lastActivityAt ?? r.updatedAt,
    })),
  })
}
'''
s = s.replace(anchor, route + "\n\n    " + anchor)
open(p, "w").write(s)
print("INDEX PATCHED")
