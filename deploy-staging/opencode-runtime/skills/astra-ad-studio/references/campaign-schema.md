<!--
來源（輪子）: https://github.com/Kappaemme-git/astra-ad-studio
License: MIT · 原作者: Kappaemme-git · 僅內部使用
入庫批次: 2026-09-06 對稱差擴容 W5（Astra 廣告創意系統）。
Blender 5.2 雷區（僅 Blender 類配方適用）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 調用表述執行時改走我方 bridge /v1/execute 同構協議。
-->

# Campaign renderer schema

Use this reference only when creating JSON for `scripts/render_campaign.mjs`.

## Minimal shape

```json
{
  "campaign": "Launch campaign",
  "product": "Product name",
  "audience": "Specific audience",
  "objective": "Desired viewer action",
  "format": "portrait",
  "brand": {
    "primary": "#7c3aed",
    "secondary": "#0b1020",
    "accent": "#a7f3d0",
    "text": "#ffffff"
  },
  "creatives": [
    {
      "id": "pain-interrupt",
      "label": "Pain Interrupt",
      "hook": "Your launch is not the problem.",
      "body": "The message is.",
      "cta": "Fix the signal",
      "proof": "",
      "backgroundImage": ""
    }
  ],
  "motion": {
    "duration": 15,
    "frames": [
      {
        "start": 0,
        "end": 3,
        "hook": "Most ads disappear.",
        "body": "Yours can interrupt the scroll."
      }
    ]
  }
}
```

## Notes

- `format` accepts `square`, `portrait`, `story`, `landscape`, `x-landscape`, or an object containing numeric `width` and `height`.
- `creatives` must contain at least one item. Three are recommended for a full exploration.
- `backgroundImage` is optional and resolves relative to the JSON input file. Supported local image types are embedded into the generated SVG as data URLs.
- `motion` is optional. Frames appear according to their `start` and `end` values inside a looping HTML preview.
- Keep every text value short enough for the chosen format. The renderer wraps copy but does not replace visual judgment.
