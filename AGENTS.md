# AGENTS.md - Image Studio（Emu）工作規則

## 任務定性優先（先於一切 skill/紀律選擇）

- 接到請求第一步定性：【能力建設】（動詞：避免/绕过/加法/造/集成/强化/让 X>Y——主線是新增能力）還是【修復】（動詞：修好/恢复/为什么坏了——保守紀律只對修復生效；凍結組件/禁重放/只准翻日誌嚴禁套到能力建設）。
- 用戶點名原材料時，第一動作是解剖原材料（讀它的文檔/源碼結構/模式清單），不是翻生產日誌；舊日誌最多是背景參考。
- 跑偏硬指標：花在「維護現狀」的呼叫數超過「新增能力」= 已跑偏，立即回主線。

## Time discipline（每次會話生效）

- 黃金時間：定改動 → 改碼 → 部署 → 寫 memory。會等的操作（部署/長驗證/外部呼叫）永遠放最後，不佔待命的先做。
- 禁自我 UI 檢查：美學歸暴君，dev server/Playwright/截圖驗外觀 = 垃圾時間，改完直接交。**例外（2026-09-26 暴君糾正）**：3D/WebGL/沉浸式渲染任務，或暴君明說「自主驗證迭代」時，tsc 綠 ≠ 畫面可用——必須截圖自驗、反覆迭代到驗收判準全達成再交。
- 禁自造輔助腳本/工具，除非暴君點名。
- 連續 3 次讀取/探測沒有產出修改 → 停下問暴君一句話；禁止猜尺寸/狀態/意圖。
- 研究 grep 優先，不通讀 >200 行大檔（除非任務需要整體理解）。
- **決策分界（2026-09-28 暴君糾正「不是产品决策不要问我」）**：ops／口徑／工程實作細節**自行拍板做到底**（例：某帳號算不算內部、要不要把改動搬到控面、用哪個欄位當判準、幫誰補名單）；只有**產品與審美**決策才回報待裁。與自身本輪操作相關的疑點（含疑似自己造成的不穩定）先自行取證排除，不轉給暴君當問題。
- 禁旁白（「我先讀…」「分析完成」），只輸出決策、證據、結果。
- 已完成的閉環不重跑驗證。
- Memory 紀律（2026-09-28 起＝memory pack 單一真源 `~/.claude/memory/`）：每完成可用工具/解決反覆問題/被糾正一次，當場 `mem add <slug> --type project|feedback|reference` → 填 `description` → `mem build`。**禁手改 `MEMORY.md`／`packs/*`／`catalog.tsv`**（生成物）；**禁整目錄讀 `notes/`**（915 篇），查詢用 `mem find <關鍵字>`／`mem pack <id>`／`mem show <檔名>`。舊路徑（`~/.codex/memories/extensions/ad_hoc/notes/`、`~/.zcode/cli/memories/projects/image-app-*/memory/`）已封為同一真源的 symlink，勿當第二庫。不寫 = 智力歸零。
- Harness 迭代閉環：暴君回報浪費時間/規則沒生效 → 當場先改對應規則再做事，每個回饋 = 一次壓縮。
- 按暴君 prompt 語言回覆；bash 語法（Arch Linux，2026-08-17 起；PowerShell/Windows 路徑是錯的）。

## 禁止造輪子（違反 = 立即返工）

- 「複用/複製/用現有的 X」= 逐行 cp 整份源碼再改白名單欄位，不是參考重寫。判定：diff 除白名單外逐行等價，做不到 = 沒交貨。
- subagent spec 必須寫明輪子源檔 + 白名單欄位（數據源/文案/接入點）；交互邏輯/物理參數/事件監聽/生命週期 hooks 一行不許動。
- 教訓（2026-08-25 模板旋轉木馬）：「精簡複製」砍掉 wheel `{passive:false}`、SPRING_TRACK、drive() → 觸控板沒反應，三輪返工。每精簡一處 = 埋一顆雷。
- 自造輪子前先問：生產上有沒有同功能實現？有 → 複製它。

## 對稱差／競品任務（違反 = 立即返工）

- **先讀對方原始碼實作，再設計我方（2026-09-28 暴君糾正「为什么你修对称差老是不看别人源代码实现？以为自己很厉害吗」）**：固化順序＝① 抓對方實作源碼（CLI 只是說明層，必須追到 `src/`）→② 逐檔讀（含 tests 與 service 實作）→③ 我方形態**照它**（能更好才更好，並寫明差異理由）→④ 才動我方代碼。**禁「先設計再找依據」**；spec 沒附對方實作檔案清單與關鍵引文 = orchestrator 失職，不許派發。
- **軸線由暴君點名**：他不點名就不自行選全產品面；報告與實作都以他點名的那一格為口徑（例：2026-09-28＝「影片提取」，即以 video 為輸入、從它取得結構化資訊的功能面）。
- 對方是本地工具鏈時：其 `LICENSE` 條件先讀完再談任何「拿來用」（例：hypit 明文禁 multi-tenant/SaaS，我方形態正好在禁止區 ⇒ 只學形態不抄碼）。

## Subagent 派遣（任何動手環節一律派發，**無「小改可內聯」的例外**——見下「禁內聯」）

- **模型鐵律（2026-09-27 暴君糾正「太浪費 token」）**：subagent 一律跑 DeepSeek，禁用 Claude Agent 工具派 Opus/Sonnet 子代理。orchestrator 只寫 spec，把 prompt 交給暴君或以 DeepSeek 通道執行。

- **禁內聯（2026-09-29 暴君糾正「还是用subagent吧 内联你很快就忘记自己要干嘛了」）**：orchestrator **一律不內聯動手**，包含「修 agent 交出的破口（補 import／補測試／小改一段邏輯）」。上游 API 打斷、agent 回空回報、agent 失敗——**都不是內聯的授權**，正確動作是**帶精確 spec 重派**（把已知的病徵、檔案:行號、期望差異當配方寫進 spec）。舊版「被 API 打斷 ≥2 次即可內聯」的例外**作廢**；只有暴君明說「內聯做」才可內聯。理由：orchestrator 一旦動手就從「知道全局的人」退化成「正在改這一行的工人」，主線目標會丟失。

- **並發槽鐵律（2026-09-06 暴君糾正）**：完工一路立刻驗收並補派一路，**常態保持 ≥3 路並發**；禁止等整批完工再派下一批——等最慢 subagent = 垃圾時間。收完工通知的當下動作順序：驗收 → 補派新片 → 再回報。
- orchestrator 只做：定位目標、寫 spec、派發、收結果、驗收。
- **上層決策/下層執行分離（2026-09-06 暴君糾正）**：orchestrator 禁止內聯執行動手環節（smoke/驗證跑批/寫碼/批量操作），全部派 subagent；orchestrator 上下文只裝決策、spec、驗收結論。驗收＝讀回報+抽查證據，不是自己重跑。
- spec 必含「必讀記憶」節（2026-09-02 暴君糾正「恶性引导」）：① `~/.claude/memory/MEMORY.md`（Tier-0 路由）＋該域 `packs/<id>.md` 路徑 ② 2-5 個與任務直接相關的 note 檔名＋一句話為何相關 ③ 指令「記憶與現場證據衝突時以現場為準並回報衝突」。沒有記憶節＝orchestrator 失職，等同 spec 沒配方，禁止派發。**記憶只有一個庫（`~/.claude/memory/notes/`），檔名一律用 `mem find <關鍵字>` 取真檔名寫進 spec，並 `mem show <檔名>` 驗在；舊的「兩庫不定庫會報幻影檔」問題已隨 symlink 封庫消失（2026-09-28）。**
- spec 帶配方不是目標：標準操作（new-api 渠道接入/env 變更/seed/rebuild/VPS 傳檔）的 copy-paste 命令直接貼進 spec（配方在 new-supplier-integration skill「new-api 渠道 5 分鐘配方」節），不許現場考古；spec 沒配方 = orchestrator 失職，不許派發。
- spec 開頭寫「預期 N 分鐘」，超 2x orchestrator 主動 TaskStop 後**重派（改 spec）**，不許內聯接管；主動巡檢，不被動等。
- subagent 同一錯誤重試 2 次未過 → 停止並回報事實（寫進 spec），禁止無限試錯。
- 「X 為基底」合併必須先雙向 diff（本地與 VPS 是並集，單向回灌沖掉另一邊修復）；舊記憶的基底聲明引用前先驗是否仍成立。
- 每次派遣事故的坑位當回合沉澱進 skill 配方節（信息差歸零）。

## Verification 鐵律

- 不故意跑預期失敗的測試；先實現再驗證；驗證意外失敗先診斷修因再重跑。
- 暴君接管視覺驗收時：Vercel READY + production alias 確認即停，視覺結果標 pending 用戶驗收。
- 不宣稱未驗證的成功；HTTP 200 ≠ 可用。
- **守門件不是 oracle（waoowaoo TG-02，2026-09-23 立）**：源碼字串斷言、檔案存在、調用次數、當前實現輸出**只算變更探針，不計入「已驗證」**；每個 REQ／能力必須另配一條真實行為斷言（真單／真輸出／真帳本），否則視為未驗。起因：對手曾因源碼掃描腳本未接 CI＋命令缺失時靜默通過而全面刪除該類腳本；我方驗收也曾大量依賴源碼層守門件。
- **禁同源斷言**：斷言「函數返回目錄裡的數」與目錄同源，無法反證單位語義錯；值域／枚舉 oracle 必須有獨立於被測實現的來源（真上游／真帳單／真用戶輸入）。
- Adobe2API 是目標時：先追直接請求與上游響應再動鑑權/路由，不動 relay；不從 HTTP 408 推斷 scope/token 問題（見 adobe2api-direct-debugging skill）。

## Authentication 紅線

- 禁 headless/自動化 Chromium 做 Adobe/Google 交互登入；遇「browser may not be secure」立即停，換用戶真實 Chrome，認證完成後再恢復自動化。
- 不重放含動態 state/device context 的舊 IMS 授權 URL。
- 生產不依賴開著的 Chrome 標籤；正常續期走 server-side auto_refresh token；保留最後一個可用的 renewable token 直到替代被接受。
- secret/憑證/token/OTP/私鑰永不入 log、memory、commit。

## 付費上游呼叫硬閘（2026-09-27 ¥31.29 事故後立，違反＝事故）

- 起因：暴君已明令「只用優惠渠道」，但 spec 未寫死單價與參數上限，代理持上游 key 出了一筆 **4k / 5s / ¥31.2857** 視頻（request `20260927135019…`）。**規則必須在下令那一刻就存在，不是事故後補。**
- **上游付費 key 一律不下發 subagent**：spec 只准寫「待暴君或 orchestrator 執行」。代理若已在 context 拿到 key，**只准打唯讀端點**（`GET /models`、`/api/pricing`、`/api/log/*`），任何生成型 POST 一律禁止。
- **任何上游生成提交必須同時滿足（缺一不許提交，逐字寫進 spec）**：
  ① **暴君逐次給定的 model 白名單是唯一真源，白名單外一律拒收**（2026-09-27 視頻白名單 7 條：`minimax-h3-933-2k-支持真人`、`minimax-h3-a`、`seedance-2.0-900-特惠`、`seedance-2.0-933-特惠`、`seedance-2.5-1010-特惠`、`seedance-2.5-900-特惠`、`grok-video-1.5`）；無白名單時才回退到通用上限（視頻 ≤¥1.0/單、圖片 ≤¥0.5/單）；
  ② 參數白名單：**`resolution ≤720p`、`seconds ≤5`**；禁 4K/2K、禁 `size` 帶 4k/2k、禁任何「满血／原生真人／max／2k／pro／hdr／4k」高價變體；
  ③ **提交前先讀站內定價頁或價目 API 核該 model 單價並寫進回報**；核不到價＝不許提交。
- **一次授權＝一次呼叫**：禁 `--retry`、禁用迴圈試探價、禁對同一 model 連續探針；同一 model 2 次失敗即停。
- **花暴君的錢一律先問（2026-09-27 暴君原話「错就错在你花我的钱压根不问」）**：任何付費呼叫（真單驗證、探針、掃價、全模型迴圈）事前逐次報備並取得同意，身分包含 orchestrator 自己；代理不得自行決定花錢，orchestrator 不得代為概括授權。報備須先講明：平台／model／單價／總額。
- 事故處置標配：**立即停損**（TaskStop 該代理）→ 唯讀取證定位（request id → 上游 log）→ 全量呼叫原文逐條對帳 → 才談恢復。

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
- 雙真相邊界（畫布 world1 ↔ 產線執行圖 world2；含節點 metadata 雙白名單三處、CanvasProject 新欄位七處清單、VPS 活本 vs repo 鏡像）：`docs/architecture/dual-truth-boundary.md`（W5，2026-09-29）

## repo 掃描地圖（2026-08-30，降低模型掃描成本）

**活程式碼（改動/讀取只進這些）**：`src/app/api/`（Next.js 路由）、`src/lib/`（generation-core 生圖/視頻/TTS 管線、supplier-channels registry、billing 等）、`src/components/`、`src/app/`（頁面）、`tools/`（seed/add-supplier-channel 等操作工具）、`bridge/`（pixai-bridge 等上游橋）、`deploy/gatus/`（探針配置）、`design-system/`（UI 權威）。

**可跳過目錄（垃圾/快取/快照，禁止花時間掃描）**：
- `.tmp-home/`、`.tsdeps/`、`.xdg-cache/`、`.vercel.bak-link/`、`.dsh-*`、`.gateway-work/`、`.vercel-home/`、`.vercel-cli-cache/`、`.tmp-vercel-cache/`、`.dsh-mem/`、`.agents-fix/`、`.vercel-cli-data/`、`.pixai-refresh/` → 本地工具 HOME/快取，已 gitignore，勿讀。
- `marketing-battle-pack/` → 社群行銷素材包（prompts/posts/logs），非運行時代碼。
- `eval-daming-film/`、`deploy-staging/opencode.json` → 歷史評測/舊快照，**勿當真源**（live 真源在 VPS `/opt/agent-harness`）。
- `public/showcase/agent-templates/*.mp4/webp` → 展示用大檔素材，非邏輯。

**記憶標記「作廢/換血」≠ 真死**：08-28 中控手術後，`scheduler.ts` lease 門禁、`adobe-health.ts`、`supplier-channels.config.ts`、`tools/add-supplier-channel.ts`、`metaso-upstream.ts` 等**仍被 worker/adapter 引用，是活的**。砍任何檔前先 `grep -rn "檔名" src` 驗證 import，勿憑記憶刪除（記憶檔 control-plane-reblood-to-new-api 已自標「舊記憶作廢聲明」，但那是指機制語義，不是檔案可刪）。
