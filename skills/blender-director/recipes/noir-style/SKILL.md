---
name: noir-style
description: Noir art direction for Blender with high-contrast lighting, wet streets, silhouettes, and monochrome or limited-color grading.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: noir, neo-noir, hardboiled, detective noir, high contrast black and white
  related-skills: camera-cinematography, lighting, compositing, materials, lookdev
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/noir-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W2（风格/mood/世界观）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->


# Noir Style

Shadows as design. Silhouettes. Wet ground mirrors. Limited color or mono.

## Tenets
1. Motivated hard keys / blinds / neon slash
2. Negative fill
3. Smoke/fog shafts
4. Costume readable in silhouette
5. Grade crushed but detailed shadows
