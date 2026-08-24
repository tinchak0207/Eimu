p = "src/components/agent-chat/AgentChatSurface.tsx"
s = open(p).read()
// imports：lucide 加 Loader2
old1 = 'import { Bot, History } from "lucide-react";'
new1 = 'import { Bot, History, Loader2 } from "lucide-react";'
assert s.count(old1) == 1, "lucide import not found"
s = s.replace(old1, new1)
// cn util
old2 = 'import { useAgentChat } from "@/hooks/use-agent-chat";'
new2 = 'import { cn } from "@/lib/utils";\nimport { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";\nimport { useAgentChat } from "@/hooks/use-agent-chat";'
assert s.count(old2) == 1, "hook import not found"
s = s.replace(old2, new2)
// hook 解構加 switchSession
old3 = "    discardAndStartNew,\n    resume,\n  } = useAgentChat({"
new3 = "    discardAndStartNew,\n    resume,\n    switchSession,\n  } = useAgentChat({"
assert s.count(old3) == 1, "hook destructure not found"
s = s.replace(old3, new3)
open(p, "w").write(s)
print("IMPORTS OK")
