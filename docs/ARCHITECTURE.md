# Emu（eimu.dev）—— 導覽式架構全覽

> 這是一份「路演」文檔。想像你坐在我旁邊，我打開電腦，從頭到尾跟你講這個項目是怎麼回事。不是技術手冊，是我會說的話。

---

## 這是什麼

Emu 是一個 AI 繪圖平台。你打開它，可以打字出圖、打字出影片、用模板批量生成、在畫布上改來改去——總之，把你腦袋裡的畫面變成真的圖片和影片。

但這不是那種「AI wrapper」。這背後藏了 8 個子系統，R1 到 R8 輪評測修復，數十小時的打磨。光 Agent 控制系統就經歷了 18 個戰役階段、7 種哨兵看門狗、6 種對話狀態、3 種權限層。這是一個真實的、上線的、有真實用戶在燒錢的生產系統。

你以為我只是個出圖網站？打開蓋子會嚇到你。

---

## 你進站會看到什麼

你打開 www.eimu.dev，第一眼是一張 Liquid Glass 卡片——就是那種 Apple 風格的玻璃質感，有折射光、有 Spring 物理彈性、有邊緣高光線。這不是貼皮的毛玻璃，這是真折射——`backdrop-filter blur + saturate(180%)` 讓 UI 真正折射背後背景的顏色。

卡片正中央是一個 prompt 輸入框。「寫點什麼，然後出圖」——這是主動作。

卡片可以翻面。四張臉：generate（生圖）、edit（改圖）、upscale（放大）、agent（AI 助理聊天）。我們管這個叫「卡片四面」組織原則——使用者要的是卡片換一面，不是換個網站。四種模式共用的是一塊底板，同一個高度鎖，切換的時候 260ms 散開重組。不跳動、不重排。

你說「我什麼都不會寫怎麼辦？」——卡片底部有 AI 引導，停頓 5 秒才彈出提示，不是進站就轟炸你。輸入了，有 6 種品質尾綴自動補上、有風格 chip 可以點、有正則幫你推斷風格。你打一句「一個女孩在夕陽下跑步」，它會自動補成專業鏡頭語言。

但這只是第一層。

---

## 四條路，都能到同一張圖

你從進站到出圖，有四條路可以走。

### 路一：直接出

正面卡片，打字，選模型，點生成。右邊出圖。最簡單，最快。

### 路二：AI 助理聊天

卡片翻到 agent 面，右側直接常駐一塊全屏畫布。你打字說「我要一個賽博朋克風格的女孩，在雨中，穿紅色雨衣」，AI 助理會理解你的意圖，先問清楚參數（「模型用什麼？比例 16:9？」），然後出圖給你看，不滿意繼續改。全程不用碰任何下拉選單、滑塊、參數——我們管這個叫「許願式對話」。

助理背後藏著一套四層提示詞漏斗（後面會講），一套三層工具配置（20+ 工具），一套安全策略引擎（deny 表），還有 7 種哨兵保護你不會卡死。

### 路三：模板環形輪播

agent 面初始態，畫布空且沒對話，浮出一個 3D 環形輪播——八張模範成片卡繞著環旋轉，卡面是真 Liquid Glass 玻璃折射，光會隨著旋轉移動。這不是套件，是手寫的二階彈簧物理。你拖動的時候，阻尼感、磁力落格、收尾的 ~4% overshoot「吻上去」的手感，全都是純函數算出來的。

你選一張卡，卡面底部有個玻璃 Dock，每個環節是一個圓點——你可以全選、單選、或按住拖過一排。點選完成，卡會彈確認窗「是否使用完整模板開始創作？」。你確認，它會注入首條消息+鋪 workflow 節點到畫布，然後 AI 助理接手。

這裡有個設計細節：送出鈕如果你什麼都沒選，還是可以點——點擊會強制播放假鼠標教學，在畫面上演示「按住站0 → 拖過站1 → 鬆開」。我們讓它保持 `aria-disabled` 而不是 `disabled`：**保持可點，點擊本身就是幫助**。在你卡住的那個瞬間教你，而不是進站時預先轟炸。

### 路四：外部深鏈回來

你在 /history 歷史頁看到一張舊圖，點「交給 AI 助理繼續做」，或者從 wish 插件跳轉回來——它會帶參數 `?agent=1&q=<半句話>&session=<uuid>`，落地直開 agent 面，話填進輸入框。

這條路保證了你永遠不會在站內迷路——不論你在哪個入口開始，最終都收斂到同一張卡片上。

---

## 但打開蓋子，事情就複雜了

你可能覺得這就是個「AI wrapper」，調個 API 把 prompt 傳過去就行了。

那我告訴你幾件事：

- 生成一張圖，背後有 **15 種 job 狀態**、**15 種失敗類別**、**4 種計費處置**。
- 同一張圖可能走 8 種不同的上游供應商，從 adobe2api、PixAI、metaso、filmera 到 new-api 渠道，每種有自己的一套協議、鑑權、計費方式。
- 我們有 7 種哨兵看門狗，每種都在真實事故中救過生產。有 90 秒的 turn 看門狗、90 秒的錯誤看門狗、90 秒的中段停滯哨兵——它們的任務是：**如果 AI 助理卡住了，不是讓用戶等到天荒地老，而是自動把它救回來**。
- 我們曾經一夜之間多扣了用戶 3000 倍的錢（計費 bug 把 0.001 幣/張的模型扣成 3 幣/張）。也發生過扣穿到負數 9.11 幣無人攔截（402 事故）。還發生過工作流節點 404 三個月沒人發現——因為工具宣告了能力，但引擎根本沒有實作。

這些不是 bug，是教訓。每一個都長成了系統的一部分。

讓我帶你一個一個看。

---

## 子系統 1：生成核心管線（generation-core）

這是引擎。所有生成任務的最終落腳點。

### 它是幹嘛的

你提交一個任務——不管是圖片、影片、還是 workflow——它會進隊列、被調度、找供應商、發請求、追蹤進度、處理結果、記帳、上傳成品。全部非同步，全部事件驅動。

### 為什麼它複雜

因為它要處理的狀態太多了。一個 job 有 15 種狀態：從 `queued` 到 `pending_billing` 到 `processing` 到 `completed` 到 `failed` 到 `billing_unknown`——是的，`billing_unknown` 是一個真實存在的狀態，因為我們發現計費確認和非同步生成之間存在時序問題，你必須有個狀態來表示「圖出來了但錢還沒扣清楚」。

失敗有 15 種分類：`upstream_4xx`、`upstream_5xx`、`timeout`、`capacity_saturated`、`billing_quota_exhausted`、`content_filtered`、`deadline_exceeded`……每個分類對應一個確定性的決策：重試？換供應商？隔離？還是直接失敗。分類器有中文模型欠費檢測，有 pixai 的 NoCredits 正則——這些都是被真實事故教會的事情。

### 三層並發控制

同一個 job 可能被多個 worker 搶到——所以我們用三層租約（`SKIP LOCKED`）來仲裁。Worker A 搶到 job 1，鎖住，處理；如果 worker A 掛了，job 1 的租約過期，worker B 可以拾起。這不是樂觀鎖，這是有過期時間的、可搶佔的、寫到 Postgres 的分散式鎖。

### 計費四階段

錢的問題是整站最敏感的部分。我們有 4 個階段：**reserve**（預扣）→ **commit**（確認扣款）→ **refund**（退還未用）→ **writeoff**（壞帳沖銷）。每個階段都有 HMAC 簽名，每筆帳都有 append-only 事件帳本（禁 UPDATE/DELETE）。我們還有**閘門**（quota precheck）和**投影**（billing projection，把尚未 commit 的 pending 金額也計入可用餘額）。

這套系統曾經出過 3000 倍超扣、0 額漏損、145 幣扣穿——每一個 bug 都對應一個修復：超扣 → 確認卡冪等鎖鈕；漏損 → 投影加 failed 分支；扣穿 → midBatchBudgetGate 批間預算閘。

### 失敗回調 outbox

上游 callback 可能斷線、亂序、重複。我們做了一個 outbox 模式：callback 先寫入 `callback_outbox` 表，由 worker 消費，保證 exactly-once 語義。15 分鐘內重試，15 分鐘後進死信隊列人工檢查。

---

## 子系統 2：多供應商上游適配層

這是最「髒」的部分。8 種上游，每種有自己的協議、鑑權、限流、帳號管理、錯誤格式。

### 供應商矩陣

| 供應商 | 協議 | 鑑權 | 帳號池 | 特點 |
|--------|------|------|--------|------|
| **adobe2api** | 自訂 HTTP | cookie+refresh token | 住宅代理池 | 最穩定的供應商，但有 IP 風控；我們花了一週才找出那個 408 是機房 IP 問題 |
| **PixAI** | GraphQL | JWT 7天 | Python 帳號池 | 有 Turnstile 驗證碼，我們用 YesCaptcha 解；帳號要每天簽到領免費額度 |
| **metaso** | 自訂 HTTP | 固定 key | 沒有池 | MiniMax-H3 最便宜渠道，約官方 1/5 價格 |
| **filmera** | 自訂 HTTP | 自註冊 | 24/7 自愈 | 最複雜的適配器：我們反編譯了它的 Next.js Server Action、用 Supabase 管理帳號、做純 JS 去水印 |
| **new-api** | OpenAI 兼容 | 標準 key | 沒有池 | 換血後的中控內核，08-28 把整個計費系統換了 |
| **openai_video** | OpenAI 兼容 | 標準 key | 沒有池 | 影片生成走這條路 |
| **sub2api** | 自訂 HTTP | 標準 key | 沒有池 | 備用，fallback 角色 |
| **cangyuansuanli** | 自訂 HTTP | 固定 key | 沒有池 | 08-30 才接入的 Seedance 主渠道，淘寶賣家供應商 |

### 路由決策

選哪個供應商不是隨機的。我們有雙路由表：一個是 `generation-model-catalog`（能力驅動，告訴你哪個模型支援什麼解析度、什麼品質檔），另一個是 `supplier-router`（健康驅動，告訴你哪個供應商現在活著、還有多少額度、排隊深度）。

最終的排序鍵是 `supply_tier` 不是 `priority`——這個我們踩過坑。relay 級供應商永遠輸給 managed_pool，priority 是無效的。

### filmera 的故事

filmera 是我們最複雜的適配器。它是一個第三方平台，沒有公開 API——所以我們做的是：反編譯它的 Next.js 前端，找到 Server Action ID，用程式碼模擬瀏覽器行為呼叫它。它的帳號要自己註冊、初始化 project 節點、token 會過期要輪換。我們還做了純 JS 的水印去除（反混合公式，對實心文字無效所以只能「純插值去水印」）。

這套東西跑在 24/7 自愈架構上：token 自動輪換、context 自動恢復、帳號被封自動換。我們為它寫了 `filmera-cleaner.ts` 專門處理水印。

---

## 子系統 3：AI 助理（Agent harness 網關）—— 全站最複雜的

這部分我花最多時間講，因為它真的複雜。

### 它不是聊天後端

你會覺得「AI 助理就是一個聊天機器人，調個 LLM 就行了」。但我們的 AI 助理能做的事情太多了：生圖、出影片、操作畫布、管理資產、查報價、讀文檔、啟動工作流、派遣子代理執行任務、甚至寫 Python 腳本執行。

它背後是一個完整的分布式系統——不是一個 chatbot，是一個**分散式狀態機 + 安全策略引擎 + 微服務網格的混合體**。

### 戰役史（R1→R8）：為什麼它這麼複雜

這不是設計出來的，是被打出來的。我們經歷了八輪評測修復戰役，每一輪真實用戶在真實任務上測，然後被罰俸、被罵、被糾正。

**R1**（08-26）：第一次大明成片測試，6.1/10 罰俸。靜默換菜（模型偷偷換了不告訴你）、偽成功（prompt 冒充演算法成功）、黑話泄漏（內部 task_id 跑進對話）、1 幣單也走 confirm。修了：turn 30s 心跳、confirm 門檻≥5 幣、引擎批並行。

**R2**（08-27）：7.0/10。誠實報錯有了、並行有了、心跳有了、退款幀兌現了。新問題：關鍵句繁體回退。

**R3**（08-28 凌晨）：4.0/10。LLM 卡死+gateway 重啟斬 turn、SSE 重試歷史重放。修了：**TURN_WATCHDOG_MS 90s 看門狗**、replayBuffer 剝離、N1 redrive 機制。

**R4**（08-28 下午）：5.4/10 罰俸。思維鏈泄漏正文、條款編號讓用戶看到、看門狗兩個場景缺席（error 狀態和 compaction 狀態不會觸發 watchdog）。修了：英文正文守門行級狀態機、**TURN_ERROR_WATCHDOG_MS 90s**、deny 表首成架構約束。

**R5**（08-28 晚）：5.9/10 罰俸，暴君人肉 11 罪狀。報價單位錯亂（RMB 0.25 應為 5 幣/秒）、模板零回饋、表格不渲染、錨定卡「第 4621 張」。修了：**MIDTURN_STALL_MS 90s 中段停滯哨兵**、preflightBudget、videoTierPerSecond、confirm 合併、t2s 守門 469 對。

**R7**（08-29）：6.5/10 罰俸。48h 死線報價=帳單 100 倍偏差、72h 死單、failover 鐵律缺失。修了：失敗即翻面、**換模請旨+價差**、deadline 3 分鐘/展期 15 分鐘、VPS 並集合併範式。

**R8**（08-29）：44/100 罰俸→R8.5 復測 5/5 PASS。推理往返慢於執行、question 卡掛死 129s 零幀、awk 硬編碼六連敗。修了：**run_py 通用執行原語**（特化工具作廢）、question 掛起 30s 心跳×N+turn 凍結、45s 靜默 notice（45/90/135 遞進）。

**五大根因**（08-29）：模型慢、提示詞催問、steer=殺掉重開、image_quote 分不清圖/視頻、abort 當失敗展示。全修了。

**deny 表放寬**（08-29）：橘貓事件——因為 `curl*` 雙 deny，免費池死路，懶貓模型完全用不了。deny 表從「預設全拒長城」改成「*:allow 45 條只留主機破壞紅線」。

**persona 綁模型**（08-29）：發現 persona 只是 prompt 注入，不是真綁模型。b-ai 全滅時主備用同一個供應商，同源全死。修了：efficient→deepseek-v4-flash-vision-exp、thoughtful→glm-5.3-flash reasoningEffort=high，per-message 模型切換。

**session 24h**（08-29）：原先是 30 分鐘回收，第二天 session 就空了。修了：idle reaper 只清內存不刪 opencode、TTL 30min→24h、GET 懶恢復。

**interaction_mode**（08-30）：協作/預設/自動三檔，auto 檔 confirm 自動放行但 402 閘不動。

**中控屎山 10 病灶**（08-30）：resolveNodeModel 取首個 config 而非最新、帳戶無自愈、0 額漏損。全修了。

### 哨兵體系（6 種）

這 6 個哨兵，是我最自豪的部分，因為每個都是從真實事故裡長出來的：

| 哨兵 | 時長 | 偵測什麼 | 事故根因 |
|--------|------|----------|--------|
| TURN_WATCHDOG | 90s | turn 全程無進展 | R3 LLM 卡死 |
| TURN_ERROR_WATCHDOG | 90s | 錯誤狀態停滯 | R4 compaction+APIError 停 5 分鐘 |
| MIDTURN_STALL | 90s | 工具執行中途死亡 | R5 影片放置 12 分鐘 |
| questionHeartbeat | 30s×N | question 掛起+turn 凍結 | R8 question 上游靜默 |
| HEARTBEAT_DELAY | 30s | turn 心跳 | R1 零匯報 |
| ACK_DELAY | 15s | 確認延遲 | R4 收斂 |

### 狀態機與權限

- **6 種 turn 狀態**：active / pending_confirm / pending_question / paused_insufficient_quota / compacting / redrive。每個狀態都有對應的哨兵監控。
- **3 種 interaction_mode**：collaborate（每步確認）/ preset（整包授權）/ auto（全自動，扣費確認自動放行但系統級 402 閘不動）。
- **3 層權限策略**：opencode 執行攔截（deny glob）→ gateway 拒單報因（60s 重讀同一 opencode.json，改表不用重啟）→ AGENTS.md bash 白名單指導。deny 表不是安全邊界——它是防注入絆腳線，沙箱可以被 edit+python3 穿透，我們知道這件事。
- **5 個持久化層**：sessions.db / opencode DB / 內存 snapshot / DB 懶恢復 / localStorage 兜底，replayBuffer 200→1000 幀。

---

### 軟實力①：提示詞與 skill 打磨（四層漏斗）

你可能會說「提示詞有什麼複雜的，不就是寫一段話告訴 AI 怎麼做嗎？」

但我們有四層。用戶只輸入一句人話，背後四層自動補齊成工業級 prompt：

**第一層：優化 agent 層**。跑在 VPS gateway 上，用 deepseek 模型，system prompt 是濃縮自 Higgsfield Hell Grind 95 分鐘長片 pipeline + Seedance 2.0 官方規則的 PROMPT_DIRECTOR_SYSTEM_PROMPT。這層很強，但有 30 秒超時、要網路。

**第二層：規則層**。`invisible-prompt-director.ts` 裡跑的純函數，同步執行、零成本、零延遲。裡面有六槽補全（把用戶短 prompt 拆成六個語義槽位補齊）、anti-slop（把 beautiful 換成 striking detail）、homograph 修正（把 shoot 換成 fire 防模型讀成第二種物理含義）、情感肌肉化（scared 變成 "jaw clenches, nostrils flare, shallow breath…" 14 種情緒都有對應的物理描述）、age-blind（內容過濾器一讀到 minor 就收緊，所以我們用 age-blind 繞過）。

**第三層：隱形引導詞**。模板卡有一個 `directive` 欄位，隨首條訊息塞進 system，用戶看不到。為什麼？因為 directive 是「給 agent 的作業指引」——含 template_id、門禁順序、行為規則這些工程語彙。用戶不該讀到，也不該被要求理解。卡片文案是給用戶看的邀請，directive 是給 agent 的作業指引，兩者必須物理隔離。

**第四層：帳戶畫像注入**。profile（用戶確認過的畫像）+ lessons（模型從會話提煉的教訓，每條帶 source_session_id + 摘要，confirmed: true 才進注入集合）。空畫像時返回 null 不佔上下文，lessons 上限 8 條。

這套體系不是一次建成的。R1→R8 八輪戰役，每一步都在打磨：vetting 指令從「信度低就問用戶」改成「先開工出骨架，只在最關鍵參數缺失時才問一次一道」；steer 打斷後注入「不要重複上輪已說的話，不要重新開場，即刻按要求幹活」；abort 文案從「aborted」改成「已按你的要求中止本轮」（中止≠失敗是人話）；question 卡 ≤30 字 + 2-4 選項硬規則（因為出過一次 6 題和空殼卡的事故）。

為什麼要把能力做成 skill 而不是寫死？因為改 SKILL.md 一行 = 改 agent 行為，不需要重啟 harness。而且 skill 可以按需加載壓縮上下文——我們把 AGENTS.md 從 299 行/37KB 瘦身到 65 行，把排障配方外移，只留每次會話都改變行為的規則。**砍到 1/3 是禁手，因為底層是 deepseek 不是 GPT-4，行為規則寧多留、知識配方才外移。**

---

### 軟實力②：工具配置體系（三層分離武器庫）

AI 助理不是只能聊天，它在背後調用 20+ 個工具。這些工具構成了一套三層分離的武器庫：

**上層（前端契約層）**：`agent-tool-contract.ts` 定義工具簽名、zod schema、能力門禁、審計。每個工具的名字、參數類型、返回值、權限需求，都在這裡定義。

**中層（VPS 工具層）**：`.opencode/tools/*.ts` 每個工具獨立執行、獨立 zod 校驗。工具不直接暴露 bash，而是經 opencode 自定義工具調用 + deny 攔截 + 審計日誌。

**底層（安全層）**：opencode.json 的 deny 表，定義哪些 bash 命令不能執行。

我們為什麼不做一個大 API 給 agent 調用，而要拆成 20 個小工具？因為每個工具可以獨立校驗、獨立控制權限、獨立審計。代價是工具數量膨脹快，而且工具間參數契約不一致時 agent 會混淆——image_quote 故意過濾 video 但 description 沒說，導致 agent 誤判「平台無影片」。我們的解法不是拆防呆，而是新增一個 video_quote 對偶工具。

工具的生命週期是一個事故驅動的演進史：

- image_quote/video_quote/quote_bundle 報價三件套（video_quote 是 08-29 對偶新增的）
- canvas_get_state/apply_ops 畫布操作
- workflow_start/connect/update_node/rerun/status 工作流全套（update_node 曾是空殼，08-30 才補路由真可用）
- **run_py 通用執行原語**（R8 新增，取代 doc_struct 特化工具——暴君裁定「通用執行原語 + 庫層 + 行為規則」取代特化工具）
- asset_search/get/activate 資產包三件套（08-30 新增）
- subagent_dispatch 派遣子代理

最關鍵的設計取捨是 deny 表的哲學轉向。一開始是「預設全拒 + 冗長白名單 + 內容級掃描」（連 `*|*`、`*&&*`、`*;*` 都整串 deny）。08-29 橘貓事件後——curl 雙 deny 讓免費池死路，model 完全不能用——我們放寬成 `*:allow` 45 條規則，只留主機破壞紅線（sudo/su/chmod/chown/fdisk/mount/rm -rf / 等）。gateway 60s 重讀同一文件，改 deny 表不用重啟。

計價錨點也經歷了三輪修復：R5 gateway 改批量路徑、R7 工具層改單節點、R8 確立 pricing-table-is-authority 鐵律——價目表是唯一權威，實扣 3 幣=計費 bug 不是定價。

發佈紀律是踩出來的：opencode 工具新增必 `systemctl restart opencode-server`（工具宿主是 opencode-server 不是 gateway）；工具返回契約必須含 `output:string`（缺了對 undefined 調 split 崩潰）；控制面 VPS 碼源比本地 HEAD 新，部署前 md5 對賬並集合併。

---

## 子系統 4：無限畫布 + 專業工作站 + 領域配方

畫布是 AI 助理的「視覺大腦」。助理在聊天裡跟你對話，畫布上展示它做的東西、讓你可以拖來拖去改。

### 畫布語義節點系統

10 種節點：Image、Text、Config、Video、Group、CharacterCard、SceneCard、Audio、Prompt、Reference。每個節點有四態生命週期：idle/success/loading/error。

畫布操作有 8 種 DSL：add_node、update_node、delete_nodes、connect_nodes、delete_connections、select_nodes、set_viewport、run_generation。這些操作全部是純函數 reducer 處理的——脫離 DOM 就可以測試，`node:test` 直接測。

### 模板管線四卡泳道

模板展開後，畫布上會出現四種卡：頭卡（模板說明）、工具卡（可用的工具）、門禁卡（需要用戶確認的節點）、生成卡（實際出圖的節點）。這四種卡全部蓋 `workflow_id`，`replaceWorkflowNodes` 可以泳道級整體替換。

### 專業工作站

三欄布局：左三步（提示詞→參考圖→參數）+ 右三面板（隊列→圖庫→歷史）。工作站入口 2026-08-27 起已經從首頁移除了——它現在只做獨立產品面。為什麼移？因為首頁屬於「快速出圖」，工作站屬於「專業創作」，兩者不適合放在同一個首屏。

### 領域配方

我們有短劇（17 道確定性門禁 storyboard_qc_17）、試衣（僅 shot_grid_batch 可用，其餘 unsupported+notReplacedByPrompt）、小說 IP（帶 provenance sha256/license）、電商（翻譯層 mapping 到 generation-core）、六槽配方模板 10 個 + 場景模板 14 條 + 風格庫 106 條 + 鯤鵬知識注入。

---

## 子系統 5：B 端 API + SKU 售貨 + 計費對帳

### B 端業務

B 端客戶每天生成 1000 張素材，不透過 UI 跟 AI 助理聊天——他們直接調 `/v1/*` API。他們的 key 叫 biz key，一生只鑄一次——sha256 存儲，3 層查找（Postgres → Blob → env）。

### SKU 引擎

我們有一套「售貨機」系統：SKU 定義（什麼套餐、多少錢、多少額度）→ 訂單（SKU + 用戶）→ 擴展（把訂單轉成實際的額度增減）。這套系統是 stateless 的——零新表，純函數 expand。

### 定價 live data 鏈

價格從 catalog → Blob overrides（不可變路徑+15s 快取+3s 超時）→ PricingSync 60s 輪詢+visibility 重同步 → usePricingRevision 訂閱重渲染。三套餐：夢芽 ¥9.9 / 夢影 ¥29.9 highlight / 夢虹 ¥69。

---

## 子系統 6：鑑權 / 帳戶 / 支付 / 管理後台

### 鑑權三層降級

Vercel 端 Postgres 是主要 session store，但冷實例有時連不上——所以我們有三層降級：Postgres → Blob → env（後備）。這就是為什麼 B 端 key 偶爾 401——冷實例掉回退層時 Blob 可不可用完全看運氣。

### 管理後台

`/admin` 路由，有供應商管理（查各渠道健康/額度/排隊深度）、用戶管理（查詢/凍結/退款）、生成監控（實時任務面板）、事件日誌（append-only 帳本查詢）。數據來自三處：generation DB（任務狀態）、new-api SQLite（餘額/key）、agent-harness 日誌（會話）。

---

## 子系統 7：站點 UX 與內容/行銷面

### 3D 環形輪播（再講深一點）

這是我最喜歡的元件。不是套件，是手寫的 CSS transform + rAF 二階彈簧物理。

為什麼不用指數逼近？指數逼近永遠不會 overshoot，末端是爬到位再突然停——這就是停靠生硬的數學原因。二階彈簧有 ~4% overshoot，會「吻上去」。磁力數學（detent）1.35 保守值——「要的是能感覺卡位阻力，不是手指拖不動」。COMMIT_MIN 0.18 格——傳統 0.5 的設計正是「滑了半張又彈回去」的來源。flick 夾在 <1 格，甩動只表達方向不表達翻三張。

WebGL 玻璃折射是真 Snell 折射（IOR 1.47），光隨轉動移動是判斷實體/貼圖的首要線索。SDF 場用 squircle 連續場保證無 branch line 穿越圖片。

### Liquid Glass 設計系統

我們有三級材質：lg-card（blur 40px）→ lg-float（28px）→ lg-bar（28px）→ lg-sheet（28px 但實際已經降到 28px，規格寫 60px——人眼不可辨）。每個 blur 半徑都有性能註釋——「28px 是本設計語言裡驗證的上限，半徑越大每幀回讀重模糊區域越大，中低端 Android 掉幀來源」。

`.lg-ambient` 把 blur 烘進漸變——「觀感等價，零合成層」。case-showcase 棄 preserve-3d 改每卡獨立 flatten，因為 Safari 會拍平 backdrop-filter 子節點，文字會發虛。

### 設計硬規則

正文不小於 13px（DESIGN.md §4，不可突破）。黑字透明度下限 0.44（測試鎖死）。雙金色取捨：`--coin-gold #c9a84c` 亮底用、`#FFCE73` 暗底用——「正宗金」讓位給暗底可讀性。

style-chip 填充 vs 描邊的審美判斷：「描邊膠囊 × 幾十個就是分割感非常重的來源——填充讓整條控制軌和畫質分段控件讀成同一族，分組靠留白而不是線。」

---

### 軟實力③：入口交互與動效

這部分我想重點講「減法哲學」——因為我們刪掉的東西可能比新增的還多。

**刪掉的東西**：/agent 獨立頁整頁刪除（改重定向回首頁）、撤銷條整塊刪除（「控件上已是現值，再畫一遍被動過什麼只是噪音」）、六點把手→全選 checkbox（單選轉複選）、拖拽把手刪除、導航欄「助理」鏈接刪除（AI 助理是卡片上的一個 toggle，不是一個去處）、agent 面底行刪除（唯一出口是 Header 收起鈕）。每個刪除都有裁定理由。

**減法哲學**：殼內不疊卡（lg-card 只准用在彩色頁面背景頂層卡，殼內一律 iOS 內嵌面——無邊框、無陰影、無 backdrop-filter）；agent 面常駐 5 層（Header → BatchProgress → transcript → 條件卡 → composer），「加新層前先想能不能併進既有層」；reasoning 默認收合；/history 首屏 6→3 層。

**聊天真空期回饋**：呈現問題到 AI 回第一個字之間，我們做了四層：思考三點（錯峰 bounce）→ 思維鏈 `<details>` 串流無正文時自動展開 → 2px 打字游標（outline 畫，永不掉行首）→ 屏讀器 `role="status"` 播報。往上翻不強拉——自動貼底只在 isNearBottomRef 128px 閾值內發生。

---

### 軟實力④：界面設計取捨

這是我學到最多的一課。

**性能是美學的紀律**。`.lg-bar` 的 blur 從規格 48px 降到 28px，理由三段論：「合成器每幀要回讀並重模糊的背景區域越大 → 中低端 Android 掉幀 → 0.62 白底觀感差異不可見」。`.lg-ambient` 把 blur 烘進漸變，零合成層。case-showcase 為文字清晰寧可手動算 z-index。這些都是「設計師懂渲染管線」的鐵證。

**視覺審核閉環**。暴君 2026-08-26 裁定：「不要给我改几个代码然后自我感动，改到视觉模型都觉得无可挑剔为止」。連續六輪自己調參數全被打回——參數正確≠好看。閉環 = 改碼 → Playwright 截圖 → `read_image.py` 毒舌審核（「你是毒舌總監，逐條缺陷+10 分制」）→ 按批注改 → 再審 → PASS（實例：3→5.5→7.5→8.8→9.6 共五輪）。

**與「禁自我 UI 檢查」互補**。功能用 1225 測試自動驗證，美學外包視覺模型裁決，工程師只翻譯批注——審美裁決權與功能驗證權分離。

---

## 子系統 8：部署 / 維運 / 監控 / 上游橋

### 部署拓撲

兩朵雲。Vercel 跑前端/邊緣，VPS 跑控制面/生成器/new-api/nginx。Vercel 的 `beforeFiles` rewrite 把 `/v1/*` 全代理到 VPS，所以 repo 內的 `/api/v1` 路徑對 Vercel 而言是死路。改 `/v1` 行為要改控制面並 rebuild+restart nginx。

### 資料庫演進（15 個遷移的業務敘事）

從「能出圖」到「每一筆錢、每一次失敗都有帳可查」：001 任務/供應商/計費全套 → 006 LoRA 收藏 → 007 B 端密鑰遷 Postgres（曾因 Blob 被 block 導致 401 事故）→ 012 換血 new-api（biz_key_newapi_token）→ 013 append-only 事件帳本（禁 UPDATE/DELETE）→ 015 writeoff 虧空記帳。

### pixai-pool 帳號池

最獨立的自愈系統。Python 寫的，跑了 YesCaptcha 解驗證碼、隨機 outlook 郵箱註冊、JWT 7 天、每天簽到領 10000 點、token 到期前 24h 重登入、生成 GraphQL createGenerationTask 輪詢 PUBLIC URL。存儲是 pool.json 原子替換（`.tmp` 副檔名防寫入中斷）。bridge 三層重試 + 全局 asyncio 鎖 + `/v1/pool-sync` 熱替換不需重啟。

---

## 所以，複雜度到底在哪

一句話：**四軸同時拉滿**。

**第一軸：狀態空間**。15 種 job 狀態 × 15 種失敗類別 × 4 種計費處置 × 4 種 tier × 6 種 turn 狀態 × 7 種哨兵 × 3 種 interaction_mode——已經超過單一人心智模型能覆蓋的閾值。

**第二軸：並發模型**。三層租約 + SKIP LOCKED 隊列 + 分散式限流 + agent 併發上限實測漂移（1→2→5）。

**第三軸：計費閉環**。外部 relay（HMAC）+ 本地 ledger + gate 投影 + zombie 回收，四套路徑在一 job 上交錯。3000 倍超扣、0 額漏損、145 幣扣穿事故皆出於此。

**第四軸：軟實力**。提示詞四層漏斗 + R1→R8 八輪戰役打磨（每條規則附生產事故註腳）；工具配置三層分離 + 20+ 工具由 6 輪事故驅動演進 + deny 表從長城到紅線的哲學轉向；入口交互四層漸進 + 手寫二階彈簧物理 + 四層真空期回饋 + 強制教學式引導；界面設計取捨（可工程化的 Liquid Glass 美學系統 + 渲染性能量化紀律 + 視覺審核外包閉環 + 減法哲學）。每一軸都有代碼基線、測試鎖定和真實事故根因，與前三軸正交疊加。

---

## 附錄：踩過的坑（你要是改這個專案，先看這幾條）

1. `src/components/ProfessionalWorkstation.tsx` **不存在**。真實入口是 `pro-workstation/InvokeInspiredWorkstation.tsx`。2026-08-27 起工作站入口已從首頁移除。

2. `src/app/api/v1/*` 真源 = **VPS 控制面**。Vercel beforeFiles 全代理。repo 內的 /api/v1 路徑對 Vercel 是死路。

3. **opencode 工具新增後必 restart opencode-server**。工具宿主是 opencode-server 不是 agent-gateway。改 deny 表不用重啟，改工具要。

4. `.vercel/output` 殘留 = 上傳過期 prebuilt，可能覆蓋真部署。

5. `channelConcurrency` 硬編碼在 seed 工具（metaso=6/pixai=2），改 DB 被 worker 重啟沖回。

6. deny 表是**防注入絆腳線不是安全邊界**。沙箱可被 edit+python3 穿透。

7. 記憶標記「作廢」≠檔案可刪。scheduler.ts lease、adobe-health.ts、supplier-channels.config.ts、tools/add-supplier-channel.ts、metaso-upstream.ts 全被 worker/adapter 引用。砍前必 `grep -rn` 驗證。

8. Vercel 端 `vercel.json` 不要加 crons——Hobby 限每日一次，且 VPS 表它夠不到。真實 cron 在 VPS crontab。

9. `job_events.detail` 是 jsonb 包字串，要雙重解析。