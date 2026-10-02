---
name: asset-optimization
description: Validates and optimizes Blender assets for polycount, topology, UV efficiency, material count, naming, collections, and game-ready performance. Use before export on all production assets via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: optimize, optimization, polycount, LOD, cleanup, performance, game ready, validate, triangle count
  related-skills: export-pipeline, blender-modeler, uv-workflow
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/asset-optimization/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1（工藝/資產）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

# Asset Optimization

Enforce budgets. Clean geometry. Game-ready validation gate before export.

## When to Use

- Before every export
- After modeling complete
- LOD generation
- Scene-wide performance audit
- Pre-delivery validation

## Workflow

```
Audit → Identify Issues → Fix → Re-Audit → LOD Generation → Validation Report
```

## Audit Checklist

Run via MCP scene queries where possible:

### Geometry
- [ ] Triangle count vs budget (`../references/polycount-budgets.md`)
- [ ] Duplicate vertices merged
- [ ] Loose geometry removed
- [ ] Non-manifold fixed
- [ ] Interior faces deleted
- [ ] Applied transforms (scale 1,1,1)

### UVs
- [ ] Pack efficiency > 75%
- [ ] Texel density consistent
- [ ] No unintended overlaps

### Materials
- [ ] Count within budget
- [ ] No unused slots
- [ ] Names follow `MAT_` convention

### Organization
- [ ] All objects named `SM_` prefix
- [ ] Collections organized per convention
- [ ] Collision meshes in `COL_Collision`

## Optimization Techniques

| Issue | Fix |
|-------|-----|
| Over budget | Remove unseen geo, decimate, bake detail |
| High triangle count on flat surfaces | Reduce subdiv/bevel segments |
| Many draw calls | Merge materials; atlas textures |
| Repeated geometry | Convert to instances |
| Heavy modifiers | Apply and merge strategically |

## LOD Generation

```
LOD0: Full detail (hero)
LOD1: 50% tris — remove micro-bevels, small greebles
LOD2: 25% tris — decimate modifier; preserve silhouette
LOD3: 10% tris — impostor/card or simple proxy
```

Naming: `SM_Asset_LOD0`, `SM_Asset_LOD1`, etc.

Use Decimate modifier:
- Planar mode for hard surface
- Collapse mode for organic
- Always verify silhouette after decimate

## Modifier Cleanup

Before export:
1. Apply stack OR export with modifiers per engine support
2. Remove unused modifiers
3. Collapse mirror/array if instances not needed
4. Document which modifiers remain live

## Scene Audit Report Template

```markdown
## Optimization Report: [Asset/Scene]

**Total Triangles:** [count] (budget: [target])
**Draw Calls (materials):** [count]
**Objects:** [count]
**Issues Fixed:** [list]

### Per-Object Breakdown
| Object | Tris | Materials | Status |
|--------|------|-----------|--------|
| SM_... | ... | ... | PASS/FAIL |
```

## MCP Integration

1. Query polycount per object via MCP
2. Query material count via MCP
3. Run cleanup operations via MCP
4. Generate LOD duplicates via MCP
5. Validate naming conventions via MCP scene tree

## Constraints

### MUST DO
- Run full validation before export
- Document polycount in production brief
- Create LODs for hero assets in games
- Fix all non-manifold before export
- Output validation report

### MUST NOT DO
- Export without budget check
- Decimate deforming meshes without testing
- Remove collision proxies
- Skip naming convention validation
- Optimize hero face/hands below animation needs

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Full validation | `../references/validation-checklist.md` | Final gate |
| Polycount budgets | `../references/polycount-budgets.md` | Budget setting |
| LOD strategies | `references/lod-strategies.md` | LOD creation |
