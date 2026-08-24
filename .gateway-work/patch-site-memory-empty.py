p = "src/app/api/agent/sessions/route.ts"
s = open(p).read()
old = "  if (memoryInjection) {\n    payload.user_profile = memoryInjection.user_profile;\n    payload.lessons = memoryInjection.lessons;\n  }"
new = "  if (memoryInjection) {\n    payload.user_profile = memoryInjection.user_profile;\n    payload.lessons = memoryInjection.lessons;\n  } else {\n    // 账户还没有画像：告知网关，首条消息时引导 agent 用选择题做 onboarding。\n    payload.memory_empty = true;\n  }"
assert s.count(old) == 1, "payload block: " + str(s.count(old))
s = s.replace(old, new)
open(p, "w").write(s)
print("SITE MEMORY EMPTY OK")
