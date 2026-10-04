---
name: blender-threejs-export
description: Export the current Blender scene as a GLB and generate a ready-to-use Three.js HTML viewer with orbit controls, lighting, and auto-rotation. Trigger when asked to export for web, create a Three.js viewer, make a 3D model interactive for a website, or export from Blender for the web.
---
<!--
來源（輪子）: https://github.com/kevinbadi/blender-skills — threejs-export/SKILL.md
License: 上游無 LICENSE 檔（GitHub API 2026-09-06 查證）· 原作者: kevinbadi · 僅內部使用，不對外散佈
入庫批次: 2026-09-06 對稱差擴容 W3（產品片運鏡/Polyhaven/圖轉 3D）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其專屬 MCP 工具面，執行時改走我方 bridge /v1/execute 同構協議。
-->

# Blender Three.js Export

Exports the current Blender scene as a compressed GLB and generates a standalone HTML file with a Three.js viewer. The viewer includes orbit controls, studio lighting, auto-rotation, and responsive sizing — ready to drop into any website.

## Prerequisites

- **Blender** (4.x+) running with the **Blender MCP addon** active on port 9876
- A scene loaded in Blender (e.g. after running `blender-product-polish`)

## How to Run

```bash
node skills/blender-threejs-export/scripts/blender-threejs-export.js --output ~/Desktop/my-product
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--output` | Output directory for the GLB + HTML files | **required** |
| `--name` | File name (without extension) | `model` |
| `--port` | Blender MCP port | `9876` |
| `--no-rotate` | Disable auto-rotation | `false` |
| `--bg` | Background color hex | `#111111` |
| `--embed` | Base64-embed the GLB into the HTML (single file) | `false` |

## Output

```
output-dir/
  model.glb          # Compressed GLB export from Blender
  model.html         # Standalone Three.js viewer (CDN imports, no build step)
```

## Viewer Features

- **Orbit controls** — click and drag to rotate, scroll to zoom, right-click to pan
- **Auto-rotation** — slow spin to showcase the product (disable with `--no-rotate`)
- **Studio lighting** — 3-point light setup matching the Blender polish look
- **Responsive** — fills container, works on mobile
- **Zero dependencies** — uses Three.js from CDN via import maps, no npm/build needed
- **Drop-in ready** — open the HTML directly or embed in any page
