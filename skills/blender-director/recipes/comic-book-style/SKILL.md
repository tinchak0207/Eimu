---
name: comic-book-style
description: Comic book and graphic-novel art direction for Blender with ink-line emphasis, halftone cues, and high-contrast framing.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: comic book, comics, graphic novel, ink lines, halftone, Ben Day, superhero comic
  related-skills: stylized-style, materials, rendering, compositing, camera-cinematography
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/comic-book-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->


# Comic Book Style

Ink-ready contrast. Panel-friendly staging. Halftone optional.

## Tenets
1. High contrast lighting for ink read
2. Strong contour / crease support
3. Limited screentone / hatch language in textures or comp
4. Hero poses and camera angles
5. Speeds lines / impacts as FX meshes when needed

## Reference Guide
| Topic | Reference |
|-------|-----------|
| Ink & tone | `references/ink-tone.md` |
