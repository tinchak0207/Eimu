p = "src/components/agent-chat/AgentChatSurface.tsx"
s = open(p).read()
old = "className=\"absolute top-full -left-2 z-30 mt-0.5 w-56 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] bg-white/98 p-1 shadow-md\""
new = "className=\"absolute top-full -left-2 z-50 mt-0.5 w-56 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] bg-white p-1 shadow-md\""
assert s.count(old) == 1, "dropdown class: " + str(s.count(old))
s = s.replace(old, new)
open(p, "w").write(s)
print("Z FIX OK")
