---
name: editor-rhythm
description: 剪輯節奏卡點與體檢配方。觸發時機：節奏不對／太平／太趕、卡點剪輯、情緒曲線、鏡頭密度、dead air、高潮落點、節奏報告。任何「節奏」「卡點」「快慢」「呼吸感」類請求必載。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 片B3
              （節奏計算器 analyze_rhythm → curve+flags+climax：avg_shot_len/dialog_ratio/density/鼓點）
              與記憶 timeline-b1-b3-harness-training-e2e（E2E 實測：rhythm 兩條 should＝dead_air 100%、pace_flat）。
工具真源: VPS .opencode/tools/timeline_rhythm.ts 與 gateway/rhythm.ts。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 節奏卡點與體檢

## 工具鏈

```
timeline_query（摸底）→ timeline_rhythm（體檢取 flags/climax）→ timeline_ops（依 flags 修）→ timeline_rhythm（複驗）
```

## 逐步配方

1. **摸底**：`timeline_query(what=state)` 取 clips 與時長（節奏分析吃真時間線，不吃記憶）。
2. **體檢**：`timeline_rhythm` 產出 `curve`（情緒／密度曲線）＋ `flags`（**must / should 分級**）＋ `climax`（高潮落點）。分析口徑＝`avg_shot_len`／`dialog_ratio`／鏡頭密度／鼓點。
   - **軟輸入**：可接受 agent 標註的 `emotionTag` 序列作情緒曲線軟輸入；缺失時降級為時長／密度分析（妥協項，誠實降級，不硬造情緒）。
   - **鼓點**：走波形能量包絡踩點（`beatDetect` 口徑）。
3. **只修 must / should 中 clip_id 明確的項**：`timeline_ops` 整批修正（trim 縮氣口、split 卡點、reorder 調密度、speed 變速）。
   - 實測常見 should 項：`dead_air`（靜音佔比過高）、`pace_flat`（鏡頭長度方差過小，節奏平）。
4. **複驗**：修正後再 `timeline_rhythm` 一次，確認 flags 收斂。**禁止「改了但沒複驗」就回報節奏已修好。**

## 硬規則

- **flags 是證據不是裝飾**：報告要逐條帶 flag 名 + clip_id + 建議動作；無 clip_id 的 flag 只作提示，不進 `timeline_ops`。
- **節奏 = 秒級浮點**（與輪子 EditorClip 一致），無幀級精度——需求要幀級時如實標註。
- 節奏修正屬「結構變更」，全部走 `timeline_ops` 批量原子；禁逐條單發造成版本爆炸。
- 修正後仍須 `timeline_lint` 過閘才可交付（節奏修完可能引入黑幀／爆音等信號層問題）。

## 交付

節奏報告文字 + 對應的 `timeline_ops`；成片交付仍走主契約三欄（`timeline_ops`／`duration_sec`／`qc`）。
