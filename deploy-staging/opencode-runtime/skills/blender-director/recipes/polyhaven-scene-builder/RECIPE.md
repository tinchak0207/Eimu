---
name: polyhaven-scene-builder
description: Build complete product scenes using PolyHaven assets — HDRI environment, textured ground/pedestal, and optional props from the 3D model library. Trigger when asked to build a product scene, create a showcase setup, add a pedestal, or compose a product shot.
---
<!--
来源（轮子）: https://github.com/kevinbadi/blender-skills — polyhaven-scene-builder/SKILL.md
License: 上游无 LICENSE 档（GitHub API 2026-09-06 查证）· 原作者: kevinbadi · 仅内部使用，不对外散布
入库批次: 2026-09-06 对称差扩容 W3（产品片运镜/Polyhaven/图转 3D）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其专属 MCP 工具面，执行时改走我方 bridge /v1/execute 同构协议。
-->

# PolyHaven Scene Builder

Builds a full product photography scene around your 3D model: HDRI environment, textured ground plane or pedestal, and optional prop models from PolyHaven's free library.

## How to Run

```bash
node polyhaven-scene-builder/scripts/polyhaven-scene-builder.js --hdri studio_small_09 --ground marble_01 --pedestal
node polyhaven-scene-builder/scripts/polyhaven-scene-builder.js --hdri royal_esplanade --ground wood_cabinet_worn_long --props "potted_plant_04"
node polyhaven-scene-builder/scripts/polyhaven-scene-builder.js --preset showroom
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--hdri` | PolyHaven HDRI asset ID | `studio_small_09` |
| `--ground` | PolyHaven texture for ground | none |
| `--pedestal` | Add a cylindrical pedestal under the product | `false` |
| `--pedestal-texture` | Texture for the pedestal | same as ground |
| `--props` | Comma-separated PolyHaven model IDs to add | none |
| `--resolution` | Asset resolution: 1k, 2k, 4k | `2k` |
| `--preset` | Quick preset: showroom, outdoor, minimal, dramatic | none |
| `--port` | Blender MCP port | `9876` |

## Presets

- **showroom** — `studio_small_09` HDRI + marble ground + pedestal
- **outdoor** — `kloppenheim_06_puresky` HDRI + concrete ground
- **minimal** — `studio_small_03` HDRI + no ground (floating product)
- **dramatic** — `industrial_sunset_02_puresky` HDRI + dark concrete + pedestal
