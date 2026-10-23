# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 15 (App Router), Tailwind CSS 3, shadcn/ui, TypeScript. 前端部署 Vercel；生成控制面在 VPS Docker（generation-worker / adobe2api / postgres）。

## Users

- C 端：非技术小白（mobile-first），必须登录后才可使用。
- B 端：企业/团队批量生产用户，买大额币（如 10 万币）靠 Agent 批量生图；走 OpenAI 相容端点（/v1/*，Bearer sk-biz-…，存于 .env.biz-key，仅服务端）。

## Product Purpose

AI 图片/影片生成 SaaS（中转站）。用户「许愿」→ Agent（coding agent harness）自动拆解、生成、迭代、批量执行直到额度；专业工作台提供模型/LoRA 等高阶精确控制。成功 = 从许愿到成品图/影片的完整闭环（伫列 → 画布 → 图库 → 改图/放大/下载）。

## Positioning

多供应商聚合中转（adobe2api / gpt-image-2 / PixAI 免费池 kotone 等），对外单一 OpenAI 相容面；Agent 扛参数与 LoRA，把生成变成「许愿」而不是填表。B 端提供批发额度与 API。

## Operating Context

- 品牌 Emu（2026-08-12 定案，废弃「影像工作室」）；网站文案一律简体中文。
- 套餐「梦之三态」：梦芽（starter）/ 梦影（popular）/ 梦虹（pro），简体勿用繁体。
- Agent 交互：确认卡先行、执行中可继续聊、结果回流图库/改图/放大/下载；失败自愈并透明展示（opencode 模式）。
- 现有页面：首页画布、pricing、history、status、docs、use-cases、admin、wechat-login（src/app/…）。

## Capabilities and Constraints

- 能力：文生图、图生图（/v1/images/edits）、扩图（/v1/upscale）、生影片；批量愿望（用户说 5000 张就生到额度为止）；B 端 OpenAI 相容 API；Agent 免费池（PixAI kotone）。
- 约束：无 dark mode 预设；UI 禁用 emoji 图示；新组件禁用旧 paper-card / zen-dock / ink-wash 类别（仅 legacy 别名，勿新增）；金钥不得暴露浏览器；hover 不得造成 layout shift。

## Brand Commitments

- 名称：Emu（manifest「Emu — AI 创作」，short_name「Emu」；站点文案简体中文）。
- Logo：Cursive 大写 E，由微缩景物/角色/动物填充（Liquid Glass 色系），Firefly 生成；已落地 /icon.png、favicon.ico、apple-icon.png、public/icon-512.png。
- 套餐命名：梦芽 / 梦影 / 梦虹（2026-08-12 追加，PricingClient 由 PLANS.map 动态渲染）。

## Evidence on Hand

- design-system/MASTER.md：设计系统总纲（Liquid Glass 材料、色板、字级、间距、反模式）——视觉权威。
- tailwind.config.ts：iOS 26 token（ios.* 系统色、Dynamic Type 字级、continuous radius、spring easing、lg-appear/dismiss/shimmer）。
- src/app/globals.css：lg-* 材料类别与 CSS 变数（--lg-blur / --lg-saturate / --lg-brightness…）及 legacy 别名。
- 记忆档：2026-08-08-agent-frontend-design-rules.md（Agent 交互决策）、2026-08-12-rebrand-emu.md（品牌与套餐）。

## Product Principles

1. 许愿式体验：用户给愿望，Agent 扛参数/拆解/迭代；确认卡是 Agent 的翻译结果，不是用户作业。
2. 闭环优先：生成 → 可见结果 → 可改/放大/下载 → 可重用，不让用户在伫列/画布/图库/历史间流浪。
3. 批量是真实场景：B 端买额度就是来批量生产，批量与额度上限必须诚实兑现。
4. 品质一致：所有 UI 遵循 Liquid Glass 设计系统（见 DESIGN.md / MASTER.md），禁止绕过设计系统凭空发挥。
5. UI 宣称必须匹配真实能力：不把纯 prompt 拼接标成区域编辑、不展示虚假百分比、不宣称不存在的上游路径。

## Accessibility & Inclusion

- 目标用户含非技术小白：文案直白、单一入口、错误可自愈可解释。
- Focus ring 常驻可见（--ring token）；可读性优先，不因美观缩小文字/目标/预览。

## Product Decision Doctrine

<!-- 2026-08-29 自 AGENTS.md 移入（减常驻 token 负担）；产品工作时按需读取本节 -->

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

## Decision Record: 可编辑工程（2026-10-02 立，FotorCut 对称差实测后）

背景：Fotor Agent（内部代号 FotorCut）API 级实测（memory `fotorcut-api-teardown`；取证 bundle 留存 `/tmp/fotor-recon/`）证实「可编辑工程」是其真护城河（Rocicorp Zero CRDT 同步 store＋帧级多轨时间线＋Remotion MG 的 editableManifest/nodeOverrides 机制＋词级字幕），而其生成侧仅 seedance-2-fast 720p 单模型。对称差结论：它赢「文字/图表/字幕要改」，我方赢「画面要改」（多模型舰队＋局部重画＋续拍）。据此立决策如下。

### 架构决策

- **A1 时间线升格为第三真相**：剪辑 Expert 已有的内部时间线（过 lint/master 后即丢）持久化为用户可见工程物件。帧精度（fromFrame/durFrames）＋词级字幕（CaptionSegment→CaptionWord→Speaker 三层）；schema 形态照 FotorCut（25 实体全栏位已提取，不重新设计）。差异化支点＝**片段锚定 lineage 生成节点**：替换镜头直通局部重画/续拍/换模型——FotorCut 单模型做不到。
- **A2 不上 CRDT、不做实时协同**：单写入方＋既有节点版本史（20 版）覆盖冲突需求；CRDT 工程量与 C 端 mobile-first 单用户场景不成比例。多人实时协同成为付费需求再议。
- **A3 MG 走「生成代码＋editableManifest＋nodeOverrides」，不生成视频**：LLM 产出带可编辑标注的 Remotion 代码，instrumenter 抽栏位白名单（text.content/gradientColors/visibility/lifecycle），改字改色＝本地补丁零积分。Remotion 作为新 supplier channel 接入（照 Blender 先例），进现有调度与计费，不另起任务系统。
- **A4 agent 改时间线走 typed mutation**（`timeline.batch_diff`、`subtitle.applyPatches` 的同构物），挂现有 gateway 工具面，复用确认卡/版本史/计费；不建第二个任务系统（Doctrine 第 9 条）。

### 产品决策

- **P1 对外叙事**：撤「不做时间轴剪辑」（在对手「单轨黑盒」话术下是靶子）。终局句「**成片之后，改稿不用重来**」——P1 落地后才上首屏；落地前 CAPABILITIES 只撤负面宣称，不宣称未兑现能力。
- **P2 优先级钉死**：
  - **P0 生成主线可靠性**（一句话→计划卡→首张关键帧；全库 526 会话仅 84 出过媒体、一张图说画就画约 50%）——编辑台建在摇晃地基上＝在失败现场精修。
  - **P1 时间线工程**：词级字幕双击改（零积分）＋片段锚定生成节点。验收证据＝「改一个字幕字、替换一个镜头」全程不重新生成整片。
  - **P2 MG/文档轴**：PDF/CSV 输入→可编辑动态图表（信息型视频滩头；进攻性扩张，单独裁）。
  - **P3 多语本地化**（词级字幕延伸，复用 TTS 8 音色）。
- **P3 计费三层**：字幕文字/时长/位置＝零积分；MG 补丁/重渲染＝按渲染成本低价计；新生成＝模型积分。标价与扣费同源（既有原则不变）。
- **P4 不做**：模板市集（「做同款」已覆盖复用）；通用剪辑软体参数面（转场滤镜全家桶不碰）；Photoshop、技能市集照旧。
- **P5 工程物件进 `/v1` API**（读工程 JSON、按 mutation 改片段）——B 端「按规格下单后改其中一镜」闭环；封闭工作台的对手结构性做不到。
