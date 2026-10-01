# image-app 第 5 批（47 commit）能力窮舉清單

- 來源：`/tmp/cap/batch-5.txt`（47 條）、`/tmp/cap/batch-5.hashes`、repo `/home/lenovo/Desktop/image-app`
- 日期範圍：2026-09-25 ～ 2026-09-27
- 能力判定：**使用者可見或可呼叫的行為**，非檔名；檔名只在必要時作證據補充。
- 已逐條處理 47 個 hash，無跳過；逐條對帳在文末。

---

## 生成核心

- [生成核心] 生成時實體卡就地解析注入 — 生成唯一出口（手動面板／A4 原地／retry／runAgentGeneration）與 drama-recipe 的 LoRA 迴圈會用與 entity-tokens 同一把尺解析 prompt 中的 `@[種類:名稱]`，在卡庫全量找相符卡並與既有鎖定集取聯集；零 token／全未命中回同一陣列參考（零漂移），不自動鎖卡 ｜ 證據: 7f9dbe4e
- [生成核心] 音頻實體卡送上游前展開 — TTS（閘道 media-internal-routes handleTts）與 music_gen（VPS）送上游前展開音頻卡參考、`reference_images` 一律空；`target=audio` 缺省不變為 image ｜ 證據: 7f9dbe4e

## 模型與供應商

- （本批無新增能力。既有模型目錄 57（影像 29）等變動只出現在文檔 commit 4b6afad5，屬前批，不重複列。）

## 控制平面與計費

- [控制平面與計費] 自訂档支付按下单档价（`custom:<coins>`）— 滑桿自訂档點「立即支付」不再退回夢芽 ¥9.9 下單；`handlePay` 傳 `customPlan.id`，`/api/payments/mapay/return` 同步改用 `resolvePricingPlan`（與 notify 同源），回調才解析得了自訂档金額 ｜ 證據: fc85156b
- [控制平面與計費] 新-api 管理面改走 TLS — 站點對 new-api 的兌換碼／訂閱兌換／認證動作改走 `https://store.tinchak0207.xyz/newapi` 的 TLS vhost（bare-IP 明文 `/api` 已被 default_server 444 關閉）；fallback 常數與測試斷言同步，未設 `GATEWAY_BASE_URL` 不會靜默回死掉的明文路徑 ｜ 證據: 432ae6c8

## B端API

- [B端API] 實體卡解析端點 `/api/biz/character-resolve` — 可選 `target(image|audio)`（缺省 image＝零漂移）；回帶 warnings（畸形 token），audio 走 `applyCharacterCards({target:"audio"})` 且 reference_images 空 ｜ 證據: 7f9dbe4e
- [B端API] 技能 API `/api/skills`、`/api/skills/[id]` — 列表／搜尋／facet 與單條查詢；公開面永不包含 user 來源 ｜ 證據: 513462a5
- [B端API] 私有自訂技能 CRUD `/api/skills/mine`（GET/POST）＋ `/api/skills/mine/[id]`（DELETE）— 身分複用 `resolveAgentCaller`＋`deriveMemoryOwnerKey`；未登入 401、非本人 404 不洩漏存在性 ｜ 證據: 513462a5
- [B端API] Remote MCP server `POST /api/mcp` — JSON-RPC 2.0 / Streamable HTTP，支援 initialize、tools/list、tools/call、ping，notifications/* 回 202，GET 405 + Allow: POST ｜ 證據: 017cbc0b
- [B端API] MCP 10 個工具 — `list_skills`／`get_skill`／`list_models`／`generate_image`／`edit_image`／`generate_video`／`tts`／`upscale`／`get_quota`／`get_result`；鑑權逐字複用 `readBearerToken`＋`authenticateBizApiKey`，Authorization 原樣透傳既有 `/api/v1/*`，扣費／配額／冪等繼承同一帳本（零第二套計費）｜ 證據: 017cbc0b
- [B端API] MCP 發現面 `/.well-known/oauth-protected-resource` — 7 個自寫 scope；401 帶 RFC 9728 `resource_metadata` 指向站根發現文件 ｜ 證據: 017cbc0b
- [B端API] agent 插件包 `public/plugin/` — Codex 插件形態（marketplace.json、`.codex-plugin/plugin.json`、`.mcp.json` 只含 URL 不含密鑰）＋ 3 個隨包技能（film-production／character-consistency／camera-motion）＋ `/plugin/` 目錄入口 ｜ 證據: b49c7401

## Agent助理

- [Agent助理] 閘道節點生成認得實體 tag — workflow-gw 節點提交處展開最終 prompt 並把卡參考圖併進 `reference_images`（去重截 5），既有單張 reference 逐字保留；key 用呼叫端傳入的使用者 key，快取鍵含 apiKey 且守衛在查快取之前（防跨租戶共用卡參考圖）｜ 證據: 7f9dbe4e
- [Agent助理] 133 條內建 Skill 條目層（10 家族）— 電影美學 40／商業廣告 27／短劇 20／特效動畫 12／劇本 8／分鏡 8／選角 5／UGC 5／MV 4／旅拍 4；公開列舉＝builtin+recipe+template＝151，私有列舉以 ownerKey 隔離 ｜ 證據: 513462a5
- [Agent助理] 對話框斜線直呼 Skill — 輸入框打 `/` 出 SkillSlashMenu（debounce 160ms＋雙路 AbortController＋「我的技能」分區），選中寫回輸入框不自動送出 ｜ 證據: 513462a5
- [Agent助理] 私有技能管理面 — 設置彈層內 MySkillsDialog 管理自訂技能（交付形態標籤收斂到 `src/lib/agent-skills/output-kinds.ts` 單真源）｜ 證據: 513462a5, 2d5dbeac
- [Agent助理] 思維鏈結算後收合 — 串流中展開、結算後自動收合成「已思考 · N 秒」一行；使用者手動點過 summary 後自動收合不再介入（reasoningTouched ref）｜ 證據: 92a2a698
- [Agent助理] 頂欄精簡為直接入口 — 常態狀態文字回空串（第二行消失），資產／歷史從 ⋯ 選單提出直接站在標題右側，⋯ 選單退役換齒輪觸發 `openSettings()`；reconnecting／closed／connecting 三個異常態文字保持唯一出口 ｜ 證據: 397571a2
- [Agent助理] 頂欄改純圖示列（零文字）— 拆掉「AI 助理」h2 與星芒圖標，五顆入口（資產／歷史／新會話／直接生成／設置）圖示即 logo；連線異常態文字不再由頂欄承擔（下沉對話區）｜ 證據: c5f89542
- [Agent助理] 使用者自己的話進入聊天記錄（injection echo）— `agentInjection` 新增 `echo` 欄位（默認 false＝模板注入 silent 行為逐字不變）；`echo:true` 時送出瞬間樂觀插入使用者氣泡，填掉建號到 TTFT 的空白 ｜ 證據: 10403d5a

## 畫布與工作流

- [畫布與工作流] 節點版本歷史 — 純函式版本層：逐節點上限 20／專案 400，座標與尺寸刻意不進版本；node.created/updated 依 `isNodeContentChange` 自動落版；GET `/api/canvas/nodes/[id]/history`、POST `/api/canvas/nodes/[id]/revert` ｜ 證據: 64aff900
- [畫布與工作流] 節點軟刪與恢復 — `delete_nodes` 改軟刪（收進 deletedNodes，呼叫端語義不變）；POST `/api/canvas/nodes/[id]/restore`、POST `/api/canvas/nodes/restore`（批量）｜ 證據: 64aff900
- [畫布與工作流] 一稿多版位裁切計劃 — `planFormatCrops(sourceW,sourceH,AD_SIZE_OPTIONS)` 逐版位回 `{mode:"crop"|"outpaint"|"rejected", cropRect, outpaintEdges, lossRatio, output 尺寸}`，`MAX_CROP_LOSS=0.25`；版位比例取 id 像素而非 label 近似 ｜ 證據: 13f26615
- [畫布與工作流] 一稿多版位真裁執行 — POST `/api/canvas/format-crops`（requireVerifiedUser）只給尺寸＝純 plan 零 IO；`execute:true` 走 sharp 真裁（`readSourceImageInfo` 含 EXIF 5~8 軸互換）；零 DOM／Image／fetch 可在 node 直測 ｜ 證據: 13f26615
- [畫布與工作流] 視頻截幀／序列幀節點動作 — POST `/api/canvas/video-frames`（requireVerifiedUser）回抽幀計劃 `frames:[{index,timeSec,label}]`＋`execution:"client"`，像素由客戶端 `extractFramesAtTimes` 落成畫布圖；`planFrameExtraction` 純時間點計算、`MAX_SEQUENCE_FRAMES=24` ｜ 證據: 272fac86
- [畫布與工作流] 畫布縮略圖預設收合與縮放膠囊控制 — `CanvasEmbed minimapOpen` 預設收合，入口收進 `CanvasZoomControls`（minimap/review 切換），`CanvasMiniMap` 加 onClose ｜ 證據: 92a2a698
- [畫布與工作流] 節點 metadata 鍵集合單一真源 — `node-metadata-fields.ts` 集中兩個清洗入口（`layout.ts` toNodeMetadata 耐久化端／`canvas-chat-types.ts` compactMetadataForAgent 上行端）的鍵集合與理由，避免漏鍵靜默消失（emitsEntity 實錘）｜ 證據: e4c16950

## 創作域

- [創作域] 行內 `@[種類:名稱]` 實體卡引用 — 五值實體（角色／場景／風格／道具／音頻）可在 prompt 行內引用；卡在庫即可用，不要求人手動鎖定 ｜ 證據: 7f9dbe4e
- [創作域] 模板自動落卡 — 13 條產線模板中 11 條（feature_film／novel_ip／ecom_model／ecom_launch／art_style／art_curation／shortdrama_poster 等，15 處）標記 `emitsEntity`，「交付物就是一個實體」時自動落卡 ｜ 證據: 7f9dbe4e
- [創作域] 音頻實體卡可被引用 — 音頻卡從型別層變成可引用（TTS／music_gen 展開）｜ 證據: 7f9dbe4e
- [創作域] 未命中實體膠囊紅色提示 — 未命中 token 的紅色底（`bg-ios-red/[0.12]`）不再被 Tailwind opacity scale 靜默編成空規則 ｜ 證據: 6452273a
- [創作域] 實體卡持久化 store — `character-card-store` 每用戶 index＋新世代寫入＋串行 write queue＋無 Blob 記憶體降級 ｜ 證據: e4c16950
- [創作域] 運鏡預設庫與 harness 工具綁定 — 23 條互斥運鏡預設（唯一 key＋簡體短標籤＋可執行運鏡指令＋建議 harness toolId＋檢索 tags），公開只讀 API；最終組裝一律走既有 `describeCameraTrajectory()`，不自造第二套翻譯 ｜ 證據: 017cbc0b

## 帳號與增長

- [帳號與增長] 未登入新訪客進站播一次宣傳片 — 每瀏覽器一次（localStorage `eimu-promo-seen-v1`）；判定鏈抽成純函式 `promo-gate.ts`（登入態水合中不播、已登入永不播、看過不播、深鏈交接 `?agent=1&q=`／`?session=` 讓路）｜ 證據: 786f366c
- [帳號與增長] 宣傳片播放政策 — 本體恆 muted autoplay，聲音由右下角按鈕由人開啟；自動播放整條被擋退成海報＋播放鈕；底部是真實播放進度條 ｜ 證據: 786f366c
- [帳號與增長] `?promo=1` 強制預覽 — 穿過全部守衛（含登入態）但不寫入「已看過」，不消耗首次進站體驗 ｜ 證據: aa752efe
- [帳號與增長] 渠道來訪不播宣傳片 — 自家投放鏈接渠道參數（utm_source/from/ref 含 bilibili/b23/weixin/wechat）、來源域名（bilibili.com／b23.tv／weixin.qq.com／wechat.com 含子網域）、MicroMessenger UA 任一命中即跳過一次且不寫已看過 ｜ 證據: 639bd737
- [帳號與增長] 宣傳片收尾＝封面畫布＋真可打字輸入框 — 輸入框座標逐字取自封面渲染源，Enter／圓鈕送出即開新對話直送產線（走既有 lazy 建號＋`agentTemplateInjection`）；未登入先存 pending（sessionStorage），登入態翻真自動補送 ｜ 證據: a940cb7a
- [帳號與增長] 宣傳片結尾「先登入再開跑」— 未登入送出當場彈登入；`resolvePromoTrialIntent` 分流（登入＝當場開跑／未登入＝留 pending 走登入）；GitHub 同窗口跳 `/api/auth/github/start`、微信走既有 `/wechat-login` 彈窗＋postMessage／token 輪詢雙完成信號；選「先不登入」並離開＝清 pending ｜ 證據: 510eb1c3
- [帳號與增長] 進站判定只做一次 — `resolvePromoEntry` 水合中不判也不記、定案後沿用首次結果；登出（登入態真翻假）不得再把 `?promo=1` 的強制預覽重播或補播 ｜ 證據: d5ba65f8
- [帳號與增長] OAuth 建號改走上游管理員建號 API — GitHub／Google／微信三條 OAuth 建號全部改走 gateway-admin `ensureGatewayUserForOAuth`（先查後建、已存在按複用吸收，管理員 POST `/api/user/`），為上游關閉自助註冊（RegisterEnabled）做準備，對外行為不變 ｜ 證據: 1129196a

## 前端與UI

- [前端與UI] /pricing 方案卡 3D 化 — 四档（梦芽／梦影／梦虹／自訂）各一 3D 世界，堆高與厚度是額度量級函數；互動四件：拖曳撥動（慣性／摩擦）、hover 拾起、自訂档滑桿即時增減（先伸縮、落定才落）、點擊回饋，聲音隨互動而生 ｜ 證據: 853244be
- [前端與UI] 3D 方案卡的漸進增強與降級 — 首屏仍為靜態卡面 DOM、idle 後才動態 import 引擎；離屏／分頁隱藏停 rAF；`saveData`／`deviceMemory ≤ 2` 不接管；`prefers-reduced-motion` 走靜止構圖；進 /pricing 零等待無 loading 遮罩 ｜ 證據: 853244be
- [前端與UI] 3D 卡堆主角模式 — 一張卡當主角、其餘淡出縮成底部選片條；四個世界硬剪接；卡面只留價格與支付 CTA，額度文字下架 ｜ 證據: 853244be
- [前端與UI] 3D 渲染精度與版面收斂 — pixelRatio 加超取樣地板（桌面 1.75／上限 2）、圖集每格 512→640（compact 256→320）、anisotropy 解開自閹 8 上限、fps 降級不再把解析度砍回 1；卡堆左移與票面右移不再重疊（min() 夾住不越出視口）；漸變文字降飽和（`--p3d-pink-soft`／`--p3d-blue-soft`）｜ 證據: 35e678c0, fc85156b
- [前端與UI] 站點對外介紹單一真源 `site-copy.ts` — layout metadata（OG／Twitter／JSON-LD）、首頁 tab 標題、PWA manifest 全改讀它；標題為「一句話到成片的 AI 影像工作台」，模型名降到 keywords 與描述尾段 ｜ 證據: 585f27b7
- [前端與UI] OG 分享預覽卡換成真宣傳片封面 — `src/app/opengraph-image` 由模板殘留的「AI SDK Image Generator」示範資產換成宣傳片 A 版封面（1200x630，138KB JPEG）｜ 證據: bc018562
- [前端與UI] AI 檢索面全面翻新 — `public/llms.txt` 產品優先改寫（H1=Eimu、硬事實節、「不是」節、主要頁面清單，B 端 API 段逐字保留）；FAQ 前置四題產品題；sitemap 補 docs 六子頁與 /status；robots 明確放行九個 AI 檢索／回答引擎爬蟲 ｜ 證據: e7917b3b
- [前端與UI] 全站 canonical 各自自指 — canonical 從 root layout 移除，改成 10 個公開頁各自自指（/pricing、/status、/docs 與六個 docs 子頁不再宣告自己是首頁副本）｜ 證據: d58eba66
- [前端與UI] 17 個行業樞紐頁 + 301 合併 — 新增 `src/lib/use-case-categories/` 17 檔（每檔 6 子場景、2–3 條可複製提示詞、翻車點、行業 FAQ、checklist，4700–6300 漢字）；舊 102 個 `/use-cases/<行業>-<n>` 門頁以 20 條 301 轉樞紐頁 ｜ 證據: dc16ff3d
- [前端與UI] `/use-cases` 總索引頁 — 17 張行業卡＋按 categorySlug 分組的深度指南＋8 張產線卡（修掉線上 404）｜ 證據: dc16ff3d
- [前端與UI] 8 條產線落地頁 `/workflows`、`/workflows/[slug]` — 依 agent-templates 卡面與 payload 真源，輸出 CollectionPage／HowTo／BreadcrumbList／FAQPage／VideoObject ｜ 證據: dc16ff3d
- [前端與UI] 技術 SEO 收口 — layout title template `%s | Eimu`＋`@graph` JSON-LD（Organization／WebSite／SoftwareApplication）；sitemap 改吃真實資料源（62 條）；robots 封私有路由放行 AI 爬蟲；history/settings noindex；IndexNow 金鑰檔 ｜ 證據: dc16ff3d
- [前端與UI] 技能庫公開只讀瀏覽面 — `/skills`（家族篩選純連結 `?family=`，零 client JS）＋ `/skills/[id]`（generateStaticParams 全量靜態，只呈現 spec 真有的欄位，未知 id 走 notFound）｜ 證據: eca25f27
- [前端與UI] `/mcp` 安裝頁與插件包節 — Codex／Claude Code／Cursor／OpenClaw／通用安裝指令（只展示佔位 key），插件包文件樹＋安裝指令 ｜ 證據: 017cbc0b, b49c7401
- [前端與UI] 站內通知鈴鐺與公告 — Navbar 鈴鐺＋紅點＋下拉＋標記已讀（portal 落點照 WalletBadge）；公告對話框；`AnnouncementSurfaces` ｜ 證據: ee89433b
- [前端與UI] 站內通知／公告／橫幅 API — GET `/api/notifications`（列表＋未讀數）、POST `/notifications/mark-read`、GET `/notifications/announcements/[id]`、GET `/notifications/banners`、GET `/notifications/active-modal`、POST `/notifications/banners/[id]/dismiss`；管理端 POST/GET/PATCH `/api/admin/announcements`（requireAdminSession）｜ 證據: ee89433b
- [前端與UI] navbar 餘額「+」浮層 portal 到 body — 不再被 `.lg-bar` 的 overflow-hidden 與 backdrop-filter 裁掉；fixed 自算座標（「+」鈕與 .lg-bar 下緣較低者+8px）、層級 z-90、收起層 z-89；點外收起層為完整視口 ｜ 證據: ccf5af5d
- [前端與UI] 宣傳片結尾封面入鏡與輸入框對位 — 結尾輸入框四周出血 6px 蓋死封面畫上去的框（幾何逐像素對位）；封面橫式 contain 完整入鏡（不裁品牌標／成片標籤）、直式 250vw 以框為中心 ｜ 證據: 1ad87154, 6844f223
- [前端與UI] 宣傳片未登入登入框改錨定小框 — 送出鈕先轉圈 0.2s，再在鈕正上方長出小框（不遮結尾畫面）；點封面空白處／Esc／先不登录皆可收；Esc 一層一層退 ｜ 證據: a2b8d79b
- [前端與UI] 封面移除「成片·片名」膠囊 — 重渲染 1920×1080 封面（tag 條帶逐像素對帳）＋ og 分享圖同修；`cover.html` 源頭元素與樣式一併刪除 ｜ 證據: 16b2751c
- [前端與UI] 滾動條與展開鈕收斂 — 滾動條 8px→6px 且懸停才顯示；「展开」鈕改用 aria-pressed/aria-expanded 態著色不再常駐藍字；NodeBody／CanvasEmbedOverlays 節點工具列整理 ｜ 證據: 92a2a698

## 運維與觀測

- [運維與觀測] `/api/version` 生產版本可查證端點 — 回部署 commit、建置時間、後端生效布林；force-dynamic + no-store（禁 CDN 快取假證據）；只輸出後端名稱與布林，永不輸出 secret／憑證／token 值 ｜ 證據: e4c16950
- [運維與觀測] GitHub Actions CI — push/PR 觸發 `tsc --noEmit` 與單元測試；刻意不部署（Vercel 部署屬人工授權）、不本地 build ｜ 證據: e4c16950
- [運維與觀測] Blob 後端可切換 VPS — `blob-backend` 依 env 在 VPS image-data-api 與 Vercel Blob 間單點切換；生產須顯式設 `BLOB_ALLOW_MEMORY_FALLBACK=true` 才允許記憶體降級 ｜ 證據: e4c16950
- [運維與觀測] 生成品質門日誌 — 每用戶上限 500 條滾動 gate log，走 Blob 世代儲存（新路徑寫入＋修剪舊世代＋per-user 串行＋無 Blob 記憶體降級）｜ 證據: e4c16950
- [運維與觀測] 伺服器端歷史持久化 store — `server-history-store`（Blob 世代、分頁／facet／stats／排序／上限與 schema 版本）｜ 證據: e4c16950
- [運維與觀測] 認證與私密內容守門 — `scanSensitiveContent`（sk-*／Bearer／AKIA／私鑰／JWT／手機號／`secret=` 賦值）接進 `validateUserSkill`，reason 只回種類代碼，原文永不進回應或 log ｜ 證據: 513462a5
- [運維與觀測] 通知的跨用戶隔離 — A 標記已讀後 B 未讀數不變、冒領他人 x-user-id 回 401、時間窗外公告不進生效清單、A 關掉的橫幅 B 仍生效 ｜ 證據: ee89433b

## 團隊與企業

- [團隊與企業] 團隊資產空間作用域持久化（REQ-B2）— `asset-scope-store` 只存兩種連結記錄（顯式分享授權／項目掛用），不存資產本體；走 OS 既有 Blob 世代模式（每用戶 index＋新路徑寫入＋修剪舊世代＋串行 write queue＋無 Blob 記憶體降級）｜ 證據: e4c16950

---

## 非程式碼能力

- VPS／部署：`.vercelignore` 排除 200MB 影片產物（promo-video/out、artifacts 等）與 `promo-video/fonts/`（23MB 本機渲染輸入）｜ 證據: 0651e7cd, 36ba61a2, e4c16950
- VPS／部署：`.gitignore` 把 200MB 級影片產物（artifacts／promo-video/out）排除，讓工作區回到可辨識狀態 ｜ 證據: e4c16950
- VPS／部署：`deploy/vps/gateway-release.sh` 收進版控 ｜ 證據: e4c16950
- 外部服務：new-api 管理面改走 TLS vhost `store.tinchak0207.xyz/newapi` 前綴（bare-IP 明文已 444 關閉）｜ 證據: 432ae6c8
- 外部服務：上游 new-api 自助註冊端點 `/api/user/register` 可由 RegisterEnabled 關閉；站點 OAuth 建號改走管理員 API 即為此準備 ｜ 證據: 1129196a
- 運營流程：宣傳片渲染鏈（`promo-video/`：audio.py、render.mjs、index.html、film.js、lib/shaders|ui|util、assets 26 素材）與三版封面（cover.html／cover-b／cover-c）；字型為本機渲染輸入不入庫 ｜ 證據: 36ba61a2
- 運營流程：站點展示資產進版控 — `public/showcase/cards`（768×1024 展示卡＝3D 卡堆貼圖來源）、`cards-thumb`、`mascot` ｜ 證據: e4c16950
- 運營流程：README 首屏宣傳片展示（加片→雙片並排→換新片只留一條全寬）｜ 證據: 8897511b, 64d404b1, 696cec9a, 6eb5e08d
- 運營流程：宣傳片片源換 1080p 分享版（1920x1080／30fps／6.76Mbps／43.2MB，faststart moov 在 mdat 前），海報重抽；代價＝未登入訪客多下 33MB ｜ 證據: 47c80991
- 運營流程：投放素材鏈接帶渠道參數（promo-video/out/bilibili.md、wechat.md）｜ 證據: 639bd737
- 運營流程：通知機制**不交付**運營配套（無 seed／cron，不 create 即永遠空清單，落地後系統行為與交付前等價）｜ 證據: ee89433b
- 運營流程：SEO 交付面 — 20 條 301、sitemap 62 條真源、IndexNow 金鑰檔、robots 放行九個 AI 爬蟲、llms.txt 頁面清單 ｜ 證據: dc16ff3d, e7917b3b, d58eba66
- 運營流程：技能庫與 MCP 的頁面清單同步進 sitemap 與 llms.txt ｜ 證據: eca25f27, 017cbc0b, b49c7401

## 邊界與拒絕

- 閘道實體解析 fail-open 硬契約 — `deploy-staging/gateway/entity-resolve.ts` 薄客戶端：零 token 零 HTTP、TTL 30s、timeout 6s，任何失敗回原文、永不阻斷生成；warn 只印長度與 status ｜ 證據: 7f9dbe4e
- 實體解析不自動鎖卡 — `mergeTokenReferencedCards` 不自動鎖任何卡，鎖定語義不動；`CanvasEmbed` 明確關閉注入的呼叫端（傳 `{cards:[]}`）保持關閉不併入 ｜ 證據: 7f9dbe4e
- 畸形 token 只診斷不改寫 — `findMalformedEntityTokens` 只回報空名稱／缺右括號／未知種類；`ENTITY_TOKEN_PATTERN` 與 `parseEntityTokens` 逐字未動，原文照留 ｜ 證據: 7f9dbe4e
- 模板落卡有明確不標清單 — 分鏡／影片／剪輯／門禁／工具卡一律不標 `emitsEntity`（免落重複卡）｜ 證據: 7f9dbe4e
- 音頻實體卡端到端未驗 — FlowMusic2API 上游實測 502（無可用帳號），只驗到「展開真的發生才送上游」｜ 證據: 7f9dbe4e
- 一稿多版位不代呼叫付費生成 — outpaint 回 `skipped/no_outpaint_upstream/suggestedSize:<ratio>`，不代呼叫付費生成；現場事實：`ADOBE_FIREFLY_FILL_MODEL_ID` 全倉僅為定價條目、無 route/adapter 消費，我方真正擴圖是提示詞路徑（nano-outpaint ＋ gemini-3.1-flash-image）不保證像素幾何 ｜ 證據: 13f26615
- 視頻抽幀邊界一律回 `{ok:false, reason}` 而非例外 — interval<=0、count<=0/非整數、超過資源長度、超過 24 幀上限、duration NaN、interval 與 count 同給 ｜ 證據: 272fac86
- MCP 只暴露公開技能族 — 私有 Skill 絕不出現在 MCP ｜ 證據: 017cbc0b
- 技能庫明確不做 — 公開發布、市集、審核、曝光統計（暴君 09-27 裁定）｜ 證據: 513462a5
- 插件包技能誠實聲明 — 隨包 SKILL.md 明確寫出我們沒有的能力（畫布節點操作／連線／成片導出）｜ 證據: b49c7401
- 通知缺 blob 憑證時回 503 — 不靜默落進程內記憶體 ｜ 證據: ee89433b
- 宣傳片渠道來訪只跳過一次不寫「已看過」；`?promo=1` 不寫入已看過；「先不登入」並離開＝清 pending ｜ 證據: 639bd737, aa752efe, 510eb1c3
- 進站判定不因登出而重判（登出不是重新進站）｜ 證據: d5ba65f8
- 3D 方案卡降級紅線 — `saveData`／`deviceMemory ≤ 2` 不接管、`prefers-reduced-motion` 走靜止構圖、不接受載入變慢 ｜ 證據: 853244be
- `/api/version` 誠實邊界 — 只證明這個部署是哪個 commit／建置時間／後端生效，不證明功能可用（HTTP 200 ≠ 可用）｜ 證據: e4c16950
- CI 刻意不做的事 — 不部署（Vercel 部署需 scope/auth，屬人工授權）、不跑本地 build（remote build 才是穩路）｜ 證據: e4c16950
- 上游 fallback 不得靜默回明文死路徑 — 未設 `GATEWAY_BASE_URL` 時斷言同步 ｜ 證據: 432ae6c8
- 話語歸屬 — 模板卡注入（機器配方）維持 `silent:true` 不進 transcript；只有宣傳片試玩那句「使用者自己的話」帶 `echo:true` 進聊天記錄 ｜ 證據: 10403d5a
- Big picture：SEO 頁面以「不認領中轉站位子」為定位紅線 — 標題不再以模型名開場、JSON-LD 刪掉「无需注册中转站」條目；但 use-cases/long-tail-faq 那批刻意投的中轉站長尾頁保留 ｜ 證據: 585f27b7, e7917b3b

## 存疑

- `4b6afad5`（README 對齊 98 commit）：本 commit 不改程式碼，其記錄的能力（五值實體卡、行內 @ 引用、模板自動落卡、13 條產線模板、分鏡 21 欄位契約與 142 條鏡頭詞庫、審核官把關、助理記憶庫五類、工作流記憶沉澱、工作流歷史卡與 DAG 縮圖、帳號四軌登入增 Google OAuth、充值回調手續費容差、模型目錄 57／影像 29／`/v1` 公開路由 31）屬 2026-09-15～09-25 既有功能面，**不在本 commit 程式碼內**，故不重複列為本批能力（避免跨批歸屬錯誤）。缺什麼證據：需要對應功能 commit（在前批）。
- `8897511b`、`64d404b1`、`696cec9a`、`6eb5e08d` 僅 README 影片嵌入（各 +4/-9 行），無法從 diff 判斷是否含產品能力；已按「無新能力（文檔展示）」計。缺什麼證據：README 渲染無程式行為。
- `e4c16950` 為 chore 收攏「前一輪三條未提交線」，新檔歸屬（pricing 3D 舞台／blob 與資產範圍／畫布節點 metadata）可能由其他並行會話先寫；本清單以其入庫內容為準，作者歸屬不追。缺什麼證據：無獨立 commit 邊界。
- `92a2a698` 自述「工作區裡另一路（同日 09-27）已落地未入庫的改動，本次一併入庫並部署」，能力歸屬可能是另一路；以入庫事實計。缺什麼證據：無原始 commit。
- 音頻實體卡（7f9dbe4e）與通知機制（ee89433b）都自陳「端到端未驗／不交付運營配套」；能力存在但未以真單證明，屬機制級交付。
- `2d5dbeac` 揭示的工程邊界（Next page 檔只能導出 Next 認可欄位，額外導出資料常量在 build 期被判死、tsc 抓不到）為建置期契約，非使用者可見能力，未列入主清單。
- `1129196a` 的「對外行為不變」屬自述；本次未以真單重驗三條 OAuth 建號（本批僅讀 commit 與現況程式碼）。
- 與記憶衝突：**無**。`13f26615` 關於「ADOBE_FIREFLY_FILL_MODEL_ID 無消費／真正擴圖是提示詞路徑」與記憶 `2026-09-28-symdiff-source-first-and-hypit-video-extraction` 所述一致；`272fac86` 的 `/api/canvas/video-frames` 與該記憶所述「全 repo 零前端呼叫」一致（本批只交付端點，未接前端）。

---

## 逐條對帳

| hash | 該 commit 貢獻的能力 |
|---|---|
| 7f9dbe4e | 生成時實體卡就地解析注入；`/api/biz/character-resolve`（target image/audio）；閘道節點生成認 tag 併參考圖（使用者 key＋快取鍵含 apiKey）；模板自動落卡（11/13 模板 15 處）；音頻卡可引用；畸形 token 警示；entity-resolve fail-open |
| 4b6afad5 | 文檔對齊（記錄 09-15～09-25 既有 98 commit 功能面）— 無新程式碼能力 |
| 8897511b | 文檔（README 首屏加宣傳片）— 無新程式碼能力 |
| 64d404b1 | 文檔（README 首屏雙片並排）— 無新程式碼能力 |
| 696cec9a | 文檔（README 一行修正）— 無新程式碼能力 |
| 853244be | /pricing 方案卡 3D 化（四档世界／拖曳與滑桿互動／音效）；漸進增強與降級；卡堆主角模式 |
| e4c16950 | `/api/version` 端點；GitHub Actions CI；blob 後端可切 VPS；生成品質門日誌；server-history-store；asset-scope 團隊資產空間；character-card-store；canvas node-metadata-fields；站點展示資產與 deploy 腳本入庫 |
| 35e678c0 | 3D 渲染超取樣與版面收斂（pixelRatio 地板／圖集 640／anisotropy 解自閹／fps 降級不砍解析度）；漸變文字降飽和 |
| 0651e7cd | 非程式碼：`.vercelignore` 排除 200MB 影片產物 |
| 678892b9 | 純修復（eslint 就地豁免，讓 next build lint 階段通過）— 無新能力 |
| ccf5af5d | navbar 餘額「+」浮層 portal 到 body（z-90、點外收起層為完整視口）— 修復暴露的 UI 邊界 |
| 6eb5e08d | 文檔（README 宣傳片換新片）— 無新程式碼能力 |
| fc85156b | 自訂档支付按 `custom:<coins>` 下單＋return 同源 resolvePricingPlan（真 bug）；票面粉蓝改柔和粉青 |
| 36ba61a2 | 非程式碼：宣傳片渲染工具鏈（三版封面、film.js、lib、26 素材）；字型不入庫 |
| 6452273a | 未命中實體膠囊紅色提示修復（Tailwind bracket 寫法） |
| 786f366c | 未登入訪客進站播一次宣傳片；`promo-gate.ts` 判定鏈；muted autoplay＋手動開聲＋poster 退路＋真進度條；收尾預填試玩語 |
| aa752efe | `?promo=1` 強制預覽（不寫已看過） |
| 639bd737 | 渠道來訪不播宣傳片（渠道參數／來源域名／MicroMessenger UA 三認定，跳過一次不寫已看過） |
| 47c80991 | 非程式碼：片源換 1080p 分享版＋海報重抽（faststart） |
| 7dd1b6a9 | 純修復（註釋措辭避開 ImageDisplay.test 契約）— 無新能力 |
| 92a2a698 | 思維鏈結算後收合；畫布縮略圖預設收合＋縮放膠囊控制；展開鈕態著色；滾動條細化懸停顯示 |
| 585f27b7 | 站點對外介紹單一真源 `site-copy.ts`（去模型名開場，模型名降 keywords） |
| bc018562 | OG 分享預覽卡換成真宣傳片封面（138KB JPEG） |
| 397571a2 | 頂欄常態零文字、資產／歷史直接入口、⋯ 選單退役換齒輪 |
| e7917b3b | AI 檢索面翻新：llms.txt 產品優先、FAQ 前置產品題、sitemap 補 docs/status、robots 放行九個 AI 爬蟲 |
| c5f89542 | 頂欄改純圖示列五入口、拆標題與星芒圖標、連線異常文字下沉對話區 |
| d58eba66 | 全站 canonical 各自自指（10 個公開頁） |
| a940cb7a | 宣傳片收尾＝封面畫布＋真輸入框送出直送產線；未登入 pending（sessionStorage）自動補送 |
| 1ad87154 | 結尾輸入框四周出血 6px 精準蓋框（幾何逐像素對位） |
| 6844f223 | 結尾封面橫式 contain 完整入鏡、直式 250vw 以框為中心 |
| 510eb1c3 | 宣傳片結尾「先登入再開跑」；PromiseLoginDialog 兩路登入；pending 補送；「先不登入」清 pending |
| a2b8d79b | 登入改不遮畫面的錨定小框（送出鈕先轉圈 0.2s；Esc 一層一層退） |
| 1129196a | OAuth 建號改走上游管理員建號 API（ensureGatewayUserForOAuth，先查後建複用吸收） |
| 16b2751c | 封面移除「成片·片名」膠囊（封面＋og 分享圖同修，逐像素對帳） |
| 432ae6c8 | 新-api 管理面改走 TLS vhost（fallback 常數與斷言同步，不靜默回明文死路徑） |
| 10403d5a | injection echo 欄位：宣傳片試玩那句話以使用者自己的話進聊天記錄（填 TTFT 空白） |
| dc16ff3d | 102 門頁合併為 17 行業樞紐＋20 條 301；`/use-cases` 總索引；8 條產線落地頁 `/workflows`；技術 SEO 收口（title template／@graph／sitemap 62 條／robots／noindex／IndexNow） |
| d5ba65f8 | 進站判定只做一次（resolvePromoEntry，登出不得重判／重播 ?promo=1） |
| 513462a5 | 133 條 Skill 條目層（10 家族）＋私有技能；`/api/skills` 與私有 CRUD；斜線直呼 SkillSlashMenu；MySkillsDialog；憑證閘 scanSensitiveContent；明確不做公開發布／市集 |
| 017cbc0b | Remote MCP server（JSON-RPC/Streamable HTTP）＋10 工具（同一帳本計費）；`/.well-known/oauth-protected-resource`；`/mcp` 安裝頁；運鏡預設庫 23 條＋公開只讀 API |
| 64aff900 | 畫布節點版本歷史（上限 20/400，座標尺寸不進版本）；節點軟刪與恢復（單／批量端點） |
| 13f26615 | 一稿多版位裁切計劃（13 版位 crop/outpaint/rejected，MAX_CROP_LOSS=0.25）；`/api/canvas/format-crops` 真裁（sharp＋EXIF）；outpaint 不代呼叫付費生成 |
| ee89433b | 站內通知／公告／橫幅機制（store＋C 端與管理端 API＋鈴鐺元件）；跨用戶未讀隔離；機制交付不含運營配套 |
| 272fac86 | 視頻截幀／序列幀節點動作（`/api/canvas/video-frames` 回抽幀計劃，client 執行）；邊界一律回 `{ok:false,reason}` |
| b49c7401 | agent 插件包 `public/plugin/`（Codex 形態＋3 隨包技能＋`/plugin/` 入口）；`/mcp` 頁插件包安裝節；技能誠實聲明缺的能力 |
| eca25f27 | 技能庫公開只讀瀏覽面 `/skills` ＋ `/skills/[id]`（全量 SSG、未知 id notFound）；sitemap 補錄 |
| 2d5dbeac | 純修復（交付形態標籤收斂到單真源，修生產 build 失敗）— 無新能力 |