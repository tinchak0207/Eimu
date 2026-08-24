p = "src/lib/agent-chat-client.ts"
s = open(p).read()
old = "    if (typeof d.error === \"string\" && d.error.length > 0) return d.error;"
new = "    if (typeof d.error === \"string\" && d.error.length > 0) return GATEWAY_MESSAGE_ZH[d.error] ?? d.error;"
assert s.count(old) == 1, "error return not found"
s = s.replace(old, new)
anchor = "function extractMessage(data: unknown, status: number): string {"
assert s.count(anchor) == 1, "extractMessage not found"
map_table = "/** 網關技術名詞 → 使用者能懂的人話。只映射確定語義的，未知的原樣透傳。 */\nconst GATEWAY_MESSAGE_ZH: Record<string, string> = {\n  \"question request unknown or already resolved\": \"这个选择已经提交过了，无需重复操作。\",\n  \"confirm request unknown or already resolved\": \"这个确认已处理过，请继续对话。\",\n};\n\n"
s = s.replace(anchor, map_table + anchor)
open(p, "w").write(s)
print("MSG MAP OK")
