# image-app repo 第 3 批（47 commit）我方能力清單

- 範圍：`/tmp/cap/batch-3.hashes` 全部 47 條（2026-09-15 → 2026-09-20）
- 唯一真源：`/tmp/cap/batch-3.txt` 訊息 ＋ `git show` 補細節 ＋ 現場 grep 驗是否還在
- 能力定義：使用者可見或可呼叫的行為；檔名一律不當能力
- 領域標籤：生成核心／模型與供應商／控制平面與計費／B端API／Agent助理／畫布與工作流／創作域／帳號與增長／前端與UI／運維與觀測／團隊與企業

---

## 生成核心

- [生成核心] 成片導出冪等指紋 — 素材集合歸一化 SHA-256 指紋（絕對／相對 URL 視為同素材），指紋相同即視為同一成片 ｜ 證據: 51631bc1
- [生成核心] 字幕分屏 — 每屏 7-12 字且切在換行 → 句末標點 → 句內停頓等語義邊界，逐行移植 AID SubtitleScreenSplitter ｜ 證據: 51631bc1
- [生成核心] 成片導出後實算指紋並回填公開 URL — 導出成功且 probe 過檔後回填 public_url 與 master_artifact_id，sha256/byte_size 取盤上實值，不拿 probe 缺值充數 ｜ 證據: 349150f3

## 模型與供應商

- [模型與供應商] yyds 渠道宣告 image_edit — gpt-image-2 改圖能力寫進 registry claims（此前只宣告 image_generate，改圖能力表只剩死渠道） ｜ 證據: 15f278d8
- [模型與供應商] edit 標註與 registry claims 同源 — model-status-probe 的 edit 標註改由 registry 推導，標了才有 capability 預檢行可查 ｜ 證據: 15f278d8
- [模型與供應商] 部署側渠道目錄同步 — gateway 15 檔與 VPS live 同步，帶入 agnes／seedance 渠道與 catalog 能力位 ｜ 證據: 75c25e24

## 控制平面與計費

- [控制平面與計費] 成片導出落帳 — 以 generation_job(kind='film_export', source='agent', status='succeeded', model_id='timeline_master', billing_amount=0) 落帳；導出免費且不經任何供應商、無 billing_operation ｜ 證據: 349150f3
- [控制平面與計費] 導出登記冪等 — 冪等鍵 `film_export:<session_id>:<fingerprint>`，重放導出 job 不重複、artifact 不重插（artifact_id 同值、total 不變） ｜ 證據: 349150f3
- [控制平面與計費] 成片索引 HMAC ingest 通道 — `/api/v1/internal/masters/ingest` 復用 memory-hmac 同一通道與同一把密鑰，無簽／錯簽／密鑰未配置回 401 ｜ 證據: 349150f3
- [控制平面與計費] 成片索引 tenant 屬主維度 — reader/ingest 兩端對稱改用 `web:<userId>`，避免成片按 B key id 查永遠查空 ｜ 證據: 349150f3
- [控制平面與計費] 尺寸 NULL 誠實直譯 — 修掉既有 Number(null)→0 的偽實測，尺寸 NULL 直譯 null（禁 0 冒充） ｜ 證據: 349150f3

## B端API

- [B端API] `/v1/images/edits` durable 改圖管線 — 非 pixai 模型改圖回 202 + Location，任務合同與 generations 一致（不再走即時短路） ｜ 證據: 15f278d8
- [B端API] 成片索引列舉 — `/api/v1/masters` 按 session／project／時間列舉成片，每條帶導出指紋、preset、時長、解析度與 probe 摘要 ｜ 證據: 0b2c2843
- [B端API] B 端讀回成片全欄位 — 讀端回 probe.verified、fingerprint、解析度、時長、job_kind=film_export 等全欄位 ｜ 證據: 349150f3

## Agent助理

- [Agent助理] AI 助理全局記憶庫（私有 + 共享）— 私有 active docs 與共享索引注入 gateway 建號與 memory-patch payload；export／ingest／retract／review 四端點 ｜ 證據: 0625d6d5
- [Agent助理] 會話級記憶追溯 — `memory-trace` 端點回某會話的記憶注入與命中軌跡（另有 sessions/:id/memory 查詢） ｜ 證據: 0625d6d5
- [Agent助理] 審核官 Expert（critic）— 獨立審核 persona，只駁回不產內容，輪子鏡像 screenwriter-delegate ｜ 證據: ff5e6c7b
- [Agent助理] 提示詞契約機械檢查器 — 27 份契約（結構範式參考 AID 提示詞開發指南），運營改完當場可判是否違約 ｜ 證據: ff5e6c7b
- [Agent助理] Expert 資產機械導出 — export-expert-agents 導出 persona／registry／contracts 三產物（contracts 為本批新增第三產物） ｜ 證據: ff5e6c7b
- [Agent助理] Jev 輸入閘與路由權威 — TypeSafe System One 接入輸入閘／expert 路由／模板判定／workflow 記憶入庫閘，附閾值校準工具 ｜ 證據: 75c25e24
- [Agent助理] 判定層 Laya 兜底 — Jev 額度用盡（閉源按量計費）時自動切開源 Laya：契約逐位同構、fail-open、fallback 打 laya_fallback log 供歸因；Jev 通時 Laya 完全不碰 ｜ 證據: d25aed7d
- [Agent助理] 工作流完成記憶沉澱 — 歷史寫入後非同步 persistWorkflowMemory（fail-open 不阻塞 202）；閘門為 prompt 非空且 ≥2 槽位、body 硬上限 2000 字 ｜ 證據: ac0dfa0d
- [Agent助理] 記憶 ownerKey 收斂 — 從 state.apiKey 算 memoryOwnerKeyHash，與 agent 側 deriveMemoryOwnerKey 收斂到同一 ownerKey ｜ 證據: ac0dfa0d
- [Agent助理] 記憶庫第五類型 workflow — TYPE_VALUES（G1 結構閘判定集）與 curator prompt output schema 兩處同時擴充，缺一即靜默丟棄或不提議 ｜ 證據: 8fff4595
- [Agent助理] subagent 停止閘 — 可停止在途 subagent，gateway 送 subagent.done status="stopped"，subagentParentState 兜底 ｜ 證據: 7ae66e5b, 0d3e12af
- [Agent助理] workflow 完成推送 — 工作流完成事件推給前端 ｜ 證據: 7ae66e5b
- [Agent助理] TaskStatus 單一語義表 — stopped≠失敗 語義固化進 types-gateway.ts，wire 值零變更 ｜ 證據: 5a7b9a90

## 畫布與工作流

- [畫布與工作流] 作品／劇集／分鏡三級狀態機資料 — CanvasProject 帶 projectType／currentStep／episodes（全 optional、向後相容），normalizeProject 單點清洗避免路由與 layout 漂移 ｜ 證據: 9d9f0483
- [畫布與工作流] agent 建作品／建劇集 op — canvas op `set_project_meta` 是唯一可達專案級三欄的寫入口，episodes 在寫入端即做 episodeNo 去重與截斷 ｜ 證據: f603864c
- [畫布與工作流] 分鏡節點 21 欄契約 — 畫面／台詞·音效／時空／攝影四組共 21 欄，讀取端與上行端雙白名單清洗，剔除已廢的第 22 欄 sceneCode ｜ 證據: b01a1c47
- [畫布與工作流] 21 欄 → storyboard_qc_17 門禁橋接 — shotId←shotNumber、order←陣列序、prompt←visualDescription、characterCardIds/sceneCardIds←referenceAssets、aspectRatio←節點 size、卡鎖←project.cardIds 按 kind 分流 ｜ 證據: 49bffcd7
- [畫布與工作流] 劇集狀態查表由 enum 值域推導 — 改由 AID_EPISODE_STATUS 推導＋satisfies 窮盡性，AID 新增第七態時編譯失敗而非靜默回 undefined（避免劇集整筆消失） ｜ 證據: 7a4bbcc0
- [畫布與工作流] 作品類型值域單一真源 — CanvasProjectType {series, movie} 收斂全倉 8 處硬編字面值與 `=== "movie" || === "series"` 判斷 ｜ 證據: 7a4bbcc0
- [畫布與工作流] 畫布節點事件寫穿快照 — canvas.node.created/updated/connected/disconnected/generating 全數寫穿 canvasStates（SSE 與快照雙軌收口），updated 淺合併 last-write-wins 冪等 ｜ 證據: cef439a0
- [畫布與工作流] 工作流模板註冊表 6→13 — 7 模板修復到 novel_film 水準（card 補 harnessTemplateId、directive 補 workflow_start 指令、後端新建 WorkflowTemplate） ｜ 證據: d59d3976
- [畫布與工作流] 打字路徑骨架卡帶 deliverable/gate — WorkflowNodeSpec 加兩欄、expandTemplate 帶進 metadata、13 模板 deliverable 100% 覆蓋、R8 克隆鏈繼承 ｜ 證據: 3525afcf
- [畫布與工作流] gate 欄位雙形態 — string＝骨架門禁全文／true＝DSL「需人工批准」旗標；layout 白名單對 boolean 原樣保留 ｜ 證據: 95a6994e
- [畫布與工作流] 工作流歷史可重跑 — canHistoryEntryRerun 對 workflow 放寬，提交前剝掉前端專用 DAG 欄位再送 ｜ 證據: 06baf18e
- [畫布與工作流] 模板拆檔零漂移 — agent-templates(8)／agent-templates-payload(8)／workflow-templates(13) 逐模板獨立檔＋types＋barrel，切割前後快照 md5 逐位相同 ｜ 證據: d59d3976
- [畫布與工作流] AID 37 enum 值域庫 — creation(7)／generation(11)／storyboard(7)／asset(4)／billing(8) 值與中文 desc 逐字入庫，供消費端以單一真源推導 ｜ 證據: c194f5f4

## 創作域

- [創作域] 鏡頭語言詞庫 142 條（12 類）— MIT 逐字取自 AID aid_prompt_lib，可多選詞條插入提示詞 ｜ 證據: 30f01c7d
- [創作域] 7 步創作流水線骨架 — 作品／劇集／分鏡七步狀態機常數，輪子源 AID CreationStepEnum，MAX_EPISODES_PER_PROJECT 收斂單一宣告處 ｜ 證據: 30f01c7d, f603864c
- [創作域] 音樂管線 yue2 — music-tools/yue2 換血＋prompt-director 升級＋staging 同源導出＋music-director skill references ｜ 證據: 75c25e24
- [創作域] shortdrama QC 時長放寬 — 單鏡 2-30s、去段上限，對齊分鏡秒數最大化（現場 `duration_bounds` gate 仍是 2-30s） ｜ 證據: 75c25e24
- [創作域] 模板 promptNotes 配方級 — 6 模板加厚到 32-41 條／2,067-2,534 字，每條含具體數值、工具用法與可驗證判據 ｜ 證據: d59d3976

## 帳號與增長

- [帳號與增長] Google OAuth 登入 — `/api/auth/google` start＋callback 三件套與 google-auth 橋接（與 GitHub 同款、禁真實 Gmail 合成 email）＋SplitLoginButton 三段斜切鈕與品牌圖標 ｜ 證據: 75c25e24

## 前端與UI

- [前端與UI] 全聊天流單層滾動 — 參數卡與參數抽屜改 overflow:clip，滾輪手勢直接冒泡給最外層消息流（不再被隱形容器吃掉） ｜ 證據: dc6ef7b9
- [前端與UI] ParticleSeaWaiting 動效回退 — 回退 shadowBlur 直繪（去掉離屏 sprite 預渲染） ｜ 證據: dc6ef7b9
- [前端與UI] 作品／劇集面板 — CreationFlowPanel 掛畫布左側彈層，資料全取自 hook 既有出口，只報「已落畫布 N 鏡／場景計畫 M 鏡」不報完成進度 ｜ 證據: f603864c
- [前端與UI] 分鏡節點卡渲染 — 21 欄分四組呈現、shotNumber 作卡面徽章；Group 帶 storyboardScene 時顯示場景名＋鏡數 ｜ 證據: 84a3ce7a
- [前端與UI] 鏡頭詞庫選詞入口 — 畫布庫面板新增「鏡頭詞庫」tab，多選後經既有 onInsertText／onUsePrompt 插入（與提示詞卡同一通道） ｜ 證據: 9e438082
- [前端與UI] 工具卡中繼態 — 已提交成品未到時帶 task_id＋artifact_pending，顯示「生成中…」金徽章＋轉圈；image/video/audio.done 結 ok、image.failed 結 failed（精確 taskId 優先、FIFO 兜底） ｜ 證據: c86dd01d
- [前端與UI] 思維鏈預設展開 — 預設受控 open，手動收起優先於任何自動行為（作廢 08-25「預設收合」契約） ｜ 證據: c86dd01d
- [前端與UI] 在途反饋 — sendPending 為單一真相源，送出鈕真空期轉圈不可再點（輸入框空亦然）、被點模板 chip 轉圈其餘禁用、20s 硬保險 ｜ 證據: c86dd01d
- [前端與UI] 文字帧併批渲染 — 每 delta 一次全面板重渲染收斂到每幀一次；中止成功合成 turn.done；IME Enter 不再誤送出 ｜ 證據: c86dd01d
- [前端與UI] 聊天氣泡樣式 — 用戶灰底氣泡＋助理無底氣泡 ｜ 證據: eb1dcede
- [前端與UI] AgentPlanCard 計畫卡 — agent 計畫以卡片呈現，reducer／types／契約同步 ｜ 證據: 75c25e24
- [前端與UI] 桌面 Electron 薄殼 — desktop/ 薄殼 AppImage 可用（node_modules/dist 已 ignore） ｜ 證據: 75c25e24
- [前端與UI] 歷史三檔位篩選＋DAG 縮圖 — 圖片／影片／工作流篩選、workflow 卡取 dagThumbnailUrl、影片卡補 videoUrl 與 Play 標示（原本純影片記錄在歷史隱形） ｜ 證據: 06baf18e
- [前端與UI] RerunDialog 費用顯示 — 「上次實付 X 幣／本次預估 Y 幣」，實付缺時只顯預估並明確標「預估」不冒充實付 ｜ 證據: 06baf18e
- [前端與UI] HistoryLightbox DAG 展開 — 展開工作流 DAG 節點清單＋節點合計幣數 ｜ 證據: 06baf18e
- [前端與UI] 工作流縮圖對齊畫布節點卡 — 220px 卡、kind 色條、標籤徽章、I/O 行（↳來源／→目標）、站內色票、PNG density 216 ｜ 證據: 5881aff6
- [前端與UI] 任務狀態→UI 語義單表 — AgentToolCard／AgentSubagentBar／reducer 改查 AGENT_TASK_STATUS_TABLE，渲染輸出逐字不變 ｜ 證據: 8b08d285
- [前端與UI] subagent 已停止態可視化 — 派遣工具卡中性結算不打臉、不顯 abort 文案；SubagentBar 灰點中性徽章；ReportCard「已停止」 ｜ 證據: 0d3e12af
- [前端與UI] 節點卡「產出／門禁」渲染 — NodeBody Config/Text 分支複用 step_head 膠囊樣式顯示 deliverable／gate ｜ 證據: 3525afcf
- [前端與UI] Agent 模板卡 ID 可解析 — 7 模板 card 補 harnessTemplateId、art 系補 styleTemplateId（style-library 真 ID），8/8 可解析 ｜ 證據: d59d3976

## 運維與觀測

- [運維與觀測] gateway 生產↔git HEAD 對賬 — recon 腳本部署前必跑，漂移即擋；補子目錄盲區、排除 refactor-audit.ts 非運行時代碼 ｜ 證據: 581a7c6a, 07e3e42e, 5a7b9a90
- [運維與觀測] 成片靜態服務 — `/agent/v1/masters/<sid>/master_<preset>.mp4(+_cover.jpg)`，放 Bearer 閘門前，路徑 resolve＋前綴守衛（路徑穿越被拒） ｜ 證據: 349150f3
- [運維與觀測] 錯誤分類單一有序表 — 28 條 ERROR_RULES 進 error-classify.ts，humanize 表與 workflow-service RETRYABLE_NODE_ERROR 合併收編（17/17 行為全等） ｜ 證據: 5a7b9a90
- [運維與觀測] opencode 接縫統一 — opencodeFetch／opencodeJson helper，批次 1+2 共 8 檔 33 呼叫點機械遷移（timeout／錯誤處理結構逐點保留） ｜ 證據: 5a7b9a90
- [運維與觀測] serverless 中文字型隨程式碼部署 — Noto Sans CJK SC 子集化 18.6MB→5MB 放 public/fonts/，首次渲染把 dag-fonts.conf 的 __FONT_DIR__ 替換寫 /tmp 並設 FONTCONFIG_FILE ｜ 證據: 8a3a6728
- [運維與觀測] sharp 隔離 — 拆出 dag-png-server.ts 隔離 sharp，workflow-png.ts 回歸零依賴，避免把 sharp 拖進 browser bundle 炸整包 build ｜ 證據: 5881aff6
- [運維與觀測] 部署體積守衛 — .vercelignore 排除 .next/（847MB）與 desktop/dist/，避免單檔超 Vercel 100MB 上限 ｜ 證據: 5881aff6
- [運維與觀測] Laya ONNX 服務可入 VPS — 無 torch（onnxruntime＋tokenizers）、RSS 1.61GB、同契約 POST /predict 與 GET /healthz、三型 choice/score/noul 校準與 torch 逐位吻合 ｜ 證據: f1d5dd98
- [運維與觀測] gateway 無損切割 — index.ts 10029→8225→272 行組合根（共 32 個新模組），行多重集 7804=7804、missing 0 extra 0 審計證明零損 ｜ 證據: c8bfe4eb, bcd57a72

## 團隊與企業

- （本批 47 commit 無新增能力）

---

## 非程式碼能力

- VPS／生產對賬落庫 — 三度以 VPS 生產實體重建 repo 基線（84952257 md5 4664e5bb；f22dd523 重立至 VPS live b65e5966 並拉齊全量源碼樹；7ae66e5b 逐檔 diff 後收編 09-20 十二檔已部署改動），終結「未 commit 部署＝生產分叉」
- VPS／repo 鏡像內容（背景，非本批新增）— f22dd523 把 director-engine／editor／delivery-gate／beatDetect 等 VPS 既有能力拉進 repo；能力面本已存在於 VPS，本批只建鏡像
- 部署紀律（runbook）— 改 registry 後必須同時 restart opencode-server 與 agent-gateway：只重啟前者會讓 gateway /event SSE 懸掛到 fetch 超時（實測 4 分 21 秒），期間模型照常推理出圖、DB 正文齊全但前端看不到任何 delta，watchdog 還會誤判零文本重發 ｜ 證據: 3ca62d82
- DB 遷移 — migration 018 已套生產 DB：generation_job kind 擴 'film_export'、source 擴 'agent'；supplier_capability.kind 刻意不動 ｜ 證據: 349150f3
- 外部服務 — Laya 自架服務（Python HTTP 包裝 multilingual checkpoint ＋ Dockerfile ＋ runbook；RSS ~2.8GB 禁與 opencode-server 同機） ｜ 證據: d25aed7d, f1d5dd98
- 運營流程 — 派遣手冊第 20 條「研究是決策輸入，不是創作素材」進真源 orchestrator-dispatch-playbook.md，並以 15 例錨點測試鎖住關鍵詞在場、編號連續（19 後即 20 不跳號）、11-19 與 L152 原文零刪 ｜ 證據: 9a1cbf6d
- 運營流程 — 提示詞契約運營化：27 份契約目錄＋機械檢查器，運營改完當場可判（不再靠人工複核） ｜ 證據: ff5e6c7b
- 運營流程 — 歷史教訓資料遷移工具 tools/migrate-agent-lessons ｜ 證據: 0625d6d5
- 運營流程 — skill 單一真源生成 tools/gen-lens-skill（禁手改兩份） ｜ 證據: 30f01c7d
- 文檔／合規 — THIRD-PARTY-NOTICES 追加 AID 引入記錄（含逐條改寫說明與剔除項，如 AID OSS 不可達、voice 塌縮實測邊界） ｜ 證據: 90e7df76
- 驗收紀律 — PRD §11 修正：tsconfig exclude 掉 src/vendor-bridges、deploy-staging 與全部 *.test.ts，標準驗收命令回 0 不代表 0 錯；改為「主庫 + 隔離檢查 + 真跑測試」三條並跑 ｜ 證據: 90e7df76
- 審計文檔 — 「只做一半」審計（系統性模式：每刀停在型別＋清洗＋單測、消費端一律缺席）＋前端對稱差報告（我方強項＝能力表達：3D 導演台 39,251 行 vs AID 5,150；45 個 agent 模板，AID 無對應物） ｜ 證據: 7fd7bb0f
- 協作紀律 — 兩線並行工作共用同一工作區時以「聯集落庫」避免乾淨 HEAD 樹部署互抹（部署史實錘 03:41/03:48 有帧批、03:52-03:59 被回退） ｜ 證據: c86dd01d

---

## 邊界與拒絕

- 素材 URL 守衛 fail-closed（邊界語義）— 成片導出 check 端以 blocker 拒絕 blob:／data:／嵌套協議／非 http(s) 素材 ｜ 證據: 51631bc1
- 不做在線剪輯（明確不做）— 不提供時間軸 UI、不接 @webav（Eimu 賣 one-shot）；不新增前端頁面，沿用既有 chat 影片卡與畫布節點；不吞 AID 的 pending_video_* 雙槽（我方無審核隊列） ｜ 證據: 0b2c2843
- storyboard_qc 缺值語義（fail-closed）— 缺欄回 missing[]＋complete:false，不補假值；hasUsableQcValue 對齊門禁自身正規化，空串／純空白／NaN／空卡 id 全進 missing（修掉 production 空值被誤判 complete=true 的「謊報可過」） ｜ 證據: b01a1c47, 49bffcd7
- 無來源欄位絕不臆造（誠實留 missing）— durationSeconds（三把尺衝突且需自造台詞解析）、sceneId、keyframeId／lastFrameId／audioAnchorId、segmentDurationSeconds 全留 missing ｜ 證據: 49bffcd7
- 不在 21 欄契約內的欄位不顯示 — durationSeconds 只在 StoryboardQcProductionFields，顯示就是編造 ｜ 證據: 84a3ce7a
- set_project_meta 非法值省略該鍵 — 模型打錯一個 enum 不清掉用戶已填的劇集清單；代價：agent 無法借此清空欄位（已誠實標注） ｜ 證據: f603864c
- ingest 誠實語義 — 欄位缺失／非法逐欄 422 回報，不補預設值（metadata 會被讀端當事實轉錄給 B 端）；登記失敗不反悔導出（檔案已在盤上、靜態路由已可服務），只誠實記 note ｜ 證據: 349150f3
- 假能力拒絕（白名單外拒收）— supplier_capability.kind 刻意不加 film_export（該表語義是「供應商能承接什麼」，導出不經供應商，加了反而是假能力） ｜ 證據: 349150f3
- AID 語音庫整支撤回（功能地基不成立）— 63 筆火山 bigtts 音色碼全不含冒號，撞上本站網關 /opt/edge-tts/tts-proxy.js:41 `if (!voice.includes(':')) voice = `${model}:alex`` ⇒ 全部塌縮成同一個 alex 音而 HTTP 200 完全掩蓋；判據修正：SF 輸出非確定，sha256 差異不能證明音色不同，唯一可靠判據是 MP3 frame header 採樣率（32k=SF 主路／24k=edge 降級），故只認實測可播的 8 條 SiliconFlow preset，移除 voice-library／tts-upstream adapter／AssetPackItemKind "voice"／CharacterCard.voiceCode／artifact voice_code 透傳鏈 ｜ 證據: 95c32abb, 0c418b53
- 只埋樁不註冊（註冊即虛報能力）— tts_speech adapter 未進 supplier_adapter_type_check 白名單、未註冊 TTS 渠道 ｜ 證據: 95c32abb
- enum 假對位拒接 — AID_MEDIA_TYPE {image,video} 是我方 MediaKind {image,video,audio} 的子集（接上會讓我方獨有 audio 失去型別來源）；AID_MEDIA_TASK_STATUS 8 態與我方含計費態的 11 態是不同生命週期；AID_CREATION_STEP 刻意保留字面值以維持 aid-enums.test.ts 的真交叉檢查（改推導會退化成自我比對） ｜ 證據: 7a4bbcc0
- art-style 模板保持 unsupported 誠實口徑 ｜ 證據: d59d3976
- Laya 校準陷阱 — HF 公開 demo Space 校準已壞（benign 判 0.9999）不可用；root 英文 checkpoint 中文崩壞，必用 multilingual 版本 ｜ 證據: d25aed7d
- 縮圖／字型失敗不擋渲染 — 寧可方框不讓歷史寫入陪葬（與縮圖失敗同款語義）；已知取捨：動態 title 出現 U+9FA6 之後罕用字會落 notdef 方框 ｜ 證據: 8a3a6728
- 記憶沉澱 fail-open — 沉澱失敗只影響記憶庫、不影響已落地歷史；不阻塞 202 回應 ｜ 證據: ac0dfa0d
- Bun 陷阱（邊界語義）— Bun 的 node:crypto `Hash.update` 只吃 string/Buffer/TypedArray/DataView，裸 ArrayBuffer 會拋錯；成片索引登記因此整條靜默失敗而導出照樣成功（手簽 ingest 的 E2E 4/4 完全看不到此洞） ｜ 證據: f9660201
- 未知狀態保守判失敗 — AGENT_TASK_STATUS_TABLE 未知值 fallback 保守判失敗 ｜ 證據: 8b08d285
- 「完成」的判準不灌水 — 只建供給側不算完成：型別可寫＋測試綠是可機器驗證的，前端可見需真開瀏覽器，不能因此跳過 ｜ 證據: 7fd7bb0f

---

## 存疑

- 0625d6d5 共享庫注入的實際生效 — 端點與注入 payload 在 repo 可驗，但共享索引注入 gateway 建號的效果端在 VPS，本批無 VPS 側證據；缺「注入後 agent 行為差異」的實測。
- 75c25e24「Jev 權威三刀」的具體三刀 — 訊息只說輸入閘／路由權威接入＋閾值校準工具，細節在 PRD/評估文檔；缺逐刀 diff 級證據（另同 commit 的 gateway 15 檔同步內容未逐檔核）。
- 349150f3 的 resolve-owner（+user_id）部署狀態 — 訊息明說「待 Vercel 部署 resolve-owner 後索引歸屬才自動生效，此前以 note 標注跳過原因」；本批無法確認該部署是否已完成，缺部署證據。
- 7ae66e5b「VPS 對賬逐檔一致」— 僅 commit 訊息聲明（除 router.ts 註釋文字外全部一致），未獨立復驗。
- f22dd523 帶入的 gateway 模組（director-engine／editor／delivery-gate／beatDetect 等）使用者可見行為面 — 本批只證明它們進了 repo，未展開其入口與驗收；若清單要涵蓋這些能力須另批處理。
- 581a7c6a 附帶刪除 src/lib/agent-templates.ts／agent-templates-payload.ts（-2505 行）— 現場已存在同名目錄（拆檔後形態），判斷為清理拆檔前殘留平檔；但 commit 訊息未說明，缺 diff 級確認其非能力移除。

---

## 逐條對帳（47/47）

| hash | 貢獻的能力（或無） |
|---|---|
| 0625d6d5 | AI 助理全局記憶庫（私有＋共享）＋四端點＋memory-trace；HMAC raw-body 驗簽；migrate-agent-lessons 工具 |
| ff5e6c7b | 審核官 Expert（只駁不產）；27 份提示詞契約＋機械檢查器；Expert 導出三產物 |
| 30f01c7d | 鏡頭語言詞庫 142 條；7 步創作流程骨架；gen-lens-skill 單源生成 |
| 51631bc1 | 成片導出冪等指紋＋URL 守衛 blocker；字幕分屏 7-12 字 |
| 15f278d8 | /v1/images/edits durable 改圖（202＋Location）；yyds 補 image_edit claim；edit 標註與 claims 同源 |
| 9d9f0483 | 作品／劇集／分鏡三級狀態機資料層（projectType/currentStep/episodes） |
| dc6ef7b9 | 全聊天流單層滾動（參數卡不吞手勢）；ParticleSeaWaiting 回退直繪 |
| 9a1cbf6d | 純測試（釘死派遣手冊第 20 條）；能力屬非程式碼（運營規則） |
| b01a1c47 | 分鏡 21 欄契約＋雙白名單；缺欄回 missing[]+complete:false |
| c194f5f4 | AID 37 enum 值域庫入庫（純常量，尚無消費端） |
| 0b2c2843 | 成片產物索引（可列舉可回溯）；明確不做在線剪輯／時間軸 UI／@webav |
| 95c32abb | 曾交付配音音色庫＋TTS adapter（同批 0c418b53 全數移除）；遺留邊界語義：63 音色在網關塌縮成 alex |
| 90e7df76 | 文檔：NOTICES 追加刀 2/刀 3 引入記錄；驗收紀律修正為三條並跑 |
| 0c418b53 | 移除 95c32abb 全部內容（語音庫／adapter／voiceCode／透傳鏈）；淨新增能力＝0 |
| f603864c | agent op set_project_meta（建作品／建劇集）；作品／劇集面板 CreationFlowPanel |
| 84a3ce7a | 分鏡節點卡渲染（21 欄四組、shotNumber 徽章、Group 場景名＋鏡數） |
| 9e438082 | 畫布「鏡頭詞庫」選詞入口（多選插入提示詞） |
| 49bffcd7 | 21 欄→storyboard_qc_17 橋接；hasUsableQcValue 修掉謊報可過 |
| 7fd7bb0f | 文檔：「只做一半」審計＋前端對稱差報告（無新可呼叫能力） |
| 7a4bbcc0 | aid-enums 消費端接線：劇集狀態推導＋作品類型值域單一真源；拒接 3 個假對位 |
| 349150f3 | 成片導出閉環：gateway 登記、HMAC ingest、film_export 落帳、冪等鍵、靜態服務、migration 018、tenant 屬主維度 |
| f9660201 | 修復：Bun Hash.update 不吃 ArrayBuffer；邊界語義（登記靜默失敗而導出成功） |
| c86dd01d | 工具卡中繼態；思維鏈預設展開；在途反饋；文字帧併批；中止合 turn.done；IME Enter 修正 |
| 3ca62d82 | 文檔：單獨重啟 opencode-server 令 gateway 盲眼 4 分 21 秒（部署紀律） |
| 84952257 | 純同步：以 VPS 生產鏡像作重構基線（無新能力） |
| f22dd523 | 純同步：重立基線至 VPS live b65e5966＋拉齊全量源碼樹（含 director-engine/editor 等既有能力的鏡像，非新增） |
| c8bfe4eb | 純重構：gateway 第一階段無損切割（10029→8225 行，7 模組） |
| bcd57a72 | 純重構：第二階段無損切割（8225→272 行組合根，18 模組）；行為零變更 |
| eb1dcede | 用戶／助理氣泡樣式對調（灰底用戶＋無底助理） |
| 75c25e24 | Google OAuth 登入；Jev 輸入閘／路由權威；音樂 yue2 管線；桌面 Electron 薄殼；AgentPlanCard；shortdrama QC 時長放寬；gateway 渠道同步 |
| d25aed7d | Jev 額度斷路保險：Laya 兜底判定層（fail-open）＋laya-server Python／Dockerfile |
| f1d5dd98 | Laya ONNX 輕量版服務（無 torch、RSS 1.61GB、契約同構、校準逐位吻合） |
| ac0dfa0d | 工作流完成記憶沉澱迴路（persistWorkflowMemory＋閘門＋ownerKey 收斂） |
| 06baf18e | 工作流歷史卡＋DAG 縮圖＋三檔位篩選＋RerunDialog 費用顯示＋Lightbox 節點幣數＋工作流可重跑 |
| 8fff4595 | 記憶庫第五類型 workflow（TYPE_VALUES＋curator prompt 兩處同步） |
| 5881aff6 | 縮圖重寫對齊畫布節點卡；sharp 隔離 dag-png-server；.vercelignore 部署體積守衛 |
| 8a3a6728 | serverless 中文字型隨程式碼部署（子集 5MB＋fontconfig 於 /tmp）；失敗不擋 |
| 7ae66e5b | 收編 09-20 已部署改動（subagent 停止閘、workflow 完成推送、模板骨架等 12 檔） |
| 581a7c6a | 部署前對賬腳本（漂移即擋）；附帶清理拆檔前殘留平檔（無新能力） |
| 5a7b9a90 | TaskStatus 單一語義表；28 條 ERROR_RULES 單表；opencode 接縫 helper 遷移；recon 補子目錄盲區 |
| 8b08d285 | 任務狀態→UI 語義單表（未知值保守判失敗） |
| 0d3e12af | 補實裝 stopped 狀態（SSE 契約與三處 union；中性結算；灰點徽章；已停止） |
| cef439a0 | 畫布節點事件寫穿 canvasStates 快照（雙軌收口、last-write-wins 冪等） |
| 07e3e42e | 純運維修正：recon VPS 側排除 refactor-audit.ts |
| d59d3976 | 工作流模板註冊表 6→13（7 模板齊平 novel_film）；拆檔零漂移；模板卡 ID 可解析；promptNotes 配方級 |
| 3525afcf | 打字路徑骨架卡富化（deliverable/gate 貫通後端模板→SSE→畫布）＋節點卡膠囊渲染 |
| 95a6994e | gate 欄位雙形態 string\|boolean 修撞名；NodeBody 分流渲染；白名單保留 boolean |