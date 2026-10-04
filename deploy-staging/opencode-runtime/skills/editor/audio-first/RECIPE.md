---
name: editor-audio-first
description: 旁白／解說先行時間線配方（audio-first）。觸發時機：口播、旁白、解說、播客式剪輯，或需要先定音軌再讓畫面配合音頻（含 TTS 生成旁白並按實測時長排時間線）。任務是「先有聲音、畫面跟音」時必載。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 片4（音視頻鏈）
              與 harness-tool-registry.ts L150 註解（audio_first_timeline 復用 gateway /agent/v1/tts
              逐行真 TTS + ffprobe 實測時長 + 累計 offset_ms 錨點）。
工具真源: VPS .opencode/tools/audio_first_timeline.ts 與 gateway /agent/v1/tts。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 旁白先行時間線（audio-first）

## 何時用

剪輯意圖是**聲音主導**：旁白／解說／口播／播客式內容。相對地，畫面主導（先剪畫面再配樂）走 `assembly/RECIPE.md`。

## 工具鏈

```
audio_first_timeline（TTS + 實測時長 + offset 錨點）→ timeline_query → timeline_ops（畫面依錨點對齊）→ timeline_lint（過閘）→ timeline_master
```

## 逐步配方

1. **定音軌**：`audio_first_timeline` 輸入逐行文稿（或既有音頻），工具會：
   - 走 gateway 真 TTS 逐行生成；
   - 對每段音頻 `ffprobe` **實測**時長（不是模型自報）；
   - 依序累計 `offset_ms`，產出**錨點時間線**（哪一行在第幾毫秒起）。
2. **摸底**：`timeline_query(what=state)` 讀回錨點時間線真狀態。
3. **畫面依錨點對齊**：`timeline_ops` 用 batch（trim／reorder／split）把畫面 clips 對齊每個 offset 起點。**錨點是唯一時序真源**，不要另算一套起點。
4. **過 lint 閘**：`timeline_lint` 檢查靜音段／音畫時長錯位／爆音等；must 未清不得交付。
5. **導出**：`timeline_master` check → export。

## 誠實條款

- **TTS 與音頻是分鐘級操作**：一次一請求，禁連發多批；整批文稿一次交給 `audio_first_timeline`，不要在 ops 迴圈裡逐行呼叫。
- **時長一律以 ffprobe 實測為準**：模型／TTS 自報時長不可作為交付口徑（音畫時長錯位是 must 級 lint 項）。
- 若交付委託單要求旁白但無 `audio_first_timeline` 產出的 offset 錨點，等於沒有音軌真源——回報缺口，不要用估算秒數冒充。

## 交付

成片交付同主契約：`timeline_ops`（畫面如何依錨點對齊）＋ `duration_sec`（成片實測）＋ `qc`（lint/master 結論）。
