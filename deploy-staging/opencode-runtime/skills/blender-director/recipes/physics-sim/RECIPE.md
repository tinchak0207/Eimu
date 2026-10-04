---
name: physics-sim
description: Rigid body, soft body, and destruction setups in Blender including constraints, cell fracture debris, and baked caches via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: physics, rigid body, soft body, destruction, fracture, debris, constraint, simulation bake, collapse
  related-skills: vfx-fx, cloth-sim, animation, export-pipeline, collision-proxy
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/physics-sim/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1（工藝/資產）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

# Physics Sim

Stable rigid/soft body setups. Motivated destruction. Baked caches.

## When to Use

- Rigid body interactions and collapses
- Soft body jiggle / rubber / simple soft props
- Destruction and debris (cell fracture / pre-cut shards)
- Pre-vis physics before VFX polish

## Workflow

```
Simplify collision meshes → Assign rigid/soft bodies
  → Constraints → Passive settings → Bake → Art-direct → Export cache
```

## Rigid Body Quick Rules

| Role | Settings notes |
|------|----------------|
| Active | Moving debris / props |
| Passive | Floors, walls, heavy anchors |
| Convex hull | Fast, approximate |
| Mesh | Accurate, heavier |

- Apply scale before sim
- Use margin appropriate to scale
- Collection: `COL_Physics_[Shot]`

## Constraints

- Hinge / fixed / motor for mechanical links
- Breakable constraints for destruction beats
- Name: `RBCON_[Object]_[Type]`

## Destruction Approach

```
1. Pre-cut shards (cell fracture or manual)
2. Island meshes as active rigid bodies
3. Passive shell until trigger frame
4. Animate trigger (force / keyframed activation)
5. Bake → cleanup interpenetrations
```

## Soft Body

- Prefer for simple soft props; use `cloth-sim` for garments
- Goal weights to retain shape
- Soft + collision object required

## Bake / Export

- Bake to cache before render
- Alembic/USD for cinematic debris
- For games: bake key poses or flipbook; rarely live Blender physics

## Constraints

### MUST DO
- Apply scale; use simplified colliders
- Bake before final delivery
- Trigger destruction intentionally (frame)

### MUST NOT DO
- High-res sculpt meshes as active colliders
- Unbounded shard counts
- Leave sims unbaked for final renders

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Rigid Body Presets | `references/rigid-body-presets.md` | When needed |
| Destruction Pipeline | `references/destruction-pipeline.md` | When needed |
| Sim Bake Checklist | `references/sim-bake-checklist.md` | When needed |
