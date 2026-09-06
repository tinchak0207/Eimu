<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/isometric-style/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W2（風格/mood/世界觀）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

---
name: isometric-style
description: Isometric and strategy-game art direction for Blender including diorama framing, true-iso camera setup, readable silhouettes, and tile asset rules.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: isometric, iso camera, diorama, strategy game, tile asset, orthographic iso, city builder view
  related-skills: camera-cinematography, environment-artist, lowpoly-style, scene-assembly, rendering
---

# Isometric Style

Readable dioramas. True iso framing. Tile-aware assets.

## When to Use

- Strategy / sim / city-builder assets
- Isometric diorama renders
- Orthographic hero presentations

## Camera Setup

```
Camera type: Orthographic
Rotation: typically 54.736° / 30° patterns (true iso) OR project-specific dimetric
Scale: frame subject with padding for UI
CAM_Iso_[Shot]
```

Match project’s exact iso angles — do not invent per asset.

## Asset Rules

1. **Readable from iso angle first** — Not perspective hero camera
2. **Tile footprint** — Document cell size (e.g. 1×1, 2×2)
3. **Height clarity** — Vertical read without confusion
4. **Edge contrast** — Separate from ground plane
5. **LOD for dense maps** — Far tiles cheaper

## Modeling

- Avoid detail only visible from ground FPS view
- Strong top/side planes
- Anchor pivot to tile corner or center per kit standard

## Presentation

- Soft key + cool fill common for dioramas
- Slight AO / ground shadow for lift
- Optional `compositing` grade for portfolio

## Constraints

### MUST DO
- Lock camera angle for the set
- Document tile size and pivot rule
- Check readability at game ortho scale

### MUST NOT DO
- Detail undersides invisible in iso
- Mix perspective cameras into iso kits without reason

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Iso Camera | `references/iso-camera.md` | When needed |
| Tile Footprints | `references/tile-footprints.md` | When needed |
