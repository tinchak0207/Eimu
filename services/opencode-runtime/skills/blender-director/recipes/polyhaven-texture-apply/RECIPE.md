---
name: polyhaven-texture-apply
description: Apply realistic PBR textures from PolyHaven to any Blender object. Supports metals, wood, concrete, fabric, and more. Trigger when asked to texture an object, apply a material from PolyHaven, make something look like metal/wood/marble, or change object surface.
---
<!--
来源（轮子）: https://github.com/kevinbadi/blender-skills — polyhaven-texture-apply/SKILL.md
License: 上游无 LICENSE 档（GitHub API 2026-09-06 查证）· 原作者: kevinbadi · 仅内部使用，不对外散布
入库批次: 2026-09-06 对称差扩容 W3（产品片运镜/Polyhaven/图转 3D）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其专属 MCP 工具面，执行时改走我方 bridge /v1/execute 同构协议。
-->

# PolyHaven Texture Apply

Downloads a full PBR texture set (diffuse, roughness, normal, displacement) from PolyHaven and applies it to a specific object in the Blender scene.

## How to Run

```bash
node polyhaven-texture-apply/scripts/polyhaven-texture-apply.js --object Mesh_0 --texture brushed_metal
node polyhaven-texture-apply/scripts/polyhaven-texture-apply.js --object Cube --texture marble_01 --resolution 2k
node polyhaven-texture-apply/scripts/polyhaven-texture-apply.js --search metal
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--object` | Blender object name to apply texture to | **required** |
| `--texture` | PolyHaven texture asset ID | **required** |
| `--resolution` | Texture resolution: 1k, 2k, 4k | `2k` |
| `--scale` | UV mapping scale | `1.0` |
| `--port` | Blender MCP port | `9876` |
| `--search` | Search PolyHaven textures by keyword | none |

## Popular Textures

- `brushed_metal` — Brushed aluminum/steel
- `carbon_fiber` — Carbon fiber weave
- `marble_01` — White marble
- `wood_cabinet_worn_long` — Aged wood
- `concrete_wall_003` — Raw concrete
- `leather_red_02` — Red leather
- `fabric_pattern_07` — Woven fabric
