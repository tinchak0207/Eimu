---
name: editor-rhythm
description: 剪辑节奏卡点与体检配方。触发时机：节奏不对／太平／太赶、卡点剪辑、情绪曲线、镜头密度、dead air、高潮落点、节奏报告。任何「节奏」「卡点」「快慢」「呼吸感」类请求必载。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 片B3
              （节奏计算器 analyze_rhythm → curve+flags+climax：avg_shot_len/dialog_ratio/density/鼓点）
              与记忆 timeline-b1-b3-harness-training-e2e（E2E 实测：rhythm 两条 should＝dead_air 100%、pace_flat）。
工具真源: VPS .opencode/tools/timeline_rhythm.ts 与 gateway/rhythm.ts。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 节奏卡点与体检

## 工具链

```
timeline_query（摸底）→ timeline_rhythm（体检取 flags/climax）→ timeline_ops（依 flags 修）→ timeline_rhythm（复验）
```

## 逐步配方

1. **摸底**：`timeline_query(what=state)` 取 clips 与时长（节奏分析吃真时间线，不吃记忆）。
2. **体检**：`timeline_rhythm` 产出 `curve`（情绪／密度曲线）＋ `flags`（**must / should 分级**）＋ `climax`（高潮落点）。分析口径＝`avg_shot_len`／`dialog_ratio`／镜头密度／鼓点。
   - **软输入**：可接受 agent 标注的 `emotionTag` 序列作情绪曲线软输入；缺失时降级为时长／密度分析（妥协项，诚实降级，不硬造情绪）。
   - **鼓点**：走波形能量包络踩点（`beatDetect` 口径）。
3. **只修 must / should 中 clip_id 明确的项**：`timeline_ops` 整批修正（trim 缩气口、split 卡点、reorder 调密度、speed 变速）。
   - 实测常见 should 项：`dead_air`（静音占比过高）、`pace_flat`（镜头长度方差过小，节奏平）。
4. **复验**：修正后再 `timeline_rhythm` 一次，确认 flags 收敛。**禁止「改了但没复验」就回报节奏已修好。**

## 硬规则

- **flags 是证据不是装饰**：报告要逐条带 flag 名 + clip_id + 建议动作；无 clip_id 的 flag 只作提示，不进 `timeline_ops`。
- **节奏 = 秒级浮点**（与轮子 EditorClip 一致），无帧级精度——需求要帧级时如实标注。
- 节奏修正属「结构变更」，全部走 `timeline_ops` 批量原子；禁逐条单发造成版本爆炸。
- 修正后仍须 `timeline_lint` 过闸才可交付（节奏修完可能引入黑帧／爆音等信号层问题）。

## 交付

节奏报告文字 + 对应的 `timeline_ops`；成片交付仍走主契约三栏（`timeline_ops`／`duration_sec`／`qc`）。
