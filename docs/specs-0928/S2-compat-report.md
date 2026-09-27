# S2 OpenAI 兼容性核對報告（`/v1/images/generations` vs OpenAI Images API）

只讀報告，未改任何代碼。每條標註 FACT（本 repo 代碼/OpenAPI 可驗，附出處）或 INFERENCE（第三方客戶端行為，
未在本 repo 驗證）。出處皆為 repo 內相對路徑。

## 結論（一句）

**不能直接接入**：production 一律回 **202 + task_id 的異步任務**（openapi 明文「production 一律 202」），
而 OpenAI Images API 的客戶端都期待**單次 POST 同步回 `data[]`**；SillyTavern 與 Cherry Studio 需加一層
「提交 + 輪詢」適配器，NextChat 根本沒有生圖 API 客戶端，不適用。

## 一、逐維度差異（左 = OpenAI Images API，右 = 我方 `/v1/images/generations`）

| 維度 | OpenAI Images API | 我方 `/v1/images/generations` | 出處 |
| --- | --- | --- | --- |
| **同步 / 異步** | POST 同步回 **200**，圖片在同一回應裡 | production：**202** Accepted + `Location: /v1/images/{id}`；回應體為 `GenerationTask`（`{object:"image_generation.task", id, task_id, status:"queued", created, model, requested_count, completed_count, primary_result_id, result_ids, retry_of_task_id, task_url, request_config}`）。取件＝輪詢 `GET /v1/images/{id}` 至 `status:"succeeded"`，或收 `callback_url` webhook。openapi 的 200 分支自標「僅在 durable control plane 未啟用的 legacy 分支回；production 一律 202」 | FACT：`src/app/api/v1/openapi.json/route.ts:88-91,102-118`；`src/lib/generation-core/task-response.ts:44-90`；`src/app/api/v1/images/generations/route.ts:263-330`（durable 分支）、`456-466`（legacy 同步分支） |
| **`data[].url` / `b64_json`** | 同一 POST 回應的 `data[]` 為 `{url}` 或 `{b64_json}`（+`revised_prompt`） | 202 回應**不含 `data`**；只在 `succeeded` 後出現，且元素是 **`TaskArtifact`**：`{id,url,mimeType,sha256,width,height,outputIndex,endpointLabel}` —— **沒有 `b64_json` 欄位**。因此異步路徑下 `b64_json` 不可得，交付一律是 artifact 的 `url`。legacy 同步分支才有 OpenAI 形狀 `{created,data:[{url|b64_json}]}` | FACT：`openapi.json/route.ts:935-947`（TaskArtifact 無 b64 欄）、`:958-995`（GenerationTask）、`src/app/api/v1/images/[id]/result/route.ts:40-47`、`generations/route.ts:456-466` |
| **`response_format`** | 預設 `url` | 代碼預設 **`b64_json`**（`body.response_format === "url" ? "url" : "b64_json"`，非 `url` 一律當 b64，含未傳）。降級：要 b64 而上游只給 URL → 該項退為 `{url}`（legacy 分支語義）。**文檔不一致**：openapi schema 寫 `default:"url"`，`docs/biz-api.md:70` 寫 `b64_json` → 以代碼為準 = `b64_json`。異步路徑下此欄位只落進 `request_config.response_format`，不改變交付形式 | FACT：`generations/route.ts:208`；`openapi.json/route.ts:1102-1106`；`docs/biz-api.md:70,81` |
| **`n`** | 1–10（DALL·E 2/3 與 gpt-image-1） | **1–4**，超界 400 `invalid_n`；串行出圖（`MAX_N=4`）。部分成功語義：`requested_count` vs `completed_count`，未出圖張數自動退款 | FACT：`generations/route.ts:60,200-205`；`openapi.json/route.ts:1091`；`docs/biz-api.md:67` |
| **`size`** | DALL·E 3：`1024x1024`/`1792x1024`/`1024x1792`；gpt-image-1：`1024x1024`/`1536x1024`/`1024x1536`/`auto` | 固定 4 值白名單 `1024x1024`/`1536x1024`/`1024x1536`/`2048x2048`，不在集合即 400 `unsupported_size`；**無 `auto`**。文檔不一致：openapi 與 `docs/biz-api.md` 只列 3 值（缺 `2048x2048`）→ 以代碼為準 = 4 值 | FACT：`generations/route.ts:53,189-198`；`openapi.json/route.ts:1092-1096`；`docs/biz-api.md:68` |

### 其他差異（同樣影響直連）

- **錯誤信封**：`{error:{message,type,code,param:null,trace_id}}` + `X-Request-Id` 頭；OpenAI 無 `trace_id`。
  額外穩定碼：`model_not_permitted`(403)、`no_endpoints`(502)、`control_plane_unavailable`(503)、`result_not_ready`(409)。
  FACT：`generations/route.ts:76-96`；`openapi.json/route.ts:706-713`。
- **額外能力（OpenAI 沒有）**：`callback_url`（webhook）、`Idempotency-Key` 頭、`control_nets`、`reference_images`、
  `routing_hint`、`quality: hd|high`。`async` 欄位是 **no-op 向後相容**（openapi 原文：「production 一律非同步 202」）。
  FACT：`generations/route.ts:98-105,206-230,264`；`openapi.json/route.ts:1097-1107`。
- **OpenAI 有、我方靜默忽略的欄位**：`style`、`user`、`output_format`、`background`、`moderation`、
  `output_compression`（未在請求體型別中，不報錯也不生效）。FACT：`generations/route.ts:98-105` 型別定義。
- **限流**：三個 `x-ratelimit-*` 頭，輪詢不消耗額度。FACT：`src/lib/biz-rate-limit-response-headers.ts`。
- **`docs/biz-api.md` 已過時**：它寫「OpenAI Images API 形狀，可直接用官方 SDK」並示範同步
  `data[0].b64_json`（`:12,77,100`），與 production 的 202 異步實際行為衝突；站內 `docs/api` 開發進階
  （`src/app/docs/api/DevAppendix.tsx:56-70`）才是對的（202 + 輪詢）。FACT。

## 二、三家客戶端逐條判定

| 客戶端 | 能否直接接入 | 阻塞點 | 依據 |
| --- | --- | --- | --- |
| **SillyTavern** | **不能** | 其 OpenAI 生圖來源是「一次 POST 取圖」模型：讀同步回應的 `data[0].b64_json`（或 `url`）。我方 202 回應無 `data`，且 `b64_json` 在異步路徑根本不可得 → 直接填 Base URL 會拿不到圖 | 我方 202 為 FACT；客戶端契約為 INFERENCE |
| **Cherry Studio** | **不能** | 同為同步取圖：把 `/images/generations` 當 OpenAI 形狀、直接讀 `data[].url|b64_json`；且我方預設 `b64_json` 而異步交付只有 URL，雙重不符 | 我方契約為 FACT；客戶端契約為 INFERENCE |
| **NextChat** | **不適用** | 純聊天客戶端，沒有 `/v1/images/generations` 生圖客戶端；圖片只能從 chat 回覆的 markdown/URL 呈現 → 無從接入 | INFERENCE（未在本 repo 驗證） |

**要讓前兩家可用，最短改動**（供裁決，不在本輪範圍）：在閘道加一層「同步兼容模式」——
POST 時若 `async !== true` 或客戶端標頭命中，內部提交任務並在 `maxDuration` 內輪詢到 `succeeded`，
再包成 OpenAI 形狀 `{created, data:[{url}]}` 回 200（或加一個 `/v1/images/generations/sync` 入口）。
調研層面這是唯一阻塞點；`n`/`size` 差異只是參數收斂，不是阻塞。

## 三、信心與驗證方式

- 本報告所有我方契約結論 = **源碼 + OpenAPI 交叉核對**（FACT），無付費呼叫（紅線：本輪禁止任何生成型上游呼叫）。
- 第三方客戶端能否接入 = **INFERENCE**，未實測；若要坐實，最快方式是拿一顆測試 key 在該客戶端配一次
  並抓包看它是否只發一次 POST（此動作需暴君授權，因會產生真實計費費用）。
- 免費可複現的自我核對：`curl -s https://eimu.dev/v1/models -H "Authorization: Bearer $KEY"`（唯讀），
  確認 model id 與 `x_coins_per_image`。

## 四、本輪未落地項（衝突，待裁決）

`docs/specs-0928/S2-dev-activation.md` 第 2 項要求把 `/v1/*` 餘額不足出口統一為：

```json
{"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}
```

**與既有契約鎖硬衝突，未動任何代碼**（依 spec「不許破壞，衝突時停下回報」）：

1. `src/app/api/v1/contract-lock.test.ts:644-649` 要求 `generations/route.ts` 源碼出現 `errorResponse(402,` 且
   `insufficient_quota` 字面量 ≥2 次（現況 3 次：型別聯集 + type + code）。
2. `contract-lock.test.ts:678-695` 要求 `quota-precheck.ts` 源碼存在 `type: "insufficient_quota" | "api_error"`、
   `code: "insufficient_quota" | "control_plane_unavailable"` 與文案 `余额不足，请先充值。` 逐字不差。
3. `contract-lock.test.ts:315-328,329-364` 要求 openapi 的錯誤 `type` 六枚舉含 `insufficient_quota`、穩定錯誤碼
   清單含 `insufficient_quota`（「對外承諾不得縮水」）。
4. `src/lib/generation-core/quota-precheck.test.ts:245,315,454` 在 **runtime** 層斷言 402 文案逐字等於
   `余额不足，请先充值。`。

新碼 `insufficient_balance` 與新文案無法與上述任何一處並存（`insufficient_balance` 不含 `insufficient_quota`
子串，改 type/code 即同時打爆 source-scan 與 runtime 兩層）。**改契約須先鬆綁上述 4 處鎖 + openapi 枚舉**，
屬暴君裁決事項；本輪只交付不衝突的第 1、3 項（建 key 快速上手 + 本報告）。