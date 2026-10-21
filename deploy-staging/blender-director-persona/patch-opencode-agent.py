#!/usr/bin/env python3
"""opencode.json 合并补丁稿（Astra P1-4 片J）——把 agent.director 条目并入 VPS
live config，**幂等、非破坏**：已存在 director 条目且内容一致则 no-op OK；
不一致则 FAIL（防覆盖人工修改）。禁整档覆盖（live 表含 permission.bash deny
真源、model、45+ 键）。跑法（上线日，经 vps.py）：
  vps.py put deploy-staging/blender-director-persona/patch-opencode-agent.py /tmp/patch-director-agent.py
  vps.py run "sudo python3 /tmp/patch-director-agent.py"
"""

import json
import sys

CFG = "/opt/agent-harness/workspace/.opencode/opencode.json"

DIRECTOR = {
    "description": "3D 导演：接委托单自主驱动 Blender 产出骨架动画与场景资产，只回资产引用与场景摘要，过程不出子代理。",
    "mode": "subagent",
    "prompt": "{file:./prompts/director-agent.md}",
    "tools": {
        "*": False,
        "blender_exec": True,
        "blender_render": True,
        "blender_export_gltf": True,
        "image_quote": True,
    },
}

src = open(CFG).read()
cfg = json.loads(src)
agents = cfg.setdefault("agent", {})
if agents.get("director") == DIRECTOR:
    print("OK: agent.director already identical (no-op)")
    sys.exit(0)
if "director" in agents:
    print("FAIL: agent.director exists with different content — inspect manually")
    sys.exit(1)
agents["director"] = DIRECTOR
open(CFG, "w").write(json.dumps(cfg, ensure_ascii=False, indent=2))
print("OK: agent.director merged")
