<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/painterly-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

---
name: painterly-style
description: Painterly art direction spanning watercolor and oil-painting looks for Blender using soft edges, pigment texture, and illustrative lighting.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: painterly, watercolor, oil painting, impressionist, illustrative paint, gouache
  related-skills: hand-painted-style, stylized-style, materials, compositing, rendering
---

# Painterly Style

Pigment feel. Soft edges. Illustration lighting.

## Sublooks
- Watercolor: paper grain, bleeds, light washes
- Oil: thicker strokes, richer impasto suggestion in texture

## Tenets
1. Soft terminators
2. Pigment/paper overlays in mat or comp
3. Limited harsh specular
4. Composition like a canvas, not a game HUD shot
