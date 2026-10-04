---
name: editor-look
description: 剪輯風格與調色配方。觸發時機：調色、濾鏡、LUT、質感、膠片感、日系冷調、暖調、轉場樣式、字卡／字幕卡。任何「看起來像…」「風格改成…」「配色／色調」類剪輯請求必載。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 片B7
              （apply_style：filterPresets→clip.filter 四滑桿、轉場 transitionPresets、字卡 subtitleExport/ASS；
              fx/追蹤 unsupported）與 §1 妥協清單第 5 條（fxComponents 花字農場不做，風格走 ffmpeg 原生子集）。
工具真源: VPS .opencode/tools/timeline_style.ts 與 gateway/style.ts（已入庫輪子 presets/filterPresets.ts、
          subset of presets/textTemplates.ts）。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 風格與調色（look）

## 工具鏈

```
timeline_query（摸底）→ timeline_style（濾鏡／轉場／字卡）→ timeline_query（回讀）→ timeline_lint（過閘）
```

## 逐步配方

1. **摸底**：`timeline_query` 取現有 clips 與其 `filter` 欄（避免重複疊加風格）。
2. **套風格**：`timeline_style`：
   - **調色**：`filterPresets` → 逐 clip `filter` **四滑桿**（原生 ffmpeg `eq`／`curves`／`colorbalance` 子集），不是 LUT 檔案。
   - **轉場**：`transitionPresets`（既有在庫）套 `set_transition` 語義。
   - **字卡／字幕**：走 `subtitleExport` ASS 字幕（`add_subtitle` 系列）。
3. **回讀**：`timeline_query` 確認 filter／transition 實際落地值。
4. **過 lint 閘**：`timeline_lint`；風格 pass 可能引入白閃／亮度跳變（must 級），必檢。

## 硬規則與誠實條款

- **風格只走 ffmpeg 原生子集**：`fxComponents`（Chromium 花字農場）與運動追蹤特效**不做**（妥協項）；需求要這類效果時如實 unsupported，不要用近似濾鏡冒充。
- **LUT 檔案**：庫內無高 star 乾淨 LUT 集合（調研結論），當前路線＝內建 eq/curves/colorbalance 手調曲線；需 LUT 時回報缺口。
- **風格是後置 pass**：先完成結構剪輯與節奏，再套風格；不要在素材未定序時套（會反覆重工）。
- 風格不改變時長與 clip 順序；若 `duration_sec` 因 filter 而變，以 `timeline_master`/ffprobe 實測為準。

## 交付

風格 pass 的 `timeline_ops`（記錄施加的 filter／transition／subtitle）；成片交付三欄同主契約。
