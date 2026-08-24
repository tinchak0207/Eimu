p = "src/hooks/use-agent-chat.ts"
s = open(p).read()
old1 = "      await openConnection(lastEventId, ticket);\n      // 续接成功：不再显示「继续上次」提示（存档继续在 transcript 变化时更新）。\n      setResumable(null);\n      persistedRef.current = null;"
new1 = "      await openConnection(lastEventId, ticket);\n      // 续接成功：不再显示「继续上次」提示（存档继续在 transcript 变化时更新）。\n      setResumable(null);\n      persistedRef.current = null;\n      // 老会话补注账户记忆：建号时记忆可能还是空的（或当时没这功能）。\n      void patchAgentSessionMemory(sid);"
assert s.count(old1) == 1, "resume tail: " + str(s.count(old1))
s = s.replace(old1, new1)
old2 = "        } else {\n          dispatch({ type: 'reset' });\n          await openConnection(0, ticket);\n        }\n        return true;"
new2 = "        } else {\n          dispatch({ type: 'reset' });\n          await openConnection(0, ticket);\n        }\n        void patchAgentSessionMemory(targetSessionId);\n        return true;"
assert s.count(old2) == 1, "switch tail: " + str(s.count(old2))
s = s.replace(old2, new2)
old3 = "  requestSseTicket,"
new3 = "  requestSseTicket,\n  patchAgentSessionMemory,"
assert s.count(old3) == 1, "import anchor: " + str(s.count(old3))
s = s.replace(old3, new3)
open(p, "w").write(s)
print("HOOK MEMORY OK")
