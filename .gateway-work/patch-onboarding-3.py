p = "/opt/agent-harness/gateway/persistence.ts"
s = open(p).read()
old_a = "  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }"
assert s.count(old_a) == 2, "iface x2: " + str(s.count(old_a))
new_a = "  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }\n  profileOnboardingPending?: boolean"
s = s.replace(old_a, new_a)
old_b = "    userMemory: state.userMemory,"
new_b = "    userMemory: state.userMemory,\n    profileOnboardingPending: state.profileOnboardingPending,"
assert s.count(old_b) == 1, "save field: " + str(s.count(old_b))
s = s.replace(old_b, new_b)
old_c = "    userMemory: d.userMemory,"
new_c = "    userMemory: d.userMemory,\n    profileOnboardingPending: d.profileOnboardingPending === true,"
assert s.count(old_c) == 1, "load field: " + str(s.count(old_c))
s = s.replace(old_c, new_c)
open(p, "w").write(s)
print("PERSIST ONBOARDING OK")
