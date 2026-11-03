# Eimu 开发史（草稿）

> 状态：**草稿**，2026-11-04 由加固批次第 5 项合成，待暴君审阅。
> 真源顺序：**HEAD 代码 > git log > docs/ 内文档 > 项目记忆笔记（mem id）**。本档只做索引与归纳，与 HEAD 冲突时以 HEAD 为准。
> 出处规则：每条都给 commit（短 hash）/ 文件路径 / mem 笔记 id；查不到的写「未查证」。不写审美判断，不改口径。
> 本档不取代 README（对外口径真源）、AGENTS.md（工程纪律真源）、`docs/CAPABILITIES.md`（能力清单）、`docs/capability-ledger-2026-09-30/LEDGER.md`（08-14～09-30 逐 commit 对账）。

## 0. 仓库事实（2026-11-04 实测）

| 项 | 值 | 出处 |
|---|---|---|
| 本仓首个 commit | `4860f1edd` 2026-08-14（gatus 探测修正） | `git log --reverse` |
| 本仓 commit 数（至 `36c23d818`） | 843；按月 08:66 / 09:268 / 10:483 / 11:26 | `git log --format=%ad --date=format:%m \| sort \| uniq -c` |
| 08-14 之前的历史 | 不在本仓；起源于 `personal_site` 仓的 `image` 分支，首次对外部署 2026-06-05（Vercel 部署元数据取证） | mem `git-history-recovery-and-chain-backup-0912` |
| 旧版产品史 | `PRODUCT-HISTORY.md`（仓根，已 gitignore，不入库，仅作参考） | `.gitignore`；mem `2026-10-03-product-history-from-commit-titles` |

## 1. 阶段总览

阶段划分取自 mem `2026-10-03-eimu-moat-arc-and-history-deliverable`（2026-10-03 定稿），10-04 之后为本档按 commit 续写。

| 阶段 | 时间 | 一句话 | 出处 |
|---|---|---|---|
| A 生图聚合站 | 05-28～08-01 | 多供应商生图/影片聚合 SaaS（PRODUCT.md 仍是这一口径） | mem 同上；`PRODUCT.md` |
| B 接入第三方 agent 能力 | 08-02～08-13 | 在聚合站上接第三方生图节点与 agent | mem 同上；mem `2026-08-03-pixai-nodes-backend` |
| C 纠错期 | 08-14～09-05 | 源码恢复、控制面换血与手术、filter-repo 事故恢复 | 见 §2 |
| D 奠基 | 09-06～09-19 | 3D 导演台、Skill 配方库、MOE 专家、Jev 判定层 | 见 §2 |
| E 发展 | 09-20～09-26 | 多线并入、分叉收尸、实体化 | 见 §2 |
| F 超越 | 09-27～09-30 | Remote MCP、三平面契约、能力帐本 | 见 §2 |
| G 护城河未证明 | 10-01～10-03 | 路由单一真源、人机共笔 DSL；mem 结论「护城河未证明」 | mem `2026-10-03-eimu-moat-arc-and-history-deliverable` |
| H 纪律与画布期 | 10-04～10-18 | 不写测试、只做简体、画布 DSL 默认、Harness 移植 | 见 §2 |
| I 成片范式与定位转向 | 10-19～10-27 | 状态变化范式、3D 预演、README 转 Vibe Directing | 见 §2 |
| J 回滚与稳定 | 10-28～11-03 | 停用画布闸、工程图撤下、发版闸、MCP 导演面、长期可改、VPS 加固 | 见 §2 |

## 2. 里程碑时间线

日期为 commit 的作者日期（`--date=short`）。「为什么」只写有出处的；没有出处的写「未查证」。

### 2.1 2026 年 6 月～8 月 13 日（本仓之外）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 05-28 | `personal_site` 仓 image 分支替换为 image.tinchak0207.xyz 应用 | 未查证 | mem `2026-10-03-personal-site-access-and-product-history-sources` |
| 06-05 | 首次对外部署（Next.js＋new-api 网关架构） | — | mem `git-history-recovery-and-chain-backup-0912`（Vercel 部署元数据） |
| 06-09～08-01 | 工作站/企业 PRD、UX 重构、B 端 API、durable 生成控制面、专业工作流主线等计划文档 | 见各文档 | `docs/plans/2026-06-09-*`、`2026-06-10-ux-refactor.md`、`2026-06-11-apple-copy-revision.md`、`2026-07-26-biz-api-design.md`、`2026-07-29-gpt2image-pro-fusion-handoff.md`、`2026-08-01-professional-workflow-product-mainline.md`（均随 `4860f1edd` 入本仓） |
| 08-01 | agent-native 终极蓝图决策稿 | mem 记载：验收条件查无达成记录 | `docs/agent-native-ultimate-blueprint-zh.md`；mem `2026-10-03-eimu-moat-arc-and-history-deliverable` |
| 08-12 | 品牌「影像工作室」改名 **Emu** | 好念、Image 谐音 | mem `2026-08-12-rebrand-emu` |

### 2.2 纠错期（08-14～09-05）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 08-14 | 本仓起点 | 8 月迁出独立仓 | `4860f1edd`；mem `git-history-recovery-and-chain-backup-0912` |
| 08-17 | 从 Vercel 生产部署恢复源码；品牌 Emu 改回 **Eimu** | 本地源码落后于生产 | `ec748a518`、`425ac0352`、`6ec4f018f` |
| 08-18 | 专业模式拆解 PRD：LoRA 迁到 Agent Skill，队列/批量迁到画布原生 | 见 PRD | `docs/plans/2026-08-18-professional-mode-migration-prd.md`（随 `e19103a3e` 入库） |
| 08-21 | B 端 P0–P2：batch API、SKU 引擎、角色卡、TTS 路由、画布语义节点 | 未查证（commit 只写做了什么） | `e19103a3e` |
| 08-22 | liquid glass 设计系统迁移＋大文件重构计划 | 未查证 | `e74079359`；`docs/plans/2026-08-22-large-file-refactor.md` |
| 08-27 | 控制面换血到 new-api（当时计费仍留自研） | 未查证细节 | mem `control-plane-reblood-to-new-api` |
| 08-28 | 控制面手术：拆自研阻塞式计费闸，改 new-api 配额预检＋异步投影记账 | 磁盘满 → postgres 崩 → 自研计费执行器死且无自愈 → 视频任务卡死并误报超时 | mem `control-plane-newapi-surgery`、`control-plane-billing-paradigm`（本仓 commit 未查证） |
| 08-30 | 中控架构大革命（「opus大革命」）：10 个病灶审计＋三片修复 | 换模失效/熔断不恢复/0 额漏损等 | mem `control-plane-overhaul-0830`（本仓 commit 未查证，见下条） |
| 09-04 | filter-repo 事故：141 个未提交文件被抹掉，经会话库重放恢复 138 个后整批入库 | 改写历史前没 stash | `ffc6e9afc`；mem `filterrepo-hard-reset-destroys-worktree` |

### 2.3 奠基（09-06～09-19）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 09-06 | Blender 3D 导演工作站全链（headless 桥、SKILL 配方库、场景 3D 卡） | 未查证 | `c005c4bf0`；mem `2026-09-06-blender-director-skill-library` |
| 09-07 | blender-director 配方 12→105＋5 个新 skill 域 | commit 写为「对称差吃进」 | `070386972` |
| 09-11 | music-director 配方库入库 | — | `3b29f169d` |
| 09-12 | 历史链保全与血统改判：Eimu 起源是 `personal_site/image`，不是 04-18 那条链；拒绝补写里程碑 commit | 补写＝弄虚作假 | mem `git-history-recovery-and-chain-backup-0912` |
| 09-13 | MOE 专家军团（7 Expert）＋orchestrator 野兽帧 | — | `c2b797976`；野兽模式效果：mem `2026-10-03-beast-mode-is-prompt-injection-unmeasured`（未量测） |
| 09-15 | README 重写为产品说明书风格；作品/剧集/分镜三级状态机 | — | `539c9c92e`、`9d9f04831`；mem `2026-09-15-global-memory-deploy-livefire`（全局记忆同日上线） |
| 09-16 | **revert** TTS 配音音色库 | 未查证 | `0c418b535` |
| 09-18～19 | YuE2 替换评估、Jev（System One）PRD、MCode 迁移评估 | 见文档 | `docs/plans/2026-09-18-yue2-replacement-assessment.md`、`2026-09-19-jev-system-one-prd.md`、`2026-09-19-mcode-migration-assessment.md`（随 `75c25e247` 入库）；mem `jev-typesafe-systemone-integration-0919` |

### 2.4 发展（09-20～09-26）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 09-20 | 多线并入：Google OAuth、Jev 权威三刀（输入闸/spec 消毒/expert 路由）、音乐 yue2 换血、桌面薄壳 | Jev：判定类交给机器，不让 LLM 读规则自判（mem） | `75c25e247`；mem `jev-typesafe-systemone-integration-0919` |
| 09-20 | Jev 额度断路兜底（Laya）；打字路径骨架富化 | Jev 是单一上游，须 fail-open | `d25aed7d4`、`135528dd4`；mem `laya-jev-fallback-0920` |
| 09-21 | **revert** agent-chat 空态玻璃装饰 | 背景与首页不同配方即劣化（commit 写明暴君裁定） | `0b12f8514` |
| 09-24 | 全量收尸入库，终结分叉 | — | `a16d5690b`；mem `homepage-layout-three-knives-and-fork-closeout-0924` |
| 09-25 | 角色/道具/场景实体化；**revert**「创作流程」步骤条 | 未查证 | `a7e169f3d`、`891d0a6c4`；mem `2026-09-25-revert-stepbar-slice-and-vercel-content-oracle` |
| 09-26 | 定价方案卡 3D 化 | — | `853244be8` |

### 2.5 超越（09-27～09-30）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 09-27 | Remote MCP server（10 工具） | 竞品已有 Remote MCP，我方没有 | `017cbc0b8`；mem `2026-09-27-eimu-mcp-server-endpoint-0927` |
| 09-27 | 节点版本历史＋软删恢复；SEO 102 个门页合并为 17 个枢纽 | — | `64aff900e`、`dc16ff3db` |
| 09-27 起 | AGENTS 付费硬闸（¥31.29 事故后） | 未经确认的付费生成 | AGENTS.md 相关节（未逐字核对 commit，未查证） |
| 09-29 | 三平面契约落地（供给 adapter registry、成本闸、canvas 走 durable）；补 6 个「做了没入口」的功能 | — | `64b2bf91a`、`3a483ee6a`；`docs/architecture/planes.md` |
| 09-30 | 能力帐本：329 个非 merge commit 逐条对账，真功能 312 条 | 摸清做过什么 | `docs/capability-ledger-2026-09-30/LEDGER.md`（`4e74140fe`、`30da94e00` 入库） |

### 2.6 护城河未证明（10-01～10-03）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 10-01 | MODEL_ROUTES 单一真源＋new-api 收为一步 | — | `75996b819` |
| 10-02 | `.opencode` 手维护子集入库为单一真源；PRODUCT.md 记「可编辑工程」决策 | FotorCut 对称差（PRODUCT.md 写明） | `ab3ccdd53`；`PRODUCT.md` Decision Record |
| 10-02 | CAPABILITIES「梦想 vs 现实」实测 | — | `docs/CAPABILITIES.md` |
| 10-03 | 人机共笔：agent 读回 DSL、写回、指定版本回退；MCP 全线修复 | — | `85bf59b22`、`d61932399` |
| 10-03 | 产品史结论：「护城河未证明」 | 蓝图验收条件查无达成记录 | mem `2026-10-03-eimu-moat-arc-and-history-deliverable` |

### 2.7 纪律与画布期（10-04～10-18）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 10-04 | **不写测试**；唯一闸门＝换手 Hack＋真路径 | 测试通过不代表功能能跑 | `3c7974d1f`；mem `no-tests-doctrine-2026-10-04`；AGENTS.md「测试与 Hack 纪律」 |
| 10-04 | 只做简体：全仓 3534 文件转简体，拆繁体镜像 | 只面向简体用户 | `d22fa6eef`；mem `2026-10-04-simplified-only-product-and-full-script-conversion` |
| 10-08 | 恢复「研究先行」定位；**撤回**长程体验 Harness 改动 | commit 写为「撤销越权削减研究」 | `13cd6f9c9`、`a14f574f6` |
| 10-08 | 修复发布链清理误删全仓（3572 档事故）＋三重防护 | — | `d7b9eea4a` |
| 10-09 | 项目→聊天→画布三层；画布 DSL 变系统默认 | — | `300b10fca`、`3c3f5bd84` |
| 10-11 | 画布写穿三闸：收盘硬闸＋默认 DSL 骨架＋覆盖率发版门 | 生产几乎不用 workflow_write | `42a928cae`（后两闸 10-28 停用，见 §3） |
| 10-14 | README 克制版落地页＋SongBench | — | `f2cbcb50c` |
| 10-18 | 移植 Claude Code 2.1.302 编排/上下文/权限/交付面 | — | `a11ae6d50`；mem `2026-10-18-cc-2.1.302-harness-port-state`（当时：未部署、无生产 E2E） |
| 10-18 | OpenUI 改为成品展示层；移除历史测试闸门 | — | `82e443966`、`97ce44763` |

### 2.8 成片范式与定位转向（10-19～10-27）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 10-20 | 影片生成改为状态变化范式，接入 3D 预演与动态 QC | — | `74ebf1d12` |
| 10-22 | NL→预演 harness | — | `5ee57e5a2` |
| 10-22 | 底模实验性切换，**当天 revert**，另改一档 flash 模型 | 实验可撤回（mem） | `2ab13dd5c` → `feee265c9`；`f52dcde17`；mem `2026-10-22-agent-base-claude-sonnet-5-5-high` |
| 10-23 | README 转向 **Vibe Directing**，去 AI 腔重写 | — | `db0ce61bc`、`fcd0e6569`、`64423ee03` |
| 10-23～24 | main 分支 README 主口径改为「不用学提示词设计和分镜，现在你也是导演。」 | — | `origin/main`：`3bba66ac5`、`857ea6e43`、`c035f0a6f`（注意：`image` 分支 README 首行仍是「剪辑和分镜已经死了，现在人人都是导演。」） |

### 2.9 回滚与稳定（10-28～11-03）

| 日期 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|
| 10-28 | 长任务目标迷失根因取证 | 状态住在对话流、DSL 无执行器、收盘闸诱导形式写入、压缩摘要链断 | mem `2026-10-28-eimu-context-rot-root-cause` |
| 10-28 | **停用**画布收盘闸与覆盖率发版门；eimu-guard 压缩链修复 | 用户裁定（commit 写明） | `159c1c6e4`、`d370c53a3`；`deploy/vps/gateway-release.sh:684` 注释「保留但不调用」 |
| 10-28 | 工程图（ProjectGraph）26 切片落地 | 针对上条根因 | `2a571c55b`；mem `2026-10-28-project-graph-26-slices-delivered` |
| 10-29 | **revert** 工程会话首句 first_look 速出 | 未查证 | `7c5699316` |
| 10-30 | **整树还原**到 `859cd60f1`（10-28 13:07），工程图及之后改动撤下，后续择优拣回 | 见 mem | `4af310238`（345 文件，删 55607 行）；备份分支 `backup/image-pre-rollback-20261030`（原 HEAD `c49279da6`）；mem `rollback-1028-cherrypick-1030` |
| 10-30 | 发版祖先闸：必须显式 `--sha`，候选须包含线上全部 commit | 防发版覆盖线上 | `df3440d47` |
| 10-31 | AGENTS.md 顶部〇、硬闸（开工 mem find／交付真路径／汇报三样） | — | `67cf8f64e` |
| 11-01 | MCP P0：默认只露导演工具面；杜绝假完成 | 只露裸生成工具不算交付（mem） | `b11c0f3b4`、`8264de867`；mem `2026-11-01-mcp-p0-release` |
| 11-02～03 | 长期可改：人手改过的栏位不被 agent 盖回；封住删除/回退绕过 | — | `3dc273e25`、`32818426a`；mem `2026-11-03-long-term-editability-20261102` |
| 11-03 | 回执缺 cost_coins 不再抹估价；VPS 内存/根盘加固；发版 drain 两段化（H07） | 线上反复 503 与内存塌方 | `e1342c4b4`、`3b7d76eca`、`36c23d818`；mem `2026-11-03-gateway-cost-coins-null-receipt-merge`、`2026-11-03-vps-memory-collapse-disk-hardening-1103`、`2026-11-03-release-drain-two-phase-reentry-h07` |

## 3. 被推翻 / 回滚的方向（现状以 HEAD `36c23d818` 为准）

| 方向 | 推翻/回滚 | HEAD 现状 | 证据 |
|---|---|---|---|
| 品牌「影像工作室」→ Emu | 08-17 改回 Eimu | `src/app/manifest.ts` short_name=Eimu；`PRODUCT.md` 仍写 Emu（过时） | mem `2026-08-12-rebrand-emu`；`6ec4f018f` |
| 专业模式独立工作站 | 08-18 PRD 拆解（LoRA→Skill，队列/批量→画布） | `ProfessionalWorkstation.test.ts` 仍在，组件实现状态未逐一核对（未查证） | `docs/plans/2026-08-18-professional-mode-migration-prd.md` |
| 自研阻塞式计费 | 08-28 改 new-api 配额预检＋异步投影 | 以 mem 权威档为准 | mem `control-plane-billing-paradigm` |
| 04-18 本地 main 链当作 Eimu 历史 | 09-12 改判为 personal_site 个人网站链 | 起源＝`personal_site/image`，06-05 首部署 | mem `git-history-recovery-and-chain-backup-0912` |
| TTS 配音音色库 | 09-16 revert | 已移除 | `0c418b535` |
| agent-chat 空态玻璃装饰 | 09-21 revert | 恢复 lg-card | `0b12f8514` |
| 「创作流程」步骤条 | 09-25 revert | 保留双白名单与审查面板 | `891d0a6c4` |
| YuE2 产品化 | 评估结论：CC BY-NC，不可产品化 | `src/lib/music-yue2.ts` 仍在仓内，产品化边界见评估文档 | `docs/plans/2026-09-18-yue2-replacement-assessment.md` |
| MCode 迁移 | 评估结论：迁不了，冻结 | 冻结 | `docs/plans/2026-09-19-mcode-migration-assessment.md` |
| 测试作为闸门 | 10-04 不写测试；10-18 移除历史测试闸门 | 仓内仍存大量 `*.test.*` 历史档；规则以 AGENTS.md 为准 | `3c7974d1f`、`97ce44763` |
| 长程体验 Harness 改动 | 10-08 撤回 | 研究先行保留 | `a14f574f6`、`13cd6f9c9` |
| 画布收盘闸＋覆盖率发版门 | 10-28 停用 | 函数保留不调用（`gateway-release.sh:684`） | `159c1c6e4` |
| 实验底模切换 | 10-22 当天 revert | 以 VPS 运行时配置为准（本档未读线上，未查证） | `feee265c9` |
| first_look 首句速出 | 10-29 revert | 已撤 | `7c5699316` |
| 工程图（ProjectGraph）引擎 | 10-30 整树还原撤下 | `deploy-staging/gateway/project/` 只剩 `types.ts`/`constants.ts`/`contract-fixtures.json`（站点编译用）；`docs/architecture/project-graph.md`、`docs/specs/2026-10-29-eimu-7day-sprint.md` 已不在 HEAD | `4af310238`；mem `2026-11-01-mcp-p0-release`、`rollback-1028-cherrypick-1030` |
| README 主口径「说出来就成片」/「剪辑和分镜已死」 | 10-23 起 main 改为「不用学提示词设计和分镜，现在你也是导演。」 | `image` 分支 README 与 `docs/CAPABILITIES.md`（标题「说出来，就成片。」）未同步 | `origin/main` `3bba66ac5`；`docs/CAPABILITIES.md` |

## 4. 现状（HEAD `36c23d818`，2026-11-03）

- 对外口径真源：`origin/main` README（Vibe Directing）。`image` 分支 README、`PRODUCT.md`（「AI 图片/影片生成 SaaS（中转站）」、品牌 Emu）、`docs/CAPABILITIES.md`（最后改动 `d22fa6eef` 10-04）都落后于它。**本档不改，列入待拍板。**
- 工程纪律真源：AGENTS.md（〇、硬闸 `67cf8f64e`；不写测试；Author≠Hacker）。
- 能力与对账：`docs/CAPABILITIES.md`、`docs/capability-ledger-2026-09-30/LEDGER.md`（只覆盖到 09-30，10-01 之后无同等对账，未查证）。
- 发版：祖先闸（`df3440d47`）＋drain 两段化（`36c23d818`）。

## 5. 未查证清单

- 08-27 换血、08-28 手术、08-30 大革命在本仓的对应 commit（08-30→09-04 的改动经 `ffc6e9afc` 重放入库，无法拆出单独 commit）。
- 05-28～08-13 的 commit 级证据（在私有仓 `personal_site`，本轮未读）。
- 多数 UI/功能 commit 的「为什么」（commit 只写做了什么）。
- AGENTS 付费硬闸（09-27）的具体 commit。
- 10-01 之后的能力对账。
- 实验底模 revert 后线上实际使用的模型（需读 VPS 运行时配置）。
