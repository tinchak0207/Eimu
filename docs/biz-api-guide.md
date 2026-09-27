# B 端 API 調用指南（`/v1`）

> 本指南講的是**異步接法**（base URL `https://eimu.dev/v1`）。要接中轉站或現成客戶端（New API、Cherry Studio、酒館、Dify、Coze、n8n、LobeChat、OpenAI SDK），走同一輪推出的**標準 OpenAI 同步層**，base URL `https://eimu.dev/openai/v1`，選型與填法見 `docs/biz-api.md` 開頭。

## 基本資訊

| 項目 | 值 |
|---|---|
| Base URL | `https://eimu.dev/v1` |
| 認證 | `Authorization: Bearer sk-biz-…` |
| 請求體 | `Content-Type: application/json` |
| 追蹤 | 每個回應帶 `X-Request-Id`；錯誤體內同值為 `trace_id` |

只需要 **key + Base URL**，不需要任何自定義請求頭。

## 最重要的一點：生圖是非同步的

`POST /v1/images/generations` **永遠回 `202` + 任務 ID**，不會在同一個回應裡給圖。
它不是 OpenAI 那種「一次請求直接拿 `data[].b64_json`」的同步形狀。

```
POST /v1/images/generations   → 202  { task_id, status:"queued", task_url }
GET  /v1/images/{task_id}     → 輪詢至 status = succeeded / failed / refunded
GET  /v1/images/{task_id}/result → 302 跳轉到圖片 URL（或 ?format=json 拿 JSON）
```

`succeeded` 的輪詢回應本身就內嵌 `data[]`，所以拿到 `succeeded` 那一刻即可取圖，
`/result` 只是額外的便捷入口。

## 快速開始

```bash
KEY="sk-biz-…"
BASE="https://eimu.dev/v1"

# 1. 列出可用模型
curl -s "$BASE/models" -H "Authorization: Bearer $KEY"

# 2. 提交任務
curl -s -X POST "$BASE/images/generations" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"pixai-haruka-v2","prompt":"1girl, silver hair, cinematic lighting","n":1,"size":"1024x1024"}'
# → {"task_id":"3988af81-…","status":"queued","task_url":"/v1/images/3988af81-…"}

# 3. 輪詢（建議 3~5 秒一次；實測 15~20 秒出圖）
curl -s "$BASE/images/3988af81-…" -H "Authorization: Bearer $KEY"

# 4. 取圖
curl -s "$BASE/images/3988af81-…/result?format=json" -H "Authorization: Bearer $KEY"
```

## 端點契約

### `GET /v1/models`

回 OpenAI `list` 形狀，額外帶兩個私有欄位：

```json
{"object":"list","data":[
  {"id":"pixai-haruka-v2","object":"model","created":1767225600,
   "owned_by":"image-studio",
   "x_display_name":"…","x_coins_per_image":{"standard":0.01,"hd":0.01}}
]}
```

注意：這裡列的是**全站**支援的模型，不是你這把 key 被授權的模型。
調用白名單外的模型會回 `403 model_not_permitted`。

### `POST /v1/images/generations`

| 參數 | 類型 | 說明 |
|---|---|---|
| `model` | string | 必填。白名單外回 403，全站不存在回 400 |
| `prompt` | string | 必填，上限 4000 字元 |
| `n` | int | 1–4，預設 1。多張為串行出圖，計費按張數乘 |
| `size` | string | `1024x1024`（預設）/ `1536x1024` / `1024x1536`，**只有這三種** |
| `quality` | string | `hd` 或 `high` → 2K；其餘（含省略）→ 1K |
| `response_format` | string | `url` 或 `b64_json`。非同步路徑實際一律回 URL |
| `callback_url` | string | 選填。任務終態時回調 |

請求頭 `Idempotency-Key`（選填）：同 key 同 body 回同一個 task；
同 key 不同 body 回 `409 idempotency_key_reused`。

### `GET /v1/images/{task_id}`

```json
{"object":"image_generation.task","task_id":"…",
 "status":"queued|running|succeeded|failed|cancelled|refunded|unknown",
 "requested_count":1,"completed_count":1,
 "result_url":"/v1/images/…/result",
 "data":[{"id":"…","url":"https://…webp","width":768,"height":768,
          "sha256":"…","mimeType":"image/webp","outputIndex":0,
          "endpointLabel":"pixai"}]}
```

`result_url` 與 `data` 只在 `succeeded` 時出現。未終態時若有可報告原因，
會帶 `error: { code, reason?, message }`（此時任務仍在重試，不代表失敗）。

### `GET /v1/images/{task_id}/result`

- 預設：`302` 跳轉到圖片 URL
- `?format=json`：回 `{object:"image_generation.result", task_id, data:[…]}`
- 未完成：`409 result_not_ready`

圖片 URL 落在 `https://store.tinchak0207.xyz/image-data/files/…`，
**公開可讀、不需認證**，格式 `image/webp`，帶一年不變快取頭。

## 模型與參數的硬約束（實測）

供應商能力表按 `(模型, 操作, 比例, 解析度)` 四元組匹配，對不上直接
`model_unsupported`，這是**參數錯誤**而非上游故障。

| 模型 | 解析度 | 可用比例 | `quality` |
|---|---|---|---|
| `pixai-haruka-v2` | 僅 1K | 1:1, 3:2, 2:3, 3:4, 4:3, 9:16, 16:9 | **不可傳 hd** |
| `pixai-reference-pro` | 僅 1K | 同上 | 不可傳 hd |
| `pixai-tsubaki-11` | 僅 1K | 同上 | 不可傳 hd |
| `pixai-tsubaki2` | 僅 1K | 同上 | 不可傳 hd |
| `pixai-hoshino-v2` | 僅 1K | 同上 | 不可傳 hd |
| `sensenova-u1-fast` | 僅 2K | 1:1, 3:2, 2:3 | **必須 hd** |

實測結果：

- 4 個 PixAI 模型（haruka-v2 / reference-pro / tsubaki-11 / hoshino-v2）
  + tsubaki2 端到端出圖成功，`n=2` 也成功（`completed_count=2`）。
- `quality:"hd"` + PixAI = `model_unsupported`（PixAI 沒有 2K 能力）。
- `sensenova-u1-fast` 目前**不可用**：它只掛在三個中轉渠道下，而
  `env:primary` 已停用、`env:sub2api` 在 cooldown、`env:fallback` 降級。
  用 2K 送過去，上游回「images endpoint requires an image model」，
  任務轉 `refunded`（已自動退款）。要開通這個模型得先修中轉渠道。

## 計費

`1 幣 = 500,000 quota`。扣費落在 key 綁定的 New API 用戶（你這把是 **user 87**）。

當前生效的定價覆寫（`/api/model-pricing` 公開端點可查）：

```
pixai-haruka-v2 / tsubaki2 / tsubaki-11 / hoshino-v2 : imageCredits 1k = 0.01
pixai-reference-pro                                  : imageCredits 1k = 0.0097
pixai-edit                                           : 0.001 (1k/2k/4k)
pixai-upscale                                        : fixedCoins 0.001
```

實測每張 PixAI 圖預留並結算 **500 quota ≈ 0.001 幣**（reference-pro 485）。
這與「衝量、幾乎無限」的意圖一致。

計費是真帳本，不是計數器：`billing_operation` 表對每個任務記 `reserve` /
`commit` / `refund`，實測成功任務 `reserve 500 → commit 500` 都 `applied`，
失敗任務 `refund` 也 `applied`。失敗自動退款。

## 錯誤契約

HTTP 錯誤體是 OpenAI 形狀 + `trace_id`，同一個 id 也在 `X-Request-Id` 響應頭：

```json
{"error":{"message":"...","type":"invalid_request_error","code":"unsupported_size","param":null,"trace_id":"b807330b-..."}}
```

實測過的 HTTP 錯誤：

| HTTP | `code` | 觸發條件 |
|---|---|---|
| 401 | `missing_api_key` | 沒帶 Authorization |
| 401 | `invalid_api_key` | key 形狀不對或不存在 |
| 403 | `api_key_disabled` | key 被停用 |
| 403 | `model_not_permitted` | 模型不在該 key 白名單 |
| 400 | `missing_prompt` / `missing_model` | 缺必填參數 |
| 400 | `model_not_found` | 站點不支援該模型 |
| 400 | `unsupported_size` | size 不在四個允許值內 |
| 400 | `invalid_n` | n 不是 1..4 |
| 400 | `prompt_too_long` | prompt > 4000 字元 |
| 402 | `insufficient_balance` | 餘額／額度不足，本次未扣費（message 內含充值入口） |
| 409 | `idempotency_key_reused` | 同 key 配不同請求體 |
| 429 | `rate_limit_exceeded` | 超過 rpm，附 `Retry-After` |
| 503 | `control_plane_unavailable` | 控制面故障 |
| 405 | `method_not_allowed` | 對 generations 發 GET |

任務層失敗放在 task 的 `error` 欄位（HTTP 仍 200）：

| `code` | `reason` | 含義 |
|---|---|---|
| `overloaded` | `suppliers_cooldown` | 供應商全在冷卻，訊息含恢復時間 |
| `overloaded` | `capacity_saturated` | 併發打滿，等待即可 |
| `model_unsupported` | — | 參數四元組匹配不到能力（你的參數錯了） |
| `user_input` | — | 上游拒收請求 |
| `quota_exhausted` | — | 帳戶額度用盡 |
| `authentication` | — | 上游憑證失效 |
| `unknown` | — | 結果不確定，需人工對賬（不自動重試） |

`overloaded` 的三種 reason 處置完全不同：`suppliers_cooldown` 等恢復、
`capacity_saturated` 降併發、`model_unsupported` 改參數。別統一當「上游掛了」重試。

## 接聚合平台的關鍵限制

**`/v1` 這個端點不是同步 OpenAI 契約。** `/v1/images/generations` 在控制面開啟時
**永遠**回 202 + task id，不會直接回 `{"data":[{"b64_json":...}]}`。

實測確認：請求體裡的 `async` 欄位會被解析但**未被使用**，沒有同步旁路。
`response_format` 同理——結果一律是 URL，不給 b64。

後果：New API / one-api 這類期待同步回應的聚合平台**不能把 `/v1` 直接當
OpenAI 生圖上游接**，需要中間層實作「提交 → 輪詢 → 取 URL」。

**不用自己寫這層了**：同一輪（2026-09-28）推出的標準 OpenAI 同步層
`https://eimu.dev/openai/v1` 就是這個包裝路由——`POST /images/generations`
同步回 `200 {created,data:[{url|b64_json}]}`，`POST /chat/completions` 支援
`stream:true`，`GET /models` 回標準 list。New API、Cherry Studio、酒館、
Dify、Coze、n8n、LobeChat 與 OpenAI SDK 一律改填這個 base URL，
填法與選型見 `docs/biz-api.md` 開頭。該層與這份文件同日推出，**尚未部署到生產、目前不可調用**，
判據是 `curl -s https://eimu.dev/openai/v1/models -H "Authorization: Bearer $EMU_API_KEY"`
能否回 list（404/502 ＝ 還沒上線，此時只能按本文的非同步流程接 `/v1`）。

## 已知坑

- **舊 task id 會查不到（404）**：任務按 `tenant_id = biz:<key記錄id>` 隔離。
  本次修復把認證源從 env 兜底切回權威記錄，key 記錄 id 由
  `env-04dd42f0adb3` 變成 `4eab19b64956`，所以修復前建的任務用這把 key
  已經查不到（實測 404）。任務本身和帳都還在庫裡。
- **rpm 是每實例計算**：滑動窗口在進程內，多實例各算一份，實際放行量可能
  高於 600。真正的花費上限靠帳戶餘額兜底。
- **`image-control-api` 容器重建後必須 reload nginx**：容器 IP 變了但
  nginx 把舊 IP 釘住，`/v1/*` 會全部 502。指令：
  `sudo docker exec imagesite-nginx nginx -s reload`。

