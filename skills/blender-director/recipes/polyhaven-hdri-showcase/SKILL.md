<!--
來源（輪子）: https://github.com/kevinbadi/blender-skills — polyhaven-hdri-showcase/SKILL.md
License: 上游無 LICENSE 檔（GitHub API 2026-09-06 查證）· 原作者: kevinbadi · 僅內部使用，不對外散佈
入庫批次: 2026-09-06 對稱差擴容 W3（產品片運鏡/Polyhaven/圖轉 3D）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其專屬 MCP 工具面，執行時改走我方 bridge /v1/execute 同構協議。
-->
---
name: polyhaven-hdri-showcase
description: Render the same product across multiple HDRI environments and output a comparison grid. Trigger when asked to compare lighting setups, test different environments, show product in multiple settings, or create an HDRI comparison.
---

# PolyHaven HDRI Showcase

Renders your product across multiple PolyHaven HDRI environments and saves each as an image — perfect for picking the best lighting for your product shots or creating a showcase grid.

## How to Run

```bash
node polyhaven-hdri-showcase/scripts/polyhaven-hdri-showcase.js --output ~/Desktop/hdri-compare
node polyhaven-hdri-showcase/scripts/polyhaven-hdri-showcase.js --hdris "studio_small_09,royal_esplanade,industrial_sunset_02_puresky" --output ~/Desktop
node polyhaven-hdri-showcase/scripts/polyhaven-hdri-showcase.js --preset studios --output ~/Desktop/studios
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--output` | Output directory for rendered images | **required** |
| `--hdris` | Comma-separated HDRI IDs to compare | default set of 6 |
| `--preset` | HDRI set: studios, outdoor, dramatic, all | none |
| `--resolution` | HDRI resolution: 1k, 2k | `1k` |
| `--render-width` | Render image width | `1920` |
| `--render-height` | Render image height | `1080` |
| `--samples` | Render samples | `64` |
| `--port` | Blender MCP port | `9876` |
