# 第 7 批（47 commit）我方能力清單

- 範圍：/tmp/cap/batch-7.hashes 全 47 條（2026-09-28 ～ 2026-09-30）
- 口徑：能力＝使用者可見或可呼叫的行為；檔名/模組名不算能力。修復類若暴露邊界語義另列。
- 領域標籤限用 11 個。同一能力只列一次。

## 生成核心

- [生成核心] 音樂三路全鏈回落（YuE2→FlowMusic→Gemini Lyria） — 只在「已選通路拋錯」時回落；Lyria 僅在 GEMINI_API_KEY 已配置或有前路時入鏈；換通路必須用該通路重新過 director；全鏈失敗回退帶每一路原因碼 music_all_channels_failed ｜ 證據: e75a2e8e
- [生成核心] 欠費無替補即時失敗＋退款 — 上次失敗判定 quota_exhausted 且診斷顯示無可用替代供應商（全被排除／冷卻／不健康）即當下失敗並退款，不再空轉到 25 分鐘 deadline（實彈 2.4 秒）；capacity_saturated 不算（仍有健康供應商在忙）｜ 證據: e75a2e8e
- [生成核心] 影片生成式後期（續片 extend_video／局部改片 edit_video） — 僅 catalog 宣告 videoGenerationTypes 含該型別者可提交（今日＝Seedance-2.5 族）；型別契約＋能力閘門＋具名錯誤碼；兩條 route（api/generation-jobs、api/v1/videos/generations）皆接 ｜ 證據: 51ca0474
- [生成核心] 生成式後期來源影片解析 — 收 source_video.url 或 source_video.object_key（objectKey→url resolver），非 http(s) 一律 video_source_video_not_url 拒、缺來源 video_source_video_missing 拒（fail-closed，不猜）｜ 證據: 51ca0474
- [生成核心] 一鍵超分檔位契約 — 檔位是 (size, factor) 參數對而非枚舉字串：1k→(1k,×2)、2k→(2k,×2)、4k→(2k,×4)，長邊保底 4608px；一鍵預設＝最高可提交檔位 ｜ 證據: 329c4221
- [生成核心] 超分提交路由統一走檔位解析 — C 端 /api/pixai/upscale 與 B 端 /v1/upscale 都走 resolveUpscaleSubmission，factor 由呼叫端任意值改為契約值（計費口徑未動）｜ 證據: 329c4221
- [生成核心] 4K 提交端打開＋嚴格解析度解析 — 顯式 resolution／size:"4k"／size:"4096x4096" 皆可到 4k；未由模型宣告即具名拒 resolution_not_declared_by_model，禁靜默降級 ｜ 證據: 0289ade9
- [生成核心] durable 圖片尺寸白名單單一真源 — 已知可交上游尺寸（1024x1024／1536x1024／1024x1536／2048x2048／4096x4096）＋檔位倍率折算（1k×1／2k×2／4k×4）＋舊 "1k"/"2k" 別名；generations 的 SUPPORTED_SIZES 與 edits 的 DURABLE_EDIT_SIZES 收攏一處 ｜ 證據: 82ee2b9a
- [生成核心] 數量上限單一真源（批次數／參考上限） — request-limits 零 import 葉模組為唯一真源（MAX_REQUEST_BATCH_COUNT=4、MAX_REQUEST_REFERENCE_IMAGES=5），images/videos generations、biz-image-references、batch-service 全改引用點 ｜ 證據: a9b33109
- [生成核心] Web durable 任務負面詞與參考圖角色不再丟失 — 分發層用與 legacy /api/generate-images 同一函式（buildWorkflowPrompt）組進單一 prompt，位元組一致；用戶原文記 workflow.originalPrompt，顯示/重跑讀 displayGenerationPrompt 還原 ｜ 證據: 64b2bf91

## 模型與供應商

- [模型與供應商] 極途 Gway 備用視頻渠道（priority 2） — xiaoyxiao 直接上游，同名模型同協議；控面 DB＋env 已上線，seed 不會把它當未知渠道 ｜ 證據: ed47cb58
- [模型與供應商] 供給 adapter registry（協議註冊表） — 新增一條新協議供給＝2 檔（adapter 檔＋channels.config 條目），載入時自動註冊；分派／對帳／對帳協議映射三處中央 switch 皆查此表；未註冊協議明確失敗（不再 default 成 newapi_video）｜ 證據: 64b2bf91
- [模型與供應商] 上游模型別名改讀資料 configuration.modelAliases — 不再認 supplier 身分特例（廢除 supplier.id === "env:sub2api" 硬編）｜ 證據: 64b2bf91
- [模型與供應商] catalog 只外露可服務的超分檔位 — 宣告 upscaleTiers:[1k,2k,4k] 但 generationCapabilities 只給 servableUpscaleTiers（校準前不含 4K），不宣告提交時必被拒收的檔位 ｜ 證據: 329c4221
- [模型與供應商] YuE2 模型輸入預算（8GB 卡） — style 上限 3000→600 runes、ABC ≤500 token，截斷標記泛化為 truncate-${limit}-hard；同單 52.4s 成片、峰值 7.10GiB ｜ 證據: b68c0fdd

## 控制平面與計費

- [控制平面與計費] 成本閘按（供給 label, 上游 model）核價 — 讀 claim 的 unitPriceCny/priceSource（含來源原文與日期），缺價才回退兜底表；兩者皆無＝未核價不許提交；openai_video 協議 fail-closed，其他協議只在上游 model 落白名單時套價檢 ｜ 證據: 64b2bf91
- [控制平面與計費] 同步直通路由的錢進帳本 — /v1/images/edits（pixai 分支）、/v1/upscale、/v1/template-generations、/api/pixai/* 經 sync-charge 門面留 billing_operation 列，可被 reconcileGenerationBilling／retryStrandedRefundOperations 撈回（原本退款失敗只剩一行日誌）｜ 證據: 64b2bf91
- [控制平面與計費] 同步 job 狀態機（絕不進 queued） — reserve 成功後 job 保持 running；確定未扣 → op failed＋job failed（客戶當下拿 402，不在背後偷偷扣）；不明 → op unknown＋job billing_unknown 交 6h 殭屍回收全額退款 ｜ 證據: 64b2bf91
- [控制平面與計費] 取消任務＋條件退款門面 — 分發路由只收 { cancelled, previousStatus, refund }；queued/leased 全額退款、pending_billing 未扣不退、submitting/running 由 worker 丟棄並交 reconcile 兜底；退款未 applied 不向客戶端謊報已完成 ｜ 證據: 64b2bf91
- [控制平面與計費] 4K 超分計費改吃檔位 — imageGenerationCoins 第三參數帶檔位，4K 不再按 1k/2k 價賣；既有輸入（1024x1024／2048x2048 ＋ fast/hd）解析度與價格逐位元不變 ｜ 證據: 0289ade9
- [控制平面與計費] GET /api/admin/statistics?format=csv 統計/用量導出 — 同一份投影的 CSV（單表＋section 欄供 Excel 篩選/pivot），meta 段帶窗口與口徑；只認 json／csv，其餘具名 400；導出與 JSON 同一道 admin 門 ｜ 證據: c6ca3857
- [控制平面與計費] 用量按生成物類別切分 — byAssetKind 切面（shot_video／still_image／unclassified 三桶），錨點與日／模型同一個 job ⇒ 三切面可逐桶對帳；CSV 增 asset_kind section ｜ 證據: 8d9e067f
- [控制平面與計費] 後台統計看板取真數字 — /api/admin/statistics 加進 CONTROL_PLANE_PROXY_SOURCES（控面容器同時有 route 與庫），不再由 Vercel 本地副本回「統計不可用」降級投影 ｜ 證據: 6221c69d

## B端API

- [B端API] /v1/models 升級成能力契約 — 逐模型揭露 maxBatchCount（全給）＋maxReferenceImages（僅 referenceImages===true 時給）；openapi ModelCapabilities schema 補 5 欄（新 2 欄＋videoGenerationTypes／promptCharLimit／upscaleTiers）｜ 證據: a9b33109
- [B端API] GET /v1/tts/voices 結構化語音庫 — 照對手 ListVoices 無參數全量回，每條附 route（實際走哪條上游）與 source（屬性實查來源），另回 default_voice 與 Age 缺席說明 ｜ 證據: 215d2f07
- [B端API] POST /v1/tts/generations 音色值域把關 — voice 走 normalizeVoiceId，未知 → 400 voice_unknown（訊息指向語音清單）；未帶 voice ⇒ 既有 "default" 行為逐位不變 ｜ 證據: 215d2f07
- [B端API] /v1/upscale 對外文件揭露檔位契約 — 三檔位上游配對、一鍵預設語義、三個具名拒收碼寫進摘要；schema 補 upscale_tier（enum＝執行端 UPSCALE_TIERS）、factor 改寫成檔位倍率語義、size 去掉假的 default ｜ 證據: de4f5df9
- [B端API] generations 的 size 列舉從執行端常數派生 — enum: [...DURABLE_IMAGE_SIZES] 補 4096x4096，並揭露 resolution／output_resolution 檔位鍵 ｜ 證據: b32c4818
- [B端API] 建 key 面板與 /docs/api 曝光 OpenAI 兼容 base — 顯示 https://eimu.dev/openai/v1（此前只寫在 repo docs，開發者不可見）｜ 證據: 3a483ee6
- [B端API] /v1/upscale 新後端口徑與自證欄位 — 文件寫明「是重新繪製、不是保真像素放大」、後端與具名碼；ImageObject 補 width/height（回應帶實測尺寸供自證）｜ 證據: 0289ade9
- [B端API] /v1/upscale 揭露「檔位以 size 表達」口徑與新碼 upscale_backend_size_unavailable ｜ 證據: 82ee2b9a

## Agent助理

- [Agent助理] 「已思考 N 秒」當下結算 — 思考後直接調工具（中間無正文）時在 tool.invoke 即結算 reasoningMs，不再等整輪 settleItems 造成每段思考都顯示成到整輪結束 ｜ 證據: bd5405f5
- [Agent助理] 「已用 N 币」只算真花費 — 報價估價與失敗工具不計入；網關側報價類工具 tool.result 不再掛 cost_coins（雙端同修）｜ 證據: 5d4e202b, e5d954a7
- [Agent助理] 自動製畫布只給出圖工具 — image_quote／get_result／upload 不再鋪永遠待處理的空節點 ｜ 證據: c5115e19
- [Agent助理] 站內可達 Remote MCP 安裝頁 /mcp — 助理帶走頁補連結（此前站內零連結、文檔只教克隆自建）｜ 證據: 74fb5728
- [Agent助理] 斜線技能選單底部「瀏覽全部技能」→ /skills ｜ 證據: 905bcccf
- [Agent助理] 助理可用影片取證工具登記＋知識正文還工具 — video_evidence／video_fetch／video_measure／video_transcribe 進 harness-tool-registry；kunpeng-knowledge 把「怎麼看參考片」從純文字指導接回這四支（含環境未 prepare 時回 video_fetch_unavailable 的誠實邊界）｜ 證據: 1fdcafc0

## 畫布與工作流

- [畫布與工作流] 畫布生成預設走 durable job — 每張 POST /api/generation-jobs（帶 Idempotency-Key）→ 伺服器端輪詢取件，回應形狀與舊版一字不變；等待上限＝maxDuration−20s，超時回 504 generation_timeout 且不取消任務 ｜ 證據: 64b2bf91
- [畫布與工作流] Blender 插件下載入口 — 畫布「连接 Blender」補 public/downloads/eimu-blender-addon.py（測試鎖與 bridge 真源逐字一致）｜ 證據: 3a483ee6
- [畫布與工作流] 節點右鍵「恢复上一版」 — 接既有 revert_node reducer（進撤銷棧，無更早版本時灰掉）｜ 證據: 3a483ee6
- [畫布與工作流] 圖片右鍵「一稿多版位」 — 經 /api/canvas/format-crops 按常用尺寸裁出版位，落成源圖右側子節點＋連線（擴圖版位無上游照實略過）｜ 證據: 3a483ee6
- [畫布與工作流] 3D 白模當生成參考 — scene_3d 節點的 stills 經既有 blender-to-video-bridge 參考卡接成生成節點的一等參考（影片/模型檔由該輪子剔除、首張帶 nodeId 作去重載體）｜ 證據: aa81b4b0
- [畫布與工作流] 回分鏡溯源兩鍵 — directorStageId／shotId 進 metadata 雙白名單；shotId 優先舞台自身 storyboardShot.shotNumber，其次生成節點自身 ｜ 證據: aa81b4b0
- [畫布與工作流] 分鏡級候選集與星標選定 — 一分鏡 ≤4 條（第 5 條明確拒絕）、首條自動選定、不自動搶稿、星標者被刪除才回退首條 ｜ 證據: aa81b4b0
- [畫布與工作流] 候選 prompt 回溯 — 候選可讀回產生它的 prompt 供重跑；缺 prompt 整條丟棄，不編造 ｜ 證據: aa81b4b0
- [畫布與工作流] 分鏡增刪複製重排 — 複製品剝掉來源的產物／裁決／溯源指針 ｜ 證據: aa81b4b0
- [畫布與工作流] 按集批次換模型／批次重跑 — metadata.episodeId＝CanvasEpisode.id（現場原無「分鏡→集」的邊）；缺 prompt 的格列 missingPromptShotNumbers 並排除，不用假 prompt 花錢 ｜ 證據: aa81b4b0
- [畫布與工作流] 任務版本／Tags／選中標記 — per-任務版本（重跑產生新版本且舊版本存活）、Tags 語義與分組、選中照既有 batchPrimaryImageId／reducer 星標回退語義（不自創第三套）｜ 證據: 51ca0474
- [畫布與工作流] 專案級風格綁定（風格一等 id） — styleId id 進全文出：request > project 優先序、查不到回 null（不猜近似 id、不回退第一個風格）；未知 id 在 /api/canvas/generate 於任何下游請求之前 400 style_id_unknown 擋下；無風格時 prompt／負面詞逐位不變 ｜ 證據: 8dcdcd57
- [畫布與工作流] 專案級劇本型別與旁白音色 — scriptType 接既有 AID enum（plot／monologue，desc 逐字取自 AID 未改寫）、narrationVoice 直接複用 normalizeVoiceId（與 /v1/tts/generations 同一把尺）｜ 證據: f2668377
- [畫布與工作流] 專案級欄位匯出／匯入帶得走 — styleId、scriptType、narrationVoice 走完整七處接線（types／normalizeProject 逐欄白名單／canvasProjectMeta／normalizeProjectMetaPatch／專案 PUT／hook state 與三處還原點／setProjectMeta），匯出整包帶走、匯入經 canvasProjectMeta ｜ 證據: 8dcdcd57, f2668377
- [畫布與工作流] 影片截幀容量放開與 at 模式 — /api/canvas/video-frames 時長上限 60→600s、序列幀 24→600、新增 mode:"at"＋atSec 時間點清單（嚴格遞增、全部 < 片長），加 intervalSamples／tileSampleTimes／frameFileName（照 hypit 語義移植）｜ 證據: 1fdcafc0
- [畫布與工作流] 模板卡片旋轉木馬重構 — 沿用 CaseShowcase 交互機件（wheel {passive:false}／SPRING_TRACK／drive() 全保留），提交鍵跑選定步驟、海報浮水印卡片、挑著跑時主按鈕帶 k/N 與「恢复全部」、零選時禁用 ｜ 證據: c859432b

## 創作域

- [創作域] 變裝子資產 — 既有 variantOf 之上長出：角色掛多個具名變裝（各自參考圖）、可新增變裝、設定階段缺件明確具名回報（不得靜默用主造型頂替）；drama-recipe 套用路徑真的取到變裝參考 ｜ 證據: 51ca0474
- [創作域] 變裝缺件 fail-closed 落到資料面 — disguises 為空時 prompt 一律清空（needsAsset/missingDisguiseNames 只是回報欄位，擋不住消費端）；命中變裝但變裝自己沒寫 prompt 才沿用卡本體片段；清洗去重鍵與 addCharacterDisguise 對齊（id 或 name，留最後一張）｜ 證據: 3d46f837
- [創作域] 兩段式上傳（直傳憑證 → objectKey 入庫） — VPS 走 image-data-api 短效 HMAC 簽名（母鑰只留伺服器端）、Vercel 走 handleUpload client token；第二段親自取回位元組算 sha256 才入庫；上限 512MB、內容型別白名單；端點 /api/uploads{,/sign,/commit} ｜ 證據: 1fdcafc0
- [創作域] 視頻運鏡預設 23 條 — 視頻生成面板「运镜」行接 camera-motion-presets，後綴替換語義同風格 chip（可選「不指定」）｜ 證據: 3a483ee6
- [創作域] 劇本入口曝光（novel_film） — 正面卡補一行入口提示；示範 chip 第三條換成長文本改編口徑（原「大电影」命中泛用 feature_film，等於把人往通用產線引）；純 UI/文案、零判定邏輯改動 ｜ 證據: 1fdcafc0

## 帳號與增長

- [帳號與增長] 助理出的圖可以分享（分享即邀請迴路） — 圖卡「分享」先以 agent-<taskId> 經既有 POST /api/history 冪等補寫歷史（順帶讓助理作品出現在歷史頁）再開既有分享框；/api/share 未命中時等歷史索引快取（3s）過期重讀一次，免跨實例剛寫入即 404 ｜ 證據: d9169959
- [帳號與增長] 公告橫幅／彈窗兩個投放面渲染 — AnnouncementSurfaces 由 Navbar 單例掛載，關閉即 dismiss/mark-read ｜ 證據: 3a483ee6

## 前端與UI

- [前端與UI] 工作站跨螢幕等比 — 以 1274×664 為設計基準按 min(寬比,高比) 放大根字級；面板／間隙／圓角／FAB／卡內字級改 rem，3D 透視跟卡寬等比 ｜ 證據: ee89d6c3
- [前端與UI] body 與助理面板 px→rem 等比縮放 — 字級／圖標／輸入框跟工作站根字級縮放（基準機零變化）｜ 證據: 620b6267
- [前端與UI] 工作站態解除導覽列頁殼 1440 上限 — >1440 視口面板／畫布不再被夾成置中窄殼 ｜ 證據: fc314d43
- [前端與UI] 首頁不再每次 hydration 失敗重建 — 內聯 <style> 註解不再含字面 <style>（SSR 轉義不符）｜ 證據: ef4e8b19
- [前端與UI] 文檔中心「找现成做法」三入口 — 場景指南／創作產線／技能目錄三個此前對用戶零可見入口（此前 /use-cases、/workflows 只在 hidden SEO 區塊）｜ 證據: 14a99737

## 運維與觀測

- [運維與觀測] 網關 opencode SSE 30s 看門狗 — /event 30s 無位元組即 abort 重連（opencode 每 ~10s heartbeat），消除重啟 opencode-server 後最長 5 分鐘的 SSE 盲窗（VPS 實測重連 35s）｜ 證據: c7788ee8
- [運維與觀測] npm healthz/smoke:image 改 curl（Arch Linux）｜ 證據: c7788ee8
- [運維與觀測] 控面建置 context 白名單＋next build 快取掛載 — .dockerignore 改 allowlist（VPS context 383M→只剩建置所需）；builder 層 RUN --mount=type=cache 掛 .next/cache，改一行不再全量編譯 ｜ 證據: c7788ee8
- [運維與觀測] 控面代理清單單一真源＋DB 綁定 route 漂移棘輪 — CONTROL_PLANE_PROXY_SOURCES／controlPlaneRewrites(origin) 為唯一真源（rewrites() 輸出逐字相等）；測試掃 src/app/api route.ts 遞迴 import 閉包，觸及含 GENERATION_DATABASE_URL 的模組且未被代理者必須列 KNOWN_VERCEL_LOCAL 基線，過期條目亦紅 ｜ 證據: 203a86ae
- [運維與觀測] 補四條漏網代理 DB route — billing-operations 裸路徑、biz-keys/provision、probe/stuck、probe/jobs/*（原本 Vercel 無庫、登入後必 500）｜ 證據: 1c6e0e20
- [運維與觀測] nginx 改 nginx -t＋reload（禁 restart）＋postcheck 加經 nginx 的對外 healthz — 事故：restart 遇上游容器已被移除 → [emerg] host not found → 全站入口重啟迴圈；容器內 healthz 當時仍 200，故補對外探測 ｜ 證據: a823d5f1
- [運維與觀測] 控面部署腳本修正 — 本機無 hostname 改 uname -n；build 快取清理改 --keep-storage 2gb（until=72h 放過新快取，部署後磁碟觸 98%）｜ 證據: 73f37beb

## 團隊與企業

- [團隊與企業] 資產團隊維度 — asset-scope 加 owner:"team"＋teamId；鬼狀態 fail-closed（不降格 personal）｜ 證據: 1fdcafc0
- [團隊與企業] 團隊／成員配額判定與存取 — fixed/daily 模式、UTC+8 日界（epoch offset 480 分）、回收上限、超賣保護；配額只寫意圖（team_settings／team_member_quota）不寫五態帳本、不預扣 ｜ 證據: 1fdcafc0
- [團隊與企業] 三級權限矩陣（主帳／管理員／成員） ｜ 證據: 1fdcafc0
- [團隊與企業] GET/POST /v1/team/quota/limits 配額讀寫面 — GET 團隊模式＋各成員模式與當日用量；POST scope=team/member 設配額；鑑權照同群組既有 /v1/team/quota，團隊主帳＝呼叫方密鑰的 user_id，成員密鑰改配額 403 ｜ 證據: 1fdcafc0
- [團隊與企業] /v1/team/members 回團隊與成員配額區塊 — 讀不到映射層就省略該欄（不冒充）｜ 證據: 1fdcafc0

## 非程式碼能力

- 控面一鍵部署腳本 deploy/vps/deploy-control-plane.sh — plan 唯讀雙向 diff 閘（VPS 將覆寫檔的 md5 不在 repo 該路徑歷史任一版 ⇒ BLOCKED）／deploy 版本化鏡像＋postcheck 自動回滾／rollback；來源＝git HEAD（git archive 白名單，不部署 working tree）；本機無 rsync 時退 md5 清單比對＋tar（判準等價）｜ 9e5664be
- DB 遷移 032_supplier_adapter_type_open.sql — 供給 adapter_type 開放為任意協議字串（由 registry 執行期判定合法值）｜ 64b2bf91
- DB 遷移 033_team_quota_limits.sql — 團隊／成員配額意圖欄位 ｜ 1fdcafc0
- VPS 側 image-data-api 新增 POST /api/blob/presign（短效 HMAC 簽名直傳）＋ nginx 上限，已完成端到端驗證（簽名直傳→讀回 sha256 相符）｜ 1fdcafc0
- VPS /opt/agent-harness/gateway/events-translate.ts 同步（報價不掛 cost_coins、自動製畫布只給出圖工具），各自留 .bak 備份 ｜ e5d954a7, c5115e19
- 控面 env 同步 ADMIN_SESSION_SECRET／ADMIN_USERNAME 進 .env.control-plane（統計代理的前置條件）｜ 6221c69d
- 控面 DB＋env 上線 gway 渠道（seed 不當未知渠道）；V-03 起在 channels.config 帶入已核單價與來源日期 ｜ ed47cb58, 64b2bf91
- 控面 compose 模板同步 control-plane-compose.yml（補齊與 VPS 現役檔的非 secret 差異並標明為模板）｜ c7788ee8
- Runbook 更新 docs/runbooks/infra-debugging.md — 網關 session 已 SQLite 持久化；opencode SSE 懸掛根因與 30s 看門狗（VPS 實測重連 35s，原 5 分鐘）｜ a7d81d8d
- 雙真相邊界文件 docs/architecture/dual-truth-boundary.md（W5，純文件） — world1（畫布多步生產鏈）↔ world2（模板＋素材注入＋成片）；新事實：world2 自己有兩份（VPS 活本 /opt/agent-harness/gateway/ 與 repo 鏡像 deploy-staging/gateway/，2026-09-29 逐檔 md5 全等但「一致」是當下狀態不是契約）｜ 79e1f5a3
- AGENTS.md 規則：禁內聯——任何動手環節一律派 subagent ｜ 1fdcafc0
- staging 鏡像同步 staging/music-tools/{music_tools,music_prompt_director}.ts（e75a2e8e／b68c0fdd 的 staging 側）｜ aa729665

## 邊界與拒絕

- YuE2 輸入硬截斷：style 600 runes、ABC 500 token，截斷標記 truncate-${limit}-hard（8GB 卡 NAR prefill 顯存預算）｜ b68c0fdd
- 生成式後期閘門壓在成本閘之後、任何 fetch 之前（fail-closed）；不支援的模型即拒，不靜默降級成 generate ｜ 51ca0474
- 分鏡候選第 5 條明確拒絕；缺 prompt 的候選/格列整條丟棄（不用假 prompt 花錢）｜ aa81b4b0
- 4K 超分 fail-closed：upscale_4k_upstream_unverified（上游 factor 語義未經真單校準），env UPSCALE_4K_UPSTREAM=1 於校準後開啟；切 gpt-image-2 新後端亦同閘（直到真單量到長邊 ≥3840px）｜ 329c4221, 0289ade9
- 不製造假檔位：對手列 720P/1080P/2K/4K，上游 RATIO_SIZES 只有 1k／2k 兩個鍵，720P 鍵不存在 ⇒ 只列 1K/2K/4K，不加靜默回退成 1K 的假標籤 ｜ 329c4221
- 超分具名拒收碼：upscale_bridge_size_unsupported／upscale_tier_unsupported／upscale_factor_conflict／upscale_input_too_large／resolution_not_declared_by_model／upscale_backend_size_unavailable（不支援一律具名拒、不靜默降級）｜ 329c4221, 0289ade9, 82ee2b9a
- 視頻超分上游無通道 ⇒ 帶 video 具名拒 upscale_video_upstream_unsupported ｜ 329c4221
- 超分後端切換（legacy PixAI bridge ↔ gpt-image-2 重繪）＝定價決策（0.001 币一口價 → 檔位價），未經裁定不擅自切；默認 legacy ｜ 0289ade9
- 檔位折算出的像素 size 落不進白名單即具名拒，不靜默降級成較低檔位（如 3:2 的 2k⇒3072x2048、16:9 的 1k⇒1792x1024）｜ 82ee2b9a
- 資產團隊維度鬼狀態 fail-closed（不降格 personal）｜ 1fdcafc0
- 配額只寫意圖上限與速率計數，不寫本地餘額、不呼叫上游額度調整、不預扣；「改回不限 ⇒ 剩餘全數回收」只回報應回收額度（reclaim），實際點數移動須另走既有轉移通路 ｜ 1fdcafc0
- 統計 CSV 缺值留空不填 0（「沒有這個數字」≠「這筆量是 0」）；control-plane DB 未配置時照抄投影的 configured:false，不吐一排 0 ｜ c6ca3857
- 統計 CSV 組織維度（總／團隊／子帳號／專案）缺席 ⇒ 一列都不偽造；byScope 留為延伸點 ｜ c6ca3857
- 用量類別：角色／場景／道具保留在值域但不指派（提交端完全沒有落盤事實，節點類型與 episodeId 都不進請求）；未知／缺席 kind 一律 unclassified 不猜 ｜ 8d9e067f
- 語音庫 Age 一律缺席（上游清單沒有 Age 欄位 ⇒ 不編造）；接受集≠描述集，刻意不收 foo:bar 這種上游會拒→降級→靜默變預設的形式 ｜ 215d2f07
- 上游缺陷釘成事實（未修，proxy 在 VPS）：shimmer → zh-CN-XiaoyouNeural 而 Microsoft 現行清單已無該音色 ⇒ 降級路徑對 shimmer 會失敗 ｜ 215d2f07
- 非解說劇卻綁旁白音色 ⇒ narrationVoiceConflicts 具名回報該設定不生效（不靜默忽略、也不代用戶清掉）；effectiveNarrationVoice 未綁＝null（不假裝綁了）｜ f2668377
- 非法值逐一欄位獨立省略（同既有 meta 範式，不整包作廢）；專案欄位型別寬 string 因載荷不可信 ｜ f2668377, 8dcdcd57
- 生成路由刻意不讀專案：按未驗證的 x-user-id 讀他人專案＝跨租戶讀取，故以「專案持久化綁定＋呼叫端帶 id」表達 ｜ 8dcdcd57
- 沒套風格時 /api/canvas/generate 回應形狀與舊版逐位一致（style_id／style_source 只在真套了才吐）｜ 8dcdcd57
- pixai-upscale 不進 /v1/models：image-model-ids 明文規定服務類定價條目不入 SUPPORTED_*，硬塞會製造空能力宣稱並壞 openapi x_endpoint 枚舉；由測試釘成事實（哪天進清單該測試會紅）｜ a9b33109, 329c4221
- maxReferenceImages 只在 referenceImages === true 時給（否則就是空能力宣稱）｜ a9b33109
- 報價類工具 tool.result 不再掛 cost_coins（報價 ≠ 已用/消耗）；失敗工具與估價不計入「已用 N 币」｜ e5d954a7, 5d4e202b
- 自動製畫布只給出圖工具（image_quote／get_result／upload 不鋪永遠待處理的空節點）｜ c5115e19
- 無 GENERATION_DATABASE_URL 的實例（Vercel 站點副本的 /api/pixai/*）沒有帳本可寫 ⇒ 門面退回直接經 billing adapter 扣退款並如實標 ledger=false（既有行為保留，不是帳本化）｜ 64b2bf91
- 供給 registry 載入期驗證：protocol 不得為空且全域唯一、channel.adapterType 須等於 adapter.protocol、reconcileVia 必須是「可輪詢」的已註冊協議，違反即載入拋錯 ｜ 64b2bf91
- Next route 模組只准匯出 handler（__setAssetsTeamGateDepsForTests 這類測試 setter 必須移出 route 檔，否則生產 build 失敗）；route 檔內不得讓 useVpsBlobBackend 被 rules-of-hooks 誤判 ｜ 0e7b3745, 159259a7
- 尺寸別名改走 hasOwnProperty 查表（原型鍵不會再被當別名讀出函式）｜ 36fcbab5
- Vercel 生產 env 無 GENERATION_DATABASE_URL（7 個鍵）⇒ 觸及該庫的 route 沒被代理就是登入後必 500，棘輪會逼刪過期基線條目 ｜ 1c6e0e20, 203a86ae
- 文件與執行端漂移鎖：/v1/upscale 檔位列舉＝執行端檔位全集、size 列舉＝bridge 比例表實際有的鍵、size.default 不得假；generations size 枚舉從執行端常數派生（改歪就紅）｜ de4f5df9, b32c4818
- 控面無 ADMIN_SESSION_SECRET／ADMIN_USERNAME 時，統計代理過去也只是 401（前置條件寫進註解）｜ 6221c69d
- 影片抽幀到頂明確拒絕、不靜默截斷（600 幀／600 秒；訊息給提高 step 或改伺服器端抽幀的出路）；mode:"at" 清單須嚴格遞增且全 < 片長；序列幀數須 ≥2（單幀用 mode:"current"）｜ 1fdcafc0
- 非綁定式變裝缺件無法歸屬到哪張卡，但作者宣告了變裝就不該有人以主造型出圖 ⇒ 本鏡所有角色卡一起去造型；場景／道具卡不受影響 ｜ 3d46f837
- 模板旋轉木馬必須保留原交互機件（wheel {passive:false}／SPRING_TRACK／drive()）——禁精簡複製（2026-08-25 三輪返工教訓）｜ c859432b

## 存疑

- aa729665：staging 側鏡像同步（staging/music-tools/music_tools.ts）——訊息僅稱「e75a2e8e 的 staging 側」，無新能力；是否有 staging 獨有差異需逐行 diff staging 與 src 才能斷定 ｜ 缺：staging 執行環境與 diff 證據
- 1fdcafc0：「站內 /api/uploads 尚未部署」為 commit 自陳；兩段式上傳目前只在 VPS 側（presign 端點）端到端驗證 ｜ 缺：站內部署與站內端到端證據
- 1fdcafc0：P1-1（白模當生成參考）與其 11 條測試因與在飛的 canvas/types.ts 同檔而暫不提交；下一顆 aa81b4b0 是否即為其落地需比對（兩顆都寫 P1-1，內容一致）｜ 缺：commit 父鏈外的在飛檔狀態
- aa81b4b0：抽卡面板／集側欄／批次按鈕等 React 接線未做；episodeId 的寫入端（誰在分鏡產生時蓋集指針）未做（commit 自陳）⇒ 「按集換模型」目前缺前端入口 ｜ 缺：前端接線證據
- 51ca0474：三條已知未收口（①字串式宣告缺件時任務 referenceImages 仍含主造型參考、閘只在 needsAsset；②綁定式缺件時 prompt 仍沿用卡本體片段；③清單清洗只按 id 去重、新增路徑才按名字覆蓋 ⇒ 解析取決於清單序），測試以「現況記錄」釘住待裁決 ｜ 缺：裁定與收緊後測試
- 51ca0474：生成式後期的真單未驗（上游生成請求需暴君逐次報備，本輪零付費呼叫）⇒ 「Seedance-2.5 族可續片/改片」僅契約與行為測試層已證 ｜ 缺：付費真單證據
- 329c4221 / 0289ade9：PixAI 是否接受 upscale=4、輸出是否等於「基底 × factor」未經真單校準；gpt-image-2 的 4K 輸出色校準亦未完成（控面唯讀取證只到能力閘 present）｜ 缺：真單色校準證據
- ed47cb58：gway「控面 DB＋env 已上線」無法從 repo 驗證（本 repo 只有 config 與 seed）｜ 缺：控面 supplier 表證據
- 64b2bf91：三平面違規項（V-01～V-09）進度表在 docs/architecture/planes-violations.md，未逐條核是否全清（V-05 渠道選擇由 new-api Distribute 承擔，本檔自陳「另案」）｜ 缺：違規表逐條核對
- c859432b：訊息未說明「海報浮水印卡片」的水印是否可關／是否影響產線；未查到相關測試語義 ｜ 缺：水印行為的驗收口徑
## 逐條對帳

| hash | 該 commit 貢獻的能力（或「純修復／純重構／無新能力」） |
|---|---|
| e75a2e8e | 音樂三路全鏈回落（YuE2→FlowMusic→Lyria）＋欠費無替補即時失敗並退款 |
| b68c0fdd | 邊界語義：YuE2 style 上限 600 runes／ABC 500 token，截斷標記 truncate-${limit}-hard |
| aa729665 | 無新能力（staging 鏡像同步 e75a2e8e 的 music_tools） |
| ed47cb58 | 極途 Gway 備用視頻渠道（priority 2），控面 DB＋env 上線、seed 不當未知渠道 |
| c7788ee8 | 網關 opencode SSE 30s 看門狗；npm healthz/smoke 改 curl；控面建置 context 白名單＋build 快取；compose 模板同步 |
| a7d81d8d | 無新能力（runbook 文檔：session SQLite 持久化、SSE 懸掛根因與看門狗） |
| 203a86ae | 控面代理清單單一真源＋DB 綁定 route 漂移棘輪（KNOWN_VERCEL_LOCAL 基線） |
| 9e5664be | 非程式碼：控面一鍵部署腳本（plan 雙向 diff 閘／deploy 版本化＋postcheck 回滾／rollback） |
| 73f37beb | 純修復：部署腳本 uname -n、build 快取 --keep-storage 2gb（防磁碟 98%） |
| 1c6e0e20 | 補四條漏網代理 DB route（billing-operations 裸路徑、biz-keys/provision、probe/stuck、probe/jobs/*）；邊界：未代理＝登入後必 500 |
| a823d5f1 | nginx -t＋reload 禁 restart＋postcheck 對外 healthz；邊界：容器內 healthz 200 ≠ 對外可用 |
| 64b2bf91 | 供給 adapter registry；成本閘按供給核價；同步直通路由計費入帳本（sync-charge）；同步 job 狀態機；取消＋條件退款門面；canvas 生成走 durable；Web 負面詞/參考圖角色不再丟失；模型別名讀資料；migration 032 |
| 3a483ee6 | 六個用戶面入口：OpenAI 兼容 base 曝光、Blender 插件下載、公告橫幅/彈窗、節點恢復上一版、一稿多版位、視頻運鏡預設 23 條 |
| 74fb5728 | 站內可達 Remote MCP 安裝頁 /mcp（此前零連結） |
| 905bcccf | 斜線技能選單底部「瀏覽全部技能」→ /skills |
| 1fdcafc0 | 資產團隊維度＋三級 RBAC＋團隊/成員配額＋/v1/team/quota/limits＋migration 033；劇本入口曝光（novel_film）；兩段式上傳（/api/uploads{,/sign,/commit}，VPS presign）；影片截幀容量放開＋at 模式；W7 影片取證工具登記＋知識還工具；AGENTS.md 禁內聯 |
| aa81b4b0 | 3D 白模當生成參考＋回分鏡溯源兩鍵；分鏡候選集/星標/prompt 回溯/增刪複製重排；按集批次換模型與批次重跑（episodeId） |
| d9169959 | 助理出的圖可分享（agent-<taskId> 冪等補寫歷史再開分享框；/api/share 快取過期重讀） |
| 159259a7 | 純修復：two-phase-upload 的 useVpsBlobBackend 補 rules-of-hooks 豁免（1fdcafc0 起 build 失敗） |
| 0e7b3745 | 純重構／修復：/api/assets 團隊閘移出 route 模組（Next 不准 route 匯出測試 setter） |
| ef4e8b19 | 純修復：內聯 style 註解含字面 <style> 致首頁每次 hydration 失敗重建 |
| 14a99737 | 文檔中心「找現成做法」三入口（場景指南／創作產線／技能目錄） |
| 51ca0474 | 生成式後期（續片 extend_video／改片 edit_video，僅 Seedance-2.5 族）；任務版本／Tags／選中；變裝子資產＋缺件具名回報 |
| fc314d43 | 工作站態解除導覽列 1440 上限（>1440 不再夾成窄殼） |
| bd5405f5 | 「已思考 N 秒」在 tool.invoke 當下結算（不再等整輪 settleItems） |
| 5d4e202b | 「已用 N 币」不再把報價估價與失敗工具算成花費（前端側） |
| e5d954a7 | 報價類工具 tool.result 不掛 cost_coins（網關側，已同步 VPS） |
| c5115e19 | 自動製畫布只給出圖工具，image_quote/get_result/upload 不鋪空節點（已同步 VPS） |
| ee89d6c3 | 工作站跨螢幕等比（1274×664 基準、min(寬比,高比) 放大根字級、多項改 rem、3D 透視等比） |
| 620b6267 | body 與助理面板字級／圖標／輸入框 px→rem 跟根字級縮放（基準機零變化） |
| 3d46f837 | 變裝缺件 fail-closed 落到資料面（參考圖與 prompt 雙清、drama-recipe 全角色卡去造型、去重鍵與 add 對齊） |
| 329c4221 | 一鍵超分檔位契約＋4K 檔位（(size,factor) 對）；具名拒收碼；servableUpscaleTiers 只外露可服務檔位；C/B 端路由統一；4K fail-closed；視頻超分具名拒 |
| 79e1f5a3 | 無新能力（W5 純文件：雙真相邊界；新事實＝world2 有 VPS 活本與 repo 鏡像兩份） |
| 8dcdcd57 | 專案級風格一等 id（id 進全文出、未知 400 style_id_unknown、不讀專案避免跨租戶讀取、匯出匯入帶走） |
| a9b33109 | /v1/models 升級成能力契約（maxBatchCount／maxReferenceImages＋openapi 補 5 欄）；request-limits 數量上限單一真源；邊界：pixai-upscale 不進清單 |
| c6ca3857 | GET /api/admin/statistics?format=csv 統計/用量 CSV 導出（BOM＋CRLF＋RFC4180、缺值留空、不偽造組織維度） |
| c859432b | 模板卡片旋轉木馬重構（沿用 wheel/spring/drive，提交鍵跑選定步驟、海報浮水印卡片） |
| 215d2f07 | GET /v1/tts/voices 結構化語音庫＋POST /v1/tts/generations 未知音色 400 voice_unknown；Age 誠實缺席；接受集≠描述集 |
| 8d9e067f | 用量按生成物類別切分（shot_video／still_image／unclassified）＋CSV asset_kind section；角色/場景/道具保留不指派 |
| f2668377 | 專案級劇本型別（接 AID enum）＋旁白音色（走語音庫同一把尺）；非解說劇綁音色具名回報 |
| de4f5df9 | /v1/upscale 對外文件對齊檔位契約（upscale_tier enum、factor 語義、size 去假 default、三閘碼）＋漂移鎖測試 |
| 6221c69d | 後台統計 /api/admin/statistics 代理到控面（生產看板取真數字）；前置條件 ADMIN_SESSION_SECRET/USERNAME |
| 0289ade9 | 4K 提交端打開＋嚴格解析（resolution_not_declared_by_model）；計費改吃檔位；/v1/upscale 後端二 gpt-image-2 生成式重繪；默認仍 legacy（定價決策不擅自切） |
| 94c48e3e | 純重構：超分後端規劃搬到 lib（route 檔只准匯出 handler）；邊界：next build 型別閘 |
| 82ee2b9a | 檔位靠像素 size 承載（推翻 resolution 假設）；durable-image-sizes 尺寸白名單單一真源；折算落不進白名單具名拒 upscale_backend_size_unavailable |
| b32c4818 | generations size 枚舉從執行端常數派生並補 4096x4096、揭露 resolution 檔位鍵；漂移鎖擴到生成端 schema |
| 36fcbab5 | 純修復：尺寸別名改走 hasOwnProperty 查表（原型鍵不再被當別名讀出函式） |
