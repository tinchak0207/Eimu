# handfeel-fix-20261027 自审

## 截图（deviceScaleFactor:2）
- `01-error-page-desktop.png` — `/zz-tmp-error-pages` 渲染 `src/app/error.tsx` 本尊
- `02-toolbar-desktop.png` — 桌面 1280：按钮 rect **28×28**
- `03-toolbar-phone-390.png` — 390 宽 + coarse：按钮 rect **44×44**
- `04-toolbar-coarse-pointer.png` — 1024 宽 + pointer:coarse：按钮 rect **44×44**

## 核对
- error：lg-sheet + specular + `rounded-ios-3xl`(量得 radius 40px) + 蓝 `#007AFF` 圆角 CTA「重试」+ ios title3/subhead；不甩 error.message
- global-error：同文案同半径同 CTA；自引 `globals.css`，无大段 inline style
- toolbar：桌面精点维持 28；max-sm / `@media (pointer:coarse)` 抬到 44；选中态桌面略增 h-8
- 人话表：`reference_snapshot_missing` / `price_unknown` / `video_price_unknown` / `submission_unknown`；未命中走 `sanitizeDisplayError`
- 链路：`image_edit` → `publicImageUrl` 抛 `.code=reference_snapshot_missing` → `classifyError` 透传 → `fail(code)` → SSE `error.code` → `classifiedErrorStatus`

收工已删 `zz-tmp-error-pages` / `zz-tmp-canvas-toolbar`。
