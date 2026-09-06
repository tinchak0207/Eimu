#!/usr/bin/env python3
"""opencode.json 合併補丁稿（Astra P1-4 片J）——把 agent.director 條目併入 VPS
live config，**冪等、非破壞**：已存在 director 條目且內容一致則 no-op OK；
不一致則 FAIL（防覆蓋人工修改）。禁整檔覆蓋（live 表含 permission.bash deny
真源、model、45+ 鍵）。跑法（上線日，經 vps.py）：
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
