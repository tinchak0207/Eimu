---
name: editor-look
description: 剪辑风格与调色配方。触发时机：调色、滤镜、LUT、质感、胶片感、日系冷调、暖调、转场样式、字卡／字幕卡。任何「看起来像…」「风格改成…」「配色／色调」类剪辑请求必载。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 片B7
              （apply_style：filterPresets→clip.filter 四滑杆、转场 transitionPresets、字卡 subtitleExport/ASS；
              fx/追踪 unsupported）与 §1 妥协清单第 5 条（fxComponents 花字农场不做，风格走 ffmpeg 原生子集）。
工具真源: VPS .opencode/tools/timeline_style.ts 与 gateway/style.ts（已入库轮子 presets/filterPresets.ts、
          subset of presets/textTemplates.ts）。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 风格与调色（look）

## 工具链

```
timeline_query（摸底）→ timeline_style（滤镜／转场／字卡）→ timeline_query（回读）→ timeline_lint（过闸）
```

## 逐步配方

1. **摸底**：`timeline_query` 取现有 clips 与其 `filter` 栏（避免重复叠加风格）。
2. **套风格**：`timeline_style`：
   - **调色**：`filterPresets` → 逐 clip `filter` **四滑杆**（原生 ffmpeg `eq`／`curves`／`colorbalance` 子集），不是 LUT 档案。
   - **转场**：`transitionPresets`（既有在库）套 `set_transition` 语义。
   - **字卡／字幕**：走 `subtitleExport` ASS 字幕（`add_subtitle` 系列）。
3. **回读**：`timeline_query` 确认 filter／transition 实际落地值。
4. **过 lint 闸**：`timeline_lint`；风格 pass 可能引入白闪／亮度跳变（must 级），必检。

## 硬规则与诚实条款

- **风格只走 ffmpeg 原生子集**：`fxComponents`（Chromium 花字农场）与运动追踪特效**不做**（妥协项）；需求要这类效果时如实 unsupported，不要用近似滤镜冒充。
- **LUT 档案**：库内无高 star 干净 LUT 集合（调研结论），当前路线＝内建 eq/curves/colorbalance 手调曲线；需 LUT 时回报缺口。
- **风格是后置 pass**：先完成结构剪辑与节奏，再套风格；不要在素材未定序时套（会反覆重工）。
- 风格不改变时长与 clip 顺序；若 `duration_sec` 因 filter 而变，以 `timeline_master`/ffprobe 实测为准。

## 交付

风格 pass 的 `timeline_ops`（记录施加的 filter／transition／subtitle）；成片交付三栏同主契约。
