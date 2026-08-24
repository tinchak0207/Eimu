p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
old_a = "  memoryInjected: boolean"
new_a = "  memoryInjected: boolean\n  /** 賬戶無畫像：開場用選擇題採集（question 工具）。 */\n  profileOnboardingPending: boolean"
assert s.count(old_a) == 1, "state iface: " + str(s.count(old_a))
s = s.replace(old_a, new_a)
old_b = "const raw = (await req.json()) as { user_profile?: Record<string, unknown>; lessons?: string[] } | null"
new_b = "const raw = (await req.json()) as { user_profile?: Record<string, unknown>; lessons?: string[]; memory_empty?: boolean } | null"
assert s.count(old_b) == 1, "create body: " + str(s.count(old_b))
s = s.replace(old_b, new_b)
old_c = "    memoryInjected: false,"
new_c = "    memoryInjected: false,\n    profileOnboardingPending: memoryBody.memory_empty === true,"
assert s.count(old_c) == 1, "state init: " + str(s.count(old_c))
s = s.replace(old_c, new_c)
open(p, "w").write(s)
print("ONBOARDING STATE OK")
