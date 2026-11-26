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
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/vegetation-artist/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W1（工艺/资产）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区（上游按 3.x/4.x 编写，命中以下 API 时以雷区为准）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认视图变换 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->

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
