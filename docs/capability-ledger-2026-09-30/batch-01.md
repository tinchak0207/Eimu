# image-app 能力清單（第 1 批，47 個 commit）

- 批次範圍：`/tmp/cap/batch-1.hashes`（47 條），線性史 2026-08-14 → 2026-08-22（`4860f1ed` 為無父的初始基線 commit，其後逐條線性）。
- 口徑：能力＝**使用者可見或可呼叫的行為**（端點、工具、UI 行為、計費/退款決策、拒絕/降級語義），不是「存在某檔」。
- 標籤：生成核心／模型與供應商／控制平面與計費／B端API／Agent助理／畫布與工作流／創作域／帳號與增長／前端與UI／運維與觀測（本批「團隊與企業」零命中）。
- 來源衝突：記憶 `2026-09-28-symdiff-source-first-and-hypit-video-extraction.md` 說我方「影片提取」只有瀏覽器端均勻抽 4 張（`video-frames.ts`）＋100MB 直傳；本批（08 月早期）現場**零命中任何影片提取/轉寫/場景切點能力**，與記憶一致，無衝突。記憶 `aid-server-symdiff-prd-0915.md` 提到的 AID 對稱差交付物（`lens-language-library.ts` 等）是本批之後（09-15）的工作，本批零命中，屬時間差而非衝突。

## 生成核心

- [生成核心] 生圖任務提交與查詢 — 同步提交 `/api/generate-images` 建立生成任務，`/api/generation-jobs`、`/api/generation-jobs/[id]` 查任務狀態與結果 ｜ 證據: 4860f1ed
- [生成核心] 生視頻提交 — `/api/generate-videos` 接受視頻模型參數（時長/解析度/音頻）提交生成 ｜ 證據: 4860f1ed
- [生成核心] 畫布節點專用生圖薄殼 — `/api/canvas/generate` 把畫布欄位（prompt/model/size/quality/count/source_image/reference_image_urls）翻成 generate-images 請求，並把單張回應聚合成畫布 reducer 可直接吃的陣列 ｜ 證據: ec748a51
- [生成核心] 畫布語義參考圖與負面詞 — `/api/canvas/generate` 接受帶角色（ReferenceImageRole）的 `reference_images` 與 `negative_prompt`；同 URL 去重後上限 5 張，只收 https/data:image，角色走 generate-images 的 workflow 鏈路 ｜ 證據: e19103a3
- [生成核心] 上游圖片 URL 轉存本站 Blob — 上游回傳短時簽名 URL 時，回應前把位元組轉存本站 Blob 回持久 URL，避免 Canvas/歷史因簽名過期破圖（失敗保留原 URL 由調用方兜底） ｜ 證據: 425ac035
- [生成核心] 生成 worker 心跳與迭代容錯 — 心跳寫入失敗（暫時性 DB 錯誤）只記錄不殺進程；主迴圈每輪 try/catch，迭代失敗繼續輪詢；`unhandledRejection` 記錄不退出（避免在飛任務全部停擺被判定 dead 而批量退款） ｜ 證據: 286c47e5
- [生成核心] 生成 worker cron 端點 — `/api/cron/generation-worker` 每分鐘 claim 待處理與過期任務、執行生成、處理失敗退款；僅允許 Vercel Cron header 或本地 localhost ｜ 證據: ec748a51
- [生成核心] 模型能力查詢在定價覆寫載入後仍穩定 — `generationModel`/`generationCapabilities` 在 effectiveCatalog 查不到時回退靜態 `GENERATION_MODEL_CATALOG`，pricing override 載入不再把模型能力抹成 null ｜ 證據: 6ebb22ef, 271c66b6
- [生成核心] 容忍式 model-id 解析 — 顯示名風格分隔符（`seedance 2.0`、`seedream 2.0`、`image 5 pro`）正規化成連字號 id，同一模型不因寫法被拒；作用於生視頻、生圖、`/v1/images/generations`、`generation-jobs` ｜ 證據: 984b9878
- [生成核心] 無目錄能力也能提交的 Dreamina 圖片模型 — `generation-jobs` 對 `image-5-pro`/`image-5-lite`/`seedream-2.0` 三個模型即使 catalog 查不到 capabilities 也接受提交（補預設配置而非 400 model_not_found） ｜ 證據: 984b9878
- [生成核心] PixAI 池帳號檔安全寫入 — 池帳號 JSON 改原子寫（mkstemp→write→fsync→os.replace）＋跨進程 flock／msvcrt 鎖＋同進程線程鎖，避免併發寫壞池檔 ｜ 證據: 984b9878

## 模型與供應商

- [模型與供應商] 模型目錄與用戶可見模型清單 — `/api/models`（含端點與價格資訊）與 `/api/user/models` 對外列生成模型 ｜ 證據: 4860f1ed
- [模型與供應商] PixAI 上游工具面 — `/api/pixai/edit`、`/api/pixai/upload`、`/api/pixai/upscale`、`/api/pixai/template-generations` 提供編輯/上傳/超分/模板生圖 ｜ 證據: 4860f1ed
- [模型與供應商] LoRA 目錄與用戶偏好 — `/api/lora-models`（PixAI bridge 代理）與 `/api/lora-preferences`（收藏/最近） ｜ 證據: 4860f1ed
- [模型與供應商] Adobe2API 帳號生命週期 — `/api/adobe/oauth`、`/api/adobe/callback`、`/api/adobe/setup`、`/api/adobe-token` 完成 Adobe 帳號授權與 token 取用 ｜ 證據: 4860f1ed
- [模型與供應商] 渠道隊列單一事實來源 — `channel-registry.buildModelQueue` 為 user 管線/biz 管線/admin 預覽/探測唯一隊列來源；admin overrides 可啟停/調序 env 渠道與池而不需改 env 重部署；未配置渠道顯示為未配置而非隱形 ｜ 證據: 4860f1ed, 425ac035
- [模型與供應商] admin 渠道與供應池治理 — `/api/admin/channels(+probe/audit/rollback)`、`/api/admin/pools(/[id],/[id]/test)`、`/api/admin/account-pools(+import)`、`/api/admin/external-channels`、`/api/admin/image-upstream-probe`、`/api/admin/adobe2api/import`、`/api/admin/sub2api-fix-groups` 管理上游供給 ｜ 證據: 4860f1ed
- [模型與供應商] Dreamina Image 5 Pro / Lite / Seedream 2.0 進模型目錄 — 三者加入 `SUPPORTED_IMAGE_MODEL_IDS` 與公開菜單前排（popularity 98/97/96），各支援 1k/2k/4k、1:1 等常用比例與參考圖，幣價 10/20/40、5/10/20、5/10/20 ｜ 證據: 8ec2239b
- [模型與供應商] Image 5 Pro 路由 Dreamina 生產池 — 對 `image-5-pro` 硬接一個 priority 1 的 `dreamina-image5-pro` relay 端點，其他模型該池零端點 ｜ 證據: 6711d495
- [模型與供應商] Dreamina relay 限制於已驗證上游模型 — 池的 `supportedModels` 僅 `image-5-pro`；`gpt-image-2`、`gemini-3.1-flash-image`、`image-5-lite`、`seedream-2.0`、`flux-2` 在該池下建不出端點（白名單拒收） ｜ 證據: 8ec2239b
- [模型與供應商] 對外模型可用性探測 — `GET /v1/model-status` 回所有 image+video 模型的可用性＋能力＋功能標註；只發 `GET {baseURL}/models` 不觸發生成不扣費；結果模組級快取 60 秒 ｜ 證據: ec748a51
- [模型與供應商] 對外通道標籤不透露供應鏈 — 回應中的 endpointLabel 把內部 label（adobe2api/sub2api/池名等）歸一成 primary/fallback，客戶端拼不出上游供應鏈 ｜ 證據: 425ac035
- [模型與供應商] sensenova-u1-fast 從供給面移除 — 生產版本同步時該模型自 `SUPPORTED_IMAGE_MODEL_IDS` 與模型目錄刪除，channel-registry 不再有 `sensenova` channel kind 與專用 baseURL ｜ 證據: 425ac035
- [模型與供應商] PixAI pool bridge（上游池服務） — `pixai-pool/bridge`（app.py/server.py/pool_store.py）作為 PixAI 帳號池的本地服務面 ｜ 證據: 4860f1ed

## 控制平面與計費

- [控制平面與計費] 生成控制平面 DB schema — `db/migrations` 001-007：generation control plane（任務/租約）、admin 配置審計、canary run、billing reconciliation、professional workflow lineage、LoRA user state、biz api key ｜ 證據: 4860f1ed
- [控制平面與計費] 計費/額度/支付 API — `/api/token(/[id])`、`/api/topup`、`/api/usage`、`/api/pricing`、`/api/model-pricing`、`/api/payments/mapay/checkout|notify|return|test-callback`、`/api/user/topup/info`、`/api/user/topup/self` 構成扣費、額度、下單、回調鏈路 ｜ 證據: 4860f1ed
- [控制平面與計費] admin 定價改寫即時生效面 — `/api/admin/model-pricing`、`/api/admin/tier-pricing` 改價，算價前同步進目錄（核心層吞錯，失敗不擋生成） ｜ 證據: 4860f1ed, 984b9878
- [控制平面與計費] B端 biz key 與內部簽名通道 — `/api/admin/biz-keys(+provision,/[id])`、`/api/internal/biz-keys`、`/api/internal/callback-worker`、`/api/internal/generation-billing` 提供 biz key 簽發與控制面內部寫入/回調 ｜ 證據: 4860f1ed
- [控制平面與計費] B端批次生成編排 — `POST /v1/batches` 逐項（image/video）走同一條 `submitGenerationCommand`（不自建第二套提交/計費/調度），`GET /v1/batches/:id` 聚合狀態，`GET /v1/batches/:id/reconciliation` 對帳匯出 ｜ 證據: e19103a3
- [控制平面與計費] 生成任務租約回收與對帳 — `recoverExpiredGenerationLeases`（leased 回 queued、submitting/running 轉 submit_unknown 並補上游對帳）、`reconcileGenerationBilling`、`refreshAdobeSupplierHealth` 由 worker 每 30 秒執行 ｜ 證據: 4860f1ed, 286c47e5
- [控制平面與計費] admin 帳務與 SLO 觀測面 — `/api/admin/billing-operations`、`/api/admin/slo`、`/api/admin/routing-events`、`/api/admin/control-plane-diagnostics` 提供帳務操作、SLO、路由事件與控制平面診斷 ｜ 證據: 4860f1ed

## B端API

- [B端API] 原有 /v1 對外契約 — `/v1/images/generations`、`/v1/images/edits`、`/v1/images/[id](/result)`、`/v1/videos/generations`、`/v1/videos/[id](/result)`、`/v1/uploads`、`/v1/history` 提供生圖/編輯/生視頻/上傳/歷史 ｜ 證據: 4860f1ed
- [B端API] /v1 元數據與相容面 — `/v1/models`、`/v1/queue`、`/v1/system_stats`、`/v1/object_info`、`/v1/openapi.json`、`/v1/templates`、`/v1/template-generations`、`/v1/upscale` ｜ 證據: 4860f1ed
- [B端API] SKU 目錄（公開只讀） — `GET /v1/skus` 列自有營銷 SKU（電商帶貨 15s、痛點廣告、多角度變體），含輸入 schema/鏡頭結構/輸出規格/計價模式，可程式化生成下單表單；不需鑑權 ｜ 證據: e19103a3
- [B端API] SKU 下單 — `POST /v1/skus/:id/runs` 輸入→鏡頭計劃展開→逐鏡頭提交；支援單輪與 `{inputs:[...]}` 表格批量；biz key 鑑權、限流頭、trace_id、OpenAI 風格錯誤體、Idempotency-Key 冪等（逐鏡頭確定性冪等鍵） ｜ 證據: e19103a3
- [B端API] SKU 訂單查詢 — `GET /v1/skus/runs/:id` 查 SKU run 狀態 ｜ 證據: e19103a3
- [B端API] TTS 提交與查詢 — `POST /v1/tts/generations`、`GET /v1/tts/:id` 走 generation-core（kind 接通、MediaKind audio 傳播到 9 處下游型別） ｜ 證據: e19103a3
- [B端API] /v1/images/generations 容忍 model 寫法 — 顯示名風格 model 字串正規化後才做支援性檢查 ｜ 證據: 984b9878
- [B端API] OpenAPI 契約隨端點擴充 — `/v1/openapi.json` 隨 batches/skus/tts 等新端點同步（本次 +336 行） ｜ 證據: e19103a3

## Agent助理

- [Agent助理] 站點↔agent 閘道純代理 — `/api/agent/sessions`、`/[id]`、`/[id]/messages`、`/[id]/confirm`、`/[id]/question`、`/[id]/attachments`、`/[id]/sse-ticket`、`/api/agent/quota`；身份統一由 `resolveAgentCaller` 解決，閘道為權威 ｜ 證據: 4860f1ed
- [Agent助理] 對話歷史 dropdown — `GET /api/agent/sessions` 代理閘道 list sessions（按 key 隔離），前端 hook `switchSession` 切換歷史會話並有目錄 UI ｜ 證據: 186b1770
- [Agent助理] 刷新自動續上上次會話 — 網關已持久化會話後，刷新/重開改為靜默 resume（transcript 含 workflow/canvas 事件流原樣回來），會話真被回收時 resume 自己清檔開新並提示 ｜ 證據: daa226cd
- [Agent助理] 會話記憶補注 — resume/switch 到老會話時 `POST /api/agent/sessions/[id]/memory` 讀本站權威 profile+lessons 並推給 gateway `memory-patch`（前端 fire-and-forget）；無畫像回 `{patched:false,has_profile:false}` ｜ 證據: 3275bef9
- [Agent助理] 建新會話注入帳戶畫像與教訓 — 建立會話時帶 `user_profile` 與 `lessons`；空畫像時帶 `memory_empty:true` 讓 gateway 首條訊息用 question 工具做選擇題 onboarding（用戶點選零打字） ｜ 證據: 984b9878, e9e1b178
- [Agent助理] 帳戶畫像 API — `GET/PUT /api/agent/profile` 讀寫「用戶確認過」的畫像（只在此或 onboarding 表單寫入，模型提煉走 lessons）；單欄 500 字、清單 12 項上限 ｜ 證據: e19103a3
- [Agent助理] 靜默教訓提煉 — `POST /api/agent/profile/lessons` 收 transcript 語料（≤64KB）→ 閘道 LLM 提煉 ≤6 條教訓入 `agent_lessons`；需 ≥2 輪往來；失敗靜默不報錯；教訓只在用戶確認後才進注入集合 ｜ 證據: e19103a3
- [Agent助理] AI 助理 LoRA 搜索引擎 — `agent-lora` 搜索站內 `/api/lora-models` 後按 versionId 過濾，複用 `/api/lora-preferences`，單選鐵律（裝配參數只留 1 個），模型無 LoRA 能力時明確報錯 ｜ 證據: e19103a3
- [Agent助理] 輸入框粘貼與拖拽附件 — AgentComposer 支援 Ctrl+V 貼檔與拖入，與附件按鈕共用 `enqueueFiles` 管道；拖拽懸停高亮，純文本粘貼放行 ｜ 證據: e62cf333
- [Agent助理] 參考圖上傳按模型能力門控 — PromptInput 容器級拖拽＋Ctrl+V 經 `ReferenceImageUpload.acceptFiles` 同一管道；模型不支持參考圖時隱藏上傳入口，杜絕「上傳後立馬消失」 ｜ 證據: e62cf333
- [Agent助理] 畫布狀態上行（agent 的眼睛） — `POST /api/agent/sessions/[id]/canvas-state` 前端畫布變更 300ms 防抖把壓縮快照推給 gateway 暫存，agent `canvas_get_state` 零往返讀取；快照盡力而為失敗不重試，512KB 上限 ｜ 證據: ec748a51
- [Agent助理] 畫布批量操作結果回報 — `POST /api/agent/sessions/[id]/canvas-ops-result` 前端執行（或用戶拒絕）agent 下發的批量畫布操作後回報，resolve gateway 端 `canvas_apply_ops` 工具調用（否則 30s 超時） ｜ 證據: ec748a51
- [Agent助理] 強制中止當前生成輪 — `POST /api/agent/sessions/[id]/abort` 透傳到 opencode `/session/:id/abort`（系統層取消，非發 prompt 軟停） ｜ 證據: ec748a51
- [Agent助理] 閘道技術名詞中文化 — question/confirm expired 等閘道錯誤/狀態文字映射為中文再呈現 ｜ 證據: 1b31ad23

## 畫布與工作流

- [畫布與工作流] 畫布專案持久化 — `/api/canvas/projects` 儲存/讀取畫布專案 ｜ 證據: 4860f1ed
- [畫布與工作流] 首次 workflow_start 即切畫布模式 — agent 第一次調 `workflow_start` 時不等 canvas.plan/節點事件落地，右側面板立即進 canvas 模式（黏性旗標，畫布清空不被踢回圖片模式）；`tool.invoke` 不入畫布 reducer ｜ 證據: 420bdbd9
- [畫布與工作流] 畫布圖片三級載入鏈路 — 直鏈失敗切同源代理 `/api/canvas/image-proxy`，代理也失敗才落破圖占位；破圖占位不偽裝生成失敗，提供「重新載入」 ｜ 證據: af3a9c4e
- [畫布與工作流] 已完成節點不再卡失敗態 — node content 更新時自動重置圖片錯誤狀態（清 useProxy/imgError）重新走載入鏈路 ｜ 證據: af3a9c4e
- [畫布與工作流] AI 助理面板 dock 佈局 — 面板 dock 時畫布收縮讓位，不遮蓋左側節點 ｜ 證據: dd83c049
- [畫布與工作流] 畫布導航與快捷鍵輔助 — CanvasMiniMap、CanvasZoomControls、CanvasShortcutsHelp、CanvasContextMenu 提供縮放/小地圖/快捷鍵說明/右鍵選單 ｜ 證據: ec748a51
- [畫布與工作流] 節點內嵌生成面板 — CanvasNodePromptPanel 就地編輯 prompt/模型/比例/數量，生成結果作相連子節點插回；模型清單取自真實供給（不擺站上不路由的假選項），生成鈕旁標「約 N 幣」與扣費同源估價 ｜ 證據: ec748a51
- [畫布與工作流] 雲端素材庫與提示詞庫面板 — CanvasLibraryPanel 兩 tab：提示詞庫（公共，一次拉全量、客戶端 debounce 過濾、可插入畫布/填節點/存素材庫）與我的素材（登入用戶雲端素材） ｜ 證據: ec748a51
- [畫布與工作流] 雲端素材庫 API — `/api/canvas/assets` list/upsert/delete，requireVerifiedUser 驗證（不信任 x-user-id）；Blob 世代持久化，與畫布專案分命名空間，有大小/數量上限 ｜ 證據: ec748a51
- [畫布與工作流] 角色/場景卡鎖定注入 — `/api/character-cards` CRUD（GET/POST/PATCH/DELETE，requireVerifiedUser）；卡鎖定後該畫布所有生成（手動面板、agent run_generation、編輯器派生）自動以卡 id 序注入 locked prompt 前綴、參考圖（卡優先）與負面詞 ｜ 證據: e19103a3
- [畫布與工作流] 畫布語義節點 — prompt 節點文本與 reference 節點圖片沿入邊收集供生成；`resolveGenerationInputs`/`composeGenerationPrompt`/`mergeGenerationReferences` 保證手動 UI 與 agent run_generation 接線語義完全一致，參考圖按 nodeId 去重合併 ｜ 證據: e19103a3

## 創作域

- [創作域] 用例庫（提示詞/場景庫） — `use-cases` 提供多領域用例與對應提示詞（含 386KB 生產版內容恢復），供站點用例頁與 sitemap 消費 ｜ 證據: 4860f1ed, 425ac035
- [創作域] 畫布圖片編輯全家桶 — CanvasImageEditorDialog 提供裁剪/切圖/摳除/旋轉/角度；像素類操作輸出新 PNG dataURL 作新子節點（原節點不動，非破壞性）；生成類（角度重繪、摳除 AI 重繪）走回調交生成鏈路並明標 AI 重繪 ｜ 證據: ec748a51
- [創作域] 提示詞庫服務端聚合 — `GET /api/canvas/prompts` 並行抓多個遠程提示詞源（每源 8s timeout、失敗跳過不擋整體、解析不了跳過），模組級 1h 記憶體快取＋stale-while-revalidate ｜ 證據: ec748a51
- [創作域] 歷史與統計 — `/api/history`、`/api/history/[id]`、`/api/history/stats` 查生成歷史與統計 ｜ 證據: 4860f1ed
- [創作域] 圖片編輯像素核心可測 — `canvas/image-edit` 純數學層（computeSplitRects/findLineSpot/clampCropRect/buildAnglePrompt）可被 node:test 直測，瀏覽器段只在 client 呼叫 ｜ 證據: ec748a51

## 帳號與增長

- [帳號與增長] 註冊/登入/身份 — `/api/auth/register`、`/api/auth/login`、`/api/auth/me`、`/api/user/self`、`/api/data/self`、`/api/log/self(+search/stat)` ｜ 證據: 4860f1ed
- [帳號與增長] GitHub OAuth 登入 — `/api/auth/github/start`、`/api/auth/github/callback` ｜ 證據: 4860f1ed
- [帳號與增長] 微信掃碼登入（輪詢式） — `/api/auth/wechat/qr`、`/poll`、`/start`、`/callback` ｜ 證據: 4860f1ed
- [帳號與增長] 微信公眾號被動回覆登入通道 — `/api/auth/wechat/msg` 驗證簽名（sha1 字典序 token/timestamp/nonce），用戶在公眾號對話發驗證碼，FromUserName(openid) 作帳號身份，匹配登入碼完成登入 ｜ 證據: ec748a51
- [帳號與增長] 邀請返利 — `/api/user/aff` 提供邀請返利資訊 ｜ 證據: 4860f1ed
- [帳號與增長] 每日簽到 — `/api/checkin` ｜ 證據: 4860f1ed
- [帳號與增長] 動態站點 URL — `getSiteUrl()` 作為 robots/sitemap/manifest/OG 的站點前綴來源，sitemap lastmod 固定為內容更新日（不用 new Date 燒爬蟲預算） ｜ 證據: 425ac035

## 前端與UI

- [前端與UI] liquid glass 設計系統遷移 — agent-chat/canvas/pro-workstation 全面遷移，新增 DESIGN.md 與 PRODUCT.md 設計/產品文件 ｜ 證據: e7407935
- [前端與UI] Tailwind 死 opacity modifier 修復 — `/94`、`/92`、`/88`、`/12` 等非 5 階值改寫成 bracket alpha（`bg-primary/[0.94]`），Button hover 與 DropdownMenu/Select 文字不再靜默編譯成無效；並擴充守門測試掃描 theme color 名前綴 ｜ 證據: 5913f5a7, 8049becd
- [前端與UI] 歷史 dropdown 視覺修復 — 縮窄貼齊觸發鈕、減影、行高修正（文字不再疊印）、點擊外部關閉、z-30→z-50、純白不透明底、surface 溢出裁切（輸入框/卡片邊框不被蓋） ｜ 證據: 1b31ad23, cb119753, 4b034edf
- [前端與UI] question 卡不擠壓輸入框 — 卡區允許收縮並設高度上限（60dvh→40dvh→45dvh 定版），面板加 overflow-hidden 防內容撐破 ｜ 證據: 5758ed5d, 5114bfcf
- [前端與UI] agent 面底部按鈕列左對齊緊湊 — 回滾 justify-between 撐開佈局，恢復左對齊排列；transcript 底部間距調整 ｜ 證據: 051606bb, 9e3d91da
- [前端與UI] CanvasEmbed 展開狀態受控 — 補上 expanded/onToggleExpand props 修 build 型別錯誤 ｜ 證據: 8ab4331f
- [前端與UI] 品牌名統一 Eimu — layout 品牌名由 Emu 恢復/統一為 Eimu ｜ 證據: 6ec4f018, 425ac035
- [前端與UI] 縮圖放行 Vercel Blob 域 — next.config 放行 Vercel Blob 域供 `/_next/image` 縮圖 ｜ 證據: af3a9c4e
- [前端與UI] 輔助文字對比度提亮 — 思考過程標題/內容與節點輔助文字由 0.35/0.4/0.45 提至 0.55/0.6/0.62；轉錄區底部 padding 加大避免思考過程被裁 ｜ 證據: af3a9c4e

## 運維與觀測

- [運維與觀測] gatus 生產探測驗證 202 任務 — `/v1/images/generations` 探測條件為 `[STATUS]==202` 且 `[BODY].id != ""`，不再寬鬆 2xx（避免卡 202 也算成功） ｜ 證據: 4860f1ed
- [運維與觀測] 健康檢查端點 — `/api/healthz` ｜ 證據: 4860f1ed
- [運維與觀測] admin 出口代理池觀測面板 — `/api/admin/proxy-pool` 取 adobe2api 出口代理池數據；控制面實例直連 adobe2api:6001，Vercel 側走 HMAC 簽名中繼（域 `proxy-pool`，與 biz key 寫入通道共用密鑰但簽名不通用）；未配置中繼或上游異常回 `available:false` 讓 UI 優雅降級 ｜ 證據: e7407935
- [運維與觀測] 內部 HMAC 中繼端點 — `/api/internal/proxy-pool` 供 edge 實例簽名中繼到控制面 ｜ 證據: e7407935
- [運維與觀測] admin 控制台與代理池管理 UI — `AdminProxyPool.tsx`、`AdminRoutingPanel`、`AdminPoolManager`、`AdminBizKeys`、`AdminLogin` 等後台面板 ｜ 證據: e7407935, 4860f1ed
- [運維與觀測] MCP server（image-studio） — `mcp-server` 以 biz key 接站點 API，暴露 `list_models`、`generate_image`（非同步等待成品 URL）等工具給 MCP 客戶端 ｜ 證據: 4860f1ed
- [運維與觀測] 運維腳本工具組 — `tools/` 的 control-plane-bootstrap、migrate-generation-db、seed-generation-suppliers、run-canary、issue-biz-key、provision-biz-account、inspect-gemini-relay 與上游探測腳本 ｜ 證據: 4860f1ed
- [運維與觀測] 生成 worker 進程入口 — `worker/generation-worker.ts` 跑 generation worker，含 fatal 捕獲與 unhandledRejection 記錄不退出 ｜ 證據: 4860f1ed, 286c47e5

## 非程式碼能力

- VPS／部署：`deploy/gatus`（config.yaml + docker-compose）自架狀態頁與 2h 間隔生產探測；`vercel.json` 配置 Vercel Cron 每分鐘打 `/api/cron/generation-worker` ｜ 證據: 4860f1ed, ec748a51
- DB 遷移：`db/migrations/001`~`007` 七支 schema 上線（生成控制平面、admin 配置審計、canary、帳務對帳、workflow lineage、LoRA 用戶態、biz key）＋ `tools/migrate-generation-db.ts` ｜ 證據: 4860f1ed
- DB 遷移：`tools/control-plane-bootstrap.ts` 與 `tools/seed-generation-suppliers.ts` 初始化控制平面與供應商 seed ｜ 證據: 4860f1ed
- DB 遷移：`tools/run-canary.ts` 跑 canary run（對應 migrations/003） ｜ 證據: 4860f1ed
- 外部服務：Adobe IMS OAuth 回調/設定鏈路（`/api/adobe/*`）與 Adobe2API 帳號導入（`/api/admin/adobe2api/import`） ｜ 證據: 4860f1ed
- 外部服務：微信公眾平台測試號被動回覆接口 URL 配置（需微信端配置 token 與 URL 指向 `/api/auth/wechat/msg`） ｜ 證據: ec748a51
- 運營流程：從 Vercel「6h 前生產部署」全量恢復源碼／品牌名／差異檔（三筆 restore commit），屬事故恢復運營動作而非開發 ｜ 證據: ec748a51, 6ec4f018, 425ac035
- 運營流程：上游帳號池導入與 biz 帳號開通（`/api/admin/account-pools/import`、`tools/provision-biz-account.ts`、`tools/issue-biz-key.ts`、`tools/verify-production-image-password.ps1`） ｜ 證據: 4860f1ed
- 文檔：`docs/biz-api.md`／`docs/biz-api-guide.md` 隨 B 端能力更新；`/v1/openapi.json` 契約同步；`public/llms.txt` 供 agent 消費 ｜ 證據: e19103a3, 984b9878
- 文檔／計畫：`docs/plans/2026-08-22-large-file-refactor.md` 大型檔案重構計畫與 4 份 domain 分析（canvas/core/input/workstation） ｜ 證據: e7407935
- 文檔：`DESIGN.md`、`PRODUCT.md` 作為 UI/產品決策權威來源 ｜ 證據: e7407935
- 契約測試守門：`agent-chat-ui.test.ts`、`character-cards.test.ts`、`canvas-reducer-adapter.test.ts`、`sku-engine.test.ts`、`batch-service.test.ts`、`agent-profile-store.test.ts`、`tailwind-opacity-modifier.test.ts` 等以「讀舊檔＋新檔拼接」方式鎖定語義不放寬 ｜ 證據: e62cf333, a7837658, e19103a3, 5913f5a7
- 運營驗證產物：`.codex-image-data-smoke.mjs`、`tools/run-production-image-upstream-probe.ps1` 等冒煙/探測腳本 ｜ 證據: 4860f1ed

## 邊界與拒絕

- gatus 探測 fail 判準：只認 202 + task id 存在，拒絕「任何 2xx 即成功」 ｜ 證據: 4860f1ed
- 模型不支持參考圖時隱藏上傳入口（不讓用戶上傳後被丟棄） ｜ 證據: e62cf333
- 畫布破圖不偽裝生成失敗：直鏈→同源代理→破圖占位三級，占位只說「圖片載入失敗」並給重新載入 ｜ 證據: af3a9c4e
- worker 暫時性 DB 錯誤 fail-open 於進程：心跳/迭代失敗只記錄，租約到期自然回收，不觸發批量退款；`unhandledRejection` 不退出 ｜ 證據: 286c47e5
- 容忍式 model-id 只正規化分隔符，不支援的模型仍 400（不變成任意別名通過） ｜ 證據: 984b9878
- Agent session DELETE 冪等：僅吞閘道 404 且 `code=="not_found"`（回 200 `already_gone`），其他 4xx/5xx 原樣透傳 ｜ 證據: 984b9878
- 無帳戶畫像時不硬塞空上下文：改帶 `memory_empty` 讓 gateway 以 question 選擇題引導採集 ｜ 證據: e9e1b178
- 記憶補注查不到畫像即回 `patched:false`，不虛報已注入 ｜ 證據: 3275bef9
- 教訓提煉只「提議」不確認：lessons 須用戶明確確認才進注入集合；提煉失敗靜默不報錯 ｜ 證據: e19103a3
- agent LoRA 單選鐵律：裝配參數 `loraModelVersionIds` 只保留 1 個（服務端 slice(0,1) 兜底）；模型無 LoRA 能力明確報錯不靜默忽略 ｜ 證據: e19103a3
- 畫布語義參考圖收口：只收 https/data:image，同 URL 去重後上限 5 張；取不回直接報錯不靜默丟棄；`cost_coins` 算不出回 null 不填 0；count 部分成功只回部分結果 ｜ 證據: e19103a3, ec748a51
- 畫布 image-proxy SSRF 立場：只服務登入用戶、只認 https 公網主機、拒 IP 字面量與 localhost/*.local/*.internal、只回 image/*、上限 25MB ｜ 證據: ec748a51
- canvas-state 快照盡力而為：失敗不重試；壓縮後超 512KB 視為異常 ｜ 證據: ec748a51
- 模型可用性探測唯讀：只發 `GET /models` 不觸發生成不扣費；無 `/models` 能力的渠道誠實回 `unknown` + note 而非假裝探測失敗 ｜ 證據: ec748a51
- SKU 目錄只讀：非 GET 明確 405；`pricing` 欄位如實標 per_shot（逐鏡頭按模型價走既有 billing-ledger），per_sku 一口價不提前虛標 ｜ 證據: e19103a3
- 上游圖轉存拒收：非 `image/*` content-type、空位元組或超 `HISTORY_MAX_IMAGE_BYTES` 即拒絕轉存（保留原 URL 由調用方兜底） ｜ 證據: 425ac035
- 供給面收口：`sensenova-u1-fast` 自目錄與渠道隊列移除；channel kind 不再有 sensenova 分支 ｜ 證據: 425ac035
- Dreamina relay 白名單拒收：非 `image-5-pro` 的模型在該池建不出端點 ｜ 證據: 8ec2239b
- proxy-pool 面板不假裝有數據：中繼未配置/上游異常一律 200 + `available:false` + reason ｜ 證據: e7407935
- 對外不透露供應鏈：endpointLabel 只回 primary/fallback ｜ 證據: 425ac035
- 渠道隊列誠實列舉：`describeChannels` 枚舉含未配置與被停用渠道並標明數值來源，未配置顯示為未配置而非隱形 ｜ 證據: 4860f1ed
- 圖片編輯非破壞性：原節點永不改動，結果作新子節點；UI 誠實標註生成類是 AI 重繪不假裝本地變換 ｜ 證據: ec748a51
- 素材庫未登入誠實顯示登入提示，不假裝可用 ｜ 證據: ec748a51

## 存疑

- `4860f1ed` 是**無父 commit 的全倉初始基線**（591 檔/95591 行，含 102 支 API route），其能力無法逐條歸屬於「本 commit 新增」。上方標 4860f1ed 者為 **baseline route-group 粒度**，未逐 route 拆條。缺證據：該 commit 之前是否存在更早歷史（`git rev-list --parents` 顯示無父；`git rev-list --count --all` = 450，本批只是主線最早 47 條）。
- `984b9878` 於 `src/app/api/agent/sessions/route.ts` 引入 `@/lib/agent-profile-store` 的 import，但 `git log --diff-filter=A` 顯示該檔直到 `e19103a3` 才被加入 ⇒ 該中間 commit 的可建置性存疑（可能為歷史重建/壓縮產物）。缺證據：該 commit 當時的 tsc/CI 是否通過。
- `e19103a3` 的 commit body 內含字面 `\n\n`（訊息被轉義），且 `canvas/generate/route.ts` 新增註解寫「2026-08-22」而 commit 日期為 08-21。實際新增檔案以 `--stat`（77 檔）為準；註解日期與 commit 日期不一致的成因不明。
- `425ac035`／`ec748a51`／`6ec4f018` 是「從 Vercel 6h 前生產部署恢復」的提交：能力是「回到生產版本」而非新開發。**無法從 commit 訊息判定恢復前後哪些差異是刻意的產品變更**（例：`sensenova-u1-fast` 移除、SenseNova channel 分支刪除是刻意下架還是恢復副作用）。缺證據：當時 Vercel 部署清單與產品意圖紀錄。
- `6711d495` 把 `image-5-pro` 硬接 `https://collector-mandatory-moderator-guitar.trycloudflare.com`（臨時隧道 URL，apiKey 明文 `dreamina-free-local`）。無法從 repo 證明該上游現在是否仍有效、是否為生產正式池。缺證據：生產環境變數/控制面池配置。
- 「團隊與企業」領域本批零命中。可能原因：本批（08 月早期）team/RBAC 尚未實作（記憶 `2026-09-30-decision-table-coverage-audit.md` 說 team 維度＋三級 RBAC 是 P0-2、`1fdcafc0`，遠晚於本批）。缺證據：未逐檔掃 baseline 是否有隱含多租戶/團隊欄位。
- `4860f1ed` 的 baseline 是否包含「影片提取/轉寫」能力：本批 grep 未見相關 route 或 lib；與記憶一致（我方該格薄弱且 08-31 才降級為備援）。標為零命中而非存疑，但未逐檔通讀 591 檔驗證。

## 逐條對帳

1. `4860f1ed` — 初始基線：591 檔全倉導入（102 支 API route、7 支 DB 遷移、pixai-pool bridge、mcp-server、tools、worker、deploy/gatus）；該 commit 意圖面＝gatus 探測改驗證 202+id（運維 fail 判準）。
2. `8ab4331f` — 純修復（CanvasEmbed 補 expanded/onToggleExpand props 修 build 型別錯誤）。
3. `ec748a51` — 能力導入（生產源碼恢復）：畫布專用生圖薄殼與 image-proxy、畫布圖片編輯全家桶、雲端素材庫 API/面板、提示詞庫聚合、節點內嵌生成面板、縮放/小地圖/快捷鍵、canvas-state 上行、canvas-ops-result 回報、生成輪 abort、v1/model-status、wechat 公眾號被動回覆登入、cron generation-worker、harness 文檔頁。
4. `6ec4f018` — 純修復／品牌（品牌名 Emu→Eimu）。
5. `425ac035` — 能力導入／供給面收口（生產版本恢復）：上游圖片轉存本站 Blob、動態站點 URL、用例庫 386KB 內容恢復、微信登入頁恢復；同時移除 sensenova-u1-fast（目錄＋渠道隊列）。
6. `e62cf333` — 新能力：輸入框粘貼/拖拽附件；參考圖上傳按模型能力門控。
7. `af3a9c4e` — 純修復＋邊界語義：畫布圖片直鏈→同源代理→破圖鏈路、破圖重試鈕、content 更新重置失敗態；`/_next/image` 放行 Blob 域；對比度提亮。
8. `8ec2239b` — 新能力：Dreamina Image 5 Pro/Lite/Seedream 2.0 進模型目錄（比例/解析度/幣價/參考圖）；Dreamina relay 白名單邊界。
9. `6711d495` — 新能力：Image 5 Pro 路由 Dreamina 生產池（priority 1 硬接端點）。
10. `6ebb22ef` — 純修復（pricing override 載入後保留模型能力，fallback 靜態 catalog）。
11. `271c66b6` — 純修復（runtime 模型能力查詢穩定，capabilities 直接查 effectiveCatalog ∪ 靜態 catalog）。
12. `984b9878` — 新能力＋邊界：容忍式 model-id 解析、Dreamina 模型無目錄能力可提交、session DELETE 冪等、建新會話注入帳戶畫像、PixAI 池帳號檔安全寫入（原子寫＋鎖）。
13. `420bdbd9` — 新能力：首次 workflow_start 即切畫布模式。
14. `286c47e5` — 純修復＋邊界語義：worker 心跳/迭代容錯，暫時性 DB 錯誤不殺進程、不觸發批量退款；unhandledRejection 只記錄。
15. `dd83c049` — 純修復（AI 助理面板 dock 佈局，畫布收縮讓位）。
16. `e19103a3` — 新能力（大）：/v1/batches 提交+聚合+對帳匯出、/v1/skus 目錄與下單與訂單查詢、/v1/tts 提交查詢、/api/character-cards CRUD、帳戶畫像與靜默教訓提煉、agent LoRA 搜索引擎、畫布語義節點、畫布語義參考圖與負面詞、OpenAPI 擴充。
17. `5758ed5d` — 純修復（question 卡區高度上限 40dvh，不擠壓輸入框）。
18. `051606bb` — 純修復（底部 pills 鋪滿整排、transcript 間距）。
19. `9e3d91da` — 純回滾（回滾 pills 撐開佈局）。
20. `5114bfcf` — 純修復（面板 overflow-hidden、卡區 45dvh 定版，回滾前兩輪錯誤 shrink/pb）。
21. `daa226cd` — 新能力：刷新自動續上上次會話（resume 取代 D-17 discardAndStartNew），提示改「已接續」。
22. `186b1770` — 新能力：對話歷史 dropdown（GET /api/agent/sessions 目錄端點＋hook switchSession＋UI）。
23. `1b31ad23` — 純修復＋誠實語義：dropdown 輕量化；閘道技術名詞（question/confirm expired）中文化。
24. `cb119753` — 純修復（dropdown 行高/點擊外部關閉/surface 溢出裁切）。
25. `4b034edf` — 純修復（dropdown z-50 與純白不透明底）。
26. `3275bef9` — 新能力：會話記憶補注鏈（resume/switch 老會話補帳戶畫像，gateway memory-patch）。
27. `e9e1b178` — 新能力：畫像 onboarding（無畫像建會話帶 memory_empty，gateway 首條訊息用 question 選擇題採集）。
28. `e7407935` — 重構＋新能力：liquid glass 設計系統遷移與 DESIGN.md/PRODUCT.md、大型檔案重構計畫；**新增 admin 出口代理池觀測面板與 HMAC 內部中繼端點**（AdminProxyPool）。
29. `5913f5a7` — 純修復（Tailwind 死 opacity modifier 改 bracket alpha＋擴充守門測試）。
30. `89294ebb` — 純重構（use-cases.ts 5396→83 行拆成 17 個領域 shard，內容不變）。
31. `8049becd` — 純修復（API docs method badge 死 opacity modifier）。
32. `3e7e4000` — 純重構（generation-model-catalog 拆 6 模組＋barrel，54 個 importer 不動）。
33. `1d7c9925` — 純重構（workstation 抽出 use-panel-resize）。
34. `a639f88d` — 純重構（PromptInput 抽出 3 hooks：use-agent-hint/use-height-lock/use-pixai-tools-panel）。
35. `69af3442` — 純重構（workstation 抽出 use-canvas-annotation）。
36. `a7837658` — 純重構＋測試（use-canvas-chat 抽 types/reducer-adapter/sync/cards/settler，新增 29 條 reducer adapter 測試）。
37. `8c7adcb5` — 純重構（workstation 抽出 use-boards-library）。
38. `04a7b366` — 純重構（workstation 抽出 workstation-recall）。
39. `22246bc0` — 純重構（CanvasNodeView 拆 node-view/：constants/use-node-gestures/NodeBody）。
40. `ca51b1ba` — 純重構（workstation 抽出 WorkstationTopbar 面板）。
41. `3442c999` — 純重構（CanvasEmbed 拆 embed/ 域：helpers/interaction/generation/shortcuts/overlays/context-menu-items）。
42. `e7e5148a` — 純重構（ImagePlayground 測試讀取路徑同步，主體抽取隨 a2cf10b 落庫）。
43. `9dff8689` — 純重構（PromptInput 抽出 4 個 JSX 面板＋rail-classes）。
44. `fcc52160` — 純重構（CanvasChatWorkstation 抽出＋use-chat-panel＋use-agent-param-reflect，D-12 三態復原行為原文搬遷）。
45. `52372765` — 純重構（workstation 抽出 InspectorPanel：queue/gallery/history）。
46. `b6e404bc` — 純重構（workstation 抽出 CanvasStage 面板）。
47. `e06544eb` — 純重構（workstation 抽出 LeftSettingsTab + WorkstationRunBar）。