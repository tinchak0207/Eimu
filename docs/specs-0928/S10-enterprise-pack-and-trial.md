# S10 企業幣包＋「用你的小說試拍 30 秒」成交流程（預期 60 分鐘）

先讀 `_common.md`（同目錄）。另外必讀：`/home/lenovo/.claude/memory/price-no-change-0928.md`（不改正價）、`/home/lenovo/.claude/memory/kunpeng-film-assembly-sharding.md`（成片拼接已可用）。

## 做什麼
1. **企業幣包**：在 `src/lib/plans.ts` 新增 `ENTERPRISE_PLANS`，**單價與夢虹完全一致**（¥69 / 1500 幣），只放大金額：¥2,000、¥5,000、¥10,000，幣數按夢虹單價換算並取整。
   - **不放進** `PLANS` 陣列；定價頁底部加一個「企业 / 工作室」區塊。
   - 查清 mapay 單筆金額上限（讀 `src/lib/mapay.ts` 和 `/home/lenovo/.claude/memory/mapay-fee-rejection-fix-0920.md`）。超過上限的檔位改為「联系我们」，走人工收款後用 `tools/issue-promo-code.ts` 發兌換碼（寫清操作步驟）。
2. **試拍申請頁 `/studio`**（簡體中文、B 端語氣、零 emoji）：
   - 首屏：《大明最后的十七年》成片直接播放（`public/showcase/agent-templates/novel-film-3.mp4`），旁邊一句話「整本小说丢进去，出来就是成片」。
   - 三行事實：全程真视频｜角色同脸｜约 ¥14 / 分钟（由 ENTERPRISE_PLANS 單價實時計算，不寫死）。
   - 表單：工作室名稱、聯繫方式（微信或手機）、每月出片量、上傳一章小說或劇本（txt/docx/pdf，≤2MB）→ 寫入控面新表 `studio_lead`（仿照 `api_rejection` 的 ensureSchema 寫法）。
   - 提交後顯示「24 小时内我们用你的故事拍 30 秒试看片」。
   - 要有內部通知：新 lead 寫入時發一封 Resend 郵件到 `.env.resend` 裡 RESEND_FROM 對應的收件地址（或暴君指定的地址；**不在代碼裡寫死任何個人郵箱**）。
3. **/admin 加 lead 列表**：狀態流為 new → 試拍中 → 已交付 → 已成交／流失，可手動改狀態。

## 驗收
- `ENTERPRISE_PLANS` 單價與夢虹一致有測試鎖住；`PLANS` 無 diff
- lead 寫入、狀態流轉的單元測試
- `/studio` 在手機寬度可用（只跑構建，不做 UI 截圖）
