# Eimu

### 说出来，就成片。

零学习门槛，自然语言，专业水准。从一句话生成，到一整批量产。

<p align="center">
  <a href="https://eimu.dev/"><strong>立即体验</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#三步上手"><strong>三步上手</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#把-eimu-接进你的工具"><strong>接入 API / MCP</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://eimu.dev/docs"><strong>文档</strong></a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/c5d7745e-5b45-462c-8b70-a30ae618de3b" width="100%"></video>
</p>

<p align="center">
  <img src="docs/preview/01-workstation.png" alt="Eimu 工作台：一句需求，结果同屏" width="100%">
</p>

**零门槛。** 用过聊天 AI，就会用 Eimu。
**专业水准。** 导演、编剧、分镜、摄影、剪辑、配乐的方法已经内建，助理在对的时候自动调用。
**到量产。** 满意的那一张，一键变成一整批。

---

## 一句话，一整条产线

你说：「帮我做一支新品上市短片。」

Eimu 的 AI 助理认出这是电商上市，选好产线，把剧本、选角、美术、分镜、出片、配音、字幕、装配一步步铺在画布上，然后开跑。你看得见每一步，随时插一句话就能改方向，不用等它跑完。

**剪辑也交给助理。** 我们不做时间轴剪辑软件，因为你要的是成片，不是一套要学的工具。画面、配音、字幕由助理自动装配并导出；想改，直接说。

<p align="center">
  <img src="docs/preview/02-intent-to-canvas.png" alt="一句需求，整张创作图一次落成" width="100%">
</p>

## 你可以拿它做什么

| 场景 | 你说的话 | 你得到的 |
| --- | --- | --- |
| **电商上市片** | 「给这款护肤品做一支 30 秒上市短片」 | 分镜、成片、配音、字幕，加各投放版位的裁切图 |
| **短剧 / 小说改编** | 「把这段小说做成 1 分钟短剧」 | 大纲、选角、美术、剧本、分镜到出片一路接力 |
| **角色系列内容** | 「主角小明，接下来 10 个场景」 | 同一张脸贯穿所有镜头 |
| **海报与主视觉** | 「做一版，再来 8 组」 | 一批同风格变体，一张主图自动裁出各版位 |
| **MV / 动画** | 「二次元风格 MV，配上这首歌的氛围」 | 画面、配乐、成片 |
| **3D 预演** | 「先在三维里拍一遍」 | Blender 白模当参考图，多版机位提案 |

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
- **语音**：TTS（8 个实测可播音色）

完整清单以 `src/lib/generation-model-catalog/catalog.ts` 为准。模型不是差异点；让它们通过同一套计费、同一套失败语义可靠交付，才是这个产品的主体。

## 诚实声明

- 3D 白模作为参考图出图已可用；由 3D 机位直接驱动成片仍在验证，暂不宣称。
- 图像类实体卡已可用；音色卡的 `@` 引用仍在验证。
- 放大由模型重新绘制，细节会变，不是像素插值。

## 有意不做的事

- **不做时间轴剪辑**：助理替你剪。
- **不做 Photoshop**：复杂修改交给模型重绘。
- **不做技能市集**：你的配方只属于你。
- **不做「分享墙」式社交**：生成是生产，不是打卡。

> 使用在线服务需注册账号并充值额度；接入生成能力需配置相应供应商的 API 凭证，模型调用与存储可能产生费用。

---

<details>
<summary><strong>开发者：仓库结构、架构、本地开发</strong></summary>

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


</details>

## 授权声明

本项目为私有项目（Proprietary），版权归作者所有，All Rights Reserved。仓库内包含的第三方开源组件及其许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，原有版权与许可声明予以保留。
