---
name: editor-mix
description: 剪輯混音與 ducking 配方。觸發時機：混音、配樂、BGM、SFX 音效、人聲太吵／太小、旁白被音樂蓋住、響度、LUFS、ducking、音軌平衡。任何「聲音層次／音量／配樂」類剪輯請求必載。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 片B5
              （混音增強：三軌 voice/bgm/sfx + ducking sidechaincompress 後置 pass，不動 composeEngine 主釘 +
              響度報告）與 §7 終驗（mix 13/13；loudnorm 口徑 I=-16 TP=-1.5 LRA=11）。
工具真源: VPS .opencode/tools/timeline_mix.ts 與 gateway/mix.ts。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 混音與 ducking（mix）

## 工具鏈

```
timeline_query（摸底音軌）→ timeline_mix（三軌 + ducking + 響度報告）→ timeline_query（回讀）→ timeline_lint（過閘）
```

## 逐步配方

1. **摸底**：`timeline_query` 取 `add_audio` 落下的音軌（voice／bgm／sfx）與 clip 層級。
2. **混音**：`timeline_mix` 做**三軌（voice / bgm / sfx）**處理：
   - **ducking**：走 ffmpeg `sidechaincompress` **後置 pass**（不動 composeEngine 主釘），人聲一出現就把 BGM 壓下去。
   - **響度**：`loudnorm=I=-16:TP=-1.5:LRA=11`（全鏈統一釘死口徑）。
   - 產出**響度報告**（LUFS／true peak／LRA）。
3. **回讀**：`timeline_query` 確認音軌狀態。
4. **過 lint 閘**：`timeline_lint` 查靜音段／爆音／音量跳變（must 級）；混音後必檢。

## 硬規則與誠實條款

- **ducking 是後置 pass**：不改 `composeEngine` 主釘；不要重寫主混音圖來「順便」加 ducking。
- **duck 基準窗**：以**掃無人聲區**的音量為基準（沉澱坑），不是全域平均；基準選錯＝人聲段被誤壓。
- **響度口徑固定** `I=-16:TP=-1.5:LRA=11`；不要自定目標值，也不要聲稱響度達標而未跑報告。
- **音樂／SFX 素材源**：接受 URL 輸入，本鏈**不建音樂庫**；需配樂時走 `music_gen`（音樂域 Expert）或既有素材 URL，不在剪輯層造音樂。
- **響度≠好聽**：報告是機器量測，混音品味不作承諾；`qc` 欄只寫可核驗的實測結論。

## 交付

混音後 `timeline_ops`（記錄 ducking／響度設定）＋ 響度報告；成片交付三欄同主契約（`qc` 帶響度與 lint 結論）。
