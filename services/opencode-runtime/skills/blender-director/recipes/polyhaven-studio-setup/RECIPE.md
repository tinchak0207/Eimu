---
name: polyhaven-studio-setup
description: Set up a professional product photography studio in Blender using PolyHaven HDRIs and PBR ground materials. Trigger when asked to create a studio setup, add HDRI lighting, set up product photography, or create a showroom scene.
---
<!--
来源（轮子）: https://github.com/kevinbadi/blender-skills — polyhaven-studio-setup/SKILL.md
License: 上游无 LICENSE 档（GitHub API 2026-09-06 查证）· 原作者: kevinbadi · 仅内部使用，不对外散布
入库批次: 2026-09-06 对称差扩容 W3（产品片运镜/Polyhaven/图转 3D）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其专属 MCP 工具面，执行时改走我方 bridge /v1/execute 同构协议。
-->

# PolyHaven Studio Setup

One-command product photography studio. Downloads a PolyHaven HDRI for environment lighting and optionally adds a PBR ground plane — dramatically better reflections than manual lights.

## Prerequisites

- **Blender** (4.x+) with **Blender MCP addon** active on port 9876
- **PolyHaven** enabled in the addon sidebar

## How to Run

```bash
node polyhaven-studio-setup/scripts/polyhaven-studio-setup.js --hdri studio_small_09
node polyhaven-studio-setup/scripts/polyhaven-studio-setup.js --hdri sunset --ground concrete_wall_003 --resolution 2k
node polyhaven-studio-setup/scripts/polyhaven-studio-setup.js --list-hdris
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--hdri` | PolyHaven HDRI asset ID | `studio_small_09` |
| `--ground` | PolyHaven texture ID for ground plane (optional) | none |
| `--resolution` | Asset resolution: 1k, 2k, 4k | `2k` |
| `--strength` | HDRI background strength | `1.0` |
| `--rotation` | HDRI rotation in degrees | `0` |
| `--ground-size` | Ground plane size | `10` |
| `--port` | Blender MCP port | `9876` |
| `--list-hdris` | List popular studio HDRIs | false |

## Popular Studio HDRIs

- `studio_small_09` — Clean white studio
- `studio_small_08` — Warm studio
- `photo_studio_loft_hall` — Loft photography studio
- `industrial_sunset_02_puresky` — Golden hour
- `kloppenheim_06_puresky` — Outdoor overcast
- `royal_esplanade` — Grand interior
