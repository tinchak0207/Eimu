# AGENTS.md - Image Studio（Emu）工作规则

## 任务定性优先（先于一切 skill/纪律选择）

- 接到请求第一步定性：【能力建设】（动词：避免/绕过/加法/造/集成/强化/让 X>Y——主线是新增能力）还是【修复】（动词：修好/恢复/为什么坏了——保守纪律只对修复生效；冻结组件/禁重放/只准翻日志严禁套到能力建设）。
- 用户点名原材料时，第一动作是解剖原材料（读它的文档/源码结构/模式清单），不是翻生产日志；旧日志最多是背景参考。
- 跑偏硬指标：花在「维护现状」的呼叫数超过「新增能力」= 已跑偏，立即回主线。

## Time discipline（每次会话生效）

- 黄金时间：定改动 → 改码 → 部署 → 写 memory。会等的操作（部署/长验证/外部呼叫）永远放最后，不占待命的先做。
- 禁自我 UI 检查：美学归暴君，dev server/Playwright/截图验外观 = 垃圾时间，改完直接交。**例外（2026-09-26 暴君纠正）**：3D/WebGL/沉浸式渲染任务，或暴君明说「自主验证迭代」时，tsc 绿 ≠ 画面可用——必须截图自验、反覆迭代到验收判准全达成再交。
- **视觉改动部署前必做本地 E2E 截图自审（2026-10-03 暴君纠正「你连本地e2e都没有截图审核就推上去」，违反＝直接退回）**：任何使用者看得见的 UI 改动，推生产前必须 ①建暂存路由真渲染该元件（`src/app/zz-tmp-*/page.tsx`，假资料即可；**预览页常是复制版元件，先确认它 import 的是本尊**）②`npx --yes next dev -p 3999` ＋ Playwright chromium `deviceScaleFactor: 2` 截图 ③**状态截齐**（折叠态／展开态／最长字／hover）并逐条写下核对结论（能量 rect 就量，别凭目测）④不达标改到过（上限 4 轮）⑤收工删暂存路由、杀 dev server、`rm -rf .next/types` 再跑 tsc（暂存路由会留假错）。tsc 绿、测试全过**一律不是**视觉的 oracle；这条不推翻上一条「禁自我 UI 检查」——禁的是为审美反覆围观，交付前的正确性截图是义务。
- 禁自造辅助脚本/工具，除非暴君点名。
- 连续 3 次读取/探测没有产出修改 → 停下问暴君一句话；禁止猜尺寸/状态/意图。
- 研究 grep 优先，不通读 >200 行大档（除非任务需要整体理解）。
- **决策分界（2026-09-28 暴君纠正「不是产品决策不要问我」）**：ops／口径／工程实作细节**自行拍板做到底**（例：某帐号算不算内部、要不要把改动搬到控面、用哪个栏位当判准、帮谁补名单）；只有**产品与审美**决策才回报待裁。与自身本轮操作相关的疑点（含疑似自己造成的不稳定）先自行取证排除，不转给暴君当问题。
- **控面部署前置：先清磁碟再 build（2026-10-03 事故，违反＝当场事故）**：动 deploy 之前先 `df -h /`；可用 <15% 或 `docker system df` 的 Build Cache >3GB 时，**先清再 build**（`docker builder prune -af`；`rollback-*`／`git-*` 映像每个 repo 只留最新一个）。VPS 只有 2 核，磁碟近满时 build 会把 IO 打满（load 100+）：站点 API 超时、`npm ci` 卡 14 分钟后失败。实测清完 96%→73%（释放 13G）后一次过。
- **暴君点名的动手项＝下一个动作就是它，不排队**（2026-10-03 暴君纠正「左耳进右耳出」）：他在对话中间点名要清 cache／要动手的事，禁止先轮询部署、先试打不进去的 SSH、先做别的观察。等他催第二遍＝犯规。
- 禁旁白（「我先读…」「分析完成」），只输出决策、证据、结果。
- 已完成的闭环不重跑验证。
- Memory 纪律（2026-09-28 起＝memory pack 单一真源 `~/.claude/memory/`）：每完成可用工具/解决反覆问题/被纠正一次，当场 `mem add <slug> --type project|feedback|reference` → 填 `description` → `mem build`。**禁手改 `MEMORY.md`／`packs/*`／`catalog.tsv`**（生成物）；**禁整目录读 `notes/`**（915 篇），查询用 `mem find <关键字>`／`mem pack <id>`／`mem show <档名>`。旧路径（`~/.codex/memories/extensions/ad_hoc/notes/`、`~/.zcode/cli/memories/projects/image-app-*/memory/`）已封为同一真源的 symlink，勿当第二库。不写 = 智力归零。
- Harness 迭代闭环：暴君回报浪费时间/规则没生效 → 当场先改对应规则再做事，每个回馈 = 一次压缩。
- **一律以简体中文回覆**（只做大陆生意，繁体＝污染；不论暴君写什么书写体都不输出繁体字）；bash 语法（Arch Linux，2026-08-17 起；PowerShell/Windows 路径是错的）。

## 禁止造轮子（违反 = 立即返工）

- 「复用/复制/用现有的 X」= 逐行 cp 整份源码再改白名单栏位，不是参考重写。判定：diff 除白名单外逐行等价，做不到 = 没交货。
- subagent spec 必须写明轮子源档 + 白名单栏位（数据源/文案/接入点）；交互逻辑/物理参数/事件监听/生命周期 hooks 一行不许动。
- 教训（2026-08-25 模板旋转木马）：「精简复制」砍掉 wheel `{passive:false}`、SPRING_TRACK、drive() → 触控板没反应，三轮返工。每精简一处 = 埋一颗雷。
- 自造轮子前先问：生产上有没有同功能实现？有 → 复制它。

## 对称差／竞品任务（违反 = 立即返工）

- **先读对方原始码实作，再设计我方（2026-09-28 暴君纠正「为什么你修对称差老是不看别人源代码实现？以为自己很厉害吗」）**：固化顺序＝① 抓对方实作源码（CLI 只是说明层，必须追到 `src/`）→② 逐档读（含 tests 与 service 实作）→③ 我方形态**照它**（能更好才更好，并写明差异理由）→④ 才动我方代码。**禁「先设计再找依据」**；spec 没附对方实作档案清单与关键引文 = orchestrator 失职，不许派发。
- **轴线由暴君点名**：他不点名就不自行选全产品面；报告与实作都以他点名的那一格为口径（例：2026-09-28＝「影片提取」，即以 video 为输入、从它取得结构化资讯的功能面）。
- 对方是本地工具链时：其 `LICENSE` 条件先读完再谈任何「拿来用」（例：hypit 明文禁 multi-tenant/SaaS，我方形态正好在禁止区 ⇒ 只学形态不抄码）。

## Subagent 派遣（任何动手环节一律派发，**无「小改可内联」的例外**——见下「禁内联」）

- **模型铁律（2026-09-27 暴君纠正「太浪费 token」）**：subagent 一律跑 DeepSeek，禁用 Claude Agent 工具派 Opus/Sonnet 子代理。orchestrator 只写 spec，把 prompt 交给暴君或以 DeepSeek 通道执行。

- **禁内联（2026-09-29 暴君纠正「还是用subagent吧 内联你很快就忘记自己要干嘛了」）**：orchestrator **一律不内联动手**，包含「修 agent 交出的破口（补 import／补测试／小改一段逻辑）」。上游 API 打断、agent 回空回报、agent 失败——**都不是内联的授权**，正确动作是**带精确 spec 重派**（把已知的病征、档案:行号、期望差异当配方写进 spec）。旧版「被 API 打断 ≥2 次即可内联」的例外**作废**；只有暴君明说「内联做」才可内联。理由：orchestrator 一旦动手就从「知道全局的人」退化成「正在改这一行的工人」，主线目标会丢失。

- **并发槽铁律（2026-09-06 暴君纠正）**：完工一路立刻验收并补派一路，**常态保持 ≥3 路并发**；禁止等整批完工再派下一批——等最慢 subagent = 垃圾时间。收完工通知的当下动作顺序：验收 → 补派新片 → 再回报。
- orchestrator 只做：定位目标、写 spec、派发、收结果、验收。
- **上层决策/下层执行分离（2026-09-06 暴君纠正）**：orchestrator 禁止内联执行动手环节（smoke/验证跑批/写码/批量操作），全部派 subagent；orchestrator 上下文只装决策、spec、验收结论。验收＝读回报+抽查证据，不是自己重跑。
- spec 必含「必读记忆」节（2026-09-02 暴君纠正「恶性引导」）：① `~/.claude/memory/MEMORY.md`（Tier-0 路由）＋该域 `packs/<id>.md` 路径 ② 2-5 个与任务直接相关的 note 档名＋一句话为何相关 ③ 指令「记忆与现场证据冲突时以现场为准并回报冲突」。没有记忆节＝orchestrator 失职，等同 spec 没配方，禁止派发。**记忆只有一个库（`~/.claude/memory/notes/`），档名一律用 `mem find <关键字>` 取真档名写进 spec，并 `mem show <档名>` 验在；旧的「两库不定库会报幻影档」问题已随 symlink 封库消失（2026-09-28）。**
- spec 带配方不是目标：标准操作（new-api 渠道接入/env 变更/seed/rebuild/VPS 传档）的 copy-paste 命令直接贴进 spec（配方在 new-supplier-integration skill「new-api 渠道 5 分钟配方」节），不许现场考古；spec 没配方 = orchestrator 失职，不许派发。
- spec 开头写「预期 N 分钟」，超 2x orchestrator 主动 TaskStop 后**重派（改 spec）**，不许内联接管；主动巡检，不被动等。
- subagent 同一错误重试 2 次未过 → 停止并回报事实（写进 spec），禁止无限试错。
- 「X 为基底」合并必须先双向 diff（本地与 VPS 是并集，单向回灌冲掉另一边修复）；旧记忆的基底声明引用前先验是否仍成立。
- 每次派遣事故的坑位当回合沉淀进 skill 配方节（信息差归零）。

## Verification 铁律

- 不故意跑预期失败的测试；先实现再验证；验证意外失败先诊断修因再重跑。
- 暴君接管视觉验收时：Vercel READY + production alias 确认即停，视觉结果标 pending 用户验收。
- 不宣称未验证的成功；HTTP 200 ≠ 可用。
- **守门件不是 oracle（waoowaoo TG-02，2026-09-23 立）**：源码字串断言、档案存在、调用次数、当前实现输出**只算变更探针，不计入「已验证」**；每个 REQ／能力必须另配一条真实行为断言（真单／真输出／真帐本），否则视为未验。起因：对手曾因源码扫描脚本未接 CI＋命令缺失时静默通过而全面删除该类脚本；我方验收也曾大量依赖源码层守门件。
- **禁同源断言**：断言「函数返回目录里的数」与目录同源，无法反证单位语义错；值域／枚举 oracle 必须有独立于被测实现的来源（真上游／真帐单／真用户输入）。
- Adobe2API 是目标时：先追直接请求与上游响应再动鉴权/路由，不动 relay；不从 HTTP 408 推断 scope/token 问题（见 adobe2api-direct-debugging skill）。

## 测试与 Hack 纪律（2026-10-04 暴君立：**从此不写测试**，违反＝当场返工）

起因：本轮 Agent 本地化，代理人交出「9/9、5/5 全 PASS」的分层测试与契约断言，而功能在使用者眼前**根本不存在**（一问就露馅）；整个仓库过半时间花在写测试，代码品质没有明显提高。**结论（暴君原话）：以后连测试都不要写了，反正没用。**

- **不写测试。** 不再新增任何测试档（单元／整合／契约／快照／E2E 脚本／守门脚本）。不得以「没有测试」为由拒绝交付或缩小交付；不得为让 CI 变绿而写测试。既有测试视为历史资产：**不扩张、不维护、不修红灯**（红灯存活不再是事故），也**不得当成交付闸门或完成证据**；要整批删除须暴君点名，不自行大规模删。
- **测试不是 oracle，全绿什么都不证明。** 功能成不成立只看使用者路径上的真实行为——真介面、真对话、真终端、真输出、真帐单。任何「已验证／已完成」的结论不得引用测试结果（含既有测试），那些一律只算**变更探针**。编年史病症一「交付不等于可用」：133 条技能 116 条从未被呼叫、一天抓出六个做完没入口的功能——测试绿灯照样盖得住。
- **唯一的闸门＝Hack ＋ 真路径。** 交付前必须有人**以弄坏它为目标**：读实作找反例、构造对抗输入（空／超长／不存在／无权限／大小写／symlink／竞态／并发／断线／重放／非 UTF-8／路径逃逸／超时边界），产物是**具体反例与失败输出**；外加一条使用者路径的真实行为证据。ACM 式：没被 Hack 过的实作，不算测过。
- **作者 ≠ Hacker（硬性）。** 写功能的人（含 agent）**不得自验**；Hack 与真路径验收必须换手——另一个 agent、另一个模型、或暴君本人。同一 agent 自称通过 ＝ 没验收。
- **等价性证明例外。** 无损重构／切割仍须用**可证明的无损标准**（编年史成就一：行多重集 `7804=7804`、`missing 0 extra 0`）。这不是测试，是交付附带的证明，可留。
- 验收结论必须写明 **oracle 是哪条真路径、Hacker 是谁**；写不出来就标「未验」。

## Authentication 红线

- 禁 headless/自动化 Chromium 做 Adobe/Google 交互登入；遇「browser may not be secure」立即停，换用户真实 Chrome，认证完成后再恢复自动化。
- 不重放含动态 state/device context 的旧 IMS 授权 URL。
- 生产不依赖开著的 Chrome 标签；正常续期走 server-side auto_refresh token；保留最后一个可用的 renewable token 直到替代被接受。
- secret/凭证/token/OTP/私钥永不入 log、memory、commit。

## 付费上游呼叫硬闸（2026-09-27 ¥31.29 事故后立，违反＝事故）

- 起因：暴君已明令「只用优惠渠道」，但 spec 未写死单价与参数上限，代理持上游 key 出了一笔 **4k / 5s / ¥31.2857** 视频（request `20260927135019…`）。**规则必须在下令那一刻就存在，不是事故后补。**
- **上游付费 key 一律不下发 subagent**：spec 只准写「待暴君或 orchestrator 执行」。代理若已在 context 拿到 key，**只准打唯读端点**（`GET /models`、`/api/pricing`、`/api/log/*`），任何生成型 POST 一律禁止。
- **任何上游生成提交必须同时满足（缺一不许提交，逐字写进 spec）**：
  ① **暴君逐次给定的 model 白名单是唯一真源，白名单外一律拒收**（2026-09-27 视频白名单 7 条：`minimax-h3-933-2k-支持真人`、`minimax-h3-a`、`seedance-2.0-900-特惠`、`seedance-2.0-933-特惠`、`seedance-2.5-1010-特惠`、`seedance-2.5-900-特惠`、`grok-video-1.5`）；无白名单时才回退到通用上限（视频 ≤¥1.0/单、图片 ≤¥0.5/单）；
  ② 参数白名单：**`resolution ≤720p`、`seconds ≤5`**；禁 4K/2K、禁 `size` 带 4k/2k、禁任何「满血／原生真人／max／2k／pro／hdr／4k」高价变体；
  ③ **提交前先读站内定价页或价目 API 核该 model 单价并写进回报**；核不到价＝不许提交。
- **一次授权＝一次呼叫**：禁 `--retry`、禁用回圈试探价、禁对同一 model 连续探针；同一 model 2 次失败即停。
- **花暴君的钱一律先问（2026-09-27 暴君原话「错就错在你花我的钱压根不问」）**：任何付费呼叫（真单验证、探针、扫价、全模型回圈）事前逐次报备并取得同意，身分包含 orchestrator 自己；代理不得自行决定花钱，orchestrator 不得代为概括授权。报备须先讲明：平台／model／单价／总额。
- 事故处置标配：**立即停损**（TaskStop 该代理）→ 唯读取证定位（request id → 上游 log）→ 全量呼叫原文逐条对帐 → 才谈恢复。

## B 端 API key（2026-08-19 签发，仅此一把）

- 明文在 `.env.biz-key`（600，.gitignore 已覆盖）；调 `https://image.tinchak0207.xyz/v1/*`（Bearer sk-biz-…）。
- 丢失/泄露只能吊销重签——用户明确不再签发，务必保管。

## 按需附件（排障/设计/产品决策时才读，平时不载入）

**膨胀铁律：本档只加行为规则；排障笔记进 runbook，历史归 memory，产品准则进 PRODUCT.md。**

- 基础设施排障（VPS 链路/控制面命令/生图卡根因/agent 网关 CORS/session 404）：`docs/runbooks/infra-debugging.md`
- Adobe2API 定向排障：skill `adobe2api-direct-debugging`
- UI 设计权威：`design-system/MASTER.md` + `DESIGN.md` + `tailwind.config.ts`（lg-* 体系；正文 ≥13px）；任何 UI 任务先载 impeccable skill（~/.agents/skills/impeccable，它会载 PRODUCT.md/DESIGN.md）；Agent 交互锁定决策见记忆档 2026-08-08-agent-frontend-design-rules.md
- 产品决策准则全文 + 品牌/套餐/交互规则：PRODUCT.md（「Product Decision Doctrine」节）
- 中控记帐/计费/排帐唯一权威：记忆 control-plane-billing-paradigm
- 双真相边界（画布 world1 ↔ 产线执行图 world2；含节点 metadata 双白名单三处、CanvasProject 新栏位七处清单、VPS 活本 vs repo 镜像）：`docs/architecture/dual-truth-boundary.md`（W5，2026-09-29）

## repo 扫描地图（2026-08-30，降低模型扫描成本）

**活程式码（改动/读取只进这些）**：`src/app/api/`（Next.js 路由）、`src/lib/`（generation-core 生图/视频/TTS 管线、supplier-channels registry、billing 等）、`src/components/`、`src/app/`（页面）、`tools/`（seed/add-supplier-channel 等操作工具）、`bridge/`（pixai-bridge 等上游桥）、`deploy/gatus/`（探针配置）、`design-system/`（UI 权威）。

**可跳过目录（垃圾/快取/快照，禁止花时间扫描）**：
- `.tmp-home/`、`.tsdeps/`、`.xdg-cache/`、`.vercel.bak-link/`、`.dsh-*`、`.gateway-work/`、`.vercel-home/`、`.vercel-cli-cache/`、`.tmp-vercel-cache/`、`.dsh-mem/`、`.agents-fix/`、`.vercel-cli-data/`、`.pixai-refresh/` → 本地工具 HOME/快取，已 gitignore，勿读。
- `marketing-battle-pack/` → 社群行销素材包（prompts/posts/logs），非运行时代码。
- `eval-daming-film/`、`deploy-staging/opencode.json` → 历史评测/旧快照，**勿当真源**（live 真源在 VPS `/opt/agent-harness`）。
- `public/showcase/agent-templates/*.mp4/webp` → 展示用大档素材，非逻辑。

**记忆标记「作废/换血」≠ 真死**：08-28 中控手术后，`scheduler.ts` lease 门禁、`adobe-health.ts`、`supplier-channels.config.ts`、`tools/add-supplier-channel.ts`、`metaso-upstream.ts` 等**仍被 worker/adapter 引用，是活的**。砍任何档前先 `grep -rn "档名" src` 验证 import，勿凭记忆删除（记忆档 control-plane-reblood-to-new-api 已自标「旧记忆作废声明」，但那是指机制语义，不是档案可删）。
