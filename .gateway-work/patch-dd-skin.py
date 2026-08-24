p = "src/components/agent-chat/AgentChatSurface.tsx"
s = open(p).read()
old = "className=\"absolute top-full left-0 z-30 mt-1 w-64 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] bg-white/95 p-1.5 shadow-lg backdrop-blur\""
new = "className=\"absolute top-full -left-2 z-30 mt-0.5 w-56 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] bg-white/98 p-1 shadow-md\""
assert s.count(old) == 1, "dropdown class count: " + str(s.count(old))
s = s.replace(old, new)
old2 = "\"flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors\","
new2 = "\"flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors\","
assert s.count(old2) == 1, "item class count: " + str(s.count(old2))
s = s.replace(old2, new2)
open(p, "w").write(s)
print("DD SKIN OK")
