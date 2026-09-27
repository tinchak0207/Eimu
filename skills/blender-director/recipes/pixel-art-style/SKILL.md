---
name: pixel-art-style
description: Pixel-art and texel-constrained art direction for Blender assets destined for pixel rendering, low-res textures, or HD-2D-adjacent pixel reads.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: pixel art, pixel, texel, low res texture, sprite-like, pixelated
  related-skills: lowpoly-style, retro-8bit-style, retro-16bit-style, hd-2d-style, materials
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/pixel-art-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->


# Pixel Art Style

Texel discipline. Crisp pixels. Limited palette.

## Tenets
1. Declare target texel size / texture res
2. Nearest filtering intent
3. Limited palette
4. Avoid thin triangles that shimmer
5. Ortho or locked angles help readability

## Reference Guide
| Topic | Reference |
|-------|-----------|
| Texel rules | `references/texel-rules.md` |
