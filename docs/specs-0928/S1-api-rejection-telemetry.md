# S1 API 拒絕遙測＋首調審計（預期 40 分鐘）

先讀 `_common.md`（同目錄）。

## 為什麼
23 個外部用戶建了 biz key，其中 16 人一次調用都沒成功過。被拒的請求（鑑權、餘額、參數）根本不會進 generation_job，我們完全看不見流失在哪一步。

## 做什麼
1. 新表 `api_rejection(id bigserial, user_id bigint null, key_prefix text null, path text, model text null, status int, reason text, created_at timestamptz default now())`
   - 寫 migration `db/migrations/029_api_rejection.sql`
   - 同時用 `ensureSchema`，首次使用時自動建表（仿照 src/lib/referral-reward.ts）
2. 在 B 端 `/v1/*` 入口（`src/app/api/v1/images/generations`、`edits`、`[id]`、`src/app/api/v1/models`，以及它們共用的鑑權、計費閘；用 grep 找 `authenticateBizKey`、biz key 驗證函數），每一個「回非 2xx」的出口都寫一行。
   - `key_prefix` 只取前 8 位
   - 不記 prompt，不記完整 key
   - 寫入失敗靜默吞掉，不能影響請求本身
3. 出一份唯讀報告，寫到 `docs/specs-0928/S1-report.md`：23 個 key 持有者（排除 117/82/253/4）的歷史 generation_job，每人列出：
   - 首單時間、模型、狀態、失敗原因
   - 從沒調用過的人，列出建 key 時間
   - 同時查 new-api 日誌：`sudo sqlite3 /opt/imagesite/new-api-data/one-api.db`，`logs` 表按 user_id 看他們有沒有打過 new-api、錯在哪
   - VPS 連線：`ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`；Postgres：`sudo docker exec image-control-postgres psql -U image_control -d image_control`

## 驗收
- 單元測試：拒絕記錄器對 401、402、400 各寫一行，且不含完整 key
- 報告按原因分組，給出人數
