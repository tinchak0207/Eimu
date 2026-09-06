<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/hd-2d-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

---
name: hd-2d-style
description: HD-2D art direction combining pixel characters/sprites with 3D environments, depth of field, and theatrical lighting.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: HD-2D, HD2D, Octopath, triangle strategy, pixel 3D hybrid
  related-skills: pixel-art-style, environment-artist, camera-cinematography, lighting, compositing
---

# HD-2D Style

Pixel actors. 3D stage. Tilted theatrical camera. Creamy DoF.

## Tenets
1. Characters: pixel/billboard or texel-locked
2. Environments: soft 3D with painted textures
3. Strong DoF / god rays
4. Ortho-leaning perspective
5. Warm theatrical keys
