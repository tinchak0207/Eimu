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
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/noir-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->


# Noir Style

Shadows as design. Silhouettes. Wet ground mirrors. Limited color or mono.

## Tenets
1. Motivated hard keys / blinds / neon slash
2. Negative fill
3. Smoke/fog shafts
4. Costume readable in silhouette
5. Grade crushed but detailed shadows
