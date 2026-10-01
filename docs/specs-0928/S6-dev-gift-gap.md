# S6 補發開發者漏掉的新人禮＋修正回溯排除口徑（預期 30 分鐘）

先讀 `_common.md`（同目錄）。另外必讀：`/home/lenovo/.claude/memory/product-reality-funnel-0927.md`（新人禮上線、回溯細節）。

## 事實（S1 報告）
- 245、250、251、252、254 建了 biz key，但 new-api 額度是 **$0**。他們按下按鈕只會撞 402。
- 根因（推論，先驗證）：`src/lib/welcome-gift.ts` 的回溯用 `listBizBillingUserIds()`，把**所有 biz key 持有者**都排除掉了。原意只是排除內部的 B 端計費帳戶。
- 登入時補發要靠 `/api/auth/me`，但開發者用的是 API，不會再登入網頁，所以永遠補不到。

## 做什麼
1. 回溯排除口徑改為只排除 `INTERNAL_USER_IDS`（env），加上現有的 probe/test/canary 規則，**不再**按「持有 biz key」排除。
   - 把 `welcomeGiftBackfillCandidates` 的測試改成新口徑：持有 biz key 的外部用戶要進候選。
2. 在 worker 維護輪（`src/lib/generation-core/worker-service.ts` 的 `runAccountMaintenanceOnce`）加一步：外部用戶一旦建了 biz key、又還沒領過新人禮、也沒成功出過圖，就自動發。
   - 直接複用 `grantWelcomeGift`，不另寫發放邏輯
   - 每輪最多 20 人
3. 不做一次性手工補發，交給第 2 步在部署後自動補齊。回報時說明預期會補到哪些 user id（只讀查詢得出）。

## 驗收
- 單元測試：biz key 持有者、無 gift、無成功單 → 發；內部 id → 不發；已領 → 不發
