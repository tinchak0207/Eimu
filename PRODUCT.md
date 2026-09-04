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
