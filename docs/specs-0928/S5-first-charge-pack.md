# S5 一次性首充套餐：1 刀 300 張（預期 45 分鐘，**依賴 S3 合併**）

先讀 `_common.md`（同目錄）。**正價 PLANS 一行都不許動。**

## 口徑（暴君拍板）
- plan id `first-charge`：**¥7（≈$1）→ 300 幣**
  - 正價 ¥9.9 = 100 幣，這個是它的約 4 倍划算
  - 成本約 ¥1.5
- 資格：該帳號在 account_ledger **從未有過 recharge 行**，並且從未購買過 first-charge。每個帳號限一次。

## 做什麼
1. `src/lib/plans.ts`：新增 `FIRST_CHARGE_PLAN`，**不放進** `PLANS` 陣列，免得出現在正價列表、也免得 lifecycle-email 的 `entryPlan()` 誤把它選成最便宜的檔。
2. 資格判定放在控面：新增內部端點，或併入 S3 的 mapay-credit 通道。**checkout 和 notify 兩端都要校驗**：
   - 沒資格的人 checkout → 403
   - notify 時發現已經不符合資格（例如併發下了兩單）→ 按 ¥7 對應的正價幣數（約 70 幣）入帳，不給 300；記 detail
3. 定價頁 `src/components/PricingClient.tsx`：
   - 有資格時，在最前面放一張卡：「首充专享 · 限一次｜¥7 得 300 币（约 300 张 GPT Image 2）」
   - 沒資格或未登入時不顯示；未登入時只顯示文案，點擊後先登入
4. 餘額不足 toast 的「去充值」（`src/components/ImagePlayground.tsx`）：改為跳轉 `/pricing?plan=first-charge`，定價頁據此滾動到該卡。
5. API 的 402 訊息（S2）裡的充值鏈接同樣帶上 `?plan=first-charge`。

## 驗收
- 資格判定的單元測試：沒有 recharge → 有資格；有 recharge → 無資格；買過 first-charge → 無資格
- `PLANS` 陣列與正價數字無 diff（`git diff src/lib/plans.ts` 只能是新增）
