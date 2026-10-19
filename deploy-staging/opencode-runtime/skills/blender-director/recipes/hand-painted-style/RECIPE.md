---
name: hand-painted-style
description: Hand-painted texture art direction for Blender with brushwork albedo, soft value transitions, and stylized PBR restraint.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: hand painted, hand-painted, painted texture, brushwork, stylized painted
  related-skills: stylized-style, texture-workflow, materials, lookdev
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/hand-painted-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W2（风格/mood/世界观）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->


# Hand Painted Style

Brushwork in albedo. Geometry supports paint, not microdetail.

## Tenets
1. Paint values in albedo
2. Low roughness variation unless wet/metal accents
3. Soft bevels for paint catch
4. Atlas-friendly for kits
5. Avoid photoreal photo-bashed noise
