#!/usr/bin/env python3
"""agent-models.json 模型頂位補丁稿（Astra P1-4 片J）——登記 3D 導演 persona
模型位：bindings.persona.director = 現有便宜模型（頂位語義：測試期照抄
bindings.persona.efficient 的現值；Astra 真模型上線日只換這一個 id）。

欄位名考古（記憶 agent-persona-bound-model-reasoning + 2026-08-31
patch-index.py 實錘）：persona→模型 真源 = /opt/agent-harness/agent-models.json
`bindings.persona.<mode>`（字串 "provider/model"）+ `bindings.fallbacks.<mode>`
（字串陣列）；gateway personaModel()/subagentModelChain() 經 loadAgentModelRegistry
讀此表，registry 按 mtime 自動重載（改表不重啟 gateway）。

冪等語義與 opencode 補丁一致：已存在且一致 = no-op；存在但不同 = FAIL（防覆蓋
並行改動——08-31 實錘 efficient 曾被並行改值，只動自己的鍵）。
"""

import json
import sys

REG = "/opt/agent-harness/agent-models.json"

reg = json.loads(open(REG).read())
bindings = reg.setdefault("bindings", {})
persona = bindings.setdefault("persona", {})
fallbacks = bindings.setdefault("fallbacks", {})

efficient = persona.get("efficient")
if not isinstance(efficient, str) or "/" not in efficient:
    print("FAIL: bindings.persona.efficient 缺失或非 'provider/model' 形，無頂位可抄 — 先核 registry")
    sys.exit(1)

director = persona.get("director")
if director == efficient and fallbacks.get("director") == fallbacks.get("efficient"):
    print(f"OK: bindings.persona.director already = {efficient} (no-op)")
    sys.exit(0)
if "director" in persona or "director" in fallbacks:
    print("FAIL: bindings.director 已存在但與頂位不一致 — 人工核對（可能有並行改動）")
    sys.exit(1)

persona["director"] = efficient
fallbacks["director"] = list(fallbacks.get("efficient", []))
open(REG, "w").write(json.dumps(reg, ensure_ascii=False, indent=2))
print(f"OK: bindings.persona.director = {efficient}（fallbacks 照抄 efficient）")
