# Eimu — eimu.dev

> 一站式 AI 影像／影片生成工作台，C 端 SaaS 與 B 端 API 轉售雙軌並行。
> 本專案為**私有專案（Proprietary, All Rights Reserved）**，README 記載的是我們與市面上所有同類產品之間的「對稱差」——只寫我們有、別人沒有的東西。

---

## 一、產品定位：我們到底是什麼

市場上「AI 生圖網站」有一百個，多數是同一套模板換皮：一個 prompt 輸入框、一個下拉選模型、一個生成鈕。我們不是。

Emu（eimu.dev）是一個**以「生產力」為設計目標的專業影像生成工作台**，同時服務兩種客戶：

| 客戶 | 入口 | 核心需求 |
|---|---|---|
| C 端創作者 | 網頁工作台（含無限畫布與 AI 助理） | 想得到 → 調得出 → 用得上（prompt 到成品的一條龍） |
| B 端平台／開發者 | OpenAI 相容 API | 穩定、可計費、可對帳、失敗可診斷的生成服務 |

別人賣「生成圖片」；我們賣「**把生成變成工作流**」。

---

## 二、前端／UI 對稱差

UI 細節不上 README——它們活在 `design-system/MASTER.md`（唯一權威：`lg-*` 類體系、色板、字級、間距、反模式）裡。整個產品——首頁案例環、專業工作台、無限畫布、AI 助理、管理後台——共用一套 iOS 26 啟發的 **Liquid Glass 液態玻璃**語言；行動端保持「單面工作台」，生成等待狀態是 canvas 粒子海而非轉圈。只留三個跨 UI 的產品事實：

- **案例環即對稱差**：首頁 3D 環上每個案例都是 `showcase-cases.ts` 的真實生成結果（附 prompt、風格、生成後記），點卡直接注入工作台復刻；磁吸數學是純函式（`carousel-detent.ts`）、固定點性質被測試鎖死
- **模型名去廠商化**：`stripVendorPrefix`——用戶選的是「這個模型適不適合我的活」，不是「我在跟哪家公司打交道」
- **鍵盤優先**：`workstation-commands.ts` 13+ 條可發現指令——專業工作台的滑鼠不是必要條件

### 2.1 Prompt 增強器與創作者資源庫

- 六種風格預設（realistic / anime / street / product / poster / watercolor），自動追加品質後綴——小白寫短 prompt 也出好圖
- **創作者資源庫**：每個資源帶 `sourceName / sourceUrl / sourceCommit` 的完整來源追溯，不是抄來的 prompt 大雜燴
- 場景模板（`scenario-templates`）＋風格庫（`style-library`）
- **Invisible Prompt Director**（`invisible-prompt-director.ts`）：規則層影片提示詞導演——偵測六槽公式（Camera + Subject + Action + Setting + Style + Lighting）缺漏並補齊、替換 anti-slop 空形容詞、把負面句改成正向聲明、執行引擎規則（age-blind、≤3 tracked characters）、附加品質鎖。全程後端發生，用戶無感

### 2.2 Workflow Recall：工作流記憶

`workflow-recall.ts`：prompt、負向 prompt、尺寸、風格模板、參考圖角色、區域 prompt 的完整工作流狀態，一鍵復原。**換個活，不重頭搭。**

配套還有 **Workflow PNG**（`workflow-png.ts`）：把工作流配置以 trailing-data 格式（JSON payload + 8-byte `WFSTUDIO` magic + version + 長度）嵌入 PNG 檔尾——提取只需讀最後 13 個位元組，magic + PNG 簽名 + JSON 合法性三重校驗擋壞檔誤判，零依賴。**圖片本身就是工作流的載體。**

### 2.3 無限畫布工作站：生成閉環的畫布協作

`src/components/canvas` + `src/lib/canvas` + `/api/canvas/*` 構成的無限畫布，定位是「生成工作流的組織層」，不是畫圖軟體：

- **DAG 分層自動排版**（`canvas/reducer.ts`）：節點按最長上游路徑分層、barycenter 兩趟掃描最小化連線交叉、層內縱向堆疊垂直置中——連線永遠短距離左進右出。手動拖過的節點（`moved`）不重排，但仍佔排序位，鄰居的邊不亂
- **語義連線**（`semantic-nodes.ts`）：prompt 節點與 reference 節點沿「入邊」收集，手動 UI 與 agent `run_generation` 共用同一個 `resolveGenerationInputs`——兩條路徑的接線語義完全一致，不建第二套
- **非破壞性像素編輯**（`canvas/image-edit.ts`）：裁剪／切图／抠除／旋轉的純數學層可被 node:test 直測；編輯結果一律作為**新子節點**落回畫布，原節點不動。「角度」模式不產出像素，只組裝生圖指令交由宿主 AI 重繪
- **雲端持久化**：畫布專案（`project-store`，每用戶上限 50 個）與素材庫（`asset-store`，上限 500 個）走 Blob 世代寫入模式，單用戶寫入串行
- **提示詞庫聚合**（`/api/canvas/prompts`）：並行抓多個遠端 prompt 源、每源 8s timeout、失敗跳過、模組級快取 1 小時 stale-while-revalidate
- **同源圖片代理**（`/api/canvas/image-proxy`）：只為把公網圖片變同源（供像素編輯讀入 `<canvas>`），只服務登入用戶、只認 https 公網主機、拒絕 IP 字面量與 localhost——不提供內網探測面
- **AI 筆 = Workflow DSL**（`workflow-dsl/`）：agent 對畫布的多步編排寫整份宣告式 DSL，站點純編譯器全圖校驗（教學式報錯：缺漏給提示、相近 id 給建議）後原子套用上畫布；圖是唯一運行時真相，DSL 只是筆，round-trip 冪等。同款編譯器開放為 B 端 `/v1/workflow/compile`
- **scene_3d 場景卡**：3D 導演 subagent 回傳的結構化節點（turntable / stills / blend / glb / 場景摘要 / 時長六欄合同），前端雙白名單（`toNodeMetadata` 收斂器 + `compactMetadataForAgent` 透傳）合同測試釘死

### 2.4 AI 助理：對話驅動的許願工作流

`src/components/agent-chat` + `src/lib/agent-*` 構成的許願 Agent 面板，交互原則是「確認卡先行、批量願望、自癒透明化」：

- **沒有獨立頁**：`/agent` 路由只負責把舊書簽重定向回首頁；AI 助理是首頁卡片上的一個 toggle（與「改圖」「放大」同層級），按下去只換卡片中間的控件區
- **確認卡（`AgentConfirmCard`）**：工具調用先出確認卡，用戶批准才執行——agent 花的是用戶的錢，用戶要有否決權
- **批量錨定（`agent-batch-anchor`）**：第一張滿意後顯式錨定，把第一張**實際用過的參數原樣念回給 agent 照抄**，整批不漂移。只引用事件流裡真實出現過的參數；湊不出可複現參數時寧可不給錨定按鈕——一顆按下去不保證同風格的按鈕，比沒有按鈕更糟
- **參數卡（`agent-tool-params`）**：常用層（模型/尺寸/張數/花費）默認展開、進階層（LoRA/權重/sampler/steps/seed）默認收起；參數唯一來源是 `tool.invoke` 的 `args_summary`，被截斷就退化顯示原文，**絕不把半截 JSON 編成看起來完整的參數表**
- **自主後期全包**：8 個 `timeline_*` 工具（查詢／剪輯操作／節奏／風格／混音／母帶／lint／回滾）——素材到成片的剪接鏈 agent 自己跑；**成片硬閘門**：未過交付驗收的片子不出卡、不結帳（確認卡金額與工作流報價逐級比對）
- **模板工作流**：`workflow_start` 從模板鋪出頭卡/工具卡/門禁卡/生成卡的多鏡頭工作流；斷點續跑、跨渠道 failover、伺服器重啟後 workflow 喚醒掃描——**中斷的 turn 是工程問題，不是用戶的損失**
- **賬戶記憶**：`/api/agent/profile`（用戶確認過的「我是誰、怎麼合作」）與 `/api/agent/profile/lessons`（回合收官後靜默提煉的教訓，只提議、用戶確認後才注入）分開存儲；resume 老會話時走 `/memory` 補針
- **額度與附件**：`/api/agent/quota` 查額度（閘道權威、無本地副本）、`/attachments` multipart 原樣透傳（不重組 boundary）
- **Prompt 優化**：`/api/agent/optimize-prompt`——Agent 層（deepseek）優先，失敗 fallback 規則層（invisible-prompt-director），再失敗返回原 prompt，全程服務端、免登入免金鑰

### 2.5 PWA：可安裝的工作台

`manifest.ts`（standalone、主題色、雙尺寸圖標）+ `PwaInstaller`（HTTPS 下靜默註冊 `/sw.js`，註冊失敗靜默忽略、不阻塞任何功能）。

### 2.6 歷史與導出

歷史頁（`src/components/history`）支援篩選、統計、Lightbox；導出三格式（`history-export.ts`）：ZIP（圖片＋清單，`export-zip.ts` 做檔名清洗擋目錄穿越）、JSON（完整檔案）、CSV（表格）。取不到的圖跳過並計數，**不讓整個導出失敗**。

---

## 三、商業邏輯／產品邏輯對稱差

### 3.1 雙軌商業模型（同一套生成核心，兩個收費入口）

| 軌道 | 使用者 | 計費主體 | 入口 |
|---|---|---|---|
| C 端 | 註冊用戶 | 用戶帳號＋餘額 | 網頁工作台 |
| B 端 | 平台／開發者 | **API 金鑰本身**（`sk-biz-`） | `/api/v1` |

B 端金鑰的設計要點：外部平台只會透傳 `Authorization: Bearer sk-...`，**不會帶我們內部的 `x-user-id`**——所以金鑰本身必須是獨立的計費主體，而不是某個用戶的附屬品。計費帳本仍然記在上游（New API），每個 B 端金鑰綁定獨立使用者 id（`tools/provision-biz-account.ts` 簽發專用計費賬戶），**不自建第二套額度系統**——重造計費只會讓「同一個信用額度」在兩處互相打架。

### 3.2 分層價目（tier-pricing）：代理分銷的拿貨價體系

`tier-pricing.ts`：按金鑰/租戶掛 tier（internal / reseller / enterprise），每個 tier 對「model × resolution」覆寫**絕對幣價**——高於基準是加成、低於基準是拿貨價，一個數字同時涵蓋兩種語意。優先順序：tier 覆寫 → 基準價（generation coins 經全局 pricing-overrides 後的 effective 價）；C 端不吃這一層。清洗規則複用 generation-model-catalog 的口徑，避免兩套定價規則漂移。

### 3.3 統一幣制：generation coins

`generation-model-catalog`（已重構為 types / catalog / pricing-overrides / capabilities / pricing / resolution 六模組，原路徑保留為純 re-export barrel）：每個模型 × 解析度 × 生成種類，映射單一「代幣」計價。套餐、餘額、SLO 單位成本、金鑰額度、PixAI 改圖/放大/模板全部跑在同一套幣制上——**跨模型可比較、可對帳**。

### 3.4 C 端成長閉環

- **三軌登入**：GitHub OAuth（`/api/auth/github/*`）；微信掃碼（`/api/auth/wechat/*`——每次請求觸發動態 QR 建立新 bot 實體、poll 輪詢、公眾號消息簽名校驗、詞庫自動鑄造用戶名）；Emu OAuth 回環授權（`/api/auth/emu-oauth/*`——DSH 插件 loopback server 走 GitHub OAuth 後換 60 秒過期的無狀態 HMAC code，再 exchange 換自動簽發的 B 端密鑰，全程無需複製粘貼任何密鑰）
- 每日簽到（`CheckinCalendar`，`checkin-copy` 文案系統化，隨機 1～3 枚額度幣）
- 充值：套餐（夢芽/夢影/夢虹，`plans.ts`）走 Mapay 支付（alipay / wxpay / qqpay，`/api/payments/mapay/*`：checkout / notify 驗簽 / return / 測試回調）＋兌換碼 topup
- 聯盟行銷（`/api/user/aff`）、用量查詢、歷史統計
- **內容增長面**：17 個行業 base use-case（`src/lib/use-cases/`）＋ Reddit 挖掘的真實需求 use-case（`reddit-use-cases*` 五個維度檔）、長尾 FAQ（`long-tail-faq.ts`）、文檔中心（`/docs`：OpenAPI 渲染的 API 文檔、MCP 接入指南、DeepSeek Harness 零基礎教程）、狀態頁（`/status`，Gatus 端點健康）——SEO 與信任資產都是程式碼維護的，不是一次性運營物料

### 3.5 對外 API 契約（B 端）

OpenAI 相容端面（`/api/v1/*`），全部走 biz key 鑑權、限流頭、trace_id、OpenAI 風格錯誤體：

- **圖像**：`/v1/images/generations`（非同步 202 task）、`/v1/images/{id}`（狀態輪詢，不消耗限流）、`/v1/images/{id}/result`（取結果）、`/v1/images/edits`（改圖，定價走 generationCoins(pixai-edit)）
- **影片**：`/v1/videos/generations`、`/v1/videos/{id}`、`/v1/videos/{id}/result`
- **語音**：`/v1/tts/generations`、`/v1/tts/{id}`（tts-1）
- **批量與對帳**：`/v1/batches`（圖片/視頻混合批量，202）、`/v1/batches/{id}`（聚合視圖）、`/v1/batches/{id}/reconciliation`（對賬導出，含失敗分解）——批內 item 各自冪等（`batchItemIdempotencyKey`），聚合數學只有一份（`computeBatchAggregate`）
- **SKU 下單**：`/v1/skus`（公開營銷 SKU 目錄，輸入 schema/鏡頭結構/輸出規格/計價模式全部可編程消費）、`/v1/skus/{id}/runs`（輸入 → 鏡頭計劃展開 → 逐鏡頭提交，支持表格批量）、`/v1/skus/runs/{id}`（run 聚合進度，**無狀態**：run_id 就是冪等鍵根，不落新表）
- **工具端點**：`/v1/uploads`（上傳參考圖換 mediaId）、`/v1/upscale`（高清放大）、`/v1/templates` + `/v1/template-generations`（PixAI 場景模板）
- **觀測端點**：`/v1/models`、`/v1/model-status`（每個生成模型的可用性 + 能力 + 功能標註；探測只發 GET {baseURL}/models，不觸發真實生成不扣費，結果快取 60 秒；不支持 /models 的渠道回報 unknown + note 而不是假裝探測失敗）、`/v1/queue`（租戶活躍任務）、`/v1/history`（歷史分頁）、`/v1/system_stats`（平台統計）、`/v1/object_info`（能力描述，ComfyUI 風格）、`/v1/openapi.json`（OpenAPI 3.1 spec，**從代碼派生不手寫漂移**）
- **冪等**：`Idempotency-Key`，重複提交直接回同一個 job（衝突時 `IdempotencyConflictError` 拒絕，而不是默默覆寫）
- **視頻 DSL**：`/v1/workflow/compile`（畫布工作流 DSL 的純編譯端點，422 帶教學式校驗報告）
- **穩定錯誤碼分類學**（`api-error-codes.ts`）：外部客戶會程式化解析 `error.code`，所以對外碼一旦發佈永不改變語義；內部分類（FailureClass、HTTP 狀態、供應商錯誤字串）自由演進——內部可以拆得更細，外部只看到承諾過的碼
- 多個客戶端不可區分的內部失敗（如 malformed_output / empty_result / artifact_download）**刻意收斂成同一個碼**，不逼客戶去分支處理只有我們運維才需要知道的區別
- 請求追蹤：`X-Request-Id`（客戶自帶的 id 若通過白名單格式則原樣回顯，失敗時有東西可以報給客服）

### 3.6 Emu OAuth：把「API 金鑰發放」做成一次點擊

B 端密鑰的發放通常是「註冊 → 進後台 → 複製密鑰 → 粘貼到客戶端」。我們的 Emu OAuth（`emu-oauth.ts`）把這條路壓縮成 GitHub 一次授權：插件本地 loopback server → 站點簽發 60 秒過期的無狀態 HMAC code → exchange 換自動簽發的 B 端密鑰並直接寫入客戶端憑據。憑證不寫庫、驗證只需重算 HMAC——沒有可以被重放的長期 token，也沒有會話存儲。

---

## 四、技術架構對稱差：生成控制平面（generation-core）

這是整個系統最「不該存在於一個生圖網站」的部分——我們把它做成了一個**資料庫為核心的分散式任務控制平面**。

### 4.1 DB-backed 供應商租約排程（不是記憶體 Map）

- `supplier_lease` 表＋`FOR UPDATE SKIP LOCKED`：多 worker、多 serverless 實例併發搶單不衝突
- 租約過期自動清理、租約到期自動釋放
- 候選過濾支援 `excludedSupplierIds`、**`excludedFailureDomains`**（失敗域隔離：某供應商連續失敗，不只它自己、整個失敗域都被暫時排除）
- 能力表（`supplier_capability`）：供應商 × 模型 × 並發上限 × 健康狀態 × 契約版本，**在資料庫裡可查、可管理**
- 門禁式健康探測（`adobe-health.ts`）：供應商帳號要被選中，必須同時滿足 token 來源（auto_refresh）、刷新狀態（healthy）、憑證未過期、近期觀測、成功率門檻——**不健康的供應商根本進不了候選**，而不是進了候選再失敗

### 4.2 失敗分類器：不是 try/catch

`failure-classifier.ts` 把每個供應商錯誤分類成結構化決策：

```
retryable / switchSupplier / quarantineSupplier / cooldownUntil
```

- 429 → 尊重 `Retry-After` 退避
- 特定供應商錯誤 → 切供應商
- 連續系統性錯誤 → **隔離（quarantine）＋冷卻計時**，而不是無腦重試打到死

### 4.3 Canary：誠實的金絲雀

`canary-service.ts` 的原則寫在註解第一行：**不模擬任何成功**。

- 對每一個當前可販售的（模型 × 種類 × 比例 × 解析度）組合，建立**真實的 `generation_job` 行**（來源標記 `canary`），走與真實流量完全相同的 job-repository 入口
- 事後評估實際結局：可驗證解碼的影像 = 成功；被卡住沒人撿 = `stale_no_pickup`（誠實報告，不當成功）
- 一旦真實 worker 上線，同一批 canary job 自動變成全鏈路金絲雀——**零改動升級**（`tools/run-canary.ts` 提供 CLI）

### 4.4 計費：預檢閘門 + 三階段帳本 + 異步投影

- **零額快車道預檢**（`quota-precheck.ts`）：提交時只讀上游餘額（無狀態無鎖）——通過則走 0 額 reserve 直進隊列，不足立即 402，映射缺失 fail-closed 503，上游不可達自動回落原 reserve 路徑。**用戶在排隊前就知道錢夠不夠**
- `billing-ledger.ts`：`reserve → commit → refund`——執行前預扣、成功提交、失敗退回；殭屍帳（進程死在半路）到期自愈回收；與外部帳本（New API / image-billing）雙向 reconcile——**兩個系統打架時，帳本層知道誰是對的**
- **異步投影記賬**（`billing-projection.ts`）：worker 維護循環每 30s 對閘門快車道的終態 job 確定性重算定價、冪等扣減（`idempotency_ref` claim pending→applied 防雙扣）——記帳不佔生成關鍵路徑
- **job_events 賬本三鐵律**：append-only 只 INSERT；寫狀態必寫事件、上游錯誤原文入庫不改寫；話術只存在於展示層。配套 probe 端點（`/api/probe/jobs/{id}/timeline`、`/api/probe/stuck`）——排障從一小時考古變一條命令

### 4.5 Callback Outbox：可靠交付

`callback-outbox.ts`：B 端 `callback_url` 交付走**交易式 outbox 模式**：

- 交付狀態機：pending → delivering → delivered → dead_letter
- payload 存 hash＋HMAC 簽名（金鑰帶版本號，可輪換）
- 帶租約的重試（`leaseOwner / leaseExpiresAt`），失敗次數達標進死信隊列，而不是無限重試

### 4.6 SLO 查詢層

`/admin` 的 SLO 以 (tenant, model) 維度呈現：成功率（succeeded / succeeded+failed，**不含排隊中的**，不灌水）、p50/p95 延遲、單位成本觀察值——計費單價有沒有貼著實際成本走，數字說話。

### 4.7 Prompt 靜置加密

`crypto.ts`：prompt 以 **AES-256-GCM**（12-byte IV + auth tag）加密後落庫，金鑰強制 32-byte（64 hex 或 Base64）。資料庫被拖走，生成內容的隱私邊界還在。

### 4.8 雙形態 worker：長駐容器與 serverless cron 同構

`worker-service.ts` 是唯一的工作循環實現，兩種形態消費同一份：

- **VPS 長駐容器**（`worker/generation-worker.ts`）：`unhandledRejection` 只記錄不退出（浮動 promise 的 rejection 不殺進程）；容器重啟時在飛任務由租約過期回收，`deadline_exceeded` 自動退款
- **Vercel cron**（`/api/cron/generation-worker`）：每分鐘 `runGenerationWorkerOnce()`——沒有長駐基礎設施也能讓控制面轉起來

### 4.9 批量與 SKU：一份聚合數學，三個消費者

`batch-service.ts` 的 `computeBatchAggregate` 同時服務 `/v1/batches/{id}`（批聚合視圖）、`/v1/batches/{id}/reconciliation`（對賬 + 失敗分解）、`/v1/skus/runs/{id}`（SKU run 聚合）——同一份數學，不抄第二份。SKU run 不落新表：run_id 就是冪等鍵根，鏡頭任務以 `skurun:<run_id>:<index>` 冪等鍵落在既有 `generation_job` 上，提交全部走 `submitGenerationCommand`——**不自建第二套提交/計費/調度**。

### 4.10 3D 導演工作站：Blender 是生成管線的一等公民

Astra——對話驅動的 3D previz→渲染管線。**Blender headless 不是外掛腳本，而是註冊進供應商租約排程的一條供應商渠道**（`blender-local`，adapter `blender_bridge`），渲染模型 `blender-render-eevee / blender-render-cycles` 進入統一模型目錄吃同一套幣制與失敗語義：

- **橋**（`bridge/blender-bridge/`）：Blender 5.2.1 + blender-mcp addon 整份複製改造成 HTTP 橋（`/v1/health` + `/v1/execute`，FIFO 佇列、超時雙層、失敗自愈）；本機 RTX 5070 EGL headless 實證 gpu=egl；netns 內 unix socket 轉發器做網路隔離
- **工具**：`blender_exec / blender_render / blender_export_gltf` 三工具 + 17 個 `director_*` 工具（機位/運動 keyframe、shot 計劃、提案流）——agent 用 L1 機位/運動語言描述鏡頭，bpy 腳本由配方庫（`skills/blender-director/`）落地
- **委託單**（`blender-delegate.ts`）：內容指紋冪等——同樣的渲染意圖不重複花錢
- **渲染節點**：本地橋之外，Modal（serverless GPU，bpy 5.2.1 同版本 wheel、單幀獨立容器）作雲端節點接入同一註冊表——`supplier-channels.config.ts` 一份十字段真源，四接入點（env 描述符/播種/scheduler 過濾/adapter 分派）
- **嵌合**：sceneCard 灰盒渲染幀可作為 Seedance 視頻生成的構圖參考卡；L1 機位軌跡反向映射進六槽提示詞公式的 Camera 槽——**3D 不替換視頻生成，是給它上導演軌道**

### 4.11 運維 CLI（tools/）

控制面的部署與運維有專用工具鏈：`control-plane-bootstrap.ts`（遷移 → 播種 → 進 worker 循環的開機自舉——「一條部署時沒人跑的命令」導致的能用/不能用分裂，用自舉根治）、`seed-generation-suppliers.ts`（供應商能力播種）、`migrate-generation-db.ts`（DB 遷移）、`issue-biz-key.ts`（無需管理員密碼的密鑰簽發）、`provision-biz-account.ts`（上游專用計費賬戶開戶）、`agent-debug.ts`（不開瀏覽器對生產 agent 網關跑真實對話、錄完整 SSE 事件流、用生產同一份 reducer 回放）。

---

## 五、路由架構對稱差：一套事實來源

`channel-registry.ts` 的存在本身就說明問題：**「到底有幾個渠道」這回事，全系統只有這裡說了算。**

之前（以及大多數同類系統）是：`generate-images` 路由一份邏輯、biz pipeline 一套邏輯、admin 的 image-upstream-probe 又直接調 `buildGatewayEndpoints`、account-pools 診斷再寫一份——同一個事實散落在四處，等於沒有事實。

現在：

- **統一註冊表**：env 渠道、帳號池渠道、biz 管道、admin 探測、Blender 渲染節點，全部消費同一個 `channel-registry` 的輸出——`generate-images` 的隊列、熔斷、冷卻全部從這裡 import，路由測試把這個 import 釘死
- **供應商譜系**：Adobe2API（web-session 直連）、Sub2API、PixAI 帳號池、New API 中轉（openai_images / openai_video / metaso / blender_bridge 四種 adapter 語義）——不同協議、不同認證、不同失敗語義，統一成同一份 endpoint 描述
- **帳號池（admin-pools）**：每個帳號有健康狀態、並發上限、in-flight 租約；`active && schedulable` 才進候選
- **Channel overrides**：渠道級覆寫優先級可調（`channel-overrides`）
- **內部端面**（`/api/internal/*`）：biz-keys、callback-worker、generation-billing、proxy-pool——serverless 對 serverless 的內部收口，不暴露給外部路由

---

## 六、網安技術對稱差

| 層面 | 做法 |
|---|---|
| Admin 認證 | scrypt（N=16384, r=8, p=1）+ 隨機鹽 + `timingSafeEqual`；session cookie 為 `httpOnly + sameSite=strict + secure`，12 小時過期 |
| B 端金鑰 | 隨機 32 bytes、`sk-biz-` 前綴與 C 端 token 明確隔離；**資料庫只存 sha256**——Blob/DB 洩漏也換不回金鑰原文 |
| 金鑰比對 | `timingSafeEqual` 常時比較，杜絕時序側信道 |
| 分散式限流 | 配了 Postgres 就自動升級為**跨 serverless 實例的分散式限流**（`consumeDistributedRateLimit`）；沒配 DB 則退化本地視窗——同一份呼叫語義，兩種部署都正確 |
| 追蹤 id | `X-Request-Id` 只接受 `[A-Za-z0-9._-]{8,128}` 白名單格式，**攻擊者無法把任意 header 內容注入日誌／回應** |
| 憑證管理 | 供應商憑證全部經 `credentialRef` 從環境變數動態讀取，**原始碼與 repo 內零憑證** |
| 密碼學資產 | prompt 加密 AES-256-GCM；callback 簽名 HMAC＋金鑰版本；Emu OAuth 回環授權用 60 秒無狀態 HMAC code（不寫庫、不可重放） |
| Agent 代理層 | 站點代理不透傳用戶 token 給網關——`resolveAgentCaller` 驗完人之後**換發服務端持有的 B 端 key**（方向與通用 proxy 相反，複用通用 proxy 等於讓任意 key 白嫖上游額度）；SSE ticket 回應欄位白名單化，長時效金鑰絕不出現在任何回應裡 |
| 圖片代理 SSRF | `/api/canvas/image-proxy` 拒絕 IP 字面量與 localhost/*.local/*.internal，只認 https 公網主機、只回 image/*、上限 25MB |
| 微信回調 | `verifyWechatSignature` 驗簽 + 公眾號 token 校驗，不信任未簽名消息 |
| 管理後台誠實性 | `/admin` 顯示的帳號狀態、路由事件、失敗原因與生產實際同源（routing-telemetry 每筆生成請求寫一條事件）；有 `routing-honesty` 測試鎖住「admin 不撒謊」這個不變量 |

### 6.1 Telemetry 的兩個鐵律

`routing-telemetry.ts` 明文規定，這是它的設計契約：

1. **絕不因疏漏而撒謊**（事件可以晚到，不可以不寫）
2. **絕不擋路**（telemetry 失敗絕不阻斷生成——可觀測性是屬性，不是依賴）

---

## 七、測試紀律：誠實性的工程化

184 個測試檔（`src/**/*.test.ts`，node:test），測試的不是「函式跑得動」，而是**不變量**：

- `routing-honesty.test`：admin 顯示 = 生產實際路由
- `carousel-detent.test`：磁吸固定點、落點決策、flick 上限
- `billing-ledger.test` / `billing-relay.test` / `batch-service.test`：reserve/commit/refund 三態、對帳與批聚合
- `crypto.test`：AES-256-GCM 加解密往返
- `canary` / `slo-service` / `adobe-health` 測試：成功率統計語義與供應商健康解析
- `api-error-codes.test`：對外錯誤碼的穩定性（發佈過的碼不准消失）
- `status-contract.test`：B 端狀態端點的契約
- `canvas`（reducer / layout / semantic-nodes / project-store）：畫布排版與連線語義
- `workflow-dsl`：DSL 編譯 round-trip 冪等、教學式報錯、patch 白名單
- `blender-e2e` / `director-wheel`：3D 工具鏈契約
- `agent-batch-anchor` / `agent-param-reflect` / `agent-tool-params` / `agent-chat-reducer`：agent 交互的誠實不變量（參數只引用事件流真實出現過的值）
- `workflow-png.test`：嵌入/提取往返與壞檔防禦
- `workstation-mobile-stage` / `admin-ui` / `ui-copy`：UI 的品質與文案不變量

**「不模擬成功」是整個程式庫的測試哲學**：canary 不造假成功、SLO 不算排隊中、admin 不隱瞞失敗、參數卡不把半截 JSON 編成完整表格——誠實是可以用測試鎖死的。

---

## 八、部署拓撲

```
┌─────────────────────────────┐       ┌─────────────────────────────────────┐
│  Vercel（邊緣，sfo1）        │       │  VPS（43.172.85.76）                 │
│  Next.js App Router         │       │  nginx（store.tinchak0207.xyz）      │
│  /api/v1 · /api/generate-*  │◄─────►│   /agent/ → agent-gateway（systemd   │
│  /api/agent/*（代理層）      │ HTTPS │             :8081，許願 Agent 網關） │
│  /api/cron/generation-worker│       │   /gatus-api（狀態頁數據源）          │
│  /admin（控制平面 UI）       │       │  Docker Compose（控制面）             │
│  DB: Postgres（Supabase）    │       │   generation-worker · adobe2api:6001 │
│  Blob: 雙後端可切換           │       │   image-control-postgres              │
└─────────────────────────────┘       │  PixAI 帳號池 daemon · 微信 QR worker │
                                      │  （:8780，動態 QR 建 bot 實體）        │
                                      └─────────────────────────────────────┘
```

- **Vercel**：前端、對外 API、agent 代理層、管理後台、控制平面（無狀態、靠 DB 租約協調；cron 每分鐘 tick 一次 worker 循環）
- **VPS**：需要長駐行程或帶狀態的上游適配——Adobe2API 會話（容器內 /api/v1/health 健康端點）、PixAI 池、控制面 Docker（Postgres + generation-worker + nginx 反代生產 API 路徑）、agent-harness 網關（systemd，session 存內存 Map——重啟即回收，站點 DELETE 對 not_found 冪等化）、微信掃碼 worker
- **渲染節點**：Blender 橋跑在本地 GPU 工作站（RTX 5070 EGL headless），經 ssh 反向隧道以 `blender-local` 渠道註冊進控制面；Modal serverless GPU（bpy 5.2.1 同版本 wheel、單幀獨立容器）作雲端渲染節點——3D 渲染與其他供應商共享同一套租約調度
- **域名分工**：agent 網關只掛在 store 域名的 `/agent/` 路徑下（image 域名同路徑是 404）；B 端生成端點走 image 域名——代理層封裝（`agent-gateway.ts`）用 `AGENT_GATEWAY_*` 前綴與計費網關的 `GATEWAY_*` 環境變數嚴格區分，兩個「閘道」在 config 裡不互相污染
- **Blob 雙後端**（`blob-backend.ts`）：配了 `IMAGE_DATA_BASE_URL` 就全量走 VPS `image-data-api`（postgres kv_store + 靜態檔），否則 Vercel Blob——對呼叫方是同一組 `list/get/put/del` 簽名，切換是一個 env 決策，擺脫 Hobby 額度/停用依賴
- **Postgres**：`generation_job`、`supplier_lease`、`billing`、`callback_delivery`、`lora_user_state`——所有分散式正確性都建立在資料庫事務上，而不是 serverless 實例的記憶體

---

## 九、支援的模型譜系（2026-09 現況）

目錄（`generation-model-catalog/catalog.ts`）共 **54 個條目**，image / video / audio 三類：

**影像**：GPT Image（2 / 1.5 / 初代）、Nano Banana 系列（Nano Banana = Gemini 2.5 Flash Image、Nano Banana Pro = Gemini 3 Image、Nano Banana 2 = Gemini 3.1 Flash Image）、Dreamina 系列（Image 5 Pro / Image 5 Lite、Seedream 2.0、Seedream 5.0 Pro / Lite）、Adobe Firefly Image 5、Flux（1.1 Pro / 1.1 Pro Ultra、2 / 2 Pro、Kontext Pro / Max）、Runway Gen-4 Image、PixAI 日系系（Tsubaki.2 / Tsubaki v1.1 / Haruka v2 / Hoshino v2 / Reference Pro）、Blender 渲染（EEVEE / Cycles——3D 場景走同一套模型目錄）

**影像工具型條目**：智能擴圖（Adobe Fill）、改圖（Image Edit）、圖像放大（2x Upscale）、模板生成（Template）

**影片**：Veo 3.1（＋Fast）、Kling（2.5 Turbo / 3.0 / 3.0 Omni）、Seedance 2.0（＋Fast / Mini）、Seedance 2.5（480p / 720p / 30s）、Runway Gen-4 / 4.5、Adobe Firefly Video、MiniMax H3、Luma Ray 系列（2 / 2 Flash / 3 / 3 HDR / 3.14 / 3.14 HDR）、Avatar 1（數字人）、Lipsync 1（對口型）

**語音**：TTS 1

> 模型本身不是對稱差——**讓 54 個模型透過同一套計費、同一套失敗語義、同一套 SLO 可靠地賣出去**，才是。

---

## 十、我們刻意不做的事

- ❌ 不做「分享牆」社交功能——生成是生產行為，不是打卡
- ❌ 不重造 Photoshop 式全功能編輯器——畫布的像素編輯只做生成閉環所需（非破壞性裁剪／切分／摳圖／旋轉，結果作為新子節點落回），不做圖層、蒙版、筆刷體系；複雜修圖交給宿主 AI 重繪
- ❌ 不自建第二套計費系統——上游帳本可信，就複用它；SKU run 不落新表、批量聚合只有一份數學
- ❌ 不讓 admin 顯示與生產分家——誠實比美觀重要
- ❌ 不給用戶「看起來能保證、實際不能保證」的控件——湊不出可複現參數就不給錨定按鈕，解析不了截斷的參數就顯示原文

---

*Proprietary. All rights reserved. Eimu — eimu.dev.*
