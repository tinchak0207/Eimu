#!/usr/bin/env python3
# patch-gateway.py — 在 VPS /opt/agent-harness/gateway/index.ts 上：
# 1) 影片 poll 預算 100→200（600s）、圖 40→60（180s）
# 2) 輪詢期間每 15s 推 canvas.node.updated 進度（elapsed/ETA/percent，封頂 95%）
import sys

PATH = "/opt/agent-harness/gateway/index.ts"
src = open(PATH).read()

OLD_BUDGET = """      const pollBudget = node.kind === "video" ? 100 : 40
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))"""

NEW_BUDGET = """      // 2026-08-21（PM 要求）：預算按真實耗時放寬——實測 image 60-90s、kling 8s 影片 >300s
      // （Kling 標準模式約 2-6 分鐘）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 進度條：每 15s 推一次 elapsed/ETA（percent 封頂 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch: { status: "running", progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } },
          })
        }"""

if OLD_BUDGET not in src:
    print("ANCHOR_NOT_FOUND")
    sys.exit(1)
if NEW_BUDGET.split("\n")[4] in src:
    print("ALREADY_PATCHED")
    sys.exit(0)

src = src.replace(OLD_BUDGET, NEW_BUDGET, 1)
open(PATH, "w").write(src)
print("PATCHED")
