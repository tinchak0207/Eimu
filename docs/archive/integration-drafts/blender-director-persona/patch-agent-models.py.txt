#!/usr/bin/env python3
"""agent-models.json 模型顶位补丁稿（Astra P1-4 片J）——登记 3D 导演 persona
模型位：bindings.persona.director = 现有便宜模型（顶位语义：测试期照抄
bindings.persona.efficient 的现值；Astra 真模型上线日只换这一个 id）。

栏位名考古（记忆 agent-persona-bound-model-reasoning + 2026-08-31
patch-index.py 实锤）：persona→模型 真源 = /opt/agent-harness/agent-models.json
`bindings.persona.<mode>`（字串 "provider/model"）+ `bindings.fallbacks.<mode>`
（字串阵列）；gateway personaModel()/subagentModelChain() 经 loadAgentModelRegistry
读此表，registry 按 mtime 自动重载（改表不重启 gateway）。

幂等语义与 opencode 补丁一致：已存在且一致 = no-op；存在但不同 = FAIL（防覆盖
并行改动——08-31 实锤 efficient 曾被并行改值，只动自己的键）。
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
    print("FAIL: bindings.persona.efficient 缺失或非 'provider/model' 形，无顶位可抄 — 先核 registry")
    sys.exit(1)

director = persona.get("director")
if director == efficient and fallbacks.get("director") == fallbacks.get("efficient"):
    print(f"OK: bindings.persona.director already = {efficient} (no-op)")
    sys.exit(0)
if "director" in persona or "director" in fallbacks:
    print("FAIL: bindings.director 已存在但与顶位不一致 — 人工核对（可能有并行改动）")
    sys.exit(1)

persona["director"] = efficient
fallbacks["director"] = list(fallbacks.get("efficient", []))
open(REG, "w").write(json.dumps(reg, ensure_ascii=False, indent=2))
print(f"OK: bindings.persona.director = {efficient}（fallbacks 照抄 efficient）")
