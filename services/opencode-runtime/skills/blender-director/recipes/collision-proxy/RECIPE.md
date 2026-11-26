---
name: collision-proxy
description: Collision proxy authoring for games including UCX/UHX naming, convex hulls, capsules, and simple collider meshes in Blender via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: collision, collider, UCX, UHX, convex hull, physics proxy, hitbox, blocking volume
  related-skills: lod-pipeline, unity-export, unreal-export, asset-optimization, physics-sim
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/collision-proxy/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W1（工艺/资产）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区（上游按 3.x/4.x 编写，命中以下 API 时以雷区为准）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认视图变换 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->

# Collision Proxy

Simple, stable colliders. Prefer primitives and convex pieces over render mesh.

## When to Use

- Game physics / blocking volumes
- Unreal UCX export
- Unity mesh or primitive colliders
- Hitboxes for interactables

## Workflow

```
Identify collision needs → Build proxies → Name correctly
  → Test overlaps → Export with render mesh
```

## Collider Types

| Type | Use |
|------|-----|
| Box | Crates, walls, simple props |
| Capsule | Characters, poles |
| Sphere | Balls, soft approximates |
| Convex hull | Organic / irregular single body |
| Multiple convex (UCX) | Vehicles, complex props |

## Unreal Naming

```
UCX_SM_Asset_01
UCX_SM_Asset_02
```

- Must match associated mesh naming rules for auto-association
- Convex only for UCX

## Unity Notes

- Prefer engine primitives when possible
- Mesh colliders: convex toggle for dynamic rigidbodies
- Keep proxy collection exportable

## Authoring Rules

1. Slightly smaller than visual mesh to reduce snagging (project-dependent)
2. No holes; watertight convex pieces
3. Apply scale
4. Origin aligned with render mesh
5. Collection: `COL_Collision_[Asset]`

## Validation

- [ ] Player cannot fall through intended blockers
- [ ] No huge invisible walls beyond mesh
- [ ] Wheel/character capsules oriented correctly
- [ ] Named for target engine

## Constraints

### MUST DO
- Prefer few simple shapes over one complex mesh
- Match engine naming conventions
- Keep proxies in dedicated collection

### MUST NOT DO
- Use render LOD0 as physics mesh by default
- Non-convex UCX for Unreal auto-convex workflows

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Collider Recipes | `references/collider-recipes.md` | When needed |
| Engine Naming | `references/engine-naming.md` | When needed |
