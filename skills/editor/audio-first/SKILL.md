---
name: editor-audio-first
description: 旁白／解说先行时间线配方（audio-first）。触发时机：口播、旁白、解说、播客式剪辑，或需要先定音轨再让画面配合音频（含 TTS 生成旁白并按实测时长排时间线）。任务是「先有声音、画面跟音」时必载。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 片4（音视频链）
              与 harness-tool-registry.ts L150 注解（audio_first_timeline 复用 gateway /agent/v1/tts
              逐行真 TTS + ffprobe 实测时长 + 累计 offset_ms 锚点）。
工具真源: VPS .opencode/tools/audio_first_timeline.ts 与 gateway /agent/v1/tts。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 旁白先行时间线（audio-first）

## 何时用

剪辑意图是**声音主导**：旁白／解说／口播／播客式内容。相对地，画面主导（先剪画面再配乐）走 `assembly/SKILL.md`。

## 工具链

```
audio_first_timeline（TTS + 实测时长 + offset 锚点）→ timeline_query → timeline_ops（画面依锚点对齐）→ timeline_lint（过闸）→ timeline_master
```

## 逐步配方

1. **定音轨**：`audio_first_timeline` 输入逐行文稿（或既有音频），工具会：
   - 走 gateway 真 TTS 逐行生成；
   - 对每段音频 `ffprobe` **实测**时长（不是模型自报）；
   - 依序累计 `offset_ms`，产出**锚点时间线**（哪一行在第几毫秒起）。
2. **摸底**：`timeline_query(what=state)` 读回锚点时间线真状态。
3. **画面依锚点对齐**：`timeline_ops` 用 batch（trim／reorder／split）把画面 clips 对齐每个 offset 起点。**锚点是唯一时序真源**，不要另算一套起点。
4. **过 lint 闸**：`timeline_lint` 检查静音段／音画时长错位／爆音等；must 未清不得交付。
5. **导出**：`timeline_master` check → export。

## 诚实条款

- **TTS 与音频是分钟级操作**：一次一请求，禁连发多批；整批文稿一次交给 `audio_first_timeline`，不要在 ops 回圈里逐行呼叫。
- **时长一律以 ffprobe 实测为准**：模型／TTS 自报时长不可作为交付口径（音画时长错位是 must 级 lint 项）。
- 若交付委托单要求旁白但无 `audio_first_timeline` 产出的 offset 锚点，等于没有音轨真源——回报缺口，不要用估算秒数冒充。

## 交付

成片交付同主契约：`timeline_ops`（画面如何依锚点对齐）＋ `duration_sec`（成片实测）＋ `qc`（lint/master 结论）。
