<!--
來源（輪子）: https://github.com/Kappaemme-git/astra-ad-studio
License: MIT · 原作者: Kappaemme-git · 僅內部使用
入庫批次: 2026-09-06 對稱差擴容 W5（Astra 廣告創意系統）。
Blender 5.2 雷區（僅 Blender 類配方適用）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 調用表述執行時改走我方 bridge /v1/execute 同構協議。
-->

# Production guidance

Use this reference when turning a selected direction into finished assets.

## Output modes

### Static campaign

Build editable SVG or HTML source and produce requested platform variants. Common dimensions:

| Format | Dimensions |
|---|---:|
| Square | 1080 × 1080 |
| Portrait feed | 1080 × 1350 |
| Story / vertical video | 1080 × 1920 |
| Landscape | 1920 × 1080 |
| X landscape | 1600 × 900 |

Use platform dimensions requested by the user when they differ from this table.

### Motion campaign

Create a browser-playable motion preview first. A useful 15-second structure is:

1. `0–2s`: hook;
2. `2–6s`: problem or tension;
3. `6–11s`: product or proof;
4. `11–15s`: payoff and CTA.

Change the structure when the concept needs it. Reading time matters more than filling every slot.

## Native image generation

Use raster generation only when the concept benefits from a photographic, illustrated, or textured scene. Specify:

- audience and ad placement;
- exact subject and setting;
- composition with deliberate negative space for copy;
- lighting, palette, and mood;
- supplied product or brand references and what must remain unchanged;
- `no text, no lettering, no watermark` when copy will be overlaid later.

Generate one asset per direction so each visual has its own prompt. Inspect the result and make only a targeted follow-up when a visible issue blocks the concept.

## Composition rules

- Keep the hook in the primary reading zone and away from crop-prone edges.
- Use one dominant visual idea per ad.
- Prefer high contrast and short line lengths for mobile.
- Keep logos subordinate to the hook unless brand recognition is the strategy.
- Never place crucial copy inside a generated bitmap when exact spelling matters.
- Preserve safe margins of at least 5% unless the platform supplies different guidance.

## Verification

Inspect the full-size asset and a mobile-sized preview. Verify exact copy, spelling, CTA, visible product, aspect ratio, safe areas, contrast, and missing asset references. For animation, watch one complete loop and confirm that each scene remains readable for its full intended duration.
