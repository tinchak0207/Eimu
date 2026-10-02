---
name: model-status
description: 生成模型可用性探測與近 24h 真實表現。調用 image_generate / image_edit / image_upscale 前確認目標模型可用（工具已內建強制探測，不可用會直接失敗）；當需要「選一個可用模型」或「模型失敗找替代」時，主動查 /v1/model-status 的 availability + last_24h.success_rate，避免把請求發給不可用或近期高失敗的模型。
---

# model-status（生成模型可用性 + 近 24h 表現）

## 守則（強制）

image_generate / image_edit / image_upscale 工具已內建「調用前自動探測」：目標模型不可用會直接失敗並提示換模型；近 24h 樣本 ≥5 且成功率 <50% 也會直接失敗並建議換。**不要重複探測**。

當你需要「選一個可用模型」或「某模型生成失敗後找替代」時，主動查可用性：

GET https://image.tinchak0207.xyz/v1/model-status（Authorization: Bearer <sk-biz-* key>，工具鏈 platformFetch 自動持有）

回傳 models[] 每項：
- id / media_type（image|video）/ endpoint（/v1/images/generations 或 /v1/videos/generations）
- functions（generate / edit / upscale）
- availability（available | unavailable | unknown）+ note（unavailable/unknown 的原因）
- last_24h（可選）：最近 24 小時真實生圖表現 `{jobs, delivered, failed, success_rate, refunded}`——success_rate 是 0~1 的小數。無此字段 = 近 24h 無樣本。

## 選模型規則

- 生圖：media_type=image 且 availability=available → POST /v1/images/generations
- 生影片：media_type=video 且 available → POST /v1/videos/generations
- 改圖：functions 含 edit → /v1/images/edits
- 放大：functions 含 upscale → /v1/upscale
- unavailable → 換下一個同類型 available 模型；全部不可用 → 告知用戶「生成服務暫時不可用」
- unknown（如 sensenova 不支持探測）→ 可嘗試，失敗即換模型
- **多個模型都 available 時，優先選 last_24h.success_rate 高的**（樣本 ≥5 才可信；jobs <5 說明數據不足，不下結論）
- **last_24h 樣本 ≥5 且 success_rate <50% 的模型要主動提醒用戶**：「這個模型探測可用，但最近 24 小時真實成功率只有 X%，建議換 Y」——可用性探測只證明渠道連通，不證明能穩定出圖

## 快取

響應 60 秒內有效（probe.cached）。同一輪工作流複用，不必每次重探。
