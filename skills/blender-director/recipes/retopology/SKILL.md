<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/retopology/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1（工藝/資產）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->
---
name: retopology
description: Production retopology for animation-ready, low-poly, quad-dominant meshes with proper edge loops and efficient polygon flow. Use after sculpting or high-poly modeling before rigging and UV work in Blender via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: retopo, retopology, edge loop, quad, topology, animation ready, poly reduction, remesh
  related-skills: character-artist, creature-artist, sculpting, uv-workflow
---

# Retopology

Clean, purposeful topology for deformation, UVs, and performance. Quad-dominant. Animation-ready.

## When to Use

- After sculpting high-poly characters/creatures
- Before rigging any deforming mesh
- Poly reduction while preserving silhouette
- Fixing topology from boolean or scan cleanup

## Workflow

```
High-Poly Reference → Guide Setup → Block Retopo → Loop Refinement
    → Pole Placement → Triangle Cleanup → Validation → UV Handoff
```

## Retopology Methods

| Method | Best For | Speed |
|--------|----------|-------|
| Manual (Poly Build tool) | Hero characters | Slow, best quality |
| Shrinkwrap retopo | Creatures, organic | Medium |
| Quad Remesh (voxel) | Quick blockout retopo | Fast, needs cleanup |
| Instant Meshes (external) | Background assets | Fast |
| Symmetry retopo | Bilateral characters | Medium |

**Production default:** Manual with shrinkwrap for hero; Quad Remesh + cleanup for background.

## Edge Loop Rules

- Loops follow muscle/deformation direction
- One loop per major form change
- Maintain even edge length in deformation zones
- Redirect loops at poles (minimum 3 edges meeting)
- Hide poles at back of head, armpits, groin

## Pole Management

| Location | Acceptable | Avoid |
|----------|------------|-------|
| Top of head | 3–5 pole | — |
| Inner eye corner | Redirect pole | Pole directly at corner |
| Shoulder | 3-edge pole hidden | Star pattern on deltoid |
| Back of knee | Pole in crease | Pole on front of knee |

## Triangle Policy

- Triangles OK on non-deforming static mesh
- Convert tris to quads on face, joints, fingers
- No n-gons on deforming surfaces
- Tris at hidden areas (scalp under hair, mouth interior)

## Polycount Targets

See `../references/polycount-budgets.md`. Retopo is where budget is enforced.

## Shrinkwrap Retopo Setup

```
1. Duplicate high-poly to reference collection (hidden in render)
2. Create retopo mesh with Poly Build / manual extrude
3. Shrinkwrap modifier → Target: high-poly
4. Snap to face with project individual elements
5. Validate shrinkwrap distance (no intersection)
```

## Validation Checklist

- [ ] Quad-dominant on all deformation areas
- [ ] Edge loops support planned rig joints
- [ ] No non-manifold geometry
- [ ] Silhouette matches high-poly reference
- [ ] Polycount within budget
- [ ] Poles placed at acceptable locations
- [ ] Mesh manifold and watertight (if required)

## MCP Integration

1. Create retopo mesh object via MCP
2. Apply shrinkwrap modifier via MCP
3. Query face/edge count during retopo
4. Compare silhouette via MCP render/query
5. Transfer to `COL_Geo_LowPoly` collection

## Constraints

### MUST DO
- Retopo before rigging deforming meshes
- Preserve silhouette vs high-poly reference
- Plan loops for facial expressions (characters)
- Enforce polycount budget
- Validate manifold before UV pass

### MUST NOT DO
- Auto-retopo without manual cleanup (hero assets)
- Leave n-gons on deformation surfaces
- Skip validation against reference
- Retopo without knowing rig requirements
- Uniform density (more density at face/hands)

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Facial retopo | `references/facial-retopo.md` | Character faces |
| Game vs cinematic | `references/game-cinematic-topo.md` | Budget decisions |
