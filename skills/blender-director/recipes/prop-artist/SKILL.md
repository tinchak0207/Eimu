---
name: prop-artist
description: Everyday and hero prop modeling for furniture, tools, household objects, kitbash parts, and readable game props. Use when hard-surface is too sci-fi/mechanical and the asset is a grounded prop.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: prop, props, furniture, chair, table, bottle, tool, kitbash, household, everyday object, hero prop, set prop
  related-skills: blender-modeler, hard-surface, materials, uv-workflow, asset-optimization, set-dressing
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/prop-artist/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入库批次: 2026-09-06 对称差扩容 W1（工艺/资产）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区（上游按 3.x/4.x 编写，命中以下 API 时以雷区为准）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认视图变换 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方内残留的 MCP/IDE 表述以上方执行环境契约为准。
-->

# Prop Artist

Grounded, readable props. Silhouette first. Real-world scale. Kitbash-friendly parts.

## When to Use

- Furniture, tools, containers, electronics, household objects
- Hero interactive props and background set dressing pieces
- Kitbash libraries (handles, brackets, panels, fasteners)
- When hard-surface sci-fi language would feel wrong

## Design Principles

1. **Real-world scale** — Measure against human (door 2.0–2.1m, chair seat ~0.45m)
2. **Silhouette readability** — Reads at game camera distance
3. **Wear hierarchy** — Contact edges dirty; protected faces cleaner
4. **Part logic** — Separate meshes where materials or LODs differ
5. **Pivot correctness** — Floor contact, grip, hinge, or socket as needed

## Workflow

```
Reference → Scale blockout → Primary volumes → Secondary forms
  → Edge bevels → Wear/damage → UVs → Materials → Optimize → Export
```

## Prop Tiers

| Tier | Tris (guide) | Detail | Use |
|------|--------------|--------|-----|
| Hero | 2k–8k | Full bevels, unique wear | Interactables, close-ups |
| Standard | 500–2k | Clean forms, shared mats | Midground |
| Background | 100–500 | Block forms, atlas mats | Far / dense dressing |

## Kitbash Rules

- Name parts `SM_KB_[Category]_[Part]`
- Keep origins at logical attach points
- Prefer modular dimensions (0.05 / 0.1 / 0.25m grid)
- Collection: `COL_Kitbash_[Set]`

## Material Guidance

- Limit unique materials; atlas where possible
- Separate glass / emissive / opaque when needed for engine
- Wear via roughness/AO, not only albedo dirt

## Handoff

- UVs → `uv-workflow`
- Look → `materials` / `lookdev`
- Placement → `set-dressing`
- Ship → `asset-optimization` → `export-pipeline` or engine export skill

## Constraints

### MUST DO
- Set real-world scale before detailing
- Place pivot intentionally
- Match prop tier to camera distance

### MUST NOT DO
- Over-greeble everyday objects
- Use sci-fi panel language on mundane props
- Skip collision planning for interactables

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Prop Tiers | `references/prop-tiers.md` | When needed |
| Kitbash Library | `references/kitbash-library.md` | When needed |
| Everyday Prop Checklist | `references/everyday-prop-checklist.md` | When needed |
