# Image Studio（Emu）第 4 批 commit 能力窮舉

- 批次：47 個 commit，日期 2026-09-20 ～ 2026-09-25（`/tmp/cap/batch-4.hashes`）
- 真源：`/tmp/cap/batch-4.txt` ＋ `git show <hash>`（訊息不足者一律看 diff）；現場驗證以 `grep -rn` 於 `/home/lenovo/Desktop/image-app` HEAD
- 口徑：能力＝**使用者可見或可呼叫的行為**；檔名單獨出現不算能力。修復／重構若暴露新能力或其邊界語義，另列於「邊界與拒絕」。

## 生成核心

- [生成核心] harness `image_generate` 影片時長下限硬規則 — `kind=video` 的 `duration_seconds` schema 為 `min(10)`，小於 10 秒直接拒絕（上游按條計費、10 秒以下虧本；seedance-2.0 適用 10–15s、seedance-2.5 適用 10–30s），並要求回傳完整 36 字元 UUID task_id、禁止截斷 ｜ 證據: a0cf8147
- [生成核心] harness `image_generate` 模型可用性強制探測與扣費確認分流 — 提交前先探測模型可用性（不可用不得提交）；預估 ≤0.1 幣的低成本草稿直接執行免確認，其餘先跳扣費確認；工具自我聲明「非同步、提交後立即交還控制權、逾時自動退款」，且要求影片/大片需求改用 workflow_* 工具而非單張生圖 ｜ 證據: a0cf8147
- [生成核心] B 端生圖參考圖解析輪子 `lib/biz-image-references.ts` — 由 `images/edits` 私有 helper 整段抽出為共用模組，`/v1/images/generations` 與 edits 兩條 route 共用同一份實現（禁造第二套） ｜ 證據: 2bd7217c

## 模型與供應商

- [模型與供應商] 打字路徑工作流模板的領域判準（6→13 模板） — `jev-gate` TEMPLATE_CRITERIA 新增 7 個領域重模板：`shortdrama_visual`／`novel_ip`／`ecom_launch`／`ecom_model`／`shortdrama_poster`／`art_curation`／`art_style`；判準為「領域關鍵詞＋交付物形態」，領域模板與泛用骨架（single/feature/novel）互斥，無領域詞的多鏡頭影片由 `feature_film` 兜底；`ecom_launch` 收緊為「明確要上市物料」；真實 Jev API 實測 7/7 全對 ｜ 證據: c7d0fad1

## 控制平面與計費

- [控制平面與計費] mPay 回調金額手續費容忍 — 實收必須 ≥ 應收（少付一律拒），超出部分 ≤ `max(0.5 元, 5%)` 才接受；簽名失敗／非成功狀態／方案或金額不符三個拒絕分支全補 warn/info 日誌（含 out_trade_no、money、param 供排障） ｜ 證據: ac8fa0c0
- [控制平面與計費] 客戶可見餘額權威歸我方帳本（/v1/quota） — `GET /v1/quota` Bearer B 端/agent key → biz_api_key.userId → `account_ledger` → `{ balance_coins }`；new-api `users.quota` 降格為「上游供貨水位」；口徑由「帳面淨額 Σ amount」改為「可用餘額」（永久池＋未過期訂閱池，過期為讀取當場 lazy 判定，不依賴定時任務）；餘額可為負且不夾到 0；回應形狀 success/balance_coins/currency 與 503 quota_unavailable 契約不破 ｜ 證據: a16d5690
- [控制平面與計費] 帳本開戶基線與調整雙寫 — `ensureAccountOpening` 以 new-api 當時餘額幂等種入上線基線；管理端 provision 改上游 `users.quota` 後同步在我方帳本記一筆 adjustment，delta 由「呼叫前後權威讀數相減」得出（不是重算目標值），幂等鍵 `provision:<username>:<目標額度>`；記帳失敗不擋路，差額由對帳報告指出 ｜ 證據: a16d5690
- [控制平面與計費] 訂閱 SKU 與兌換碼履行 — `subscription-sku` 定義訂閱 SKU 與履行通道（預設走兌換碼）；`subscription-redemption` 是唯一發碼端，碼的 `name` 承載 `SUB-<sku>@<ref>` 供入帳端辨識；訂閱池 `pools`（永久池＋訂閱池）供餘額口徑讀取 ｜ 證據: a16d5690
- [控制平面與計費] 任務失敗記錄與對帳模組 — `failure-record`（落 `failure_record` 表）＋ `account-reconciliation`（帳本對帳）＋ `operation-registry`（操作註冊）＋ `callback-outbox` 回調外送箱，構成失敗態與對帳的持久層 ｜ 證據: a16d5690
- [控制平面與計費] Vercel 側歷史經控制面代理歸併任務記錄 — `GET /api/history` 在本地控制面未啟用時，經 `GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 打 `/image-control/api/history`（pageSize 100、15s timeout、轉發呼叫者 Bearer/x-user-id），與本地記錄合併後再本地分頁；修「任務跑在 VPS、歷史讀在 Vercel，兩邊不相見→再來 N 組/微調變體卡片永不進歷史」 ｜ 證據: 8ece45dc
- [運維與觀測] 管理側統計只讀端點與 CSV — `GET /api/admin/statistics` 驗管理員 session、驗窗口 `days`（1..MAX_WINDOW_DAYS，越界 400），回 `statistics-projection` 投影與 CSV 匯出；本路由零 SQL 寫入、不碰計費扣額重試；模型三態不在此重算，消費既有 `/api/user/model-status`（與 `/v1/model-status` 同一份判活） ｜ 證據: a16d5690
- [控制平面與計費] 拔除 biz-key-token-mapping 影子映射（G1） — 刪除 `src/lib/generation-core/biz-key-token-mapping.ts`，並以測試斷言該檔不存在；B 端 key 的身分映射權威歸帳本路徑，不得另立第二套 token→user 映射 ｜ 證據: a16d5690

## B端API

- [B端API] `/v1/images/generations` 新增 `reference_images` 輸入 — 接受 `string` 或 `{url, role, name}`；上限 5 張、保序、非法形狀回 400 不靜默截；role 收斂到 `GenerationReference` 值域（未知→general）；轉成 `workflow.references`；零參考圖時不加 `workflow` 鍵（逐位元零回歸）；計費/kind/模型白名單/size/n/quality/control_nets 校驗一行未動；生成本身仍走控制面（billing/queue/worker 不變） ｜ 證據: 2bd7217c
- [B端API] prompt 行內實體 tag 解析（`@[種類:名稱]`）— 對呼叫金鑰 owner 的卡庫解析，命中者就地展開成該卡 prompt 片段、其參考圖併入 references（卡的圖在前、顯式在後、按 url 去重、上限 5 截尾並回 warning）；未命中原樣保留（fail-open）；卡庫抖動降級成 warning 不讓生成失敗；plans 端不重寫 regex，直接複用 `entity-tokens` 的 `expandEntityTokens` ｜ 證據: 2bd7217c
- [B端API] B 端角色卡 API `/api/biz/character-cards` — GET/POST，B 端金鑰認證，與站內 `/api/character-cards` 共用同一卡庫與同一清洗收口；決定性 id `biz-<sha256(userId|kind|name)[:16]>` 做 upsert（同鍵幂等）；`/v1/character-cards` 為開發/測試掛載點（生產 `/v1/*` 被 next.config beforeFiles 代理到控制面，故生產真正服務 agent 的是 `/api/biz/character-cards`），兩掛載點共用同一實現與同一斷言套件 ｜ 證據: 2bd7217c
- [B端API] B 端實體解析端點 `POST /api/biz/character-resolve` — 是參考圖輸入與行內 tag 兩者的解析前端，供 agent 工具層在生圖前呼叫 ｜ 證據: 2bd7217c
- [B端API] `/v1/team/quota` 團隊成員點數配額（GET/POST） — GET 回主帳總額／已分配／各成員額度與消耗（全部當場讀 new-api 權威源）；POST 由團隊主帳對成員劃額度，`target_coins`/`target_quota` 為**絕對目標值**（大於現值＝劃額度、小於現值＝回收、等於現值＝幂等 no-op 不寫上游）；分配＝主帳扣、成員加，兩條腿不成功即回滾；所有金額對外以幣為準（1 幣 = QUOTA_PER_COIN quota）；禁影子帳本，額度真源只有 new-api ｜ 證據: a16d5690
- [B端API] 團隊資產空間 `/api/project-assets`（掛用／解除） — GET 列表（包 + 卡，帶掛用標記）＋ sharesIn；POST 掛用採 copy-on-use：建本地副本並回 `localCopyId`，同鍵幂等；DELETE 解除掛用回該記錄的 `localCopyId`（前端據它解鎖）；認證 `requireVerifiedUser`（不信任 x-user-id） ｜ 證據: a16d5690
- [B端API] 資產顯式分享授權 `/api/project-assets/shares` — POST 授權（同鍵重放回 `created:false`，幂等）／DELETE 撤銷（支援 id 或四元組）；跨項目復用只能靠這個顯式動作；拒收碼 `cross_user`／`not_a_project_asset`／`project_mismatch`／`same_project` 各有中文訊息 ｜ 證據: a16d5690

## Agent助理

- [Agent助理] 回合中追加指引（steer） — `POST /api/agent/sessions/[id]/steer` 透傳網關 `/agent/v1/sessions/:id/steer`；語義與 /messages 不同：不終止當前回合、不另起用戶消息；網關回 `status=injected`（已注入當前回合）或 `status=queued`（已排隊，本回合結束後生效），結果原樣透傳；D2b 修復 body 必須轉發（含 `steer_id`，否則命令身份層失去防重放意義）；長度上限權威在網關 `STEER_MAX_CHARS`，不在站內複製第二份常數 ｜ 證據: a16d5690
- [Agent助理] steer 引導鏈閘道側與前端整合 — 新增 `steer-core`／`steer-identity`／`steer-ledger-gw`／`steer-gw`（VPS 網關側）＋ composer `steerActive`＋ `agent-chat-reducer` 的 steer 處理與 `agent-steer-ui` 測試 ｜ 證據: a16d5690
- [Agent助理] 子代理在跑不再消失 — running 卡跨回合原樣保留，終態裁決權交給 `subagent.done`（async 子代理生命週期長於派出回合），根治「不顯示子代理」 ｜ 證據: d70732dd
- [Agent助理] 回合重試體驗與黏性渠道 — 重試時顯示「重试中 (x/10)」取代醜錯誤幀；重試預算 4→10；重試成功且有真實正文者把該模型釘為 session 黏性渠道（`personaModel` 快路，記 `stickyModel`），該渠道再跑掛即自動解釘交回常規鏈輪轉；重試用滿後依分類回「上游欠費／缺少該模型／持續報錯」三種訊息 ｜ 證據: 0b3dee7f
- [Agent助理] 移除中段靜默心跳「處理中（已 Ns）」 — 六檔機械拆除 `arm/clearQuietNoticeTimer`、`QUIET_NOTICE_MS`、`quietNoticeTimer` 欄位（哨兵體系 7→6）；活動可見性改由計畫卡即時上屏＋思維鏈承擔；一次性 `turn.status` 通知（已收到／誤判恢復／略去英文思考）全部保留，前端零改動 ｜ 證據: 461d775a
- [Agent助理] 思維鏈真秒數 — `reasoningMs`/`reasoningStartedAt` 入型別並在 reducer 兩個時機結算（首正文 delta／settleItems）；收合行顯示「已思考 · N 秒」，串流中顯示「正在思考…」；caret 加 trim 條件（首 delta 為 `\n` 時不再懸空閃爍） ｜ 證據: 6119e159

## 畫布與工作流

- [畫布與工作流] 打字路徑骨架富化：引擎衍生工具卡／配方卡／門禁卡 — `WorkflowNodeSpec` 加 `tools[]`／`notes[]`，`expandTemplate` 在 R8 克隆後、連線解析前衍生三類卡（pipelineCard tool/gate ＋ 配方 content 卡），id 遞增不撞、R8 克隆繼承；節點數 shortdrama_visual 14→81、novel_film 90、feature_film 51 ｜ 證據: 135528dd
- [畫布與工作流] 13 模板回填 tools/notes — 8 個 payload 模板逐字搬 `requiredTools`/`promptNotes`；`novel_film` 補 previs 白模預演步（8→9 環對齊 payload）；`feature_film` 照 novel_film 密度自寫配方級；4 個簡單模板輕量 ｜ 證據: 135528dd
- [畫布與工作流] 前端雙白名單放行衍生卡欄位 — `layout.ts toNodeMetadata` 與 `canvas-chat-types.ts compactMetadataForAgent` 放行 `pipelineCard` tool|gate|director＋五工具欄；NodeBody 零改動（分支已存在） ｜ 證據: 135528dd
- [畫布與工作流] gateway 下發畫布節點權威座標 — `emitNodeDelta` 不再發 `{0,0}`，改由 `computeSwimlanePositions` 照前端 `pipelineToCanvasLayout` 同款配方（lane/主節點、col/衍生卡、CARD_W 300／GAP_X 60／LANE_GAP_Y 330）計算，並蓋 `moved:true` 讓 `layoutGraph` 不重排；衍生卡 300x150 ｜ 證據: 275d387d
- [畫布與工作流] 配方卡新增 `note` 卡型 — 配方卡 metadata 補 `pipelineCard:note`（此前無標記落入純文字分支）；雙白名單＋聯合型＋NodeBody＋typeBadge 加 note（Lightbulb/配方/amber） ｜ 證據: 275d387d
- [畫布與工作流] 畫布 DAG 分層佈局 — 主鏈按依賴深度分欄＋barycenter 壓交叉＋衍生卡垂直脊柱；行內單向串聯（星狀穿透歸零）；`bezierPath` 改垂直底出頂入／長距離拱橋路由 ｜ 證據: a0cf8147
- [畫布與工作流] 角色/道具/場景/風格/音頻五值實體 kind — `CharacterCardKind` 3→5 值（character/scene/style/prop/audio）；變體不新增 kind，改用 `variantOf` 指母卡；存卡入口（右鍵選單、歷史對話框）五值化，並新增「存為角色變體卡→選母卡」 ｜ 證據: a7e169f3
- [畫布與工作流] 行內實體引用 `@[種類:名稱]` — `entity-tokens.ts` 就地展開 token，`applyCharacterCards` 展開時被引用的卡不再重複塞前綴；新增 `target`／`referenceScope` 兩個可選參數（缺省＝既有行為逐位元不變）；提示詞面板既有 @-mention chip 系統擴成兩組（圖片／素材卡）並序列化成 token ｜ 證據: a7e169f3
- [畫布與工作流] 分鏡參考素材解析可見（ShotReferencePanel） — 攤開「本鏡參考素材 N」，三段來源 token > shot > locked；未匹配 token 紅字警示；零空殼不渲染 ｜ 證據: a7e169f3
- [畫布與工作流] 模板自動落卡（emitsEntity） — gateway 模板節點 `defaults.emitsEntity` 送進 metadata（閘道側零引擎改動）；四個模板標記（character_sheet view1／scene_setup result／shortdrama_visual cast_card／novel_film char_card+art_card）；引擎解析 role→nodeId 支援四視圖聚合（referenceRoles → referenceNodeIds）；站點漸進聚合（updatedCards 就地更新既有卡）＋卡名第二來源（上游文本節點首行）＋退回標題時可見化 ｜ 證據: a7e169f3
- [畫布與工作流] 分鏡契約 propCardIds 全鏈路與門禁第⑤條 — `propCardIds` 貫穿 StoryboardQcShot／resolveReferenceAssetsToCardIds／productionFieldsFromContext 第④條；門禁第⑤條以節點 metadata 卡 id 為輸入，優先序 production > referenceAssets > nodeMetadata；真門禁 A/B：節點宣告卡 id → 17/17 ready=true，不宣告 → 15/17 blocked（characters_bound／scenes_bound）；`QC_REQUIRED_FIELDS` 刻意不含 propCardIds ｜ 證據: a7e169f3
- [畫布與工作流] 節點 metadata 耐久性放行 — 雙白名單（`layout.toNodeMetadata` ＋ `canvas-chat-types.compactMetadataForAgent`）放行 `emitsEntity`／卡名三鍵／四個卡 id 欄／`fontSize`（10..28，修「改字號重載即失」既有 bug）；漏放行 `emitsEntity` 時該能力「當下就被剝」而非重載才壞 ｜ 證據: a7e169f3
- [畫布與工作流] 分鏡批准與門禁裁決狀態持久化 — `metadata.approval`（分鏡批准）與 `metadata.gateConfirm`（門禁裁決）進 `types.ts`（宣告）、`layout.ts toNodeMetadata`（讀取端）、`canvas-chat-types compactMetadataForAgent`（上行端）三處；`toGateConfirm` 導出化供上行端共用同一份清洗；殘形／缺欄整包丟棄、不製造半形狀態（缺 `request_id` 的門禁卡按不下批准） ｜ 證據: f382569a
- [畫布與工作流] 資產／分鏡審查面板入口 chip — 「審查 · 待確認 N」chip 與面板 props（overlays／CanvasEmbed 兩面板掛載、五個 handler、檔位回讀、`patchShotApproval`） ｜ 證據: f382569a／891d0a6c
- [畫布與工作流] 畫布 cardIds 作用域閘 — `POST /api/canvas/projects` 的 `cardIds` 逐個過 `filterCardIdsForProject`（生成時卡注入讀的就是這份 cardIds）；跨項目、未顯式分享的卡不得鎖進本項目；個人卡逐位不變，查不到的 id 不猜（原樣保留） ｜ 證據: a16d5690

## 創作域

- [創作域] 生成中任務卡進歷史 — 歷史列表新增生成中卡片：粒子海動畫、無操作條、5s 輪詢（`HistoryClient` `setInterval(..., 5000)`） ｜ 證據: 7ee680cd
- [創作域] 歷史光箱拔除「發布為案例／存為角色卡」兩鈕 — 移除 `onSaveCard`／`onPublishCase` 兩顆工具列按鈕與其 props 掛載；mask 改純漸變 ｜ 證據: 7ee680cd
- [創作域] 生成血統（lineage）登記與視圖 — `generate-images` 完成落歷史時登記 `parents`：本次請求的參考圖若出自另一條生成任務（`sourceGenerationId`）記 derivation、直接引用產物（`sourceResultId`）記 reference；裸上傳無持久身份不登記；「再來 N 組」以 `retry_of_job_id` 落庫、源無 taskId 時用歷史把手 `history-<id>` 組 rerun；job 面為讀時投影組裝（存量任務同路徑自動可溯）；`LineageDrawer` 血統抽屜＋ `tools/backfill-lineage.ts` 回填工具；血統只落歷史本體，agent/canvas 兩面零觸碰 ｜ 證據: a16d5690
- [創作域] 資產作用域與血統清洗收口 — `asset-pack-store` 與 `character-cards` 共用 `asset-scope`／`lineage` 清洗：非法條目丟、上限截尾並顯式標記 `parents` 曾超限；非 project 一律收斂成 personal 並省略欄位（不寫 `scope:{owner:"personal"}` 冒充已設定） ｜ 證據: a16d5690
- [創作域] 修 `isUsableCardImageUrl` 誤判 `data:audio/` 為非法 — 修復內嵌參考音頻被靜默丟棄的缺陷 ｜ 證據: a7e169f3

## 帳號與增長

- [帳號與增長] QQ 交流群入口 — 手機端直跳加群分享頁；桌面端在導覽列提供與金幣膠囊同構的「售後/交流群組」鈕，點開二維碼彈窗，群號 980122175 一鍵複製 ｜ 證據: 0ef8381c

## 前端與UI

- [前端與UI] AI 助理聊天全量重設計（Grok 骨架＋Liquid Glass 皮） — 用戶 `lg-float` 玻璃氣泡、助手正文直鋪、思維鏈預設收合「已思考」；ToolCard/SubagentBar/BatchProgress 卡降級成無底色細行、狀態詞去膠囊（ios-blue 運行／ios-green 完成／ios-red 失敗）、整行觸發展開；composer `lg-float`＋specular 亮線＋品牌色送出鈕；決策卡不再鎖輸入框（2px 藍提示條＋新 placeholder）；空態輸入框 30vh 居中主角「想做点什么？」＋幽靈文字鏈示例；頂欄三幽靈鈕＋⋯收納歷史／資產／設置；拆 CanvasChatWorkstation 白底 `!important` 覆蓋層 ｜ 證據: 5e8196a1
- [前端與UI] 聊天滾動門檻單一真源 — `scroll-threshold.ts` 的 `NEAR_BOTTOM_PX=96` 統一全站聊天滾動判定 ｜ 證據: 5e8196a1
- [前端與UI] 批准用靜態預覽頁 `/agent-chat-preview` — 提供不依賴真實會話的聊天 UI 靜態預覽頁 ｜ 證據: 5e8196a1
- [前端與UI] 結果卡與決策卡語彙對齊 — F 路（圖/視頻/音頻/錨點/報告卡）figure 去灰底、幽靈動作條、幣數灰字、`lg-sheet` 補 specular 亮線；G 路（確認/問題/計畫/通知/導演卡）主 CTA `#2d3142`＋signature 陰影、金膠囊改幣金文字、計畫卡改工具行式折疊、膠囊全面灰階化；`lightbox` 500 行資產零改動 ｜ 證據: 9a777861
- [前端與UI] 工具行對版（類型圖標＋參數摘要＋幣數） — `toolRowIcon` 類型圖標映射（exact+rules 兩層）；參數摘要與幣數收進展開面板（key:value 行＋「消耗：N 幣」）；狀態詞「运行中…／完成／失败」 ｜ 證據: 6119e159
- [前端與UI] composer 逐項對版預覽設計 — 外殼 `gap-1 p-1.5`、textarea `rows=1`／`min-h-52`／`max-h-140`／`py-[15px]`／`leading-[22px]` 單形態；預設 placeholder「描述你想做的…」；送出鈕與 attach icon 同步 18px（Send→ArrowUp） ｜ 證據: 4917fd27
- [前端與UI] composer 長文本重排 — 按鈕下移一行（附件左、送出/停止右）、文字區全幅；三顆鈕 44→36px；附件鈕主色實底→淺灰幽靈（主色只留送出鈕）；textarea `max-h` 124→240px（約 10 行才滾）；後經 9609fc97 回滾 flex-col 但保留輕量化（恢復橫排 items-end） ｜ 證據: a17e1fb0／9609fc97
- [前端與UI] 計畫卡排版 — 懸掛縮排（標籤 absolute、正文 `pl-[38px]`）讓換行與首行左對齊、專家晶片自成排；後改 grid 兩列（auto+1fr、items-baseline）標籤與正文首行共基線、收合預覽與展開正文同字級行高（ios-subhead/1.55）零字體跳變 ｜ 證據: 9609fc97／c7f0ce68
- [前端與UI] 計畫卡細節 — 去掉 provisional「臨時」標記（數據層保留）；展開正文與「計畫」標籤同行、從緊鄰右邊開始折行；標籤字號對齊子代理卡（ios-footnote/medium/foreground-80）；計畫頭與思維鏈頭左緣對齊（`px-3`→`-mx-1 px-1`）＋header 頂距減 33%（`py-2.5`→`py-[7px]`） ｜ 證據: 13dd0b1b／16458779
- [前端與UI] 建號／忙碌態零位移 — 刪「正在建立會話…」行（在途回饋交給送出鈕轉圈）；拆掉 `sessionStarting || turnActive` 忙碌分流，歡迎態一套 DOM 從始至終；忙碌時推薦語仍渲染但強制 disabled；輸入框與歡迎態逐字同構 ｜ 證據: b403ac57／c7f0ce68
- [前端與UI] 問答卡截斷與橫向溢出根治 — `agent-transcript` 補 `overflow-x:hidden`；markdown `p` 補 `break-words`；卡片區限高 45dvh→62dvh（四選項卡不再被切）；question/label/description 全補 `break-words`＋`overflow-wrap:anywhere`（選項文字是答案、不能用 truncate 藏）；計畫卡摺疊預覽 `shrink-0 truncate`→`max-w-[45%]+min-w-0`；面板容器 `min-w-0`＋`overflow-x-hidden` 防護層 ｜ 證據: e18b1b05／6119e159
- [前端與UI] 空態禁止滾動 — 30vh padding 改真 `justify-center` 置中，矮視口不再溢出 ｜ 證據: 3a493b30
- [前端與UI] 空態 Liquid Glass 氛圍層與後續收斂 — 藍/粉/紫光斑烘進徑向漸變、光斑提濃推向卡片帶、環境光直鋪卡本身（`:has` 空態標記）、composer `lg-float` 玻璃上摺玻璃；最終（0b12f851）撤回空態玻璃裝飾，卡片恢復 `lg-card` 真玻璃（0.72 白底 + blur，不過透），backdrop 回到與首頁 `body::after` 逐字同配方 ｜ 證據: e60820e6／fe3ed2fb／38fbddb4／0b12f851
- [前端與UI] 工作站 backdrop 換鋪首頁同款環境光漸層 — 進 AI 助理底色不再被抹平；後續對比度刀提濃光斑、壓深底色 ｜ 證據: afadaee7／fe3ed2fb
- [前端與UI] QQ 入口排版與彈窗三輪根治 — 挪到左側貼 Logo、圖標換官方 Simple Icons 企鵝、二維碼裁正方形＋加寬 420px；Logo+QQ 包同一左組容器（`justify-between` 三子元素才會頂到中間）；彈窗徹底去重（拔標題行＋白色內嵌卡、二維碼直鋪 460px、關閉鈕浮右上、僅剩一行群號＋複製）；高度溢出修：面板 `max-h 100dvh-2rem`、二維碼封頂 60dvh（`object-contain` 保正方形） ｜ 證據: 5c427d55／91d802f4／711d8c65
- [前端與UI] 登出鈕不再被頂出膠囊 — 中段圖示收 36px、群組與帳號名讓位；640–1024px 收圖示與間距、寬螢幕再放回文字 ｜ 證據: 3ad48bd5
- [前端與UI] AI 助理面板吃滿天花板 — 面板頂至 0.75rem；navbar 經 `--ws-navbar-inset` 右退跟隨面板拖寬；聊天態與空態一律吃滿面板全高（`:has` 分流經 0924 終裁作廢） ｜ 證據: 9f0b1695／0cae069c
- [前端與UI] 首秒零回縮與寬度回填不跳變 — `--ws-panel-w` 單一真源首幀即終態＋`settled` 閘關水合動畫；存值升代 v2 赦免舊垃圾＋`beforeInteractive` 首幀前套用；修「載入後寬度回填跳變／秒縮回」 ｜ 證據: 1efcd34a／e09a9ffe
- [前端與UI] header-offset 站點框架 — Navbar sticky ＋ `--site-header-offset` 變數，供面板／dock 扣除頭部高度 ｜ 證據: a16d5690
- [前端與UI] ui-strings 單源字串表 — 新增 `src/lib/ui-strings.ts`（177 行）＋測試，集中站點文案（含簡體契約，如計畫卡「计划」） ｜ 證據: a16d5690／e18b1b05
- [前端與UI] 首頁版面三刀 — 左卡 `fit-content` 垂直置中＋40/60 默認寬＋減法陰影；輪播分頁收進卡內反色＋Dock 淨空；示例改橫向玻璃 chips ｜ 證據: a16d5690
- [前端與UI] 實體引用就地渲染成帶微縮圖的膠囊 — `entity-chip.tsx` 為唯一渲染真源：`EntityChip` 為 `lg-float` 圓角膠囊＋最左 16px 微縮圖格（有卡有圖放圖、否則種類圖示佔位，寬度恆定 ⇒ 卡庫載入前後零位移）；`EntityText` 把字串 token 就地換成膠囊；`EntityThumbStack` 卡面左緣最多 3 格 18px 微縮圖＋N 收尾；接線三處（AgentMarkdown InlineSpan、NodeBody 六處只讀正文、CanvasNodeView header） ｜ 證據: 50f7e436
- [前端與UI] 文檔中心收斂與教程 — `/docs/api` 重寫為教學向五章（對話/流程/設定五行含野獸模式/計費/帶走）＋開發進階附錄保留 spec 動態目錄；快速上手擴容三章（工作流：模板轉盤 8 條產線＋畫布節點操作＋續寫＋配方模板；歷史素材複用：篩選/懸浮動作/再來 N 組 vs 微調變體＋餘額兜底；充值：頂欄入口/四檔方案/支付到賬兌換碼）；文檔中心收斂為單一文檔 `/docs`（刪 api|mcp|harness|report 子頁） ｜ 證據: 9304b9e6／83e09bea／47b670ca

## 團隊與企業

- [團隊與企業] 團隊成員額度持久層與模型 — `db/migrations/019_team_member_quota.sql` ＋ `member-quota.ts`（成員＝new-api 另一 user 子帳號；查成員名冊、讀團隊配額視圖、`toCoins` 換算） ｜ 證據: a16d5690

## 非程式碼能力

- DB 遷移 019–022 — `019_team_member_quota.sql`、`020_account_ledger.sql`、`021_failure_record.sql`、`022_subscription_pools.sql`（團隊成員配額／帳本／失敗記錄／訂閱池四張表的 schema 落地） ｜ 證據: a16d5690
- VPS 網關部署產物 — steer 引導鏈閘道側檔案（`deploy-staging/gateway/steer-core.ts`／`steer-identity.ts`／`steer-gw.ts`／`steer-ledger-gw.ts` 與對應測試）、`outbound-emit.ts` 自 `outbound-sanitize.ts` 拆分；0b3dee7f 自陳「VPS 已同步跑同一碼，md5 逐檔等價」 ｜ 證據: a16d5690／0b3dee7f
- VPS harness 工具落檔 — `deploy-staging/vps-tools/image_generate.ts`（169 行）入庫，含影片時長硬規則與模型探測 ｜ 證據: a0cf8147
- 血統回填運維工具 — `tools/backfill-lineage.ts`（168 行），供存量歷史回填生成血統 ｜ 證據: a16d5690
- 外部服務整合 — mPay 支付回調（notify/return）容忍規則與拒絕日誌（手續費容忍上限 `max(0.5 元, 5%)`） ｜ 證據: ac8fa0c0
- 運營內容資產 — QQ 交流群二維碼圖檔（`public/qq-group-qrcode.jpg`，群號 980122175）與站點教程文檔（`/docs` 五章＋快速上手三章） ｜ 證據: 0ef8381c／83e09bea
- 發布物 — `public/docs/eimu-competition-report.pdf` 隨 a16d5690 入庫 ｜ 證據: a16d5690

## 邊界與拒絕

- [邊界語義] mPay 支付金額 fail-closed — 實收 < 應收一律拒絕；超出容忍上限（`max(0.5 元, 5%)`）亦拒絕；簽名失敗時欄位不可信只回原值供排障 ｜ 證據: ac8fa0c0
- [邊界語義] B 端參考圖非法形狀不靜默截 — `/v1/images/generations` 的 `reference_images` 形狀非法回 400；上限 5 超出以截尾＋warning 回報；role 未知收斂成 general 而非拒收 ｜ 證據: 2bd7217c
- [邊界語義] 控制面未啟用＋帶參考圖 → 501 fail-closed — 站點側只做欄位與解析，生成本身仍走控制面；控制面不可用時帶參考圖的請求明確 501，不降級成無參考圖生成 ｜ 證據: 2bd7217c
- [邊界語義] 行內實體 tag fail-open 與誠實降級 — `@[種類:名稱]` 未命中原樣保留；卡庫抖動降級成 warning 不讓生成失敗；前端未命中卡走虛線紅框且原文照留；零 token 輸出逐位元等於原文、不多包 span ｜ 證據: 2bd7217c／50f7e436
- [邊界語義] 資產「不可見即不可用」 — `/api/project-assets` 掛用前必過 `resolveMountable`，不可見一律 403 不得靜默成功；agent 注入項目包前過 `isAssetUsable`，無項目上下文＝不注入；個人口包逐位不變 ｜ 證據: a16d5690
- [邊界語義] 跨項目復用只認顯式分享 — `shares` 路由拒收 `cross_user`／`not_a_project_asset`（個人資產本身跨項目可用、無需分享）／`project_mismatch`／`same_project`；沒有隱含可見、沒有「同帳號自動放行」 ｜ 證據: a16d5690
- [邊界語義] 鬼狀態不降格 — 資產 scope 為 project 但無 projectId 時寫回 `GHOST_ASSET_SCOPE`（該卡在任何上下文都不可見/不可用），不降格成 personal；理由：降格＝把歸屬不明的項目資產變成人人可用的個人資產 ｜ 證據: a16d5690
- [邊界語義] 團隊成員金鑰不得自行分配額度 — 成員金鑰的 user 若已在成員名冊裡，呼叫 `/v1/team/quota` 分配回 403；分配只認團隊主帳（出資方） ｜ 證據: a16d5690
- [邊界語義] 門禁卡半形狀態拒收 — 缺 `request_id` 的門禁卡按不下批准；殘形／缺欄整包丟棄，不製造半形狀態 ｜ 證據: f382569a
- [邊界語義] 餘額負值與降級 — 客戶可見餘額可為負（真實狀態，不夾到 0）；帳本儲存層不可用時 `/v1/quota` 退回讀 `users.quota`（C 端顯示不因權威搬遷而斷） ｜ 證據: a16d5690
- [邊界語義] 記帳失敗不擋路 — admin provision 的帳本雙寫失敗不阻止上游額度調整，差額交由對帳報告指出 ｜ 證據: a16d5690
- [邊界語義] 歷史代理 fail-soft — 控制面不可達或非 2xx 時 `/api/history` 只記日誌回本地那部分記錄，不讓歷史頁整體失敗 ｜ 證據: 8ece45dc
- [邊界語義] 影片時長 <10 秒直接拒絕 — harness `image_generate` `duration_seconds` 最小 10，schema 層擋下；task_id 必須完整 36 字元 UUID 禁止縮寫 ｜ 證據: a0cf8147
- [邊界語義] 忙碌／建號態防二次計費 — 忙碌時推薦語 disabled、拒絕重複送出（避免同一次生成被提交兩次計費） ｜ 證據: b403ac57／c7f0ce68
- [邊界語義] 音頻實體 target 刻意無生產呼叫端 — 查證站上無「拿得到鎖定卡」的音頻生成入口（v1/tts 是 B 端、input 語義為朗讀文本；畫布無 audio 生成分支），故 `target:"audio"` 無生產呼叫端，四個模板 voiceover 刻意不標 ｜ 證據: a7e169f3
- [邊界語義] 資產確認閘生產惰性 — AssetReviewPanel/ShotReviewPanel/gateConfirm 的閘道側本次不部署，確認閘在生產需閘道端 `markGateNodeState` 寫入才生效 ｜ 證據: a7e169f3
- [邊界語義] 選項文字不得用 truncate 藏 — 問答卡 question/label/description 是答案，一律 `break-words`＋`overflow-wrap:anywhere`，不以截斷藏答案 ｜ 證據: e18b1b05
- [邊界語義] 白模預演補步與模板互斥 — 領域模板與泛用骨架互斥；`ecom_launch` 收緊為「明確要上市物料」，不帶領域詞的普通多鏡頭影片兜底 `feature_film`，單圖/none 對照組不變 ｜ 證據: c7d0fad1
- [邊界語義] copy-on-use 掛用的崩潰／辨偽邊界 — 9 條對抗斷言：刪到一半崩潰重試收斂且 `deletedCards` 誠實不回虛報；記錄混入別 project 真副本或 derivation 指向別來源者拒刪；另一用戶同 id 卡庫只動本人 store；二次解除為 no-op；建副本一半崩潰孤兒由重掛收編再解除全清 ｜ 證據: e53324cf
- [撤回／移除] 撤回創作流程步驟條呈現 — 暴君裁定「為什麼創作流程要這樣靜態顯示？先撤回」，刪 `wizard-steps` 及其 UI 掛載；雙白名單收鍵（approval/gateConfirm）與審查面板入口保留（見畫布與工作流節） ｜ 證據: 891d0a6c
- [撤回／移除] 撤回空態玻璃裝飾 — 卡片恢復 `lg-card` 真玻璃、backdrop 回與首頁逐字同配方（不同步即劣化） ｜ 證據: 0b12f851
- [撤回／移除] 移除中段靜默心跳通知 — 「處理中（已 Ns）」不再發送；一次性 `turn.status` 通知保留 ｜ 證據: 461d775a
- [撤回／移除] 歷史光箱移除「發布為案例／存為角色卡」鈕 ｜ 證據: 7ee680cd
- [撤回／移除] 拔除 biz-key-token-mapping 影子映射（G1）＋測試斷言該檔不存在 ｜ 證據: a16d5690

## 存疑

- [存疑] `deploy-staging/vps-tools/image_generate.ts` 與 VPS 活體工具是否同一份 — commit 為新檔入庫，但未附 harness `image_generate` 的 md5/版本對帳；本 repo 是否為 VPS 活體鏡像、該硬規則是否已在生產生效，缺證據 ｜ 證據: a0cf8147
- [存疑] `deploy-staging/gateway/*` 是否已上生產 — 本批多個 gateway 改動（jev 模板 c7d0fad1／骨架衍生 135528dd／泳道座標 275d387d／心跳移除 461d775a）落在 `deploy-staging/gateway/`，除 0b3dee7f 自陳「VPS 已同步 md5 逐檔等價」外，其餘未附部署對帳；訊息不足以判定生產是否已跑新碼 ｜ 證據: c7d0fad1／135528dd／275d387d／461d775a
- [存疑] 指標投影是否落地 — `statistics-projection` 於 a16d5690 入庫（62KB），但當時是否已接上生產 DB 與管理頁觸達未在訊息中說明；記憶 2026-09-30-decision-table-coverage-audit 另載「P2-1/P2-2 交付但生產不可見，2026-09-30 才修（共享 admin session 祕密＋把 /api/admin/statistics 加進控面代理清單）」 ｜ 證據: a16d5690
- [存疑] 9304b9e6 的 `/docs/api` 五章在 47b670ca 後是否仍存在 — 47b670ca 刪除了 `src/app/docs/api/page.tsx` 並收斂為單一 `/docs`；兩者是否為同一內容的搬遷（能力保留）或功能縮減，訊息未逐字對應 ｜ 證據: 9304b9e6／47b670ca
- [存疑] 真上游是否吃下參考圖與 agent 真回合 — 2bd7217c 自陳「真上游是否吃下參考圖與 agent 真回合未驗，屬誠實邊界」；本批未附生產端到端證據 ｜ 證據: 2bd7217c
- [存疑] 生成中卡片進歷史需依賴 VPS 任務投影 — 7ee680cd 的行為在本地控制面未啟用時是否可見未驗（與 8ece45dc 代理修復互為條件） ｜ 證據: 7ee680cd／8ece45dc
- [存疑] test-only commit 的能力歸屬 — `de568aba`（僅測試字串對齊，無產品行為）與 `e53324cf`（僅測試入庫，被測能力由 a16d5690 交付）都不含新生成能力；列表中不計為能力條目，僅 e53324cf 抽出邊界語義 ｜ 證據: de568aba／e53324cf

## 逐條對帳

- `5e8196a1` — 聊天全量重設計（玻璃氣泡/工具行降級/composer/空態/頂欄收納）＋滾動門檻單源＋批准用預覽頁（前端與UI 3 條）
- `3a493b30` — 空態禁止滾動、真置中（前端與UI）
- `c7d0fad1` — 打字路徑自動選模板（13 模板判準）＋ 7 領域重模板入池（模型與供應商／畫布與工作流邊界）
- `4917fd27` — composer 逐項對版預覽（前端與UI）
- `9a777861` — 結果卡/決策卡語彙對齊＋光標亂閃修復（前端與UI）
- `135528dd` — 骨架富化：衍生工具卡/配方卡/門禁卡＋13 模板回填＋雙白名單放行（畫布與工作流 3 條）
- `e18b1b05` — 問答卡截斷/橫向溢出根治（前端與UI＋邊界：選項不得 truncate）
- `6119e159` — 思維鏈真秒數＋工具行對版＋溢出根因清剿＋卡片對版（Agent助理／前端與UI）
- `275d387d` — gateway 下發權威座標＋moved 章＋配方卡 note 卡型（畫布與工作流 2 條）
- `13dd0b1b` — 計畫卡/輸入區細化（前端與UI）
- `ac8fa0c0` — mPay 回調手續費容忍＋拒絕分支全補日誌（控制平面與計費＋邊界）
- `a17e1fb0` — composer 長文本重排（前端與UI）
- `9609fc97` — composer 橫排輕量化回滾＋計畫卡懸掛縮排（前端與UI）
- `b403ac57` — 建號忙碌態劣化拔除、輸入框與歡迎態同構（前端與UI＋邊界防二次計費）
- `c7f0ce68` — 忙碌態單一 DOM 零位移＋計畫卡 grid 基線（前端與UI）
- `16458779` — 計畫頭與思維鏈頭左緣對齊＋頂距減 33%（前端與UI）
- `461d775a` — 移除中段靜默心跳通知（Agent助理／撤回移除）
- `afadaee7` — 工作站 backdrop 換首頁同款環境光（前端與UI）
- `e60820e6` — 空態 Liquid Glass 氛圍層（前端與UI）
- `9304b9e6` — `/docs/api` 重寫為教學五章（前端與UI）
- `fe3ed2fb` — 玻璃感對比度刀（前端與UI）
- `38fbddb4` — 空態玻璃三刀（前端與UI）
- `7ee680cd` — 生成中卡進歷史（粒子海＋5s 輪詢）＋移除發布案例/存角色卡兩鈕（創作域 2 條）
- `0b12f851` — 撤回空態玻璃裝飾、卡復真玻璃（撤回移除）
- `47b670ca` — 文檔中心收斂單一文檔＋刪四子頁（前端與UI）
- `8ece45dc` — Vercel 歷史經控制面代理歸併任務記錄（控制平面與計費＋邊界 fail-soft）
- `0ef8381c` — QQ 群入口（帳號與增長）
- `5c427d55` — QQ 入口三刀排版（前端與UI）
- `91d802f4` — QQ 鈕置中根治＋彈窗去重（前端與UI）
- `711d8c65` — QQ 彈窗高度溢出修（前端與UI）
- `a0cf8147` — 畫布 DAG 分層佈局＋harness image_generate 時長硬規則（畫布與工作流／生成核心 3 條）
- `d70732dd` — 子代理在跑不再消失（Agent助理）
- `0b3dee7f` — 重試體驗三刀＋黏性渠道（Agent助理／運維部署產物）
- `83e09bea` — 快速上手擴容三章（前端與UI）
- `a16d5690` — 全量收尸：steer 引導鏈／餘額權威帳本／團隊配額／資產空間與顯式分享／血統／統計／遷移 019-022／ui-strings／header-offset／首頁版面／拔 biz-key-token-mapping（多領域，見上）
- `de568aba` — 純測試（ImagePlayground 字串探針對齊）；無新能力
- `e53324cf` — 純測試入庫（copy-on-use 對抗 9 斷言）；被測能力由 a16d5690 交付，本條僅貢獻邊界語義
- `9f0b1695` — AI 助理面板吃滿天花板（前端與UI）
- `0cae069c` — 空態不再縮卡、一律吃滿全高（前端與UI）
- `1efcd34a` — 首秒零回縮（前端與UI）
- `e09a9ffe` — 消滅寬度回填跳變（前端與UI）
- `3ad48bd5` — 登出鈕不再被頂出膠囊（前端與UI）
- `a7e169f3` — 五值實體化＋行內 @token＋模板自動落卡＋四視圖聚合＋門禁閉環＋metadata 耐久性（創作域／畫布與工作流共 7 條）
- `f382569a` — 步驟條接對話區＋批准/門禁雙白名單收口（畫布與工作流 3 條）
- `891d0a6c` — 撤回步驟條切片、保留雙白名單與審查面板（撤回移除）
- `2bd7217c` — B 端參考圖＋行內 tag 角色卡＋B 端卡 API＋resolve 前端（B端API／生成核心共 6 條）
- `50f7e436` — 實體引用就地渲染成帶微縮圖膠囊（前端與UI）