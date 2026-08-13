# Image Studio — image.tinchak0207.xyz

> 一站式 AI 影像／影片生成工作台，C 端 SaaS 與 B 端 API 轉售雙軌並行。
> 本專案為**私有專案（Proprietary, All Rights Reserved）**，README 記載的是我們與市面上所有同類產品之間的「對稱差」——只寫我們有、別人沒有的東西。

---

## 一、產品定位：我們到底是什麼

市場上「AI 生圖網站」有一百個，多數是同一套模板換皮：一個 prompt 輸入框、一個下拉選模型、一個生成鈕。我們不是。

Image Studio 是一個**以「生產力」為設計目標的專業影像生成工作台**，同時服務兩種客戶：

| 客戶 | 入口 | 核心需求 |
|---|---|---|
| C 端創作者 | 網頁工作台 | 想得到 → 調得出 → 用得上（prompt 到成品的一條龍） |
| B 端平台／開發者 | OpenAI 相容 API | 穩定、可計費、可對帳、失敗可診斷的生成服務 |

別人賣「生成圖片」；我們賣「**把生成變成工作流**」。

---

## 二、前端／UI 對稱差

### 2.1 CaseShowcase：3D 環形案例輪播（首創級）

首頁的招牌。不是卡片橫向滑動，而是一圈**空間縱深拱起的 3D 環**，每一張案例卡以真實的圓週分佈懸浮在軌道上：

- **TILT = 0.82**：卡片傾角嚴格貼合圓週切線，而非固定角度——側邊卡會傾到幾乎只剩邊線，製造真實的 coverflow 空間感
- **TILT_MAX = 80°**：任何卡片最多傾斜 80°，卡在環上永遠不會出現「翻面」破綻
- **DEPTH = 0.78**：z 位移用軟化曲線，純數學 `R·cos(θ)` 會讓背側縮太小，軟化後整個環保有可讀性
- **LIFT = 26px**：越遠的卡越往上抬，環拱起來、而不是平躺的圓
- **SWEEP_WIDE = 360°**：一次可橫滑的總轉角，兼顧單張細看與整環預覽

背後的 `carousel-detent.ts` 是**純函式的「磁吸數學」**，與組件完全解耦、可以單獨被測試鎖住：

- `detent()`：輸入連續角度，往最近的卡位「擰」——`DETENT_EXP = 1.35` 刻意保守，卡得穩但不搶手指
- `commitSteps()`：滑動慣性結束時，從起點走整格決定落點。`COMMIT_MIN = 0.18`——用戶只要拖過 18% 的卡寬就進位，拖了一大截卻彈回原位的「白拖感」不存在
- `FLICK_MAX_STEPS = 0.9`：快甩最多帶走一格多一點。物理上，甩動表達的是「方向＋想翻」，不是「連翻三張」
- **固定點性質**：`detent(n·step) === n·step`——磁吸數學保證卡位永不累積漂移，滑十圈還是準確停在卡片中心

### 2.2 專業模式：三欄可拖動工作台

不是「進階設定頁」，而是一個真正的**工作站佈局**：

- 左（資源庫）／中（畫布）／右（生成隊列＋歷史檢視）三欄，邊界把手可拖動，實時重排（`pointer capture` + CSS 變數 `minmax(200px, var(--pro-left-w))`，不碰 DOM 重排）
- 下界硬約束 200/220/320px，左欄上限依容器動態計算；行動裝置自動隱藏把手、塌縮為單面工作台

### 2.3 鍵盤優先的命令系統

13+ 條可發現指令（`workstation-commands.ts`）：執行生成、聚焦 prompt、開 LoRA 庫、開隊列、開圖庫、重用結果、下載、前後翻結果、復原標註、關閉浮層。**專業工作台的滑鼠不是必要條件。**

### 2.4 去廠商化的模型心智

`stripVendorPrefix`：`Google Veo 3.1` 在 UI 上就是 **Veo 3.1**，`Gemini Nano Banana Pro` 就是 **Nano Banana Pro**。用戶選的是「這個模型適不適合我的活」，不是「我在跟哪家公司打交道」。

### 2.5 Liquid Glass 設計語言

- iOS 26 啟發的液態玻璃質感、微漸變、情境光暈
- 每個案例卡帶 `glow` 色值——環轉到誰，背景光就被誰暈染（案例卡的沉浸式「環境色」設計）
- 行動端保持「單面工作台」：畫布為核心，一切工具可呼出可收回

### 2.6 LoRA 生態：首訪引導＋庫內選卡

- 普通模式 hover 首訪引導、專業模式的教學引導（`driver.js` 動態載入，普通模式不載入任何多餘 CSS）
- 專業模式內建 **LoRA 庫**：搜索、排序、選卡一氣呵成；用戶偏好持久化（`lora-user-state`）

### 2.7 Prompt 增強器與創作者資源庫

- 六種風格預設（realistic / anime / street / product / poster / watercolor），自動追加品質後綴——小白寫短 prompt 也出好圖
- **創作者資源庫**：每個資源帶 `sourceName / sourceUrl / sourceCommit` 的完整來源追溯，不是抄來的 prompt 大雜燴
- 場景模板（`scenario-templates`）＋風格庫（`style-library`）

### 2.8 Workflow Recall：工作流記憶

`workflow-recall.ts`：prompt、負向 prompt、尺寸、風格模板、參考圖角色、區域 prompt 的完整工作流狀態，一鍵復原。**換個活，不重頭搭。**

### 2.9 案例庫 → 工作台的閉環

首頁 3D 環上的每個案例，都來自 `showcase-cases.ts` 的**真實生成結果**（附 prompt、風格、生成後記）。點一下案例卡，prompt + 風格預設直接注入工作台——「看到好圖 → 復刻它」的路徑是一步，不是三步。

---

## 三、商業邏輯／產品邏輯對稱差

### 3.1 雙軌商業模型（同一套生成核心，兩個收費入口）

| 軌道 | 使用者 | 計費主體 | 入口 |
|---|---|---|---|
| C 端 | 註冊用戶 | 用戶帳號＋餘額 | 網頁工作台 |
| B 端 | 平台／開發者 | **API 金鑰本身**（`sk-biz-`） | `/api/v1` |

B 端金鑰的設計要點：外部平台只會透傳 `Authorization: Bearer sk-...`，**不會帶我們內部的 `x-user-id`**——所以金鑰本身必須是獨立的計費主體，而不是某個用戶的附屬品。計費帳本仍然記在上游（New API），每個 B 端金鑰綁定獨立使用者 id，**不自建第二套額度系統**——重造計費只會讓「同一個信用額度」在兩處互相打架。

### 3.2 統一幣制：generation coins

`generation-model-catalog`：每個模型 × 解析度 × 生成種類，映射單一「代幣」計價。套餐、餘額、SLO 單位成本、金鑰額度全部跑在同一套幣制上——**跨模型可比較、可對帳**。

### 3.3 C 端成長閉環

- GitHub OAuth 登入＋註冊
- 每日簽到（`CheckinCalendar`，`checkin-copy` 文案系統化）
- 充值：Mapay 支付（alipay / wxpay / qqpay）＋回調驗簽＋測試回調端點
- 聯盟行銷（`/api/user/aff`）
- 用量查詢、歷史統計

### 3.4 對外 API 契約（B 端）

- OpenAI 相容：`/api/v1/images/generations`、`/api/v1/models`、`/api/v1/images/{id}/result`
- **冪等**：`Idempotency-Key`，重複提交直接回同一個 job（衝突時 `IdempotencyConflictError` 拒絕，而不是默默覆寫）
- **穩定錯誤碼分類學**（`api-error-codes.ts`）：外部客戶會程式化解析 `error.code`，所以對外碼一旦發佈永不改變語義；內部分類（FailureClass、HTTP 狀態、供應商錯誤字串）自由演進——內部可以拆得更細，外部只看到承諾過的碼
- 多個客戶端不可區分的內部失敗（如 malformed_output / empty_result / artifact_download）**刻意收斂成同一個碼**，不逼客戶去分支處理只有我們運維才需要知道的區別
- 請求追蹤：`X-Request-Id`（客戶自帶的 id 若通過白名單格式則原樣回顯，失敗時有東西可以報給客服）

---

## 四、技術架構對稱差：生成控制平面（generation-core）

這是整個系統最「不該存在於一個生圖網站」的部分——我們把它做成了一個**資料庫為核心的分散式任務控制平面**。

### 4.1 DB-backed 供應商租約排程（不是記憶體 Map）

- `supplier_lease` 表＋`FOR UPDATE SKIP LOCKED`：多 worker、多 serverless 實例併發搶單不衝突
- 租約過期自動清理、租約到期自動釋放
- 候選過濾支援 `excludedSupplierIds`、**`excludedFailureDomains`**（失敗域隔離：某供應商連續失敗，不只它自己、整個失敗域都被暫時排除）
- 能力表（`supplier_capability`）：供應商 × 模型 × 並發上限 × 健康狀態 × 契約版本，**在資料庫裡可查、可管理**

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
- 一旦真實 worker 上線，同一批 canary job 自動變成全鏈路金絲雀——**零改動升級**

### 4.4 三階段計費帳本

`billing-ledger.ts`：`reserve → commit → refund`：

- 執行前預扣（`reserve`）、成功提交（`commit`）、失敗退回（`refund`）
- 帳本層分類：429 → retry、4xx 確定性錯誤 → rejected、未知 → 對帳批次處理
- 與外部帳本（New API / image-billing）雙向 reconcile——**兩個系統打架時，帳本層知道誰是對的**

### 4.5 Callback Outbox：可靠交付

`callback-outbox.ts`：B 端 `callback_url` 交付走**交易式 outbox 模式**：

- 交付狀態機：pending → delivering → delivered → dead_letter
- payload 存 hash＋HMAC 簽名（金鑰帶版本號，可輪換）
- 帶租約的重試（`leaseOwner / leaseExpiresAt`），失敗次數達標進死信隊列，而不是無限重試

### 4.6 SLO 查詢層

`/admin` 的 SLO 以 (tenant, model) 維度呈現：成功率（succeeded / succeeded+failed，**不含排隊中的**，不灌水）、p50/p95 延遲、單位成本觀察值——計費單價有沒有貼著實際成本走，數字說話。

### 4.7 Prompt 靜置加密

`crypto.ts`：prompt 以 **AES-256-GCM**（12-byte IV + auth tag）加密後落庫，金鑰強制 32-byte（64 hex 或 Base64）。資料庫被拖走，生成內容的隱私邊界還在。

---

## 五、路由架構對稱差：一套事實來源

`channel-registry.ts` 的存在本身就說明問題：**「到底有幾個渠道」這回事，全系統只有這裡說了算。**

之前（以及大多數同類系統）是：`generate-images` 路由一份邏輯、biz pipeline 一套邏輯、admin 的 image-upstream-probe 又直接調 `buildGatewayEndpoints`、account-pools 診斷再寫一份——同一個事實散落在四處，等於沒有事實。

現在：

- **統一註冊表**：env 渠道、帳號池渠道、SensE nova 專用渠道、biz 管道、admin 探測，全部消費同一個 `channel-registry` 的輸出
- **供應商譜系**：Adobe2API（web-session 直連）、Sub2API、PixAI 帳號池、SensE nova、New API 中轉——不同協議、不同認證、不同失敗語義，統一成同一份 endpoint 描述
- **帳號池（admin-pools）**：每個帳號有健康狀態、並發上限、in-flight 租約；`active && schedulable` 才進候選
- **Channel overrides**：渠道級覆寫優先級可調（`channel-overrides`）

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
| 密碼學資產 | prompt 加密 AES-256-GCM；callback 簽名 HMAC＋金鑰版本 |
| 管理後台誠實性 | `/admin` 顯示的帳號狀態、路由事件、失敗原因與生產實際同源（routing-telemetry 每筆生成請求寫一條事件）；有 `routing-honesty` 測試鎖住「admin 不撒謊」這個不變量 |

### 6.1 Telemetry 的兩個鐵律

`routing-telemetry.ts` 明文規定，這是它的設計契約：

1. **絕不因疏漏而撒謊**（事件可以晚到，不可以不寫）
2. **絕不擋路**（telemetry 失敗絕不阻斷生成——可觀測性是屬性，不是依賴）

---

## 七、測試紀律：誠實性的工程化

40+ 個測試檔（`src/**/*.test.ts`），測試的不是「函式跑得動」，而是**不變量**：

- `routing-honesty.test`：admin 顯示 = 生產實際路由
- `carousel-detent.test`：磁吸固定點、落點決策、flick 上限
- `billing-ledger.test` / `billing-relay.test`：reserve/commit/refund 三態與對帳
- `crypto.test`：AES-256-GCM 加解密往返
- `canary` / `slo-service` 測試：成功率的統計語義
- `api-error-codes.test`：對外錯誤碼的穩定性（發佈過的碼不准消失）
- `workstation-mobile-stage` / `admin-ui` / `ui-copy`：UI 的品質與文案不變量

**「不模擬成功」是整個程式庫的測試哲學**：canary 不造假成功、SLO 不算排隊中、admin 不隱瞞失敗——誠實是可以用測試鎖死的。

---

## 八、部署拓撲

```
┌─────────────────────────────┐       ┌─────────────────────────────┐
│  Vercel（邊緣）              │       │  VPS（43.172.85.76）         │
│  Next.js App Router         │       │  Docker Compose             │
│  /api/v1 · /api/generate-*  │       │  adobe2api upstream         │
│  /admin（控制平面 UI）       │◄─────►│  PixAI 帳號池 daemon        │
│  DB: Postgres（Supabase）    │  HTTPS│  nginx（網關＋健康檢查）      │
└─────────────────────────────┘       └─────────────────────────────┘
```

- **Vercel**：前端、對外 API、管理後台、控制平面（無狀態、靠 DB 租約協調）
- **VPS**：需要長駐行程或帶狀態的上游適配（Adobe2API 會話、PixAI 池、瀏覽器 relay）
- **Postgres**：`generation_job`、`supplier_lease`、`billing`、`callback_delivery`、`lora_user_state`——所有分散式正確性都建立在資料庫事務上，而不是 serverless 實例的記憶體

---

## 九、支援的模型譜系（2026-08 現況）

**影像**：Adobe Firefly、Nano Banana 系列（2.5 / 3 / 3.1 Flash）、GPT Image（1.5 / 2）、Flux（1.1 Pro / Ultra、2 / 2 Pro、Kontext Pro / Max）、Runway Gen-4、PixAI 日系 premium 系（Moonbeam / Diamond / Neverland / Whimsical / Hassaku / Tsubaki / Haruka / Reference Pro / Hoshino）、SensE nova U1 Fast

**影片**：Veo 3.1（＋Fast）、Kling（2.5 Turbo / 3.0 / 3.0 Omni）、Seedance 2.0（＋Fast）、Runway Gen-4 / 4.5、Adobe Firefly Video、Luma Ray 系列（2 / 3 / 3.14，含 HDR）

> 模型本身不是對稱差——**讓 40+ 個模型透過同一套計費、同一套失敗語義、同一套 SLO 可靠地賣出去**，才是。

---

## 十、我們刻意不做的事

- ❌ 不做「分享牆」社交功能——生成是生產行為，不是打卡
- ❌ 不內建圖片編輯器——編輯是別人的主場，我們把「生成對」這件事做到極致
- ❌ 不自建第二套計費系統——上游帳本可信，就複用它
- ❌ 不讓 admin 顯示與生產分家——誠實比美觀重要

---

*Proprietary. All rights reserved. Image Studio — image.tinchak0207.xyz.*
