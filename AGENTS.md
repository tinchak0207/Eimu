# AGENTS.md - Image Studio（Emu）工作規則

## 任務定性優先（先於一切 skill/紀律選擇）

- 接到請求第一步定性：【能力建設】（動詞：避免/绕过/加法/造/集成/强化/让 X>Y——主線是新增能力）還是【修復】（動詞：修好/恢复/为什么坏了——保守紀律只對修復生效；凍結組件/禁重放/只准翻日誌嚴禁套到能力建設）。
- 用戶點名原材料時，第一動作是解剖原材料（讀它的文檔/源碼結構/模式清單），不是翻生產日誌；舊日誌最多是背景參考。
- 跑偏硬指標：花在「維護現狀」的呼叫數超過「新增能力」= 已跑偏，立即回主線。

## Time discipline（每次會話生效）

- 黃金時間：定改動 → 改碼 → 部署 → 寫 memory。會等的操作（部署/長驗證/外部呼叫）永遠放最後，不佔待命的先做。
- 禁自我 UI 檢查：美學歸暴君，dev server/Playwright/截圖驗外觀 = 垃圾時間，改完直接交。
- 禁自造輔助腳本/工具，除非暴君點名。
- 連續 3 次讀取/探測沒有產出修改 → 停下問暴君一句話；禁止猜尺寸/狀態/意圖。
- 研究 grep 優先，不通讀 >200 行大檔（除非任務需要整體理解）。
- 禁旁白（「我先讀…」「分析完成」），只輸出決策、證據、結果。
- 已完成的閉環不重跑驗證。
- Memory 紀律：每完成可用工具/解決反覆問題/被糾正一次，當場寫 `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/` note + 更新 memory_summary.md。不寫 = 智力歸零。
- Harness 迭代閉環：暴君回報浪費時間/規則沒生效 → 當場先改對應規則再做事，每個回饋 = 一次壓縮。
- 按暴君 prompt 語言回覆；bash 語法（Arch Linux，2026-08-17 起；PowerShell/Windows 路徑是錯的）。

## 禁止造輪子（違反 = 立即返工）

- 「複用/複製/用現有的 X」= 逐行 cp 整份源碼再改白名單欄位，不是參考重寫。判定：diff 除白名單外逐行等價，做不到 = 沒交貨。
- subagent spec 必須寫明輪子源檔 + 白名單欄位（數據源/文案/接入點）；交互邏輯/物理參數/事件監聽/生命週期 hooks 一行不許動。
- 教訓（2026-08-25 模板旋轉木馬）：「精簡複製」砍掉 wheel `{passive:false}`、SPRING_TRACK、drive() → 觸控板沒反應，三輪返工。每精簡一處 = 埋一顆雷。
- 自造輪子前先問：生產上有沒有同功能實現？有 → 複製它。

## Subagent 派遣（2+ 檔或單檔 diff >50 行必派；單檔 <5 行可內聯）

- orchestrator 只做：定位目標、寫 spec、派發、收結果、驗收。
- spec 必含「必讀記憶」節（2026-09-02 暴君糾正「恶性引导」）：① `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/memory_summary.md` 路徑 ② 2-5 個與任務直接相關的 note 檔名＋一句話為何相關 ③ 指令「記憶與現場證據衝突時以現場為準並回報衝突」。沒有記憶節＝orchestrator 失職，等同 spec 沒配方，禁止派發。
- spec 帶配方不是目標：標準操作（new-api 渠道接入/env 變更/seed/rebuild/VPS 傳檔）的 copy-paste 命令直接貼進 spec（配方在 new-supplier-integration skill「new-api 渠道 5 分鐘配方」節），不許現場考古；spec 沒配方 = orchestrator 失職，不許派發。
- spec 開頭寫「預期 N 分鐘」，超 2x orchestrator 主動 TaskStop、內聯接管或重派；主動巡檢，不被動等。
- subagent 同一錯誤重試 2 次未過 → 停止並回報事實（寫進 spec），禁止無限試錯。
- 「X 為基底」合併必須先雙向 diff（本地與 VPS 是並集，單向回灌沖掉另一邊修復）；舊記憶的基底聲明引用前先驗是否仍成立。
- 每次派遣事故的坑位當回合沉澱進 skill 配方節（信息差歸零）。

## Verification 鐵律

- 不故意跑預期失敗的測試；先實現再驗證；驗證意外失敗先診斷修因再重跑。
- 暴君接管視覺驗收時：Vercel READY + production alias 確認即停，視覺結果標 pending 用戶驗收。
- 不宣稱未驗證的成功；HTTP 200 ≠ 可用。
- Adobe2API 是目標時：先追直接請求與上游響應再動鑑權/路由，不動 relay；不從 HTTP 408 推斷 scope/token 問題（見 adobe2api-direct-debugging skill）。

## Authentication 紅線

- 禁 headless/自動化 Chromium 做 Adobe/Google 交互登入；遇「browser may not be secure」立即停，換用戶真實 Chrome，認證完成後再恢復自動化。
- 不重放含動態 state/device context 的舊 IMS 授權 URL。
- 生產不依賴開著的 Chrome 標籤；正常續期走 server-side auto_refresh token；保留最後一個可用的 renewable token 直到替代被接受。
- secret/憑證/token/OTP/私鑰永不入 log、memory、commit。

## B 端 API key（2026-08-19 簽發，僅此一把）

- 明文在 `.env.biz-key`（600，.gitignore 已覆蓋）；調 `https://image.tinchak0207.xyz/v1/*`（Bearer sk-biz-…）。
- 丟失/泄露只能吊銷重簽——用戶明確不再簽發，務必保管。

## 按需附件（排障/設計/產品決策時才讀，平時不載入）

**膨脹鐵律：本檔只加行為規則；排障筆記進 runbook，歷史歸 memory，產品準則進 PRODUCT.md。**

- 基礎設施排障（VPS 鏈路/控制面命令/生圖卡根因/agent 網關 CORS/session 404）：`docs/runbooks/infra-debugging.md`
- Adobe2API 定向排障：skill `adobe2api-direct-debugging`
- UI 設計權威：`design-system/MASTER.md` + `DESIGN.md` + `tailwind.config.ts`（lg-* 體系；正文 ≥13px）；任何 UI 任務先載 impeccable skill（~/.agents/skills/impeccable，它會載 PRODUCT.md/DESIGN.md）；Agent 交互鎖定決策見記憶檔 2026-08-08-agent-frontend-design-rules.md
- 產品決策準則全文 + 品牌/套餐/交互規則：PRODUCT.md（「Product Decision Doctrine」節）
- 中控記帳/計費/排帳唯一權威：記憶 control-plane-billing-paradigm

## repo 掃描地圖（2026-08-30，降低模型掃描成本）

**活程式碼（改動/讀取只進這些）**：`src/app/api/`（Next.js 路由）、`src/lib/`（generation-core 生圖/視頻/TTS 管線、supplier-channels registry、billing 等）、`src/components/`、`src/app/`（頁面）、`tools/`（seed/add-supplier-channel 等操作工具）、`bridge/`（pixai-bridge 等上游橋）、`deploy/gatus/`（探針配置）、`design-system/`（UI 權威）。

**可跳過目錄（垃圾/快取/快照，禁止花時間掃描）**：
- `.tmp-home/`、`.tsdeps/`、`.xdg-cache/`、`.vercel.bak-link/`、`.dsh-*`、`.gateway-work/`、`.vercel-home/`、`.vercel-cli-cache/`、`.tmp-vercel-cache/`、`.dsh-mem/`、`.agents-fix/`、`.vercel-cli-data/`、`.pixai-refresh/` → 本地工具 HOME/快取，已 gitignore，勿讀。
- `marketing-battle-pack/` → 社群行銷素材包（prompts/posts/logs），非運行時代碼。
- `eval-daming-film/`、`deploy-staging/opencode.json` → 歷史評測/舊快照，**勿當真源**（live 真源在 VPS `/opt/agent-harness`）。
- `public/showcase/agent-templates/*.mp4/webp` → 展示用大檔素材，非邏輯。

**記憶標記「作廢/換血」≠ 真死**：08-28 中控手術後，`scheduler.ts` lease 門禁、`adobe-health.ts`、`supplier-channels.config.ts`、`tools/add-supplier-channel.ts`、`metaso-upstream.ts` 等**仍被 worker/adapter 引用，是活的**。砍任何檔前先 `grep -rn "檔名" src` 驗證 import，勿憑記憶刪除（記憶檔 control-plane-reblood-to-new-api 已自標「舊記憶作廢聲明」，但那是指機制語義，不是檔案可刪）。
