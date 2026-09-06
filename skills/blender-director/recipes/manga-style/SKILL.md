<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/manga-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

---
name: manga-style
description: Manga-inspired art direction for Blender emphasizing monochrome value design, speed lines, screentone feel, and manga panel staging.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: manga, seinen, shonen, shojo, screentone, manga panel, Japanese comic
  related-skills: anime-style, comic-book-style, compositing, camera-cinematography
---

# Manga Style

Value-first. Screentone feel. Panel staging. Distinct from full-color anime.

## Tenets
1. Design in grayscale values first
2. Screentone / hatch textures sparingly
3. Speed lines and emphasis FX
4. Expressive faces / eyes per demographic
5. Black-heavy compositions OK

## Vs anime-style
Anime = color cel; Manga = print value language (can still be 3D color with manga staging).
