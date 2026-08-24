p = "src/components/agent-chat/agent-chat.css"
s = open(p).read()
old = ".agent-panel {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  flex: 1;\n  overflow: hidden;\n}"
new = ".agent-panel {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  flex: 1;\n}"
assert s.count(old) == 1, "panel css count: " + str(s.count(old))
s = s.replace(old, new)
open(p, "w").write(s)
print("OVERFLOW REVERTED")
