---
name: polyhaven-material-swap
description: Cycle through multiple PolyHaven materials on a product and render each variant. Great for showing color/finish options. Trigger when asked to show material variants, swap textures, create color options, show finish comparisons, or render product in different materials.
---
<!--
來源（輪子）: https://github.com/kevinbadi/blender-skills — polyhaven-material-swap/SKILL.md
License: 上游無 LICENSE 檔（GitHub API 2026-09-06 查證）· 原作者: kevinbadi · 僅內部使用，不對外散佈
入庫批次: 2026-09-06 對稱差擴容 W3（產品片運鏡/Polyhaven/圖轉 3D）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其專屬 MCP 工具面，執行時改走我方 bridge /v1/execute 同構協議。
-->

# PolyHaven Material Swap

Applies multiple PolyHaven PBR textures to the same object one by one and renders each — perfect for showing product finish variants (matte black, glossy white, brushed metal, marble, etc.).

## How to Run

```bash
node polyhaven-material-swap/scripts/polyhaven-material-swap.js --object Mesh_0 --textures "marble_01,brushed_metal,carbon_fiber" --output ~/Desktop/variants
node polyhaven-material-swap/scripts/polyhaven-material-swap.js --object Mesh_0 --preset metals --output ~/Desktop/metals
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--object` | Blender object name | **required** |
| `--textures` | Comma-separated PolyHaven texture IDs | **required** (or use --preset) |
| `--output` | Output directory for rendered images | **required** |
| `--preset` | Texture set: metals, woods, stones, fabrics | none |
| `--resolution` | Texture resolution: 1k, 2k | `2k` |
| `--render-width` | Render image width | `1920` |
| `--render-height` | Render image height | `1080` |
| `--samples` | Render samples | `64` |
| `--port` | Blender MCP port | `9876` |

## Presets

- **metals** — brushed_metal, rusty_metal, painted_metal_02, corrugated_iron
- **woods** — wood_cabinet_worn_long, plywood, bark_brown_02, wood_floor
- **stones** — marble_01, concrete_wall_003, rock_face, gravel_floor_02
- **fabrics** — fabric_pattern_07, leather_red_02, denim_fabric, burlap_01
