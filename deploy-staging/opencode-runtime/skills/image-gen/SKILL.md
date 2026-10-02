---
name: image-gen
description: 生圖備援渠道（付費，僅當 agent-pixai 免費池不可用時使用）。用戶要「生成圖片、把這張圖改一下、放大圖片」時，若 agent-pixai 已失敗或用戶明確要求平台付費渠道，用它。走 image.tinchak0207.xyz 平台 API，生圖非同步（空閒時幾十秒到幾分鐘，高峰期排隊可能更久、逾時自動退款），改圖同步 10-30s。
license: internal
metadata:
  audience: coding-agent
---

## 我負責什麼
呼叫我們平台的圖像 API（OpenAI 相容）。**只負責 API 呼叫與狀態判斷，不負責構思 prompt 內容**。

## API 總覽（Base: https://image.tinchak0207.xyz/v1，認證 Bearer）
| 動作 | 端點 | 同步? | 花費 |
|---|---|---|---|
| 生圖 | POST /v1/images/generations | 非同步(202) | 見定價表 |
| 查狀態 | GET /v1/images/{id} | 同步 | 0 |
| 改圖 | POST /v1/images/edits | 同步 10-30s | 用 image_quote 查 |
| 放大 | POST /v1/upscale | 同步 ~20s | 用 image_quote 查 |
| 上傳 | POST /v1/uploads | 同步 | 0 |

**影片已可用**：POST /v1/videos/generations（非同步 202，建影片任務；model/prompt/n/size/duration_seconds/generate_audio）。支持模型：seedance-2.0、kling 2.5/3.0、veo 3.1、runway-gen-4、luma-ray、minimax-h3 等（以 GET /v1/models 為準）。**查影片模型與按秒報價用 `video_quote` 工具**（免費）：它列出全部影片模型與 x_coins_per_second 每秒單價（依解析度分檔），總價 = 每秒單價 × 時長。`image_quote` 只列圖片模型，查影片不要用它。**大片/多鏡頭請用 workflow_* 工具建工作流**（workflow-director skill），不要手動逐支提交。

## 模型與定價（快照，以 GET /v1/models 的 x_coins_per_image 為準）
| 模型 | 單價（標準） | 定位 |
|---|---|---|
| pixai-reference-pro | 0.00097 幣 | 最便宜 |
| pixai-tsubaki2 / pixai-haruka-v2 / pixai-tsubaki-11 / pixai-hoshino-v2 | 0.001 幣 | 二次元/插畫，極便宜 |
| sensenova-u1-fast | 0.1 幣 | 通用草稿 |
| gpt-image-2 / adobe-firefly / gemini-2.5-flash-image / flux-kontext-max / flux-kontext-pro / flux-1.1-pro | 1 幣 | 成品 |
| gemini-3.1-flash-image / gpt-image-1.5 / flux-2-pro / flux-2 / flux-1.1-ultra / runway-gen-4-image | 2 幣 | 高階成品 |
| gemini-3-image | 4 幣 | 高階 |
| gpt-image | 6 幣 | 最貴，只在用戶明確要求時用 |

**模型名必須完全照抄上表**（pixai 系列一定帶 `pixai-` 前綴，寫錯會回 model 錯誤）。
部分模型 hd 比 standard 貴（如 runway-gen-4-image：標準 2 / hd 4），用 image_quote 查準價。

## 步驟化工作流：生圖
1. 未指定模型 → 二次元/插畫類需求用 pixai-tsubaki2（0.001 幣），其餘用 sensenova-u1-fast（0.1 幣）；告知用戶用了哪個與價錢。
2. 先報價（用 image_quote 查即時單價），確認後才發請求。
3. POST /v1/images/generations（response_format: "url"）。
4. 收到 202 → 記 task_id，**不要開始輪詢**。回報「已提交」並結束本回合；耗時一律說「通常幾十秒到幾分鐘，高峰期可能排隊更久，逾時自動退款」，不報精確秒數。回報給用戶的 task_id 必須原樣照抄完整 UUID（36 字元含連字號），嚴禁截斷成前 8 位——短 id 在平台查不到任務。
5. 圖完成後 harness 會把結果續接回來 → 直接給最終圖片 URL。

## 狀態機
| status | 動作 |
|---|---|
| queued / running | 等待，不重試 |
| succeeded | 回應已內嵌 result_url，直接取圖 |
| failed | 讀 error，依陷阱表修復後重發 |

## 陷阱表
| 症狀 | 原因 | 下一步 |
|---|---|---|
| 錯誤含 model 字樣 | 模型名錯 | 換表內模型名重試 |
| HTTP 413 | 上傳 >20MB | 壓縮重傳 |
| 429 | 超過 60rpm | 等 Retry-After 再重試 |
| 402 insufficient_quota | 餘額不足 | 告知用戶充值，不重試 |

## 省錢紀律
- 探索/草稿用 0.001-0.1 幣那一層；1 幣以上只在成品或用戶指名時用。
- n 預設 1；>0.1 幣的動作扣費前必先報價並等確認（≤0.1 幣免確認，方便自由探索）。
- 完全相同的 (model, prompt, size, n) 會命中快取，0 幣直接回舊圖——不必重發。
