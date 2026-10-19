# Eimu

**说出来，就成片。**

小说章节拆成 64 秒古装短片。一句话拍出 36 秒北极熊骑兵电影。商品图扩成整套上市物料。一句提示词写出带人声的整首歌。
在左边用自然语言提要求，右边自动铺开 21 个节点的创作画布；角色从第一镜锁到最后一镜，哪一格不满意就地重跑，关掉网页后台照样把片子交出来。

<p align="center">
  <a href="https://eimu.dev/"><strong>打开工作台</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#eimu-适合你吗"><strong>适合谁</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#快速上手"><strong>快速上手</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#它具体做了什么"><strong>工作机制</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#把-eimu-接进你的工具"><strong>API / MCP</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://eimu.dev/docs"><strong>文档</strong></a>
</p>

<p align="center">
  <a href="https://eimu.dev/promo/eimu-promo.mp4" title="播放 Eimu 宣传片">
    <img src="public/promo/eimu-promo-poster.jpg" alt="Eimu 宣传片" width="100%">
  </a>
</p>

<p align="center"><strong><a href="https://eimu.dev/promo/eimu-promo.mp4">▶ 播放宣传片（49 秒）</a></strong></p>

<p align="center">
  <img src="docs/preview/01-workstation.png" alt="Eimu 工作台：一句需求，结果同屏" width="100%">
</p>

## 成片

<p align="center">
  <a href="https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/eimu/showcase/eimu-milestone-caption.mp4" title="播放 Eimu 完整成片">
    <img src="public/showcase/eimu-milestone-cover.jpg" alt="Eimu 完整成片（带字幕）" width="100%">
  </a>
</p>

<p align="center"><strong><a href="https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/eimu/showcase/eimu-milestone-caption.mp4">▶ 播放完整成片（2:41，带字幕）</a></strong></p>

2 分 41 秒的完整成片，字幕已烧录。点击封面或上方链接直接播放；自托管时文件在 `public/showcase/eimu-milestone-caption.mp4`（9.1 MB）。

## Eimu 适合你吗？

做一条完整片子时，剧本在一处写，人物定妆在另一处抽，视频、配音、配乐和字幕散在四五个工具里。改一句台词，后面的镜头全得重接；多聊几轮，上下文满了，主角的脸也变了。Eimu 把这整条产线收进一张画布和一个助理背后：

- **一句需求铺开整张画布**：助理识别你要做短剧、上市片还是单曲，选好产线和模型，把剧本、四视图角色、分镜、配乐、合成一步步连成节点开跑。
- **同一个角色贯穿到底**：人物、场景、画风存成实体卡，写一句 `@[角色:崇祯]`，每个镜头都自动带上他的参考图；复杂运镜先在三维导演台排好机位，再去出画面。
- **先看计划再花钱，坏了只重跑那一格**：便宜的草稿直接跑，正式生成前先摊出计划卡标明币数；单个节点抽坏了单独重跑，不用推翻整条产线，没出图不扣费。

如果你要持续产出漫剧、故事短片、商品投放物料或配乐，需要把第一部作品捏好的角色和产线留给第二部接着用，那它适合你。如果你只是偶尔抽一张单图或 5 秒视频图个乐子，直接去用单点模型就够了，你不需要 Eimu。

桌面与手机浏览器直接访问 [eimu.dev](https://eimu.dev/) 即可使用；任何支持自定义 Base URL 或 MCP 的开发工具（Claude Code、Cursor、Codex）也能直接接入。

## 开源与商业服务

Eimu 的架构**全量开源**：站点前端、后端 API、生成控制面、Agent 网关与工具、数据库迁移、Docker / Nginx / systemd 部署模板都在本仓库，没有“开源版”与“商业版”的代码分叉。

- **许可证**：[AGPL-3.0](LICENSE)。你可以自托管、修改、分发；通过网络向第三方提供服务时，需要按许可证公开对应源码。
- **官方托管服务**：[eimu.dev](https://eimu.dev/) 继续以商业服务方式运营，提供上游模型通道、额度、存储与运维。开源的是架构与代码，不包含官方服务的容量、账号与供应商合约。
- **自托管**：见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。你需要自备上游账号、Postgres 与对象存储。
- **架构说明**：见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- **安全问题**：见 [SECURITY.md](SECURITY.md)。

## 快速上手

1 · **登录**。打开 [eimu.dev](https://eimu.dev/)，用微信或 GitHub 登录，新账号自带约 5 张图的免费额度（不登录也能用免费提示词结构化工具）。

2 · **直接说你要什么**。贴入一段小说正文、丢一张商品图，或者只输入一句「生成秦始皇骑北极熊的电影」。不知道怎么描述时，点几道选择题就行。

3 · **看计划，改节点，拿成片**。助理在右侧画布铺开节点并标明消耗；跑完后自动配音、加字幕、合成导出。哪一镜不顺眼，点开那个节点改词或换模型，其余镜头不动。

或者直接在终端里把 Eimu 当成生成底座调用：

```bash
# 兼容 OpenAI SDK，等图生成完才回 200，不用自己写轮询
# 带 Idempotency-Key：重复请求不重复扣费
curl https://eimu.dev/openai/v1/images/generations \
  -H "Authorization: Bearer $EIMU_API_KEY" \
  -H "Idempotency-Key: job-001" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"@[角色:崇祯] 站在煤山风雪中"}'

# 把生图、生影片、配乐、放大和查额度直接挂进 Claude Code / Cursor
# Endpoint: https://eimu.dev/api/mcp (Bearer $EIMU_API_KEY)
```

## 已接入的模型与产线

GPT Image · Nano Banana · Seedream / Dreamina · FLUX · Adobe Firefly · Runway · PixAI 日系 · Blender 5.2 渲染 · Veo 3.1 · Kling · Seedance 2.0 / 2.5 · Firefly Video · MiniMax · Luma Ray · 数字人 · 对口型 · Lyria · FlowMusic · YuE2 · 多音色 TTS

共 13 条产线、57 个模型、90 个 Agent 工具，完整清单与定价在 `src/lib/generation-model-catalog/catalog.ts`。模型本身不是差异点；让它们走同一本账、同一套画布状态和同一套失败恢复逻辑可靠地交出作品，才是 Eimu 做的事。

## 它怎么串起来

一句输入进来，轻量小模型先接住响应，`Jev` 决策模型顺手拦掉无关输入、挑出当前轮次用得上的那几块记忆（没点名的历史不进上下文）。主 Agent 把意图写成 `Descript DSL`，过一遍编译器变成确定的画布工作流（DAG），再分发给只带域内白名单工具的专家子代理执行，最后过一道独立审片门禁（Critic Gate）落盘。

<p align="center">
  <img src="docs/preview/02-intent-to-canvas.png" alt="一句需求，整张创作图一次落成" width="100%">
</p>

## 它具体做了什么

### 左聊右画，双向同步
在手机或简单任务下，你只需要跟左侧的 AI 助理说话，它在后台自动帮你连线建节点；到了桌面端复杂项目，右侧 21+ 节点的完整画布随时展开。助理改画布走的是 `Descript DSL` 编译，你手动拖拽或修改节点也会实时写回同一份工作流状态，两边不会各改各的。每个节点都留着历史版本，删掉的也能找回；修图、抠图、抽帧时，原图永远不动。

<p align="center">
  <img src="docs/preview/03-canvas.png" alt="无限画布" width="49%">
  <img src="docs/preview/07-history.png" alt="生成历史与复用" width="49%">
</p>

### 角色卡与三维导演台
单点模型跨镜头必穿帮。Eimu 把角色四视图、场景、风格和道具存成实体卡，锁定后整张画布的节点都认得同一张脸（《大明最后的十七年》64.48 秒成片的所有镜头与音轨均出自同一张画布）。遇到复杂的机位调度，内置的三维导演台与 Blender 渲染节点提供 142 条镜头语言，先在三维空间里把人物站位和运镜轨迹排好，再交给模型渲染画面。

<p align="center">
  <img src="docs/preview/10-film-strip.jpg" alt="成片关键帧：全部镜头出自同一张创作图" width="100%">
</p>

### 不动手的导演与白名单子代理
编排层不是「更会写提示词」，而是把不可控的自由度从流程里拿掉。开启野兽模式（`BEAST_MODE=ON`）时，系统往主 Agent 头部注入派遣手册与专家注册表（手册不可读直接报 `playbook_unavailable`，拒绝假开裸奔）：

- **主 Agent 只当导演**：本体不内联动手，只负责写验收标准、必读配方与交付契约，再通过 `routeExpert` 派单。
- **工具表物理隔离**：音乐导演不是「被提示词劝告别用画图和 Blender 工具」，而是它的工具白名单里本来就没有这些工具，从机制上做不了越界的事。
- **子会话用完即删**：子代理内部的多轮网页搜索、六层确定性改写、多 take 采样和试听日志全部留在子会话里，用后即删，不污染主上下文；只准向主 Agent 回传 `≤500 token` 的摘要和带 `qcSignature` 的六栏交付契约，缺一栏不算交付。

<p align="center">
  <img src="docs/preview/ZH-8-mechanism.png" alt="音乐 Agent 的设计机制" width="100%">
</p>

### 音乐生成与 SongBench 实测
在不针对音乐做底层模型训练的情况下，直接用上面这套「导演派单 + 六层改写 + 8 条距离轴集合熵选优 + Lyria / FlowMusic / YuE2 三通道探针降级」机制跑音乐。只输入一句：「我想要一首类似飞儿乐团那种喧闹史诗风格的乐曲」，生成《逆风不灭》。

用腾讯 SongBench（arXiv:2604.25937）官方评测器与权重，和 27 首格莱美、金曲奖获奖曲及经典录音放在同一批次重跑：

| 对比项 | 七维均分 | 旋律 | 编曲 | 音乐性 | 器乐 | 混音 | 结构 | 说明 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| **裸 YuE2（无 harness）** | 6.411 | 6.45 | 6.75 | 5.70 | 6.85 | 6.70 | 6.32 | 直接调底层模型的基线（表基线 6.50） |
| **27 首得奖曲均值** | 6.400 | 6.51 | 6.69 | 5.47 | 6.60 | 6.37 | 6.48 | 同批评测的参考曲目均值 |
| **Eimu 编排（4 首单次均值）** | **6.975** | 7.38 | 7.43 | 6.16 | 7.24 | 6.97 | 7.34 | 4 首实际交付成品，各取单次 |
| **Eimu《逆风不灭》（best-of-8）** | **7.418** | **7.60** | **7.87** | **6.41** | **7.51** | **7.44** | **7.85** | 旋律处参考集 96% 分位，编曲/音乐性 93% 分位 |

在给定相同成熟 Brief 的四臂对照中（只测执行层），Eimu 编排把单通道跨 3 题的采样极差从裸模型的 `0.829` 压到了 `0.436`（编曲维 `+0.196`，混音维 `+0.098`）。以上分数只是同一把尺上的相对位置，用来检验编排层对下限和方差的收敛作用，不等于「音乐价值更高」，也不能据此推断超过获奖作品。

<p align="center">
  <img src="docs/preview/POSTER-grammy-leaderboard.png" alt="选定录音的评分分布，非排行榜" width="100%">
</p>

### 成本、账本与断网续跑

| 机制 | 实际行为 |
| --- | --- |
| **单位成本** | 因为省掉了每轮全量 Prefill 和全链路盲目重跑，一次中等生图任务的推理（约 600k token，¥0.06）加三次生成（¥0.03）核心成本仅 ¥0.09，售价 ¥0.45 |
| **计费账本** | 预扣 → 提交 → 失败退回，带僵尸账自愈与双向对账；支持按量计费与月费订阅 |
| **断网落盘** | 任务在云端异步跑完。对抗评测中在第 18 秒直接强杀客户端 SSE 连接，服务端仍在第 54 秒完成 `workflow_write` 并将完整画布落盘 |
| **失败如实报告** | 1,816 项自动化测试与抽签式故障注入验证：工具不存在不编造、伪造 `ok:true` 回执不采信、通道不可用自动切备用路或如实告知 |

## 常用场景

| 场景 | 你说的话 | 交付物 |
| --- | --- | --- |
| **短剧 / 小说改编** | 「把这段小说做成 1 分钟短剧」 | 角色卡锁定外观，大纲、选角、分镜到 64 秒含音轨成片一路接力 |
| **电商上市片** | 「给这款护肤品做一支 30 秒上市短片」 | 分镜、成片、配音、字幕，加各投放版位的裁切图 |
| **角色系列内容** | 「主角小明，接下来 10 个场景」 | 同一张脸贯穿所有镜头 |
| **原创音乐与配乐** | 「来一首华语金曲奖风格的乐曲」 | 三路子代理并发查曲风歌词，六层改写与集合熵选优交付成品音频 |
| **海报与主视觉** | 「做一版，再来 8 组」 | 一批同风格变体，一张主图自动裁出各版位 |
| **三维机位预演** | 「先在三维里拍一遍」 | Blender 白模当参考图，142 条镜头语言排好多版机位提案 |

## 把 Eimu 接进你的工具

在设置页自助建 Key，弹窗直接给可粘贴的命令，扣的是同一个账号的余额：

- **OpenAI 兼容接口**：`/openai/v1/images/generations` 等 31 个公开路由，改一个 Base URL 就能接进现成代码。
- **Remote MCP**：`/api/mcp`，把生图、改图、生影片、配音、放大、查额度直接挂进 Claude Code、Cursor 或 Codex。
- **批量与回调**：支持 `/v1/batches`、`/v1/skus`；传入 `callback_url`，任务跑完后通过交易式 outbox 签名回调。

端点表见 [图像生成 API 文档](docs/biz-api.md)，调用流程见 [B 端 API 调用指南](docs/biz-api-guide.md)。密钥即计费主体，请勿写入前端代码或提交进版本库。

## 诚实边界与有意不做的事

- 3D 白模作为参考图出图已可用；由 3D 机位直接驱动成片仍在验证，暂不宣称。
- 图像类实体卡已可用；音色卡的 `@` 引用仍在验证。
- 放大由模型重新绘制，细节会变，不是像素插值。
- **不做时间轴剪辑软件**（助理替你装配），**不做 Photoshop**（复杂修改交给重绘），**不做技能市集**（你的配方只属于你），**不做打卡式分享墙**（生成是生产，不是社交）。

---

## 仓库结构与系统架构

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

---

## 📈 Star History & 授权声明

<p align="center">
  <a href="https://star-history.com/#zyese/eimu&Date">
    <img src="https://api.star-history.com/svg?repos=zyese/eimu&type=Date" alt="Star History Chart" width="80%">
  </a>
</p>

- **开源共享与商业托管**：我们公开 Eimu 的系统架构规范、五段式 Agent 隔离机制与评测基准实证，供多模态 Agent 社区研究参考；生产环境完整算力托管请直接访问 **[eimu.dev](https://eimu.dev/)**。
- **版权声明**：本项目核心业务代码与专属产线配方为私有产权（Proprietary），版权归作者（陈天泽、徐振华）所有，All Rights Reserved。仓库内包含的第三方开源组件及其许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
