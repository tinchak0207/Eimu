p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
old = "    promptBody.system = [vettingLines, ...(memoryLines.length > 0 ? memoryLines : [])].join(\"\\n\\n\")"
new = "    const onboardingLines = state.profileOnboardingPending ? [PROFILE_ONBOARDING_DIRECTIVE] : []\n    promptBody.system = [vettingLines, ...(memoryLines.length > 0 ? memoryLines : []), ...onboardingLines].join(\"\\n\\n\")"
assert s.count(old) == 1, "system join: " + str(s.count(old))
s = s.replace(old, new)
open(p, "w").write(s)
print("ONBOARDING INJECT OK")
