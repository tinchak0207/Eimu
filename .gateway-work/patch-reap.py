p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
old1 = 'function teardownSession(id: string, state: SessionState, reason: string): void {\n  sessions.delete(id)\n  dirtySessions.delete(id)\n  deleteSessionRow(id)'
new1 = 'function teardownSession(id: string, state: SessionState, reason: string, keepRow = false): void {\n  sessions.delete(id)\n  dirtySessions.delete(id)\n  // idle reaper keeps the sqlite row: lazy reload can revive the session later.\n  // Only explicit DELETE removes the durable record.\n  if (!keepRow) deleteSessionRow(id)'
assert s.count(old1) == 1, 'teardown signature not found'
s = s.replace(old1, new1)
old2 = 'teardownSession(id, state, "idle_timeout")'
assert s.count(old2) == 1, 'idle teardown call not found'
s = s.replace(old2, 'teardownSession(id, state, "idle_timeout", true)')
open(p, 'w').write(s)
print('PATCHED')
