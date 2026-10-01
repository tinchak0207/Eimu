# image-app 第 2 批（47 commits）能力窮舉清單

- 來源：/tmp/cap/batch-2.txt、/tmp/cap/batch-2.hashes（唯一真源）
- 口徑：能力 = 使用者可見或可呼叫的行為，不是檔案存在。修復類若暴露新邊界語義亦收錄。
- 領域標籤：生成核心 / 模型與供應商 / 控制平面與計費 / B端API / Agent助理 / 畫布與工作流 / 創作域 / 帳號與增長 / 前端與UI / 運維與觀測 / 團隊與企業
- 本批 commit 數：47；能力條數：96；存疑條數：9；本批無「團隊與企業」領域命中。
- 分領域計數：生成核心 9／模型與供應商 6／控制平面與計費 2／B端API 3／Agent助理 16／畫布與工作流 5／創作域 23／帳號與增長 5／前端與UI 16／運維與觀測 11／團隊與企業 0。

## 生成核心

- [生成核心] 內容審核類失敗歸為不可重試 — HTTP 451 或命中 legal_error／content_rejected／compliance filter 時 failureClass=content_rejected、retryable=false、不切換供應商、不隔離、無冷卻；其餘失敗分類路徑不變 ｜ 證據: efe3d029
- [生成核心] 生成品質門 v1（前置確定性檢查） — 空提示詞／超長（>6000）／非法寬高比／負面詞反噬所選風格等「可判定」項阻斷提交，不可判定項 status=skip 僅記錄；零外部依賴 ｜ 證據: 4557829f
- [生成核心] newapi／openai 視頻上游 adapter — 新增 newapi-video-upstream 與 openai-video-upstream 兩條上游提交通道（取代單一 adobe2api 視頻路徑） ｜ 證據: ffc6e9af
- [生成核心] 提交前配額預檢（quota-precheck） — 任務進入通道前先做上游配額檢查，避免先受理後才發現上游不可用 ｜ 證據: ffc6e9af
- [生成核心] Blender 節點接入生成管線 — blender-node-upstream 把 blender 渲染節點當一等生成上游，可經既有任務通道派發 ｜ 證據: c005c4bf
- [生成核心] 3D 場景卡嵌合視頻生成 — /api/generate-videos 接受 scene_card／camera_trajectory 兩欄，經 fuseSceneVideo 併入視頻 prompt；缺欄時零行為變化 ｜ 證據: 5f8170c8
- [生成核心] Modal 雲端 Blender 渲染暖復用與場景快取 — 以 sha256 為鍵命中場景快取即跳過 open_mainfile 與重編譯；blend 單幀暖 0.4–1.8s vs 冷 20.8–22.7s（$0.036/10 幀鏈） ｜ 證據: 4b5b464b
- [生成核心] C 端生成完成後的寫盤挪出關鍵路徑 — localStorage 生成快取改在 requestIdleCallback 執行並節流 ≥500ms（Safari 降級 setTimeout），避免生成結束瞬間搶主線程 ｜ 證據: 36ce9469
- [生成核心] hub 渠道固定路由（routing_class=hub_only） — DB 約束擴充第三種 routing_class，讓 routing_hint=hub 的 Gatus uptime 探針固定走 hub 渠道，不被 supply_tier 排序到 adobe2api ｜ 證據: 0455beb0

## 模型與供應商

- [模型與供應商] filmera 渠道 24/7 自愈 — token 自動輪換並持久化回 env 文件（worker 重啟不退回舊 token）、project/node 自愈、純插值去水印；凍結成 protocol=filmera 的渠道 ｜ 證據: 06c6fdda
- [模型與供應商] 帳號池守護（402 自動切號） — 帳號常駐註冊保活，遇 402 額度不足自動切換下一帳號，並掛載 worker env ｜ 證據: 06c6fdda
- [模型與供應商] 渠道 registry 化與一鍵註冊 — 渠道條目集中登記於 supplier-channels.config，tools/add-supplier-channel 提供註冊入口；registry 條目映射為 env 渠道描述子 ｜ 證據: 06c6fdda
- [模型與供應商] Blender 節點以 supplier channel 形態接入 — supplier-channels 新增 adapterType=blender_bridge、blender-local／blender-modal 渠道條目，catalog 掛 blender-render-eevee／cycles 能力標籤，director-engine assetLoader 接線 ｜ 證據: 5f8170c8
- [模型與供應商] 模型知識面三字段 — generation-model-catalog/knowledge 為模型卡補上知識面欄位，供模型卡呈現 ｜ 證據: 4557829f
- [模型與供應商] 模型檔位解析器（resolution.ts） — 依模型實際支持的 aspectRatios／resolutions／durations 解析請求值，不支持則回退模型預設（aspectRatioFromImageSize 由像素反推比例） ｜ 證據: 0455beb0

## 控制平面與計費

- [控制平面與計費] INC-0831 供應商對帳（provider-reconciliation） — 新增上游對帳模組，含 metaso／newapi／filmera 三條 poll 分支，把「上游其實成功」與「我方記失敗」對齊 ｜ 證據: ffc6e9af
- [控制平面與計費] 自訂檔位計價（plans.ts） — 0.045 幣/金幣單點權威、custom:<coins> 服務端計價，含 clampCustomPlanCoins／snapCustomCoins／customPlanFor 及 9 檔位；方案折扣與 GPT Image 2 等價張數換算 ｜ 證據: 0455beb0

## B端API

- [B端API] B 端 key 代理路由（/api/agent/biz/[...path]） — 把插件（emu_wish 等）帶 B 端 key 的 agent 網關請求換發為使用者派生 key 後轉發，零網關改動；GET events 以 SSE 流式透傳 ｜ 證據: 87167706
- [B端API] B 端代理路徑正規化 — 消除重複的 agent/v1 前綴段，兩種 baseUrl 形態皆可正確轉發 ｜ 證據: 0f28e05f
- [B端API] 用戶自助管理 B 端 API key — 設定頁可自助建立／列出／撤銷綁定 userId 的 biz key（/api/user/biz-keys 與 /[id]） ｜ 證據: b097b4b3

## Agent助理

- [Agent助理] 免登入提示詞優化端點（免費層鉤子） — POST /api/agent/optimize-prompt：Agent 層優先、失敗回落規則層、皆無效回 502；每 IP 10 分鐘 20 次限流；不讀任何授權頭 ｜ 證據: b097b4b3
- [Agent助理] 免費優化端點回傳六槽結構化 JSON — extractSixSlots(prompt, mediaType) 輸出六槽 JSON，並以 media_type 區分 image／video 兩種分流 ｜ 證據: cbf81b62
- [Agent助理] SOTA agent 工作流模板工業化 — 8 模板加 pipeline 與 requiredTools／tool-contract／domain 註冊表（agent-tool-contract／agent-tool-registry／agent-tool-adapter） ｜ 證據: 06c6fdda
- [Agent助理] 助理模板庫（四領域 SOTA 模板） — AgentTemplateGallery 左對話右模板庫，小說／電商／短劇／藝術各 3 張，資料層 lib/agent-templates ｜ 證據: ef0bbc6b
- [Agent助理] 模板流水線藍圖字段 — AgentTemplate 新增 pipeline 字段（步驟含 deliverable／inputFrom／promptNotes／gate），8 張流水線藍圖（每領域 2 張），骨架為文本結構化→資產先行→門禁審核→組裝產出 ｜ 證據: 6bf50774
- [Agent助理] MOE 專家軍團（7 Expert） — 7 個 Expert persona／delegate／契約框架（blender-director／music／video／editor／screenwriter／motion／web3d）＋ expert-registry／expert-contract 註冊表 ｜ 證據: c2b79797
- [Agent助理] orchestrator 野獸幀 — orchestrator-beast-frame 提供野獸模式的編排回覆框架（OFF 時回覆鍵逐欄位同現狀） ｜ 證據: c2b79797
- [Agent助理] vision／web_search 工具註冊 — harness-tool-registry 補上視覺與網路檢索工具 id ｜ 證據: c2b79797
- [Agent助理] 輸入筆記與畫布圖的宣告式 DSL — workflow-dsl 提供 compile／decompile／schema，AI 筆產出 DSL 可編譯成畫布圖、畫布圖可反編譯 ｜ 證據: ffc6e9af
- [Agent助理] harness 工具註冊表 — harness-tool-registry 納入可用工具清單 ｜ 證據: ffc6e9af
- [Agent助理] persona 放行資產檢索工具 — 3D 導演 persona 契約放行 asset_search／asset_get ｜ 證據: 86b2584b
- [Agent助理] wish 會話併入用戶助理空間 — 經 B 端 key 代理路由把 wish（插件）會話與用戶網頁助理合併為同一隔離空間，並提供 session 深鏈 ｜ 證據: 87167706
- [Agent助理] 音頻成品卡 — AgentAudioCard 呈現 TTS／音樂類成品 ｜ 證據: d6e1ceb2
- [Agent助理] 子代理跑馬燈與報告卡 — AgentSubagentBar 尾隨跑馬燈＋AgentSubagentReportCard 提交報告卡 ｜ 證據: d6e1ceb2
- [Agent助理] 會話身份與標題正典化 — 會話標題雙軌（網關摘要優先）、switchSession 解鎖、歷史 normalizer、resolve-owner 身份正典化、beast-mode 設定端點 ｜ 證據: d6e1ceb2
- [Agent助理] 附件上傳與發送同源 lazy 建號 — ensureSession 走 start() 串行化管線，修復空態附件鈕恆 disabled 的回歸，附件可先於發送建立會話 ｜ 證據: d6e1ceb2

## 畫布與工作流

- [畫布與工作流] agent 模式畫布常駐 — 右面板常駐 canvas，resultMode 純派生，刪除中間態切換 ｜ 證據: ef0bbc6b
- [畫布與工作流] 模板 pipeline 鋪多步驟 canvas 工作流 — 每個 pipeline 步驟鋪一泳道（步驟節點帶產出／要點／門禁＋生成節點），步內 step→gen、步間 gen→next-step 鏈式連線；無 pipeline 走舊兩層兜底 ｜ 證據: f653b458
- [畫布與工作流] 場景 3D 卡接畫布節點 — Scene3dCardBody／Scene3dGltfViewport 讓 3D 場景以節點卡形態存在並可預覽 GLTF ｜ 證據: c005c4bf
- [畫布與工作流] 短劇生產域工具狀態機 — shortdrama-domain 8 支工具（script_scene_parse／storyboard_qc_17 等）＋統一回執契約（status/gates/canvas metadata/unsupportedCode）與 17 道門禁 ｜ 證據: 06c6fdda
- [畫布與工作流] 導演台 R1–R3 與 proposals 持久化 — seed 門禁泛化、capabilities、shot_count、addGroup 重疊守衛；proposals 磁盤持久化；前端 AgentDirectorCard／DirectorMiniViewport three.js 視口 ｜ 證據: ffc6e9af

## 創作域

- [創作域] 配方模板六槽具名 profile — 具名的六槽參數快照可攤進工作台表單修改，套用走 parseWorkflowRecallConfig 同一驗證路徑；含配方模板捕獲器與 Blob 世代儲存 ｜ 證據: 4557829f
- [創作域] showcase 案例雙向化（用戶投稿） — 歷史配方可一鍵發布為社區案例，與官方案例合併在首頁環展示（現僅發布者瀏覽器可見，讀／寫兩函數預留服務端審核替換點） ｜ 證據: 4557829f
- [創作域] 短劇配方五段管線 — outline／cast／art／script／storyboard 五段 JSON 接力收斂為一條配方，能算的不讓模型猜（分鏡秒數按語速折算、批次切分、資產清單），資產引用複用 character-cards 卡體系 ｜ 證據: 4557829f
- [創作域] 審查頁單頁組裝器 — 由 boards-store 的 SavedShotMeta 生成可渲染 pane 模型（每鏡一 pane、分組與 hash 錨點），供 /review 單頁合成模式 ｜ 證據: 4557829f
- [創作域] 歷史一鍵存為角色卡 — 歷史記錄的圖可錨定成 character-card（HistoryEntry→卡 payload），走 normalizeCharacterCard 唯一清洗 ｜ 證據: 4557829f
- [創作域] 電商新品上架 domain adapter — 8 支工具（product_lock／background_remove／product_conditioned_generation 等）契約與映射，只做 planning/translation 不擁有 queue／billing／history／artifact ｜ 證據: 06c6fdda
- [創作域] 時裝 flat-lay→模特 domain 工具 — 8 支工具契約（garment_extract／virtual_tryon／hand_contact_repair 等），僅 shot_grid_batch 對映到本倉已具能力、其餘誠實標 unsupported ｜ 證據: 06c6fdda
- [創作域] 小說／IP 視覺包 domain 契約 — 7 支工具（world_bible_extract／emotion_board_matrix／style_anchor_sref 等）的宣告式投影與 canvas metadata 契約 ｜ 證據: 06c6fdda
- [創作域] 3D 導演工作站工具族 — blender_exec／blender_export_gltf／blender_render 三支工具（Blender 5.2 兼容、分塊 10 幀 turntable 存活配方）＋ headless 執行橋 ｜ 證據: c005c4bf
- [創作域] 3D 導演 persona 交付契約與嵌合三件套 — blender-director-persona 交付契約＋ camera-trajectory-to-prompt／scene3d-video-fusion／blender-to-video-bridge 把鏡頭軌跡與 3D 場景嵌進生成 ｜ 證據: c005c4bf
- [創作域] 3D 資產指紋零 token 復用 — blender-asset-store 以 FNV-1a 指紋雙通道復用既有資產，命中不走模型 ｜ 證據: c005c4bf
- [創作域] blender-director SKILL 配方庫（五階段＋12 份） — 五階段 SKILL 手冊與 12 份上游配方＋seed-mapping 入庫 ｜ 證據: c005c4bf
- [創作域] blender-director 配方庫對稱差擴容 12→105 — 逐目錄 verbatim 吃進工藝資產／風格 mood／特效／產品運鏡／圖轉 3D 等配方，附來源/license/雷區白名單註釋塊 ｜ 證據: 07038697
- [創作域] 五個新頂級 skill 域 — make-blender-education-video／motion-design／astra-ad-studio／web-3d-awwwards／blender-agent-os 五域入庫 ｜ 證據: 07038697
- [創作域] 12 資產庫入庫 — seed-asset-packs／seed-openasset-packs 冪等 upsert，落地 91 包／2935 條×2 戶並以五庫搜索驗證 ｜ 證據: 86b2584b
- [創作域] blender 執行成功自動入庫與指紋命中 — blender_exec 成功自動 saveSceneAssets 入庫、執行前指紋命中回報 template_hit、result 帶 artifact_base_url 供產物取回 ｜ 證據: 86b2584b
- [創作域] 3D 路由硬規則（禁二維頂替） — SKILL 明訂 3D 需求必須走 3D 工具鏈，禁止用二維生成頂替 ｜ 證據: 86b2584b
- [創作域] kunpeng 知識與提示詞模板資產 — kunpeng-knowledge／kunpeng-prompt-templates／kunpeng-style-assets 三份知識資產入庫並附紅線測試（禁 ffmpeg／Kimi 等字串） ｜ 證據: ffc6e9af
- [創作域] 音樂 Expert 配方庫（SunoForge v3.0 六層公式） — 六層 style 公式 GENRE→MOOD→INSTRUMENTATION→VOCAL→STRUCTURE→PRODUCTION，含診斷 12 查／詞彙表／45+ 風格預設，14 檔入版控 ｜ 證據: 3b29f169
- [創作域] 音樂通路判定先於配方 — 首頁改為通路判定對照表，DATA_FLOWMUSIC 實測入庫：時間戳在 FlowMusic2API 無效、無歌詞標籤時 style prompt 壓單行上限 220 runes、帶 [Verse]/[Chorus] 走保版面分支（上游自行加寫段落並產 A/B 兩版）、BPM／調性／instrumental 有效 ｜ 證據: a54ea6d0
- [創作域] 音樂工具家族 — music_gen／music_lyria／music_flowmusic 三支工具＋adapter＋staging 導出器入庫（音樂生成可被 harness 調用） ｜ 證據: 9a6ee963
- [創作域] 音樂 prompt 確定性規則層 — 六層偵測＋缺層補齊、偽標籤剝除、anti-slop、mood ≤2，外加通路感知（flowmusic 剝無效時間戳、無歌詞標籤壓單行並按層權重守 220 runes，超限整層丟棄記 truncated；lyria 保留時間戳）；零 import 純函數決定性 ｜ 證據: 86eb165f
- [創作域] 音樂 prompt 硬截用滿預算 — 首 cap runes 內存在 ≥60% cap 的子句邊界才退讓，否則退最後空白（避免切斷拉丁單詞），CJK 直接在 cap 切；同一輸入由 15 runes 提升到 217 runes 且保住 mood／genre／instrumentation ｜ 證據: bdb8b81a

## 帳號與增長

- [帳號與增長] GitHub 一鍵授權 DSH 插件並自動簽發 biz key — emu-oauth 產 60s 簽名碼（HMAC，timingSafeEqual 驗證），callback 帶 loopback cookie 時 302 回 DSH loopback（保留站點 session），exchange 驗碼後簽發綁 userId 的 sk-biz- key ｜ 證據: b097b4b3
- [帳號與增長] PWA 跨瀏覽器登入 handoff — 常用瀏覽器完成 GitHub 授權後以一次性 ticket 交回 PWA（create→callback 帶 state→poll→一次性 claim 種 napi_token），解決 standalone storage 隔離；TTL 10 分鐘 ｜ 證據: 5f8170c8
- [帳號與增長] auth 韌性鏈 — auth/me 遇壞殘留憑證反查重試（newapi-session-token），fetchMe transient 錯誤不抹憑證，github-login 補齊 ｜ 證據: 5f8170c8
- [帳號與增長] newapi 會話 token 反查 — api/internal/newapi-session-token 由憑證反查 userId／會話 ｜ 證據: 5f8170c8
- [帳號與增長] auth/me 硬超時與微快取 — 對控面 GET /api/user/self 加 2.5s 硬超時（超時回 503 走 transient），成功結果 30s TTL／上限 500 條微快取，key 為憑證 SHA-256 雜湊 ｜ 證據: c2b79797

## 前端與UI

- [前端與UI] 失敗提示依錯誤碼分類顯示 — 依 errorCode／errorMessage 正則給出人類可讀提示，新增「當前帳號無影片生成權益」與「內容審核未通過」兩類 ｜ 證據: efe3d029
- [前端與UI] 點模板卡注入提示與鋪畫布 — 點卡即注入 initialPrompt（複用 useAgentChat().send）並用 slots 鋪 canvas workflow，可 undo ｜ 證據: ef0bbc6b
- [前端與UI] ModelPicker flyout 固定寬 — 展開能力卡時固定 lg:w-[24rem]，不再抖動 ｜ 證據: ef0bbc6b
- [前端與UI] 模板入口旋轉木馬 — AgentTemplateCarousel 繼承 case-showcase 全套物理（拖拽／慣性／彈簧／鍵盤／磁力落格），300px 卡寬，僅正面卡觸發 onUseTemplate ｜ 證據: f653b458
- [前端與UI] 模板卡材質層棧修復 — 補 edge／surface（sheen／rim）光照四件套、GL 缺席冷光 inset、grid 置中、pointer-events 由 slab 承接；測試鎖死五層 JSX 防再砍層 ｜ 證據: 476244e0
- [前端與UI] 模板卡海報區重造 — 卡面 55% 領域海報區（領域大字水印＋pipeline 步驟鏈），8 張按領域 accent 配色，卡寬 320→420 豎版，文字區垂直置中 ｜ 證據: 7b8f5992
- [前端與UI] 歷史「再來 N 組／微調變體」重跑 — 把歷史記錄完整配方 payload（六槽＋模型＋尺寸）批量提交到 /api/generation-jobs，支援只改 prompt／換模型／換尺寸；帶 retryOfTaskId 父鏈與參考圖繼承；組數檔位 1/2/3/5/8 ｜ 證據: 4557829f
- [前端與UI] 定價彈窗重構 — PricingClient 重構並導入 PricingQuality 品質測試 ｜ 證據: 4557829f
- [前端與UI] 生成中粒子海彈等候視覺 — ParticleSeaWaiting（藍粉灰 1:1 卡內鋪滿）接 ImageDisplay isRendering 分支，後續重做為生成中海底視覺 ｜ 證據: 5f8170c8
- [前端與UI] 定價方案輪播卡 — PricingPlanCarousel 輪子＝AgentTemplateCarousel 逐行複製，含自訂檔 Log Scale 滑桿 ｜ 證據: 0455beb0
- [前端與UI] 燈箱與編輯面板／參考圖 — 燈箱復用（ImageLightbox），PromptInput 編輯面板與參考圖上傳（ReferenceImageUpload）重做 ｜ 證據: 0455beb0
- [前端與UI] 工具顯示名映射 — 113 鍵工具 id→顯示名映射，agent 工具卡不再顯示裸 id ｜ 證據: d6e1ceb2
- [前端與UI] Service Worker v2 與下載穿透 — 拆除 navigate 攔截（登入 redirect 不再被寫入快取毒藥面），CORS 圖下載以 ?dl=1 穿透（imageHelpers 與 nginx default.conf 同步） ｜ 證據: 5f8170c8
- [前端與UI] 手機端批次修復 — Seedance 時長 10s 地板、手機全螢幕助理、彈窗置中 ｜ 證據: 5f8170c8
- [前端與UI] 工作台 boards 庫導入參考圖 — 從資料夾導入 shot 為參考圖時量測自然尺寸（measureNaturalSize）並帶入，避免比例失真 ｜ 證據: 00af5fb9
- [前端與UI] 工作台引導行動端適配 — tour 文案更新＋移動端三件（可見錨點解析、容器 .pro-studio-body 滾動同步、移動端安全彈層方位），修 driver.js 在 <1024px 的錯位 ｜ 證據: 00af5fb9

## 運維與觀測

- [運維與觀測] /v1/model-status 追加 24 小時表現統計 — 每模型追加 jobs／delivered／failed／success_rate／refunded 的 last_24h 真實數據，與 /admin 模型分布同源 ｜ 證據: 62610cfe
- [運維與觀測] 生成品質門日誌 — generation-gate-log 以 Blob 世代儲存每用戶門禁檢查紀錄（上限 500 條）並統計各門觸發率（fail/(pass+fail)） ｜ 證據: 4557829f
- [運維與觀測] 餘額信號與供應商健康同源裁決 — model-status R7-E 餘額信號＋supplier-health-signal 讓執行側與觀測側對供應商可用性做同源裁決 ｜ 證據: ffc6e9af
- [運維與觀測] admin 路由調度面板顯示產出圖 — AdminRoutingPanel 展開路由調度時顯示對應產出圖 ｜ 證據: 06c6fdda
- [運維與觀測] 橋上產物取回端點（GET /v1/artifact） — blender bridge 提供產物下載，含 traversal 雙防護與副檔名白名單 ｜ 證據: 86b2584b
- [運維與觀測] staging 工具稿 byte 等價導出器 — export-blender-tools-staging --check 驗證 staging 稿與真源機械導出 byte 等價（根治 461→832 行漂移） ｜ 證據: 86b2584b
- [運維與觀測] blob 讀寫統一 10s 硬超時 — blob 的 list／put 統一 10s 硬超時與呼叫方 abortSignal 合併；put 屬寫入且冪等性未知故超時不重試 ｜ 證據: 36ce9469
- [運維與觀測] 音樂工具回執新增 prompt_director 欄 — music_gen 回執如實回報 applied／warnings／truncated／layers，讓規則層介入可被觀測 ｜ 證據: 86eb165f
- [運維與觀測] VPS 同步 export 工具 — 提供把本地真源同步／導出到 VPS harness 的工具 ｜ 證據: c2b79797
- [運維與觀測] headless 執行橋 — server.py／blender_addon.py／launcher.py 提供 job FIFO 佇列、雙層超時、stdout 分道輪轉（codeout 與 blender.log 不互相截斷）、scan_artifacts 快照 diff 判定產物 ｜ 證據: c005c4bf
- [運維與觀測] 殭屍會話根治鏈 — agent 會話生命週期清理，避免殭屍會話殘留 ｜ 證據: d6e1ceb2

## 非程式碼能力

- DB 遷移：010_filmera_supplier（filmera 渠道）、011_metaso_supplier、012_biz_key_newapi_token、013_job_events、014_cangyuansuanli_supplier、015_billing_writeoff、016_provider_reconciliation ｜ 證據: 06c6fdda, ffc6e9af
- VPS／部署稿：deploy-staging 五目錄（SSH 反向隧道服務＋bridge-reverse-tunnel.js、Modal 雲端渲染 POC 四檔、blender-nodes 渠道稿、blender-gateway 工具真源、blender-director-persona 冪等補丁） ｜ 證據: 04ebc177
- 倉庫追蹤清理：-2318 檔、追蹤體積 230MB→15MB；pixai-pool 帳號數據（638 帳號明文）／redteam 腳本／log 全家退追蹤，AGENTS.md 加 repo 掃描地圖 ｜ 證據: ea41f112, 951451ab
- 憑證隔離：.flowmusic-creds／staging／deploy-staging／*.bak-* 進 .gitignore，tsconfig 排除 staging ｜ 證據: a51702bd
- 文檔站改版：/docs/report 掛 13M 比賽報告 PDF 並設快頭 Cache-Control，docs/*.md 戰役記錄入庫 ｜ 證據: 5ea2d5cb
- README 產品說明書化：中性章節名、第三人稱、表格承載信息，改簡體中文，模型目錄 54→56、API base 改 eimu.dev/v1、Blender 5.2.1，附 13 張產品預覽圖 ｜ 證據: 539c9c92
- PRD 入檔：prd-agent-global-memory（私有／共享雙層記憶庫契約）＋symdiff-aid-swallow-prd（吞 AID 產品層刀位裁定），THIRD-PARTY-NOTICES 追加 AID（MIT） ｜ 證據: f7e9032f
- filter-repo 事故恢復：從 ZCode 會話庫重放 138 檔未提交改動＋bundle 組裝 agent-templates（tsc 0 錯、1411/1411 測試綠） ｜ 證據: ffc6e9af
- 部署忽略與探針：.vercelignore 補漏排除評測產物／一次性殘片 patterns，gatus 探針配置調整 ｜ 證據: 1f9e9f2b, 057243be, 1fae23c0

## 邊界與拒絕

- 451／legal_error／content_rejected／compliance filter 一律 fail-closed：不可重試、不切換供應商、不隔離、無冷卻 ｜ 證據: efe3d029
- 帳號無影片生成權益時顯示專屬提示，不誤報成「審核未通過／額度不足」 ｜ 證據: efe3d029
- 生成品質門：不可判定項一律 skip，僅 fail 才阻斷；明訂「誤攔的門比沒有門更糟」 ｜ 證據: 4557829f
- 免費優化端點不讀授權頭，AGENT_OPTIMIZE_KEY 只在內部使用、永不進響應；限流為盡力而為而非精確配額 ｜ 證據: b097b4b3
- B 端代理：B 端密鑰與派生 key 只出現在發往網關的 Authorization 頭，任何 log／錯誤響應不夾帶（固定文案）；網關 404（session not found 防枚舉）原樣透傳不改寫 ｜ 證據: 87167706
- 時裝 flat-lay domain 8 工具中僅 shot_grid_batch 有真能力，其餘標 unsupported（不宣稱分割／身份／試穿／修手／排版模型存在） ｜ 證據: 06c6fdda
- 電商 domain adapter 明確不擁有 queue／billing／history／artifact storage／canvas persistence，只做規劃與翻譯 ｜ 證據: 06c6fdda
- 短劇域統一回執：status 有 succeeded／blocked／unsupported／failed 四態，unsupported 需帶 code／message／requiredCapability 誠實回報 ｜ 證據: 06c6fdda
- 3D 路由硬規則：3D 需求禁止用二維生成頂替 ｜ 證據: 86b2584b
- 音樂規則層「庫內無依據的同義詞表誠實留空」；決定性純函數，規則逐條引用配方庫行號 ｜ 證據: 86eb165f
- 音樂通路邊界：FlowMusic2API 時間戳無效需剝除、無歌詞標籤時 style prompt 壓單行守 220 runes、帶 [Verse]/[Chorus] 走保版面分支；BPM／調性／instrumental 有效 ｜ 證據: a54ea6d0
- 音樂硬截邊界：僅當 ≥60% cap 處存在子句邊界才退讓，否則退最後空白（避免切斷拉丁單詞），CJK 直接在 cap 切 ｜ 證據: bdb8b81a
- blob put 屬寫入且冪等性未知 → 超時不重試，AbortError 依現行錯誤路徑照拋 ｜ 證據: 36ce9469
- 3D 場景卡嵌合為可選：scene_card／camera_trajectory 缺欄時零行為變化 ｜ 證據: 5f8170c8
- auth/me 明文 token 永不進快取、永不進日誌（快取 key 為 SHA-256 雜湊，日誌只印前 8 碼）；只快取成功結果 ｜ 證據: c2b79797
- 資產庫擴充的 SKILL 鐵律與 3D 路由白名單；kunpeng 知識正文禁出現 ffmpeg／Kimi／vision_video_analysis 等工具名字串（紅線測試） ｜ 證據: 86b2584b, ffc6e9af

## 存疑

- 4557829f「R 鍵配方回填」：diff 只見資料層 workstation-recall.ts，未見 R 鍵 keydown 綁定或 UI 觸發點，缺「按 R 即回填」行為的直接證據（缺：UI 綁定檔與行號）。
- 06c6fdda「每個模型追加…」「agent chat silent 注入」與「admin 路由調度展開顯示產出圖」：僅有 commit 訊息與檔名（AdminRoutingPanel.tsx、messages route），未逐行讀 diff，具體可驗證行為待補（缺：AdminRoutingPanel 與 messages route 的 diff）。
- 04ebc177：deploy-staging 五目錄自陳為「稿」，是否已部署成活體未知（缺：VPS 現場檔案與服務狀態）。
- 07038697：五個新頂級 skill 域與 105 份配方是否已部署到 VPS harness 並被 Expert must-load 未證（commit 只說入庫）。
- 3b29f169：commit 自陳「部署與 Expert 接線由後續片處理」，本 commit 本身未接線（缺：後續片是否已閉環的證據）。
- ffc6e9af：138 檔重放入庫，無法從 commit 區分「新能力」與「事故前既有能力復原」，本清單只取其中明確的新模組（provider-reconciliation／quota-precheck／workflow-dsl 等）。
- 1fae23c0：blender-bridge server.py +81 行修訂內容未細讀，是否含新能力存疑（缺：server.py diff）。
- 62610cfe：/v1/model-status 的 last_24h 與 /admin 模型分布「同源」為 commit 自陳，未跑 SQL 實際核對。
- 476244e0／7b8f5992／9fd19be9／3fea5783：屬純外觀或逐行複製類；本清單按「使用者可見行為（外觀）」收錄，若採「僅可呼叫行為」口徑則這幾條可剔。

## 逐條對帳

| hash | 該 commit 貢獻的能力（或純修復／純重構／無新能力） |
|---|---|
| 9c32e211 | 純重構（LeftPromptTab 從工作站抽離，task 8 panel 5/5） |
| efe3d029 | 邊界語義：content_rejected（451/legal_error）不可重試；影片權益提示（生成核心＋前端與UI 各 1 條） |
| b097b4b3 | GitHub 一鍵授權 DSH 自動簽發 biz key；用戶自助 biz key 管理；免登入提示詞優化端點（3 條） |
| cbf81b62 | 免費優化端點六槽 JSON 與 image/video 分流（1 條） |
| 87167706 | B 端 key 代理路由；wish 會話併入用戶助理空間＋session 深鏈（2 條） |
| 0f28e05f | 純修復（B 端代理重複 agent/v1 前綴正規化，列為 B端API 邊界語義 1 條） |
| 4557829f | 配方總線第一波：配方模板六槽 profile／showcase 用戶投稿／短劇配方／審查頁組裝器／歷史存角色卡／歷史再來 N 組／定價彈窗重構／模型卡三字段／生成品質門＋日誌（9 條） |
| 057243be | 無新能力（移除超大 dmg、gitignore workbuddy） |
| ef0bbc6b | 助理模板庫；畫布常駐；點卡注入＋鋪畫布；ModelPicker 固定寬（4 條） |
| 6bf50774 | 模板流水線藍圖字段（pipeline/deliverable/gate）（1 條） |
| f653b458 | 模板 pipeline 鋪多步驟 canvas；模板入口旋轉木馬（2 條） |
| 476244e0 | 前端與UI：模板卡材質層棧修復（1 條，外觀） |
| 7b8f5992 | 前端與UI：模板卡海報區與領域配色重造（1 條，外觀） |
| 3fea5783 | 純重構（旋轉木馬改為 CaseShowcase 逐行複製／輪子紀律） |
| 9fd19be9 | 純修復（CSS import 相對路徑，build 修復） |
| 06c6fdda | filmera 渠道自愈；帳號池 402 切號；渠道 registry＋一鍵註冊；agent 工作流 8 模板工業化；電商／時裝／IP domain 契約；短劇域狀態機；admin 調度面板（8 條） |
| 62610cfe | /v1/model-status last_24h 真實表現統計（1 條） |
| 59221be9 | 純修復／觀測微調（last_24h 統計失敗時記錯誤日誌，無新能力） |
| ea41f112 | 非程式碼（倉庫追蹤清理，-2318 檔／230MB→15MB） |
| ffc6e9af | 全量入庫：provider-reconciliation／quota-precheck／newapi+openai video upstream／workflow-dsl／harness-tool-registry／導演台 R1-R3＋proposals／餘額與健康同源裁決／kunpeng 三資產／6 個 DB 遷移（含非程式碼項） |
| 951451ab | 非程式碼（根目錄暴露面清理，帳號池數據退追蹤） |
| c005c4bf | blender 3D 導演全鏈：工具族／persona＋嵌合三件套／資產指紋復用／SKILL 五階段＋12 配方／headless 橋／場景 3D 卡／節點接入（7 條） |
| 04ebc177 | 非程式碼（deploy-staging 五目錄部署稿） |
| 5f8170c8 | PWA 跨瀏覽器 handoff；auth 韌性鏈；newapi 會話 token；粒子海；blender 節點渠道；3D 場景卡嵌合；SW v2；手機端批次（8 條） |
| 1f9e9f2b | 非程式碼（.gitignore 補漏一次性殘片 patterns） |
| 4b5b464b | Modal 雲端渲染暖復用與場景快取（1 條） |
| 07038697 | blender-director 配方庫 12→105；五個新頂級 skill 域（2 條） |
| 86b2584b | 12 資產庫入庫；blender 自動入庫＋指紋命中＋artifact 取回；/v1/artifact 端點；3D 路由硬規則；persona 放行資產工具；byte 等價導出器（6 條） |
| f67dc3d0 | 無新能力（臨時 secret 指紋診斷路由，驗完即刪） |
| 90ad3615 | 無新能力（移除上條臨時路由） |
| 3b29f169 | 音樂 Expert 配方庫（SunoForge 六層公式）（1 條） |
| a54ea6d0 | 音樂通路判定先於配方＋FlowMusic 實測邊界（1 條） |
| 9a6ee963 | 音樂工具家族（music_gen/lyria/flowmusic）（1 條） |
| 86eb165f | 音樂 prompt 確定性規則層；工具回執 prompt_director 欄（2 條） |
| bdb8b81a | 音樂硬截用滿預算（15→217 runes，邊界語義）（1 條） |
| a51702bd | 非程式碼（憑證與 VPS 同步工作目錄隔離） |
| d6e1ceb2 | 音頻成品卡；子代理跑馬燈＋報告卡；會話標題與身份正典化＋beast-mode；附件 lazy 建號；工具顯示名 113 鍵；殭屍會話根治（6 條） |
| c2b79797 | MOE 7 Expert＋registry/contract；orchestrator 野獸幀；vision/web_search 工具；auth/me 硬超時＋微快取；VPS 同步 export 工具（5 條） |
| 0455beb0 | hub_only 017 遷移；模型檔位解析器；自訂檔計價；定價輪播卡；燈箱＋編輯面板／參考圖；粒子海重做（6 條） |
| a8c1d059 | 純修復（GitHub 回調／me、mapay 下單回調三件套、adobe 回調、new-api 鑑權端修訂） |
| 5ea2d5cb | 非程式碼（文檔站改版＋/docs/report 掛 PDF） |
| 77cf70a3 | 純重構（移除首頁 CaseShowcase，改由模板廊承載） |
| 00af5fb9 | 工作台 boards 庫導入參考圖（自然尺寸）；工作台引導行動端適配（2 條） |
| 36ce9469 | 生成快取寫盤挪出關鍵路徑；blob 讀寫 10s 硬超時（2 條） |
| 1fae23c0 | 非程式碼／運維（vercelignore／gatus 探針／blender-bridge 與 skill 配方微調，無明確新能力） |
| 539c9c92 | 非程式碼（README 產品說明書化＋13 張預覽圖） |
| f7e9032f | 非程式碼（兩份 PRD 入檔＋THIRD-PARTY-NOTICES 追加 AID） |