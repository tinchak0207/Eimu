p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
start_marker = "// L0 畫像 onboarding：賬戶還沒有任何確認過的畫像時，引導 agent 用 question 工具"
end_marker = "].join(\"\\n\")"
i0 = s.find(start_marker)
assert i0 != -1, "directive start not found"
i1 = s.find(end_marker, i0)
assert i1 != -1, "directive end not found"
i1 += len(end_marker)
block = s[i0:i1]
assert "PROFILE_ONBOARDING_DIRECTIVE" in block, "sanity: block contains const"
s = s[:i0] + s[i1:]
anchor = "async function handleSendMessage(key: string, id: string, req: Request): Promise<Response> {"
assert s.count(anchor) == 1, "handleSendMessage anchor: " + str(s.count(anchor))
s = s.replace(anchor, block + "\n\n" + anchor)
open(p, "w").write(s)
print("DIRECTIVE MOVED OK")
