# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 15 (App Router), Tailwind CSS 3, shadcn/ui, TypeScript. 前端部署 Vercel；生成控制面在 VPS Docker（generation-worker / adobe2api / postgres）。

## Users

- C 端：非技術小白（mobile-first），必須登錄後才可使用。
- B 端：企業/團隊批量生產用戶，買大額幣（如 10 萬幣）靠 Agent 批量生圖；走 OpenAI 相容端點（/v1/*，Bearer sk-biz-…，存於 .env.biz-key，僅服務端）。

## Product Purpose

AI 圖片/影片生成 SaaS（中轉站）。用戶「許願」→ Agent（coding agent harness）自動拆解、生成、迭代、批量執行直到額度；專業工作台提供模型/LoRA 等高階精確控制。成功 = 從許願到成品圖/影片的完整閉環（佇列 → 畫布 → 圖庫 → 改圖/放大/下載）。

## Positioning

多供應商聚合中轉（adobe2api / gpt-image-2 / PixAI 免費池 kotone 等），對外單一 OpenAI 相容面；Agent 扛參數與 LoRA，把生成變成「許願」而不是填表。B 端提供批發額度與 API。

## Operating Context

- 品牌 Emu（2026-08-12 定案，廢棄「影像工作室」）；網站文案一律簡體中文。
- 套餐「夢之三態」：夢芽（starter）/ 夢影（popular）/ 夢虹（pro），簡體勿用繁體。
- Agent 交互：確認卡先行、執行中可繼續聊、結果回流圖庫/改圖/放大/下載；失敗自癒並透明展示（opencode 模式）。
- 現有頁面：首頁畫布、pricing、history、status、docs、use-cases、admin、wechat-login（src/app/…）。

## Capabilities and Constraints

- 能力：文生圖、圖生圖（/v1/images/edits）、擴圖（/v1/upscale）、生影片；批量願望（用戶說 5000 張就生到額度為止）；B 端 OpenAI 相容 API；Agent 免費池（PixAI kotone）。
- 約束：無 dark mode 預設；UI 禁用 emoji 圖示；新組件禁用舊 paper-card / zen-dock / ink-wash 類別（僅 legacy 別名，勿新增）；金鑰不得暴露瀏覽器；hover 不得造成 layout shift。

## Brand Commitments

- 名稱：Emu（manifest「Emu — AI 创作」，short_name「Emu」；站點文案簡體中文）。
- Logo：Cursive 大寫 E，由微縮景物/角色/動物填充（Liquid Glass 色系），Firefly 生成；已落地 /icon.png、favicon.ico、apple-icon.png、public/icon-512.png。
- 套餐命名：夢芽 / 夢影 / 夢虹（2026-08-12 追加，PricingClient 由 PLANS.map 動態渲染）。

## Evidence on Hand

- design-system/MASTER.md：設計系統總綱（Liquid Glass 材料、色板、字級、間距、反模式）——視覺權威。
- tailwind.config.ts：iOS 26 token（ios.* 系統色、Dynamic Type 字級、continuous radius、spring easing、lg-appear/dismiss/shimmer）。
- src/app/globals.css：lg-* 材料類別與 CSS 變數（--lg-blur / --lg-saturate / --lg-brightness…）及 legacy 別名。
- 記憶檔：2026-08-08-agent-frontend-design-rules.md（Agent 交互決策）、2026-08-12-rebrand-emu.md（品牌與套餐）。

## Product Principles

1. 許願式體驗：用戶給願望，Agent 扛參數/拆解/迭代；確認卡是 Agent 的翻譯結果，不是用戶作業。
2. 閉環優先：生成 → 可見結果 → 可改/放大/下載 → 可重用，不讓用戶在佇列/畫布/圖庫/歷史間流浪。
3. 批量是真實場景：B 端買額度就是來批量生產，批量與額度上限必須誠實兌現。
4. 品質一致：所有 UI 遵循 Liquid Glass 設計系統（見 DESIGN.md / MASTER.md），禁止繞過設計系統憑空發揮。
5. UI 宣稱必須匹配真實能力：不把純 prompt 拼接標成區域編輯、不展示虛假百分比、不宣稱不存在的上游路徑。

## Accessibility & Inclusion

- 目標用戶含非技術小白：文案直白、單一入口、錯誤可自癒可解釋。
- Focus ring 常駐可見（--ring token）；可讀性優先，不因美觀縮小文字/目標/預覽。

## Product Decision Doctrine

<!-- 2026-08-29 自 AGENTS.md 移入（減常駐 token 負擔）；產品工作時按需讀取本節 -->

- Start from friction observed in the real creation workflow, not from a generic feature inventory. Name the affected user, task stage, blocked outcome, and observable evidence before proposing work.
- Treat the professional workspace as a task-state machine. Allocate attention and screen space according to whether the user is preparing, generating, reviewing, or reusing an asset; do not keep every panel equally prominent at all times.
- Readability, comprehension, and reliable operation outrank fitting everything into one viewport. Preserve visual quality, but never use beauty or zero-scroll as a reason to shrink text, targets, previews, or feedback below comfortable use.
- Remove duplicate mental models before adding another surface. If two modules transform substantially the same fields, merge them behind one authoritative entry and preserve undo rather than teaching two names for one action.
- UI claims must match real capability. Do not label plain prompt concatenation as regional editing, expose decorative percentages as real control, or imply an upstream/model path is available without generation evidence.
- Prefer closed loops over isolated features: an action should lead to a visible result, a recoverable state, and the next reuse action without making the user hunt across queue, canvas, gallery, and history.
- Convert repeated manual intervention into an interface or state transition only after the decision is stable. Automate deterministic work; keep ambiguous visual judgment with the user when they explicitly own final acceptance.
- Search for and extend the existing owner of state, persistence, billing, model capability, or UI responsibility. Do not create a second queue, history store, capability catalog, or task system without an explicit migration plan.
- Rank product work by expected movement of the user outcome per unit of time, implementation risk, operational risk, and future reuse. Feature count and architectural novelty are not value.
- State important beliefs as `FACT`, `INFERENCE`, or `HYPOTHESIS`. Each accepted issue must name the dominant bottleneck, smallest useful intervention, acceptance evidence, and what remains out of scope.
- Verification depth is a product decision. Use expected-pass contract tests, type checks, and production builds by default; add browser automation only when its result can change a decision. If the user takes over visual acceptance, report it as pending and stop after the agreed deploy boundary.
- When implementation is requested and expected-pass gates succeed, Image Studio changes default to production deployment unless the user explicitly limits the task to research, planning, documentation, or local-only work.

## Decision Record: 可編輯工程（2026-10-02 立，FotorCut 對稱差實測後）

背景：Fotor Agent（內部代號 FotorCut）API 級實測（memory `fotorcut-api-teardown`；取證 bundle 留存 `/tmp/fotor-recon/`）證實「可編輯工程」是其真護城河（Rocicorp Zero CRDT 同步 store＋幀級多軌時間線＋Remotion MG 的 editableManifest/nodeOverrides 機制＋詞級字幕），而其生成側僅 seedance-2-fast 720p 單模型。對稱差結論：它贏「文字/圖表/字幕要改」，我方贏「畫面要改」（多模型艦隊＋局部重畫＋續拍）。據此立決策如下。

### 架構決策

- **A1 時間線升格為第三真相**：剪輯 Expert 已有的內部時間線（過 lint/master 後即丟）持久化為用戶可見工程物件。幀精度（fromFrame/durFrames）＋詞級字幕（CaptionSegment→CaptionWord→Speaker 三層）；schema 形態照 FotorCut（25 實體全欄位已提取，不重新設計）。差異化支點＝**片段錨定 lineage 生成節點**：替換鏡頭直通局部重畫/續拍/換模型——FotorCut 單模型做不到。
- **A2 不上 CRDT、不做實時協同**：單寫入方＋既有節點版本史（20 版）覆蓋衝突需求；CRDT 工程量與 C 端 mobile-first 單用戶場景不成比例。多人實時協同成為付費需求再議。
- **A3 MG 走「生成代碼＋editableManifest＋nodeOverrides」，不生成視頻**：LLM 產出帶可編輯標註的 Remotion 代碼，instrumenter 抽欄位白名單（text.content/gradientColors/visibility/lifecycle），改字改色＝本地補丁零積分。Remotion 作為新 supplier channel 接入（照 Blender 先例），進現有調度與計費，不另起任務系統。
- **A4 agent 改時間線走 typed mutation**（`timeline.batch_diff`、`subtitle.applyPatches` 的同構物），掛現有 gateway 工具面，復用確認卡/版本史/計費；不建第二個任務系統（Doctrine 第 9 條）。

### 產品決策

- **P1 對外敘事**：撤「不做時間軸剪輯」（在對手「單軌黑盒」話術下是靶子）。終局句「**成片之後，改稿不用重來**」——P1 落地後才上首屏；落地前 CAPABILITIES 只撤負面宣稱，不宣稱未兌現能力。
- **P2 優先級釘死**：
  - **P0 生成主線可靠性**（一句話→計劃卡→首張關鍵幀；全庫 526 會話僅 84 出過媒體、一張圖說畫就畫約 50%）——編輯台建在搖晃地基上＝在失敗現場精修。
  - **P1 時間線工程**：詞級字幕雙擊改（零積分）＋片段錨定生成節點。驗收證據＝「改一個字幕字、替換一個鏡頭」全程不重新生成整片。
  - **P2 MG/文檔軸**：PDF/CSV 輸入→可編輯動態圖表（信息型視頻灘頭；進攻性擴張，單獨裁）。
  - **P3 多語本地化**（詞級字幕延伸，復用 TTS 8 音色）。
- **P3 計費三層**：字幕文字/時長/位置＝零積分；MG 補丁/重渲染＝按渲染成本低價計；新生成＝模型積分。標價與扣費同源（既有原則不變）。
- **P4 不做**：模板市集（「做同款」已覆蓋複用）；通用剪輯軟體參數面（轉場濾鏡全家桶不碰）；Photoshop、技能市集照舊。
- **P5 工程物件進 `/v1` API**（讀工程 JSON、按 mutation 改片段）——B 端「按規格下單後改其中一鏡」閉環；封閉工作台的對手結構性做不到。
