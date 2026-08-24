#!/usr/bin/env python3
"""修復 2026-08-21 測試輪發現的 workflow 引擎假陽性：
1. workflow-service.ts generate()：全 text/config 節點 → 明確報錯（原本靜默 success）
2. workflow_add_node.ts：kind 語義寫清楚（config 不執行；image/video 才生成）
"""
import sys

def patch(path, old, new, label):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if new in src:
        print(f"[skip] {label} already patched")
        return True
    if old not in src:
        print(f"[FAIL] {label}: old text not found in {path}")
        return False
    src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print(f"[ok] {label} patched")
    return True

ok1 = patch(
    "/opt/agent-harness/gateway/workflow-service.ts",
    """    // 展開節點流 → emit plan + node.created + connected（前端渲染整條流）
    this.emitGraph(wf)
""",
    """    // 展開節點流 → emit plan + node.created + connected（前端渲染整條流）
    this.emitGraph(wf)

    // 防假陽性（2026-08-21 測試輪實錄）：模型可能把生成節點建成 config 類型，
    // 引擎逐節點跳過後仍回 success——前端顯示「跑完了」實際什麼都沒發生。
    // 全工作流沒有任何可執行節點時必須顯式報錯，把正確的 kind 語義告訴模型。
    const executableCount = order.filter((id) => {
      const node = wf.graph.nodes.find((n) => n.id === id)
      return node && node.kind !== "text" && node.kind !== "config"
    }).length
    if (executableCount === 0) {
      wf.status = "failed"
      return {
        ok: false,
        status:
          "no executable nodes: every node is text/config, which the engine skips. " +
          "Nodes that should produce an image or video must be created with kind='image' or kind='video' " +
          "(config nodes are reference/data-only and never execute).",
      }
    }
""",
    "engine zero-executable guard",
)

ok2 = patch(
    "/opt/agent-harness/workspace/.opencode/tools/workflow_add_node.ts",
    '''    kind: tool.schema.enum(["text", "config", "image", "video"]).describe("node type"),''',
    '''    kind: tool.schema.enum(["text", "config", "image", "video"]).describe(
      "text = prompt/data node (engine skips); config = reference/setting node, NEVER executed — use only for inputs other nodes consume; image = generates an image via the platform (REQUIRED for any node that must output an image); video = generates a video via the platform (REQUIRED for any node that must output a video)",
    ),''',
    "add_node kind semantics",
)

sys.exit(0 if (ok1 and ok2) else 1)
