# S3 付款綁定用戶——notify 直接入帳（P0，預期 60 分鐘）

先讀 `_common.md`（同目錄）。另外必讀：
- `/home/lenovo/.claude/memory/payment-must-fulfill-0920.md`
- `/home/lenovo/.claude/memory/payment-callback-forensics-0920.md`
- `/home/lenovo/.claude/memory/mapay-fee-rejection-fix-0920.md`

## 為什麼
現在 checkout 的 `param = plan.id`，訂單不綁用戶。notify 只生成兌換碼，靠 return 回跳 `/pricing?cdk=` 自動兌換。用戶付完錢如果關掉分頁，錢已付、額度卻沒到帳。

## 做什麼
1. `src/app/api/payments/mapay/checkout`：已登入時，`param = ${planId}.${userId}.${hmac8}`。
   - hmac8 = `HMAC-SHA256(GENERATION_BILLING_RELAY_SECRET, "mapay-order." + planId + "." + userId)` 的前 8 位 hex
   - 未登入沿用舊格式
   - 仿照 `src/lib/referral-code.ts` 的簽名和 timingSafeEqual 寫法
2. `notify`：param 驗簽通過後，調控面內部端點入帳：
   - 新建 `src/app/api/internal/mapay-credit/route.ts`，複用 biz-key-sync 的 HMAC 通道，仿照 `src/app/api/internal/user-attribution/route.ts`
   - 入帳邏輯仿照 `src/lib/referral-reward.ts` 的 grantOnce：佔位表 `mapay_credit(out_trade_no pk, user_id, plan_id, amount_quota, status…)` → 上游 `adjustGatewayUserQuotaExact` → 帳本 `recordRecharge`
   - 冪等鍵 = mapay 的 out_trade_no
   - notify 重放時不重複入帳
3. notify 直接入帳成功後，**不再**生成兌換碼。入帳失敗時退回舊流程（生成兌換碼），保證錢一定能落地。
4. return 頁：如果訂單已經直接入帳，顯示「支付成功，已到账」，不再觸發兌換。
5. 驗簽失敗或 param 是舊格式 → 完全走舊流程。

## 驗收（全部是單元測試，禁止真實支付）
- 簽名對 / 錯 / 篡改 userId 三種情況
- notify 同一單重放兩次，只入帳一次
- 上游調額失敗時退回兌換碼流程
- 舊格式 param 行為不變
