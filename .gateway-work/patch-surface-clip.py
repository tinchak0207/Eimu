p = "src/components/agent-chat/AgentChatSurface.tsx"
s = open(p).read()
old = "className={isInline ? \"flex min-h-0 flex-1 flex-col pb-2.5\" : \"page-shell flex flex-col pb-4 pt-3\"}"
new = "className={isInline ? \"flex min-h-0 flex-1 flex-col overflow-hidden pb-2.5\" : \"page-shell flex flex-col pb-4 pt-3\"}"
assert s.count(old) == 1, "surface class: " + str(s.count(old))
s = s.replace(old, new)
open(p, "w").write(s)
print("SURFACE CLIP OK")
