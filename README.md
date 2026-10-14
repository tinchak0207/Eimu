# Eimu

### 说出来，就成片。

**终结多轮 Agent 的上下文腐烂与时空坍缩。将一句自然语言编译为确定性的二维分镜画布与三维机位空间。**

<p align="center">
  <a href="https://eimu.dev/"><strong>⚡ 立即体验云端工作台 (eimu.dev)</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#核心机制把不可控的自由度从流程里拿掉"><strong>架构与隔离机制</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#跨模态泛化实证零特化刷榜腾讯-songbench"><strong>SongBench 评测实证</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#把-eimu-接进你的工具"><strong>接入 API / MCP</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://eimu.dev/docs"><strong>文档</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pipelines-13_产线_·_57_模型-0F172A?style=flat-square" alt="13 Pipelines 57 Models">
  <img src="https://img.shields.io/badge/Agent_Runtime-90_工具_·_1,816_测试-2563EB?style=flat-square" alt="90 Tools 1816 Tests">
  <img src="https://img.shields.io/badge/3D_Director-Blender_5.2_·_142_镜头语言-4F46E5?style=flat-square" alt="142 Camera Rules">
  <img src="https://img.shields.io/badge/SongBench-7.418_(Best--of--8)_·_极差砍半-DC2626?style=flat-square" alt="SongBench 7.418">
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/c5d7745e-5b45-462c-8b70-a30ae618de3b" width="100%"></video>
</p>

<p align="center">
  <img src="docs/preview/01-workstation.png" alt="Eimu 工作台：一句需求，结果同屏" width="100%">
</p>

- **折叠一维时间，锁定三维时空**：单点模型只能吐出「5 秒钟即用即弃的时空切片」，传统对话 Agent 则在多轮 Prefill 中迅速丢失角色与机位状态。Eimu 用子会话隔离杀死试错的「垃圾时间」，通过 `Descript DSL` 编译器将创作意图固化为二维有向无环画布（DAG）与三维 Blender 机位轨迹。
- **左聊右画（L1 自动挡 + L2 手动挡）**：左侧像发微信一样说人话，AI 总导演自动拆剧本、锁角色卡、排产线；右侧 21+ 节点工程画布随时展开，供专业创作者做手术刀级局部微调。
- **时空资产沉淀与复利**：作品完成，制作方法与实体卡片（角色、场景、LoRA、分镜产线）完整留存。让第二次创作顺着第一次自然发生，使第 N 部作品的边际成本趋近于零。

---

## 为什么传统 Agent 交不出完整长片？

市面上绝大多数 Agent 框架活在一条脆弱的**一维线性时间流**里：每一轮交互都必须把全量 System Prompt、工具索引和历史记录重新 Prefill 一遍（TTFT 首字延迟极长、Token 随轮次指数级爆炸）；角色外貌与分镜状态完全寄居在自然语言上下文（Context Engineering）中，跑过数轮后必然发生上下文腐烂与角色变脸。

在 Eimu 中，你说出一句**「生成秦始皇骑北极熊的电影」**或贴入一段《大明最后的十七年》小说正文，系统不是靠写更长的提示词去碰运气，而是启动一套**编译级多 Agent 产线**：

1. **空间上不穿帮**：人物骨相、服装、场景光影被封装为跨镜头强绑定的实体卡片（`@[角色:崇祯]`），配合三维导演台与 Blender 渲染节点预排的 142 条镜头语言，21 个生成节点一次编排到位。
2. **时间上不断裂**：从剧本拆解、四视图定妆、分镜关键帧、动态视频到原创配乐与字幕装配，全部在同一张创作图上闭环合成，直接交出 **64.48 秒**《大明最后的十七年》与 **36 秒**《始皇帝的北境征途》完整成片。

<p align="center">
  <img src="docs/preview/02-intent-to-canvas.png" alt="一句需求，整张创作图一次落成" width="100%">
</p>

---

## 核心机制：把不可控的自由度从流程里拿掉

> **“编排层不是「更会写提示词」，是把不可控的自由度从流程里拿掉。”**

Eimu Agentic Runtime 彻底摒弃了让单一全能模型“既当裁判又当运动员”的脆弱范式，通过五层硬核机制锁死长链路交付质量：

1. **双路预处理与 Jev 百毫秒级路由（Preprocessing & Dynamic Memory）**
   用户输入瞬间分流：一路由轻量小模型毫秒级响应接住前端交互；另一路经 `Jev 1` 决策模型单次前向传播拦截越狱与无关指令（零主模型算力浪费）。`Jev 2` 动态判定当前轮次是否需要调取历史设定，按需从记忆库（已沉淀 1,359+ 篇工程与创作记忆）精准抽取目标块，彻底告别全量 Prefill。
2. **野兽模式强注入与「不动手的导演」（Beast Mode Playbook Injection）**
   开启 `BEAST_MODE=ON` 时，向主 Agent 头部强注入《派遣手册（Orchestrator Dispatch Playbook）》与《Expert 注册表摘要》（手册缺失或空档即触发 `playbook_unavailable` 结构化报错，拒绝假 ON 裸奔）。主 Agent 被强制降级为**「本体不内联动手的导演」**，仅负责定位目标、撰写含验收标准的 Spec，并通过 `routeExpert` 与 `Jev 3` 路由至领域专家。
3. **物理级工具白名单隔离（Physical Tool Whitelisting）**
   领域专家子代理（如音乐导演、分镜导演）进入会话即加载专属配方库（`.opencode/skills/`），且仅挂载域内白名单工具。音乐导演不是“被提示词劝告别用画图和 Blender 工具”，而是**它的工具表里从物理机制上根本不存在域外工具**，从根源上消灭越界幻觉。
4. **子会话用后即删 + ≤500 Token 六栏契约闸门（Return Isolation & Contract Gate）**
   子代理内部复杂的多轮网页检索、六层导演确定性改写、多 take 采样日志与试听中间态全部封闭在子会话内，**用后即删，绝不回传污染主上下文**。子代理仅允许向主 Agent 回传 `≤500 token` 的交付摘要，以及强制包含 `qcSignature` 在内的六栏交付契约（缺一栏即判定未交付）。
5. **Descript DSL 编译锁画布 + Critic Gate 云端异步落盘**
   所有画布修改指令均编译为自研 `Descript DSL`，与前端 Canvas 双向无损同步。产出的媒体资产必须通过挂载 `Critic Skill` 的独立审片子代理门禁检验，失败自动触发局部重试隔离。全链路在云端持久化运行——**实测在前端 18 秒强行掐断 SSE 连接的极端断网场景下，服务端依然在 54 秒内独立跑完 `workflow_write` 并将完整画布状态安全落盘**。

---

## 跨模态泛化实证：零特化刷榜腾讯 SongBench

检验一套 Agent 架构含金量的最高标准，是看它在**未做底层模型特化微调**的情况下，能否将方法论直接泛化至全新模态。

我们将 Eimu 的影视编排底座直接延伸至音乐生成领域（内置 `genre → mood → instrumentation → vocal → structure → production` 六层确定性改写、8 条距离轴集合熵选优 `熵 = 相异度分布熵 × 平均距离`、以及 `Lyria / FlowMusic / YuE2` 三通道健康探针与失败降级）。仅输入一句自然语言提示词：**「我想要一首类似飞儿乐团那种喧闹史诗风格的乐曲」**，自动生成原创曲目《逆风不灭》。

在腾讯官方 **SongBench（arXiv:2604.25937）** 第三方模型七维评测尺（与 27 首格莱美、金曲奖获奖曲及经典录音同批同尺测试）下：

| 评测维度 / 对照组 | 裸模型基线 (YuE2 无 Harness) | Eimu 编排均值 (4首单次成品) | Eimu 《逆风不灭》 (Best-of-8) | 27 首参考金曲库内相对分位 |
| :--- | :---: | :---: | :---: | :---: |
| **七维综合均分** | 6.411 (表基线 6.50) | **6.975** | **7.418** | — |
| **旋律 (Melody)** | 6.45 | 7.38 | **7.60** | **96% 分位** |
| **编曲 (Arrangement)** | 6.75 | 7.43 | **7.87** | **93% 分位** |
| **音乐性 (Musicality)** | 5.70 | 6.16 | **6.41** | **93% 分位** |
| **器乐 (Instrumental)** | 6.85 | 7.24 | **7.51** | **89% 分位** |
| **结构 (Structure)** | 6.32 | 7.34 | **7.85** | **89% 分位** |
| **混音 (Mixing)** | 6.70 | 6.97 | **7.44** | **85% 分位** |
| **人声 (Vocal)** | 6.74 | 7.08 | **7.23** | **74% 分位** |

- **强力收敛抽卡方差（四臂消融对照）**：即便剥离前端导演层、仅给定相同的成熟 Brief 测试执行层，Eimu 编排依然将单通道跨题采样的极差从裸模型的 **0.829** 大幅压缩至 **0.436**（波动率直接砍半），并在最考验工程组织的「编曲」与「混音」维度分别带来 **+0.196** 与 **+0.098** 的净增益，把“玄学抽卡”彻底改造为工业级稳定交付。

> *科学口径声明：以上数据采用腾讯 SongBench 官方评测器与官方权重跑出（正控制曲四批独立运行均复现 6.9150），仅作为同一标尺下验证 Eimu Harness 相较裸模型抬升上限与收敛方差的工程实证，不作跨口径商业排名或“超越人类获奖作品”的主张。*

---

## 你可以拿它做什么

| 场景 | 你说的话 | 你得到的 |
| --- | --- | --- |
| **历史长片 / 小说漫剧** | 「把这章《大明最后的十七年》拆成短剧」 | 角色卡锁定崇祯骨相，21+ 节点一次编排，直出 **64.48 秒**含音轨成片 |
| **史诗奇观短片** | 「生成秦始皇骑北极熊的电影」 | 剧本、角色四视图、分镜、配乐全自动接力，直出 **36 秒**电影级成片 |
| **金曲级原创音乐** | 「来一首华语金曲奖风格的乐曲」 | 3 路子代理并发调研曲风歌词，六层改写 + 集合熵选优交付完整人声单曲 |
| **电商上市片** | 「给这款护肤品做一支 30 秒上市短片」 | 分镜、成片、配音、字幕，加各投放版位的裁切图 |
| **角色系列内容** | 「主角小明，接下来 10 个场景」 | 同一张脸贯穿所有镜头 |
| **海报与主视觉** | 「做一版，再来 8 组」 | 一批同风格变体，一张主图自动裁出各版位 |
| **三维机位预演** | 「先在三维导演台排好运动轨迹」 | Blender 渲染节点 + 142 条镜头语言，三维空间排好机位再驱动成片 |

## 为什么用起来不一样

**1. 助理全包，不是工具箱。** 你说目标，助理拆解、选模型、定参数、派任务、失败重试。需要精确控制时，专业工作台和画布随时就在手边。

**2. 同一个角色，从第一镜到最后一镜。** 角色、场景、风格、道具存成卡，提示词里写 `@[角色:小明]` 就带上他的样子；锁定后整张画布都认得他。

**3. 花钱之前，先看它打算怎么做。** 助理先摊出计划卡；便宜的草稿直接跑，其余先确认。每个按钮旁写明要花多少币，没出图不扣钱，失败、逾时自动退款。

**4. 每一份产出，先过两道关。** 独立的审核官只负责驳回、不替任何人说好话；成品还要过质检，没清完不许交付。

**5. 看到好作品，一步复刻。** 点「做同款」，提示词和风格直接进工作台；满意的一张，一键「再来 N 组」。

**6. 画布就是控制台。** 每个结果都是一个节点，就地改提示词、换模型、再生成；每个节点留着历史版本，删掉的也能找回；修图、抠图、抽帧，原图永远不动。

<p align="center">
  <img src="docs/preview/03-canvas.png" alt="无限画布" width="49%">
  <img src="docs/preview/07-history.png" alt="生成历史与复用" width="49%">
</p>

<p align="center">
  <img src="docs/preview/10-film-strip.jpg" alt="成片关键帧：全部镜头出自同一张创作图" width="100%">
</p>

## 三步上手

1. 打开 [eimu.dev](https://eimu.dev/)，用 GitHub、Google 或微信登录，首次登录送约 5 张图的额度。
2. 说出你要什么。不知道怎么说，回答几道选择题就行。
3. 看助理的计划，确认，成片出来。

没登录也能先试：免费提示词优化会把一句大白话整理成结构化提示词。

## 把 Eimu 接进你的工具

OpenAI 兼容接口，改一个 base URL 就接上；Claude Code、Cursor、Codex 复制一行指令即可调用，扣的是同一个账号的余额。

```bash
curl https://eimu.dev/openai/v1/images/generations \
  -H "Authorization: Bearer $EIMU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a premium skincare bottle on a soft ivory background"}'
```

- **同步出图**：等图出来才回 200，现成 OpenAI SDK 不用改轮询代码。
- **重复请求不重复扣费**：带 `Idempotency-Key`；给 `callback_url`，完成后主动回调。
- **Remote MCP**：`/api/mcp`，生图、改图、生影片、配音、放大、查额度，与站内同一本账。
- **批量与按规格下单**：`/v1/batches`、`/v1/skus`。
- 在设置页自助建 key，弹窗直接给可粘贴的 curl。

端点表见 [图像生成 API 文档](docs/biz-api.md)，调用流程见 [B 端 API 调用指南](docs/biz-api-guide.md)。密钥即计费主体，请勿写入前端代码或提交进版本库。

## 模型

- **图像**：GPT Image、Nano Banana、Seedream / Dreamina、FLUX、Adobe Firefly、Runway、PixAI 日系、Blender 渲染
- **影片**：Veo 3.1、Kling、Seedance 2.0 / 2.5、Runway、Firefly Video、MiniMax、Luma Ray、数字人、对口型
- **音乐与配乐**：Lyria、FlowMusic、YuE2（支持三通道健康探针与自动失败降级）
- **语音**：TTS（8 个实测可播音色）

完整清单（13 条产线、57 个模型）以 `src/lib/generation-model-catalog/catalog.ts` 为准。模型不是差异点；让它们通过同一套 `Descript DSL` 编译器、同一套计费账本与同一套失败恢复语义可靠交付，才是 Eimu 的主体。

## 诚实声明

- 三维导演台、Blender 渲染节点（142 条镜头语言）及 3D 白模作空间参考图已可用；全自动复杂机位直驱长片仍在持续迭代。
- 图像类实体卡已可用；音色卡的 `@` 引用仍在验证。
- 放大由模型重新绘制，细节会变，不是像素插值。

## 有意不做的事

- **不做时间轴剪辑**：助理替你剪。
- **不做 Photoshop**：复杂修改交给模型重绘。
- **不做技能市集**：你的配方只属于你。
- **不做「分享墙」式社交**：生成是生产，不是打卡。

> 使用在线服务需注册账号并充值额度；接入生成能力需配置相应供应商的 API 凭证，模型调用与存储可能产生费用。

---

## 架构全景与工程实现（90 个 Agent 工具 · 1,816 项自动化测试）

### 仓库结构

| 路径 | 内容 |
|------|------|
| `src/app/api/v1/` | B 端 OpenAI 兼容对外面（31 个公开路由） |
| `src/app/api/` | 站点接口：生成、画布、智能体、计费、管理后台、cron |
| `src/app/api/biz/` | B 端专用接口：实体卡查询与解析 |
| `src/lib/generation-core/` | 生成控制平面：租约调度、失败分类、计费账本、回调投递 |
| `src/lib/` | 模型目录、供应商注册表、计费、实体卡、画布与工作流实现 |
| `src/lib/agent-templates/` | 智能体产线模板池：领域模板、节点骨架与配方备注 |
| `src/lib/aid-enums/` | 分镜与镜头语言的枚举契约、词库与状态机定义 |
| `src/components/` | 前端组件（工作台、画布、智能体面板、实体胶囊、历史） |
| `src/app/` | 页面（首页、pricing、history、status、docs、admin） |
| `worker/` | 长驻生成 worker（与 Vercel cron 共用同一条工作循环） |
| `bridge/` | 上游桥接（Blender 桥、PixAI 桥等） |
| `tools/` | 控制面运维 CLI：迁移、播种、密钥签发、canary |
| `deploy/` | VPS 部署配置（nginx、gatus 探针、image-data-api） |
| `design-system/` | UI 设计系统权威（材料、色板、字级、间距） |
| `docs/` | 架构文档、接口文档、排障 runbook、技能文档、产品预览图 |


### 系统架构

```text
Eimu
├── 前端与对外面（Vercel）
│   ├── src/app/                  页面：首页工作台、pricing、history、status、docs、admin
│   ├── src/app/api/v1/           B 端 OpenAI 兼容接口
│   ├── src/app/api/              站点接口：生成、画布、智能体、计费、管理后台
│   └── src/app/api/cron/         定时任务入口（worker 循环）
├── 生成控制平面（src/lib/generation-core）
│   ├── 供应商租约调度            数据库租约 + SKIP LOCKED，多实例并发抢单不冲突
│   ├── 失败分类与隔离            重试 / 切换 / 隔离冷却的结构化决策
│   ├── 计费账本                  预扣 → 提交 → 退回，僵尸账自愈与双向对账
│   ├── 回调投递                  交易式 outbox，签名 payload 与带租约重试
│   └── canary 与 SLO             真实任务金丝雀、成功率与单位成本观测
├── 路由与供应（src/lib）
│   ├── channel-registry          渠道唯一事实来源，被队列、熔断与路由测试锁定
│   ├── supplier-channels         渠道注册表与 adapter 分派
│   └── generation-model-catalog  模型、分辨率、能力与定价目录
├── 创作域（src/lib）
│   ├── character-cards           五类实体卡、别名变体与参考图绑定
│   ├── canvas/                   画布图模型、DAG 分层布局、工作流 DSL 编译
│   ├── agent-templates/          产线模板池与节点骨架展开
│   ├── aid-enums/                分镜 21 栏位契约、镜头词库与流水线状态机
│   └── agent-memory-store        五类助理记忆的私有库与共享库
├── 长驻进程（VPS）
│   ├── worker/                   生成 worker（与 cron 同构）
│   ├── bridge/                   上游桥接（Blender、PixAI）
│   └── deploy/                   nginx、gatus 探针、数据服务
└── 存储
    ├── Postgres                  任务、租约、计费、回调、用户状态
    └── Blob                      双后端可切换，对调用方同一组签名
```

调用链：`Controller → Service → 控制平面 → Provider / 渠道 → 上游`。所有分布式正确性建立在数据库事务上，而不是 serverless 实例的内存。


### 技术栈

| 维度 | 技术 | 版本 |
|------|------|------|
| 框架 | Next.js（App Router） | 15.5 |
| UI | React | 19 |
| 语言 | TypeScript | 5.7 |
| 样式 | Tailwind CSS | 3.4 |
| 数据库 | Postgres（Supabase） | — |
| 对象存储 | Vercel Blob / 自建数据服务 | — |
| 前端托管 | Vercel | — |
| 控制面 | VPS + Docker Compose | — |
| 三维渲染 | Blender（headless，EGL） | 5.2.1 |
| 测试 | node:test | — |


### 本地开发

要求：Node.js 20+、npm，以及一个可用的 Postgres 实例。

```bash
npm install
npm run dev          # 开发服务器，默认 http://localhost:3000
npm test             # 单元与契约测试（node:test）
npm run build        # 生产构建
```

生成能力需要供应商凭证，控制面运维命令通过环境变量注入数据库与凭证后执行，各脚本的头部说明写明了所需变量。仓库内不存放任何凭证。

### 文档导航

| 文档 | 说明 |
|------|------|
| [站内文档中心](https://eimu.dev/docs) | 面向使用者的分篇教学：快速上手与一轮对话流程、助理设定与野兽模式、工作流与画布、历史素材复用、充值与计费、把助理带走（MCP 接入） |
| [架构全览](docs/ARCHITECTURE.md) | 导览式架构说明：各子系统职责与相互关系 |
| [图像生成 API 文档](docs/biz-api.md) | B 端接入：基址、认证、端点表与字段说明 |
| [B 端 API 调用指南](docs/biz-api-guide.md) | 调用示例与异步取结果的完整流程 |
| [基础设施排障 Runbook](docs/runbooks/infra-debugging.md) | 部署与线上问题的定位步骤 |
| [技能文档](docs/skills/README.md) | 领域配方：短剧生产、小说 IP 视觉包、电商与换装、LoRA 与风格研究 |
| [设计系统](design-system/MASTER.md) | UI 材料、色板、字级、间距与反模式（视觉权威） |
| [产品准则](PRODUCT.md) | 用户、定位、能力边界与产品决策原则 |
| [第三方声明](THIRD-PARTY-NOTICES.md) | 引入的第三方开源组件与许可 |


## 开源生态与商业托管声明

- **架构与评测实证共享**：我们鼓励开发者与研究者参考 Eimu 的编译级多 Agent 编排机制（`Descript DSL`、五段式物理白名单与契约回传隔离）及对抗评测基准。
- **免配置云端生产环境**：本地完整复现 13 条产线需配置 57 个上游模型供应商凭证、Postgres 租约库及 Headless Blender 渲染集群。如需零配置开箱即用、体验单次任务 ¥0.09 极低核心成本的工业级成片产线，请直接访问官方云端工作台 **[eimu.dev](https://eimu.dev/)** 或通过上方 OpenAI 兼容 API / MCP 接入。
- **版权与许可**：本仓库核心业务代码与专属产线配方版权归作者（陈天泽、徐振华）所有。仓库内包含的第三方开源组件及其许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，原有版权与许可声明予以保留。
