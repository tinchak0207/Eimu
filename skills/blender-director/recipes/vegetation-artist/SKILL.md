<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/vegetation-artist/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1（工藝/資產）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->
---
name: vegetation-artist
description: Vegetation and foliage authoring for Blender including trees, plants, grass cards, canopy LODs, and game-friendly leaf atlases via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: vegetation, foliage, tree, plant, grass, bush, leaf cards, canopy, ivy, forest
  related-skills: environment-artist, geometry-nodes, materials, lod-pipeline, procedural-modeling
---

# Vegetation Artist

Believable plants. Card efficiency. Wind-ready pivots. Canopy LODs.

## When to Use

- Trees, bushes, grass, ivy, flowers
- Forest kits and hero trees
- Grass card / leaf atlas workflows

## Path Decision

```
Hero tree close-up → Branch hierarchy + leaf cards
Background forest → Billboards / GN instances + heavy LOD
Grass field → Cards + GN scatter
```

## Workflow

```
Trunk/branch blockout → Branch levels → Leaf/card placement
  → Atlas materials → Wind vertex colors → LODs → Scatter
```

## Game Plant Structure

| Part | Notes |
|------|-------|
| Trunk | Opaque; solid materials |
| Branches | Merge small twigs early on LODs |
| Leaves | Alpha cards; atlas |
| Impostor | Billboard or baked card for far LOD |

## Atlas Rules

- Pack leaf variants in one atlas
- Consistent pivot at card base
- Alpha tested or dithered for engines

## Wind Prep

- Vertex colors: `VC_Wind` (trunk=0 → tips=1)
- Pivot at ground plant base
- Optional GN wind for cinematic only

## Constraints

### MUST DO
- Plan LODs with canopy silhouette
- Keep leaf alpha cheap
- Ground pivot correct for scatter

### MUST NOT DO
- Unique leaf mesh per leaf on game trees
- Skip impostor for dense forests

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Leaf Atlas | `references/leaf-atlas.md` | When needed |
| Tree Lod | `references/tree-lod.md` | When needed |
| Wind Vertex Colors | `references/wind-vertex-colors.md` | When needed |
