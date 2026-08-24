p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
anchor = "// 會話目錄：當前 key 的歷史會話列表（對話歷史 dropdown 的數據源）。"
assert s.count(anchor) == 1, "list route anchor: " + str(s.count(anchor))
route = "// 會話記憶補注：resume/switch 的老會話（建號時記憶為空或當時還沒這功能）\n// 事後補上帳戶畫像——memoryInjected 仍為 false 時下一條訊息注入 system。\nif (req.method === \"POST\" && pathname === \"/agent/v1/sessions/memory-patch\") {\n  const body = (await req.json().catch(() => null)) as { session_id?: string; user_profile?: Record<string, unknown>; lessons?: string[] } | null\n  const sid = body?.session_id ?? \"\"\n  if (!sid) return jsonError(400, \"session_id is required\", \"bad_request\", \"bad_request\")\n  const state = getOwnedSession(key, sid)\n  if (!state) return jsonError(404, \"session not found\", \"not_found\", \"not_found\")\n  const up = body.user_profile ?? {}\n  if (Object.keys(up).length > 0) {\n    state.userMemory = { user_profile: up, lessons: body.lessons ?? [] }\n    // 若記憶已注入過但內容更新了：重置標記讓下一條訊息帶上最新畫像。\n    state.memoryInjected = false\n    markDirty(state)\n    return Response.json({ patched: true, has_profile: true })\n  }\n  return Response.json({ patched: false, has_profile: false })\n}"
s = s.replace(anchor, route + "\n" + anchor)
open(p, "w").write(s)
print("MEMORY PATCH ROUTE OK")
