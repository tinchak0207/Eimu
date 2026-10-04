---
name: vfx-fx
description: Cinematic and game VFX in Blender including smoke, fire, particles, trails, and Geometry Nodes FX setups via MCP.
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: VFX, FX, smoke, fire, explosion, particles, sparks, trails, muzzle flash, magic effect, geometry nodes FX
  related-skills: geometry-nodes, physics-sim, materials, lighting, rendering, compositing
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/vfx-fx/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
入庫批次: 2026-09-06 對稱差擴容 W1 補漏（特效 vfx）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區（上游按 3.x/4.x 編寫，命中以下 API 時以雷區為準）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認視圖變換 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；配方內殘留的 MCP/IDE 表述以上方執行環境契約為準。
-->

# VFX / FX

Readable effects. Controlled simulation domains. Game sprites vs cinematic volumes.

## When to Use

- Smoke, fire, dust, sparks, debris
- Magic / sci-fi energy FX
- Muzzle flashes, trails, impacts
- Geometry Nodes driven particle systems

## Path Decision

```
Game real-time → Meshes/cards/ribbons + emissive mats (+ GN)
Cinematic     → Mantaflow / particles / GN → render → comp
Hybrid        → Sim in Blender → bake flipbooks/meshes for engine
```

## Workflow

```
Brief (silhouette + timing) → Proxy emitter → Sim/GN prototype
  → Art-direct motion → Materials/lights → Cache → Render/comp or export
```

## Effect Types

| Type | Blender Approach |
|------|------------------|
| Smoke/fire | Mantaflow domain + flow; keep domain tight |
| Sparks | Particle Newtonian + collision + trail |
| Debris | Rigid body shards (`physics-sim`) |
| Magic ribbons | Curves / GN extrude + emissive |
| Dust hit | Short particle burst + soft sprites |

## Domain Rules (Volume)

- Domain only as large as needed
- Resolution from low → high after motion approved
- Open borders intentionally; avoid wasted empty voxels
- Collection: `COL_FX_[Shot]`

## Naming

- Emitters: `FX_Emit_[Name]`
- Domains: `FX_Domain_[Name]`
- Caches: document frame range in brief

## Game Export Notes

- Prefer mesh cards / GN instances over volume export
- Atlas flipbooks when baking fire/smoke for engines
- Keep pivot at logical spawn point

## Constraints

### MUST DO
- Approve motion at low res before high-res sim
- Light FX intentionally (emissive + key)
- Cache before final render

### MUST NOT DO
- Huge empty domains
- Unbounded particle counts
- Skip timing brief (start/peak/end frames)

## Reference Guide

| Topic | Reference | Load When |
|-------|-----------|----------|
| Fx Timing Brief | `references/fx-timing-brief.md` | When needed |
| Volume Domain Rules | `references/volume-domain-rules.md` | When needed |
| Game Fx Export | `references/game-fx-export.md` | When needed |
