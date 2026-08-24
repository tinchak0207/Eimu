p = "src/lib/agent-chat-client.ts"
s = open(p).read()
anchor = "/** 列出當前用戶的歷史會話（按 updated_at 降序）。 */"
assert s.count(anchor) == 1, "list anchor: " + str(s.count(anchor))
addition = "/** 會話記憶補注：resume/switch 的老會話補上帳戶畫像（best-effort，失敗不打擾）。 */\nexport async function patchAgentSessionMemory(sessionId: string): Promise<void> {\n  try {\n    await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/memory`, { method: \"POST\" });\n  } catch {\n    // 補不上就算了：下一次建新會話時記憶仍會正常注入。\n  }\n}"
s = s.replace(anchor, addition + "\n" + anchor)
open(p, "w").write(s)
print("CLIENT MEMORY OK")
