p = "src/components/agent-chat/AgentChatSurface.tsx"
s = open(p).read()
old = "\"flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors\","
new = "\"flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left leading-normal transition-colors\","
assert s.count(old) == 1, "item class: " + str(s.count(old))
s = s.replace(old, new)
old2 = "<span className=\"min-w-0 flex-1\">"
new2 = "<span className=\"flex min-w-0 flex-1 flex-col gap-0.5\">"
assert s.count(old2) == 1, "label wrapper: " + str(s.count(old2))
s = s.replace(old2, new2)
anchor = "  const [switchingTo, setSwitchingTo] = useState<string | null>(null);"
assert s.count(anchor) == 1, "switchingTo state: " + str(s.count(anchor))
click_outside = "  const [switchingTo, setSwitchingTo] = useState<string | null>(null);\n  const historyRef = useRef<HTMLDivElement | null>(null);\n\n  // 開著的 dropdown：點外面就收——浮層不該把人鎖在原地。\n  useEffect(() => {\n    if (!showHistory) return;\n    const onDocPointerDown = (ev: PointerEvent): void => {\n      if (historyRef.current && !historyRef.current.contains(ev.target as Node)) {\n        setShowHistory(false);\n      }\n    };\n    document.addEventListener(\"pointerdown\", onDocPointerDown);\n    return () => document.removeEventListener(\"pointerdown\", onDocPointerDown);\n  }, [showHistory]);"
s = s.replace(anchor, click_outside)
old3 = "<div className=\"relative mb-2 flex shrink-0 flex-col items-start gap-1.5\">"
new3 = "<div ref={historyRef} className=\"relative mb-2 flex shrink-0 flex-col items-start gap-1.5\">"
assert s.count(old3) == 1, "dropdown wrapper: " + str(s.count(old3))
s = s.replace(old3, new3)
open(p, "w").write(s)
print("DD POLISH OK")
