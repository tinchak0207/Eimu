# 野獸模式「專家軍團作戰」大 PRD（暴君 09-10 親定範式）

> 目標：beast ON 時，任務按「專家軍團作戰方法論」真實運轉——研究軍團先行（web 搜索彈藥）、交叉契合度分析、多毒蛇並發評審（視覺審核通路）、agent-evolve 式返工、成片毒舌終審。
> 三類工作：①純提示詞（playbook v1.3 已上 VPS ✅）②Harness 工具增強（本 PRD 主體）③後端+Harness 配合（實測後迭代）。
> 三路並發鐵律推進到做完；每片 20-40 分鐘，2x 殺線。

## 現狀與缺口（09-10 驗屍）

- ✅ playbook v1.3 軍團範式已注入（第〇節：研究先行/世界第一標尺/Orchestrator 純度/極專業細分技能/多輪閉環）
- ❌ 研究 subagent 沒有 web 搜索工具——「研究 2026 日本動漫」只能靠模型內部知識（過時且無實證）
- ❌ 毒蛇評審 subagent 沒有讀圖通路——「美觀/構圖/色彩」審核無從下手
- ❌ playbook 範式未掛接具體工具名（模型不知道研究該調 web_search、審核該調 vision_analyze）
- ⏳ 3D 預演環節：blender Expert 已可用（blender_exec/render），playbook 已指派——待實測驗證
- ⏳ agent-evolve 式返工循環：純提示詞可指導，待工具到位後實測

## 片清單

| 片 | 內容 | 依賴 | 狀態 |
|---|---|---|---|
| R0 | 本地 Harness 素材庫盤點 → 軍團化接入清單（見文末 R0 節） | - | ✅ 完成 |
| R1 | web_search harness 工具（Tavily 上游，本地 key 已有）→ staging 導出 → VPS 部署 → env 注入 | - | 進行中 |
| R2 | vision_analyze harness 工具（Gemini API 讀圖，審美審核維度 prompt 模板）→ 部署 → 復用現有 GEMINI_API_KEY | - | 進行中 |
| R3 | playbook v1.4：第〇節掛接 web_search/vision_analyze 工具名＋研究/評審 subagent spec 模板 | R1+R2 | ✅ 完成（09-10，本地+VPS 已部署，md5 對齊） |
| R4 | beast ON 全鏈實測原例「2026 日本動漫 MV」→ 逐環節取證（研究軍團真派？契合度分析真做？多毒蛇真審？）→ 缺口清單 | R3 | 排隊 |
| R5 | 按 R4 缺口迭代（後端+Harness 配合類） | R4 | 排隊 |

## 成功標準

beast ON 發「製作一個和 2026 年日本動漫風格切合的动画片头曲 MV」後，真實觀察到：
1. 研究軍團 subagent 派出且引用 web_search 結果（有 URL 出處的研究結論）
2. 曲/分鏡創作引用研究結論（配方可追溯）
3. 契合度分析與模型風險映射 subagent 跑過（成功門檻成文）
4. 多毒蛇評審 subagent 並發≥2 且引用 vision_analyze 讀圖證據
5. 返工循環至少 1 輪（評審結論→修復→復審）
6. 成片＋毒舌終審結論

## 憑證彈藥（已盤點）

- Tavily：本地 `/home/lenovo/.agents/skills/aggregate-search/.env`（tvly- 開頭，1 條）→ R1 傳 VPS（0600）
- Gemini：VPS `.env`/`.env.opencode` 已注入 → R2 直接用

---

# R0 盤點節：本地 Harness 素材庫 → 軍團化接入清單（09-10）

> 盤點方法：每項只讀 SKILL.md 頭部 description＋目錄/段落結構，未通讀。凡未親眼讀到的內容一律標「未讀」，不腦補。
> 接入方式三選一定義：【嵌入 spec】= 內容複製進 subagent prompt（一次性、零運行時依賴）；【skill path】= 引用 repo/skill 目錄路徑由 subagent 現場讀（有先例：expert-registry `skillPaths` 字段 + music-director/blender-director 掛載）；【工具化】= 造 harness 工具（重成本，僅高頻複用才值得）。

## 前置實錘：現有掛載機制（R3 引用即成立）

- `src/lib/expert-registry.ts` 每個 Expert 行有 `skillPaths: readonly string[]` 字段（L106），7 個 Expert 全有（music → `skills/music-director/SKILL.md` + files/ 目錄；web3d → `skills/web-3d-awwwards/SKILL.md`；motion → `skills/motion-design/` 域目錄）。**軍團 subagent 沿用此模式 = 零新機制**。
- VPS 真源在 `/opt/agent-harness/workspace/.opencode/tools/`（harness-tool-registry.ts L1-9），本地 `skills/` 目錄是否同步上 VPS 由部署流程管，R3 引用前需確認目標路徑在 VPS 存在。

## 表一：軍團環節 → 素材映射

### 研究軍團（世界觀/作曲理論/受眾情緒）

| 環節 | 素材 | 位置 | 內容（讀過的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| Web 搜索主力 | **R1 web_search 工具**（進行中） | harness 工具 | Tavily 上游，key 已在本地 aggregate-search/.env | 【工具化】R1 已在做 | 軍團每次作戰都要搜索，必須是 harness 工具而非 prompt 素材 |
| Tavily key 與用法 | tavily skill（`tavily-search-1.0.0`，名 `tavily`） | `~/.agents/skills/tavily-search-1.0.0/SKILL.md` | AI 優化 web 搜索 API 封裝，env `TAVILY_API_KEY` | 【嵌入 spec】3 行 | 只需告知「R1 工具已封裝 Tavily」，不需要 skill 全文 |
| Reddit 深挖（受眾情緒/流行語料） | reddit-miner | `~/.agents/skills/reddit-miner/SKILL.md`（150 行） | arctic-shift 存檔 API（`https://arctic-shift.photon-reddit.com/api`，免 key、官方 reddit 全 403 僅此入口可靠）、意圖×態度交叉表、高頻短語提取、踩坑清單（L134-143） | 【嵌入 spec】只嵌 L24-30（API base+要點）+ L134-143（踩坑），或全檔 150 行也可接受 | 免 key、純 HTTP → 研究軍團 subagent 可直接 curl；150 行小於一份 spec 模板，嵌入無稀釋風險 |
| 多平台聚合（B站/小紅書/Telegram） | aggregate-search | `~/.agents/skills/aggregate-search/SKILL.md`（73 行） | B站 WBI 簽名/Reddit arctic-shift/GitHub API 免登錄可用；Tavily/Telegram(Telethon)/小紅書(xhs-cli)/X(twikit) 需配置；含 `scripts/` 本地腳本 | 【工具化】❌ 暫不 / 【嵌入 spec】❌ 太薄 → **裁定：嵌入「能力聲明」2 行，平台矩陣留 skill path** | scripts 在本機不在 VPS；研究 subagent 只需知道「B站/Reddit/GitHub 免 key 可挖」，細節等 R4 實測暴露缺口再升級 |
| 邊緣情報（地下論壇） | edge-knowledge | `~/.agents/skills/edge-knowledge/SKILL.md` | 依賴 browser-use 自動化+視覺識別產出 Markdown 報告 | 【嵌入 spec】❌ | 依賴本機 browser-use，VPS harness subagent 跑不動 → 短期不可用，標記「未接入，等有 VPS 瀏覽器通路再議」 |
| 通用視覺識別後備 | read-image | `~/.agents/skills/read-image/SKILL.md` | 本機腳本 gemini-3.7-flash 主/groq 後備，SSH 隧道鏈 | 【嵌入 spec】❌ | 本機專屬鏈路，VPS 側對應物就是 R2 vision_analyze，不重複造 |

### 創作軍團（分鏡/鏡頭 prompt/視覺錨定）

| 環節 | 素材 | 位置 | 內容（讀過的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| 分鏡卡→鏡頭 prompt | **shot-prompt 15-block**（film-studio-skills 七件套之一） | `~/.agents/skills/film-studio-skills/skills/shot-prompt/SKILL.md`（103 行） | 15 塊結構（L46-60）：scene context→active references→location map→blocking→format→optics→camera body→action timing(0.3-0.8s beats)→physics→lighting→audio→acting→style prefix(60:30:10)→quality bar→positive constraints；明令不加負面 prompt 段 | 【嵌入 spec】（15 塊標題+一句話，約 20 行） | 15-block 是「檢查清單」不是「操作手冊」，核心可壓縮；完整檔依賴 `/prompts/`、passport 檔案系統（studio 樹），VPS subagent 沒有該樹 → 整檔 skill path 反而誤導 |
| 資產一致性（角色/場景不漂移） | asset-passport | 同上 `skills/asset-passport/SKILL.md`（124 行） | 生成前建資產護照，角色/地點/道具/狀態變體可重複視覺身份 | 【skill path】或嵌核心規則 | 護照理念=「verbatim 複製進每個 prompt」，與 harness `character_dna_turnaround`/`model_identity_lock`/`garment_dna_lock`（registry L46/L134/L132）天然同構 → 優先映射到已有工具，skill 只作方法論補充 |
| 通用 prompt 工程（SLCT/幻覺防治/鏡頭語言） | ai-ad-prompt-guide | `~/.agents/skills/ai-ad-prompt-guide/SKILL.md`（411 行，三段結構已實讀） | Part1 通用規則（SLCT L17、幻覺防治 5 條 L52、鏡頭運動詞彙表 L79、UGC L109、產品鏡頭 L145、pass³ L168）；Part2 模型分支（選型矩陣 L196：Sora2/Veo3/Kling/Flux/Nano Banana/Seedance）；Part3 API 自動化（L256-403，本地 credit 計費，與 harness 無關） | 【嵌入 spec】：Part1 全嵌（L15-193，約 180 行）；Part2 只嵌 Seedance/Kling 相關節；Part3 不嵌 | 視頻軍團每個分鏡 subagent 都該帶 SLCT+幻覺防治+鏡頭詞彙——這是「寫法基因」，必須逐字在 prompt 裡；Part3 是別家 API 說明，嵌進去是毒藥 |
| 圖反推（參考圖→結構詞） | nuyoah-image-reverse-prompt | `~/.agents/skills/nuyoah-image-reverse-prompt/SKILL.md` | 參考圖解構、色卡、反推中文 prompt | 【嵌入 spec】❌ / 待 R2 | 其價值一半在「生成返圖校準」循環（需本機反覆生圖）；VPS 有 vision_analyze 後可提取其分析維度段嵌入，現階段標「素材已有，接入待 R4 實測」 |
| 平面設計產物 | canvas-design | `~/.agents/skills/canvas-design/SKILL.md` | 設計哲學→canvas 產出 png/pdf，兩步法 | 【嵌入 spec】❌ | 產出物是本地檔案繪製，MV 軍團鏈路用不上；僅當終審要「海報類宣傳物」時以 skill path 引用，非主線 |
| 音樂域配方 | music-director（已在 registry 掛載） | `skills/music-director/SKILL.md` + `files/` SunoForge 12 檔 | 「音樂生成類請求必載本庫，禁止憑記憶寫音樂 prompt」 | 【skill path】✅ 已掛 | 既有資產，研究軍團產出的作曲理論結論應寫進其輸入，不動配方庫 |
| 3D 預演 | blender-director / blender-agent-os / make-blender-education-video | `skills/` 內三庫（白名單複製上游，帶 Blender 5.2 雷區註釋） | 五階段管線+12 份配方（blender-director）；agent-os 含 core/img2threejs/knowledge | 【skill path】✅ 已掛（blender-director-persona） | 既有資產，PRD 已指派 blender Expert，R4 驗證即可 |

### 審核軍團（多毒蛇並發評審）

| 環節 | 素材 | 位置 | 內容（讀過的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| 讀圖證據 | **R2 vision_analyze 工具**（進行中） | harness 工具 | Gemini API 讀圖+審美審核維度 prompt 模板 | 【工具化】R2 已在做 | 毒蛇必須引用讀圖證據（PRD 成功標準 4） |
| 審美審核標準 | impeccable | `~/.agents/skills/impeccable/SKILL.md`（79 行）+ reference/ 子檔 | 79 行主檔是「設計總綱」（bounded passes 紀律/modes）；具體審核條目在 reference/ 子檔（**未讀**，僅確認存在） | 【嵌入 spec】：只嵌主檔核心原則 ~30 行；毒蛇 spec 引 vision_analyze 的審美維度模板為主 | impeccable 面向 web UI（brief/modes/command 路由），與「動漫 MV 幀審核」域不匹配，全文嵌入是噪音；其「驗證有界、不無限自審」紀律值得嵌 |
| 過程審核（資產鎖定前壓測） | stress-test（film-studio 七件套） | `~/.agents/skills/film-studio-skills/skills/stress-test/SKILL.md` | 「Combat-test draft film assets before locking」——passport/reference 存在後、場景生成前 | 【嵌入 spec】 | 這就是 agent-evolve 式返工循環在影片域的現成輪子：壓測不過→回爐，正是 PRD 成功標準 5 |
| 方法論循環（評測→修復→復測） | agent-evolve | `~/.agents/skills/agent-evolve/SKILL.md` | 三階段流水線：真輪子評測→暴君第一人稱毒舌報告→逐句修復派工→復測閉環（沉淀自 2026-08-27 小說成片實戰） | 【嵌入 spec】：嵌「三階段+判決格式」骨架 | Orchestrator 級紀律而非 subagent 素材；playbook 第〇節已含其精神，R3 在毒蛇→返工環節點名引用 |
| 排版/UI 資料庫 | ui-ux-pro-max（名 `ui`） | `~/.agents/skills/ui-ux-pro-max/SKILL.md` | 67 風格/96 色板/57 字體配對/99 UX 準則檢索庫，Python 檢索 | 【嵌入 spec】❌ / 【skill path】❌ | 本機 Python 依賴+web UI 域不匹配；僅其「色彩/字體配對」資料未來或可提取，現階段不接入 |

## 表二：接入方式裁定彙總（R3 直接抄）

| 素材 | 裁定 | 成本 | 一句話理由 |
|---|---|---|---|
| R1 web_search | 【工具化】（進行中） | 已沉沒 | 軍團基礎設施，每戰必用 |
| R2 vision_analyze | 【工具化】（進行中） | 已沉沒 | 毒蛇讀圖唯一通路 |
| reddit-miner API 段 | 【嵌入 spec】 | ~30 行 | 免 key 純 HTTP，嵌入即用，無部署 |
| aggregate-search | 【嵌入 spec】2 行能力聲明 | 2 行 | 腳本在本機，VPS 不可跑；先聲明後實測 |
| ai-ad-prompt-guide Part1 | 【嵌入 spec】 | ~180 行 | 寫法基因必須逐字隨行 |
| shot-prompt 15-block | 【嵌入 spec】 | ~20 行 | 檢查清單性質；整檔依賴 studio 檔案樹 |
| stress-test | 【嵌入 spec】 | 短（未逐行讀） | 返工循環的影片域現成輪子 |
| impeccable 核心原則 | 【嵌入 spec】 | ~30 行 | 只取紀律與品味標尺，棄 web UI 域內容 |
| agent-evolve 骨架 | 【嵌入 spec】（playbook 層） | ~15 行 | Orchestrator 級紀律 |
| music-director / blender-director | 【skill path】✅ 已掛 | 0 | expert-registry 先例，零新機制 |
| asset-passport | 【skill path】＋映射已有 DNA 工具 | 0 | 護照理念已被 harness 工具實現 |
| nuyoah-image-reverse-prompt | 待 R4 | - | 價值在返圖校準循環，VPS 暫無通路 |
| edge-knowledge / read-image / canvas-design / ui-ux-pro-max | 不接入 | - | 本機依賴或域不匹配 |

裁定總則：**研究/創作/審核三軍的 subagent spec 全走【嵌入 spec】；域 Expert（music/blender/motion/web3d）沿【skill path】；只給「每戰必用的基礎能力」造工具（R1/R2 已在做，軍團化不再新增工具化項）。**

## 表三：R3 spec 模板彈藥（檔名+行號，皆已實讀）

### 研究軍團 spec 模板嵌入清單
1. `~/.agents/skills/reddit-miner/SKILL.md` L26（API base URL）＋L134-143（實測踩坑 8 條，含降級 pullpush.io）——研究 subagent 的 Reddit 通路配方
2. `~/.agents/skills/tavily-search-1.0.0/SKILL.md` 頭部 env 聲明——僅提示 key 由 R1 工具注入，不嵌全文
3. `~/.agents/skills/aggregate-search/SKILL.md` L8-12（功能特點免登錄矩陣）——B站/Reddit/GitHub 免 key 能力聲明
4. R1 web_search 工具調用簽名（R1 交付後補進模板）

### 創作軍團 spec 模板嵌入清單
1. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L17-50（SLCT 框架+示例）＋L52-77（幻覺防治 5 條+觸發表）＋L79-107（鏡頭運動詞彙表）——分鏡 subagent 必載
2. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L168-192（pass³ 質量測試）——分鏡 subagent 自檢＋毒蛇復用
3. `~/.agents/skills/film-studio-skills/skills/shot-prompt/SKILL.md` L46-60（15 塊定義逐條）——鏡頭 prompt 的硬結構，明令「不加負面 prompt 段」（L62）
4. `~/.agents/skills/film-studio-skills/skills/asset-passport/SKILL.md` 核心規則——與 `character_dna_turnaround`（registry L46）綁定使用
5. `skills/music-director/`（skill path 引用）——音樂 subagent，研究軍團作曲理論結論作輸入

### 毒蛇評審 spec 模板嵌入清單
1. R2 vision_analyze 審美維度模板（R2 交付後補）——證據主體
2. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L168-192（pass³）＋L52-77（幻覺防治）——毒蛇按此逐項開罰，與創作者共用同一標尺（雙方都嵌 = 評審與被評審對表）
3. `~/.agents/skills/impeccable/SKILL.md` 核心原則節（~L20-33：brief wins / refinement preserves / bounded passes 紀律）——只嵌紀律，棄 web UI modes
4. `~/.agents/skills/agent-evolve/SKILL.md` 三階段骨架——返工循環的判決格式（評分+逐句修復派工），供 Orchestrator 併入 playbook 而非毒蛇本體
5. `~/.agents/skills/film-studio-skills/skills/stress-test/SKILL.md`——「資產鎖定前壓測」崗位的操作依據（此檔未逐行讀，R3 引用前先讀全文）

### 誠實備註（09-10 R3 更新：原「未讀」項已逐個通讀 SKILL.md 全文，嵌入裁定如下）

**已通讀並嵌入 playbook v1.4 模板的**：
- stress-test（109 行全文）：嵌入精華=壓測矩陣八欄（Test/Angle/Shot size/Scene lighting/Paired asset/Prompt/Result/Verdict）＋「角色 10/10 全過才鎖定、miss 不可被好圖平均」門禁→ 模板二【鎖定前壓測】節；檔案操作（registry/passport 檔讀寫）依賴 studio 樹，未嵌。
- shot-prompt（103 行全文）：15-block 逐塊定義＋「不加負面 prompt 段」→ 模板二【15-block 鏡頭 prompt 硬結構】；/prompts/ 樹依賴未嵌。
- film-breakdown（112 行全文）：三 lane 22 欄（9+6+7）＋「單 clip 單動作 10-15s、畫面文字分離」→ 模板二【分鏡卡三 lane 22 欄】；breakdown.md 檔案流未嵌。
- reference-board（118 行全文）：「參考是規格不是靈感、先有圖後有描述、anti-reference 入 ban list（like this — not allowed）」→ 模板二【資產一致性】節；bible.md/圖片數量配額未嵌。
- asset-passport（124 行全文）：canonical descriptor 完整 prose verbatim 複製、狀態變體獨立護照 → 模板二【資產一致性】節；與 harness DNA 工具同構，映射已在模板標明。
- setup / studio-init（104/110 行全文）：純訪談式配置＋建樹流程，**依賴本機 studio 檔案樹，VPS subagent 用不上 → 不嵌入，無可嵌規則精華**（四黃金規則「lock before generate / verbatim / one-line edit / version everything」精神已被模板二/三覆蓋）。
- agent-evolve（301 行，關鍵節 L12-71/L145-197 已讀）：判決格式（評分+逐條修復指令+未觀察項聲明）→ 模板三【verdict 規則】【產出格式】；三階段骨架留在 playbook 軍規 5，附錄 A（VPS harness 教學）不嵌。
- impeccable 主檔（79 行全文）：「驗證有界（bounded passes，一輪批讀+至多一輪復核）＋brief wins＋refinement preserves」→ 模板三【紀律】節；reference/ 子檔群與 commands/modes 為 web UI 域，確認不嵌。

**維持不接入（理由不變）**：edge-knowledge / read-image / canvas-design / ui-ux-pro-max（本機依賴或域不匹配）；nuyoah-image-reverse-prompt（待 R4 返圖校準循環）。
