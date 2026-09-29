---
name: voxel-style
description: Voxel and Minecraft-adjacent art direction for Blender with block grid modeling, limited palettes, and chunk-friendly assets.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: voxel, Minecraft, blocky, cube world, pixel voxel, grid block, chunk
  related-skills: lowpoly-style, environment-artist, materials, geometry-nodes
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/voxel-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->


# Voxel Style

Block grid language. Limited palette. Chunk-friendly forms.

## When to Use

- Minecraft-adjacent / voxel game assets
- Blockout aesthetic as final style
- Grid-snapped props and characters

## Core Tenets

1. **Grid snap** — Occupancy on explicit voxel size (e.g. 0.1 / 1.0m)
2. **No diagonal organic bevels** — Cubes and stepped forms
3. **Palette atlas** — Few colors; readable blocks
4. **Silhouette via steps** — Not smooth curves
5. **Chunk modularity** — Pieces fit tile sizes

## Workflow

```
Choose voxel size → Block occupancy → Merge cubes
  → Palette materials → Optional GN instance → Export
```

## Modeling Tips

- Start from cubes; boolean union / merge by distance
- Characters: stepped limbs, clear head block
- Avoid subdivision surface (breaks voxel language)
- Remesh to blocks only if converting from smooth

## Materials

- Flat colors or nearest-neighbor textures
- Atlas preferred
- Emission for glow blocks sparingly

## Vs lowpoly-style

- `lowpoly-style` allows irregular low tris / PS1 vibes
- `voxel-style` enforces grid occupancy aesthetic

## Constraints

### MUST DO
- Declare voxel size in brief
- Snap consistently
- Keep palette small

### MUST NOT DO
- Smooth shading that hides block edges (unless intentional glass)
- Organic sculpt detail

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Voxel Grid | `references/voxel-grid.md` | When needed |
| Voxel Characters | `references/voxel-characters.md` | When needed |
