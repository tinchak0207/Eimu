# 共通規則（四份 spec 都適用，先讀）

## 必讀記憶
- 總索引：`/home/lenovo/.codex/memories/extensions/ad_hoc/notes/memory_summary.md`
- `/home/lenovo/.claude/memory/control-plane-billing-paradigm.md`：帳本（account_ledger）是餘額權威，入帳只准走 recordRecharge / recordAdjustment
- `/home/lenovo/.claude/memory/product-reality-funnel-0927.md`：真實漏斗；內部用戶 117/82/253/87/90（及計費身分 4）要剔除
- `/home/lenovo/.claude/memory/referral-loop-0928.md`：最新的「佔位 → 動上游 → 記帳本」範例（src/lib/referral-reward.ts）
- `/home/lenovo/.claude/memory/price-no-change-0928.md`：**禁止改正價**
- 記憶與現場衝突時，以現場代碼為準，並在回報裡寫明衝突。

## 紅線
- 禁止發起真實支付；禁止任何付費上游生成調用（只准 GET /models 之類的唯讀端點）。
- secret、key 明文、email 一律不進日誌、commit、回報。
- 同一個錯誤重試 2 次仍失敗 → 停下，回報事實。
- 不部署。完成後只做這些：`npx tsc --noEmit -p .`、`npx next lint --file <改過的檔>`（**控面連測試檔也 lint**）、`npx tsx --test <相關 *.test.ts>` 全綠 → `git commit`（訊息結尾加 Co-Authored-By 行）→ 回報 commit hash、改動檔清單、測試輸出摘要。
- 風格：跟隨周邊代碼（註釋密度、正體註釋＋簡體用戶文案，與現有檔案一致）。
