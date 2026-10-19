---
name: editor-mix
description: 剪辑混音与 ducking 配方。触发时机：混音、配乐、BGM、SFX 音效、人声太吵／太小、旁白被音乐盖住、响度、LUFS、ducking、音轨平衡。任何「声音层次／音量／配乐」类剪辑请求必载。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 片B5
              （混音增强：三轨 voice/bgm/sfx + ducking sidechaincompress 后置 pass，不动 composeEngine 主钉 +
              响度报告）与 §7 终验（mix 13/13；loudnorm 口径 I=-16 TP=-1.5 LRA=11）。
工具真源: VPS .opencode/tools/timeline_mix.ts 与 gateway/mix.ts。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 混音与 ducking（mix）

## 工具链

```
timeline_query（摸底音轨）→ timeline_mix（三轨 + ducking + 响度报告）→ timeline_query（回读）→ timeline_lint（过闸）
```

## 逐步配方

1. **摸底**：`timeline_query` 取 `add_audio` 落下的音轨（voice／bgm／sfx）与 clip 层级。
2. **混音**：`timeline_mix` 做**三轨（voice / bgm / sfx）**处理：
   - **ducking**：走 ffmpeg `sidechaincompress` **后置 pass**（不动 composeEngine 主钉），人声一出现就把 BGM 压下去。
   - **响度**：`loudnorm=I=-16:TP=-1.5:LRA=11`（全链统一钉死口径）。
   - 产出**响度报告**（LUFS／true peak／LRA）。
3. **回读**：`timeline_query` 确认音轨状态。
4. **过 lint 闸**：`timeline_lint` 查静音段／爆音／音量跳变（must 级）；混音后必检。

## 硬规则与诚实条款

- **ducking 是后置 pass**：不改 `composeEngine` 主钉；不要重写主混音图来「顺便」加 ducking。
- **duck 基准窗**：以**扫无人声区**的音量为基准（沉淀坑），不是全域平均；基准选错＝人声段被误压。
- **响度口径固定** `I=-16:TP=-1.5:LRA=11`；不要自定目标值，也不要声称响度达标而未跑报告。
- **音乐／SFX 素材源**：接受 URL 输入，本链**不建音乐库**；需配乐时走 `music_gen`（音乐域 Expert）或既有素材 URL，不在剪辑层造音乐。
- **响度≠好听**：报告是机器量测，混音品味不作承诺；`qc` 栏只写可核验的实测结论。

## 交付

混音后 `timeline_ops`（记录 ducking／响度设定）＋ 响度报告；成片交付三栏同主契约（`qc` 带响度与 lint 结论）。
