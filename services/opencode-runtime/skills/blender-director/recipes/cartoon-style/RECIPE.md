---
name: cartoon-style
description: Cartoon art direction for Blender with squash-stretch readable shapes, bold colors, and graphic silhouettes for games and animation.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: cartoon, toon, rubber hose, Saturday morning, bold cartoon, graphic cartoon
  related-skills: stylized-style, anime-style, materials, rendering, character-artist
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/cartoon-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W2（风格/mood/世界观）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->


# Cartoon Style

Bold shapes. Graphic color. Readability over realism.

## When to Use
- Cartoon games / animated props and characters
- Exaggerated silhouettes and expressions
- When anime cel language is too specific

## Tenets
1. Silhouette first
2. Exaggerated proportions
3. Limited palette, bold accents
4. Soft or graphic shading (project choice)
5. Detail in shapes, not micro-PBR

## Handoff
`character-artist` / `prop-artist` → `materials` → `lookdev`

## Reference Guide
| Topic | Reference |
|-------|-----------|
| Shape language | `references/cartoon-shape-language.md` |
