# S8 標準 OpenAI 同步接口 /openai/v1（最高優先，預期 3 小時，可拆 2 路）

先讀 `_common.md`（同目錄）與 `docs/specs-0928/S2-compat-report.md`（差異全表，本 spec 的依據）。

## 為什麼（第一性）
我們的資產是便宜且獨有的供給（gpt-image-2、PixAI 二次元），缺的是分發。分發管道已經存在，而且裡面的用戶本來就在付費：
- new-api／one-api 中轉站：加渠道只需要填 base URL 和 key
- Cherry Studio、SillyTavern（酒館）、Dify、Coze、n8n、LobeChat
- 直接用 OpenAI SDK 寫代碼的開發者

這些管道全部只認標準 OpenAI 的**同步**形狀。我們的 production 一律回 202 異步任務，所以每一條管道對我們都是關著的；`docs/biz-api.md` 還寫著「可直接用官方 SDK」，這句是錯的。

## 做什麼
**新開一個兼容層 `/openai/v1/*`，現有 `/v1/*` 契約一行不動**（contract-lock 不許改）。現有 biz key 在兩邊都能用。

1. `POST /openai/v1/images/generations`
   - 內部走現有 durable 管線：提交後在服務端等到任務完成，然後回 **200**，body 為 `{created, data:[{url} | {b64_json}]}`
   - `response_format` 按 OpenAI 語義：預設 `url`；要 `b64_json` 時由服務端取回 artifact 再編碼
   - 失敗時回 OpenAI 錯誤信封（`{error:{message,type,code}}`），未出圖＝不扣費（沿用退款語義）
   - 等待上限先實測部署平台允許的函數時長，按實際值設定；超時回 504，並在 `error.message` 附上 task id（任務繼續在後台跑，可在網頁歷史裡找到）
2. `POST /openai/v1/chat/completions`：生圖模型以對話形式調用。
   - 取最後一條 user 訊息作為 prompt，同步等出圖，回標準 chat.completion：`content = "![image](<url>)"`
   - 支援 `stream:true`：先送 keep-alive 片段，出圖後送一個含圖片 markdown 的 delta，最後送 `[DONE]`（酒館、Cherry Studio 走的是這條）
   - 非生圖模型 → 400 `model_not_supported`
3. `GET /openai/v1/models`：標準 `{object:"list", data:[{id, object:"model", owned_by:"eimu"}]}`，只列目前可用的圖片模型（沿用熔斷閘，不列已熔斷或斷供的模型）。
4. 文檔：`docs/biz-api.md` 開頭改為兩種接法：
   - 「標準 OpenAI 同步（中轉站、客戶端、SDK 直接填）：base URL `https://eimu.dev/openai/v1`」
   - 「異步任務（`/v1`，帶 callback 或 Idempotency-Key，適合批量）」
   - 附 new-api 加渠道的填法（類型選 OpenAI，base URL 填上，模型列表填上）

## 驗收
- 用官方 `openai` npm SDK 寫的測試（mock 上游）：`client.images.generate(...)` 拿到 `data[0].url`；`client.chat.completions.create(...)` 拿到 markdown 圖片；stream 模式能正常收完
- `/v1/*` 的 contract-lock 測試不改、全綠
- **真單驗證只准 1 次**：gpt-image-2、1024x1024、n=1，由 orchestrator 報備暴君同意後執行，不在本 spec 內執行
