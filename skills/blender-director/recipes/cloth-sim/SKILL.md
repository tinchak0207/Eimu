---
name: cloth-sim
description: Garment blockout, cloth simulation, pin groups, and bake to shape keys or caches for characters and props in Blender via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: cloth, garment, clothing sim, fabric sim, pin group, shape key bake, cloth bake, dress, cape, soft clothing
  related-skills: character-artist, physics-sim, materials, animation, export-pipeline
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/cloth-sim/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1（工藝/資產）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

# Cloth Sim

Garment blockout → sim → art-direct → bake. Stable pins. Engine-friendly caches/shape keys.

## When to Use

- Dresses, capes, coats, flags, banners
- Character clothing that needs drape
- Baking sim to shape keys or Alembic/USD caches
- Pre-roll settling before animation export

## Workflow

```
Garment mesh (quad-friendly) → Vertex groups (pin/collide)
  → Cloth modifier settings → Collision objects
  → Pre-roll settle → Sim pass → Art-direct fixes
  → Bake shape keys / cache → Cleanup → Export
```

## Mesh Prep

- Quads preferred; even density on deforming areas
- Avoid long skinny triangles on folds
- Apply scale before sim
- Separate garment from body collider

## Vertex Groups

| Group | Purpose |
|-------|---------|
| `PIN_Cloth` | Anchors (waist, shoulders, collar) |
| `COL_Ignore` | Optional non-colliding regions |
| `STIFF_High` | Belts, seams that should resist stretch |

## Settings Starters

| Look | Quality | Speed | Bending |
|------|---------|-------|---------|
| Soft dress | 8–12 | 1.0 | Low |
| Stiff coat | 5–8 | 1.0 | Higher |
| Flag/cape | 8–10 | 1.0–1.5 | Low–mid |

Tune mass and air viscosity for scale. Always run a settle pre-roll.

## Bake Targets

| Target | Use |
|--------|-----|
| Shape keys | Game poses / few frames |
| Alembic/USD | Cinematic caches |
| Armature weights | If converting to deform-only |

## Constraints

### MUST DO
- Apply scale; define pin groups before long sims
- Collide against simplified body capsule/mesh
- Art-direct after sim (sculpt/corrective keys)

### MUST NOT DO
- Sim hero cloth on ultra-dense sculpt meshes
- Skip pre-roll (starts mid-air / exploding)
- Export raw unstable caches

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Cloth Settings Presets | `references/cloth-settings-presets.md` | When needed |
| Pin And Collide | `references/pin-and-collide.md` | When needed |
| Bake Targets | `references/bake-targets.md` | When needed |
