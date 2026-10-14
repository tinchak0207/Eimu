<div align="center">

# 🎬 Eimu

### **说出来，就成片。**
**The Spatiotemporal Multi-Agent Compiler for Film, 3D & Music Production**

*终结长链路 Agent 的上下文腐烂与 5 秒时空坍缩 —— 将一句自然语言编译为确定性的二维分镜画布与三维机位空间。*

<p align="center">
  <a href="https://eimu.dev/"><img src="https://img.shields.io/badge/⚡_Live_Cloud-eimu.dev-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo"></a>
  <a href="#-跨模态泛化实证零特化刷榜腾讯-songbench"><img src="https://img.shields.io/badge/SongBench_Eval-7.418_(Best--of--8)-DC2626?style=for-the-badge" alt="SongBench 7.418"></a>
  <a href="#-编译级-agent-runtime把不可控的自由度拿掉"><img src="https://img.shields.io/badge/Runtime-90_Tools_·_1,816_Tests-2563EB?style=for-the-badge" alt="90 Tools 1816 Tests"></a>
  <a href="#-把-eimu-接进-cursor--claude-code--openai-sdk"><img src="https://img.shields.io/badge/Protocol-OpenAI_API_&_Remote_MCP-059669?style=for-the-badge" alt="OpenAI & MCP"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pipelines-13_工业产线_·_57_生成模型-1E293B?style=flat-square" alt="13 Pipelines 57 Models">
  <img src="https://img.shields.io/badge/3D_Director-Blender_5.2_Headless_·_142_镜头语言-4F46E5?style=flat-square" alt="Blender 5.2">
  <img src="https://img.shields.io/badge/Resilience-18s_SSE_Kill_→_54s_Async_Commit-D97706?style=flat-square" alt="Chaos Tested">
  <img src="https://img.shields.io/badge/Unit_Economics-¥0.09_Core_Cost_·_80%25_Margin-10B981?style=flat-square" alt="Unit Economics">
</p>

<p align="center">
  <a href="https://eimu.dev/"><strong>🚀 在线工作台 (送免费额度)</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#-为什么传统-agent-交不出完整作品"><strong>范式代差</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#-编译级-agent-runtime把不可控的自由度拿掉"><strong>五段式隔离架构</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#-跨模态泛化实证零特化刷榜腾讯-songbench"><strong>SongBench 评测</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#-把-eimu-接进-cursor--claude-code--openai-sdk"><strong>接入 API / MCP</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://eimu.dev/docs"><strong>完整文档</strong></a>
</p>

</div>

<p align="center">
  <video src="https://github.com/user-attachments/assets/c5d7745e-5b45-462c-8b70-a30ae618de3b" width="100%"></video>
  <br>
  <sub>▲ 真实会话实录：仅输入一句「生成秦始皇骑北极熊的电影」，Eimu 零反问直接编排 21 个生成节点，串联剧本、四视图角色卡、Blender 三维机位与原创配乐，直出 36 秒与 64.48 秒完整成片。</sub>
</p>

<p align="center">
  <img src="docs/preview/01-workstation.png" alt="Eimu 工作台：左聊右画，一句需求结果同屏" width="100%">
</p>

---

## ⚡ 为什么传统 Agent 交不出完整作品？

单点视频模型只能吐出**「5 秒钟即用即弃的时空切片」**；而市面上 99% 的网红 Agent 框架活在一条脆弱的**一维线性时间流**里——每轮对话重复 Prefill 全量索引，角色与机位状态寄居在自然语言上下文里，跑过数轮必然发生**上下文腐烂与角色变脸**。

**Eimu 是一台将「一维时间」折叠并锚定为「二维画布与三维空间」的创作状态机：**

| 核心维度 | 单点生成工具 (Sora / 海螺等) | 手搓节点工具 (ComfyUI 等) | 传统对话 Agent (ReAct / OpenClaw 类) | **🎬 Eimu (Spatiotemporal Compiler)** |
| :--- | :--- | :--- | :--- | :--- |
| **时空连续性** | ❌ **5 秒即坍缩**<br>跨镜头角色变脸、光影重置 | ⚠️ **靠人肉硬连**<br>改一个设定需手动重连整张网 | ❌ **长链路必丢状态**<br>靠 Context 硬记，多轮后记忆腐烂 | ✅ **全域时空守恒**<br>`@[角色:崇祯]` 实体卡 + 3D 导演台锁死 64s 长片 |
| **上下文与延迟** | — | — | ❌ **指数级膨胀**<br>每轮全量 Prefill，TTFT 极慢且烧钱 | ✅ **百毫秒路由 + 用后即删**<br>`Jev` 按需挂载记忆，子会话仅回传 `≤500 Token` 契约 |
| **控制粒度** | ❌ **纯黑盒抽卡**<br>局部穿帮只能整条重抽 | ⚠️ **纯手动挡**<br>极客玩具，普通创作者零可用性 | ❌ **纯嘴皮子幻觉**<br>工具越界乱调，不可控自由度极高 | ✅ **L1 自动挡 + L2 手动挡**<br>左聊自然语言，右改 21+ 节点 `Descript DSL` 画布 |
| **故障与断网韧性** | ⚠️ 刷新页面易丢任务 | ❌ 本地算力崩盘即归零 | ❌ 前端断连 SSE 即中断报错 | ✅ **云端持久化 + Critic 门禁**<br>实测 18s 强杀断网，后台 54s 独立跑完并完整落盘 |
| **时间复利** | ❌ 关掉网页一切归零 | ⚠️ 仅留存静态 JSON 连线 | ❌ 跑一万次任务仍是失忆新手 | ✅ **跨作品资产沉淀**<br>角色卡、LoRA 与成熟产线一键复用于第 N 部作品 |

<p align="center">
  <img src="docs/preview/02-intent-to-canvas.png" alt="一句需求，整张创作图一次落成" width="100%">
</p>

---

## 🧠 编译级 Agent Runtime：把不可控的自由度拿掉

> **“编排层不是「更会写提示词」，是把不可控的自由度从流程里拿掉。”**

Eimu 拒绝让单一全能模型“既当裁判又当运动员”，全栈自研了包含 **Jev 决策路由**、**野兽模式强约束注入**、**物理级白名单子代理** 与 **Descript DSL 编译器** 的运行时核心：

```text
                                  ┌─► [Small Model] ──► Quick Response (毫秒级前端接话)
[User Input] ──► (Preprocessing) ─┤
                                  └─► [Jev 1: 安全/相关性判定] ──(拦截越狱/废话)──► Reject
                                                │ (Pass)
                                                ▼
                 (Memory System)  ◄── [Jev 2: 按需记忆探针] ──► 仅抽取命中块 [Memory A/B/C/D] (1,359+ 篇沉淀)
                                                │
                                                ▼
                 (Runtime Core)       [Beast Mode Gate: 强注入 Dispatch Playbook + Expert 注册表]
                                                │
                                                ▼
                                      [Orchestrator (降级为「不动手的导演」: 仅写 Spec 与验收契约)]
                                                │
                      ┌─────────────────────────┴─────────────────────────┐
                      ▼ (Dispatch Subagent via Jev 3)                     ▼ (Edit Canvas)
         [领域专家子代理: Music / Storyboard / 3D]              [Write Descript DSL] ──► [Compiler]
         ├─ 物理级工具白名单 (音乐专家工具表内无画图/Blender)                              │
         ├─ 内部六层确定性改写 + 8 轴集合熵选优 + 三通道降级                               ▼
         └─ 💥 子会话用后即删！仅回传 ≤500 Token 摘要 + 六栏契约 ──► [Deterministic DAG Workflow ⇄ Canvas UI]
                                                                          │
                                                                          ▼
                 (Critic Gate)        [Asset Output] ──► [Critic Subagent (qcSignature 质检)]
                                                         ├─ Pass ──► 落盘交付资源库
                                                         └─ Fail ──► 局部节点隔离重试 (不重跑全链路)
```

<p align="center">
  <img src="docs/preview/ZH-8-mechanism.png" alt="图 8：Eimu 五段式 Agent 隔离与契约设计机制" width="100%">
</p>

### 五大工程铁律
1. **杀死「垃圾时间」（Sub-session Destruction）**：子代理内部上百次网页检索、多 take 采样与通道报错日志全部封闭在子会话内，**用后即删，绝不污染主上下文**；主会话仅接收 `≤500 token` 摘要与带 `qcSignature` 的六栏交付契约（缺一栏即拒收）。
2. **物理级工具白名单（Physical Whitelisting）**：领域专家不是“被 Prompt 劝告别乱调工具”，而是从注册表机制上直接剔除域外工具，彻底根绝越界幻觉。
3. **三维导演台先排机位（3D Pre-vis to Render）**：内置 Headless Blender 5.2 渲染节点与 **142 条专业镜头语言**，复杂运镜先在三维空间排好几何轨迹，再精准驱动画面生成。
4. **花钱前先摊出计划卡（Cost Guardrails）**：预扣 → 提交 → 失败自动退回，僵尸账自愈；正因为砍掉了每轮无脑全量 Prefill，单次中等任务推理（~600k token，¥0.06）+ 生图（¥0.03）**核心成本仅 ¥0.09**，在 ¥0.45 售价下实现 **80% 核心毛利率**。
5. **混沌工程实证（Chaos-Tested Harness）**：历经 **1,816 项自动化测试** 与凌晨抽签式红蓝对抗评测——不存在工具绝不编造、伪造 `ok:true` 回执当场拒斥、客户端 18 秒断网强杀 SSE 后服务端 54 秒独立落盘。

<p align="center">
  <img src="docs/preview/10-film-strip.jpg" alt="《大明最后的十七年》64.48秒成片关键帧：全部镜头出自同一张创作图" width="100%">
</p>

---

## 🏆 跨模态泛化实证：零特化刷榜腾讯 SongBench

一套真正强大的 Agent 编排架构，应当在**不改底层框架、不做垂类模型微调**的前提下，直接泛化至全新模态。

我们将 Eimu 架构直接用于音乐生成（子代理内建 `genre → mood → instrumentation → vocal → structure → production` 六层改写、8 条距离轴集合熵选优 `熵 = 相异度分布熵 × 平均距离`、以及 `Lyria / FlowMusic / YuE2` 三通道健康探针路由）。仅输入一句提示词：**「我想要一首类似飞儿乐团那种喧闹史诗风格的乐曲」**，自动交付《逆风不灭》。

<p align="center">
  <img src="docs/preview/POSTER-grammy-leaderboard.png" alt="腾讯 SongBench 七维评测分布：Eimu 7.418" width="100%">
</p>

在腾讯官方 **SongBench（arXiv:2604.25937）** 第三方模型七维评测尺（与 27 首格莱美、金曲奖获奖曲同批同尺测试）下：

| 评测维度 / 对照组 | 裸模型基线 (`YuE2` 无 Harness) | Eimu 编排均值 (4首单次交付) | **Eimu 《逆风不灭》 (Best-of-8)** | 27 首参考金曲库内相对分位 |
| :--- | :---: | :---: | :---: | :---: |
| **📊 七维综合均分** | 6.411 (表基线 6.50) | **6.975** | **7.418** | — |
| **🎵 旋律 (Melody)** | 6.45 | 7.38 | **7.60** | **🔥 96% 分位** |
| **🎻 编曲 (Arrangement)** | 6.75 | 7.43 | **7.87** | **🔥 93% 分位** |
| **✨ 音乐性 (Musicality)** | 5.70 | 6.16 | **6.41** | **🔥 93% 分位** |
| **🎸 器乐 (Instrumental)** | 6.85 | 7.24 | **7.51** | **89% 分位** |
| **🏗️ 结构 (Structure)** | 6.32 | 7.34 | **7.85** | **89% 分位** |
| **🎛️ 混音 (Mixing)** | 6.70 | 6.97 | **7.44** | **85% 分位** |
| **🎤 人声 (Vocal)** | 6.74 | 7.08 | **7.23** | **74% 分位** |

- **强力收敛抽卡方差（四臂消融对照）**：在给定相同成熟 Brief 的执行层对照实验中，Eimu 将单通道跨题采样极差从裸模型的 **0.829** 强行压降至 **0.436（不稳定性直接砍半）**，并在最考验工程组织的「编曲」与「混音」维度分别带来 **+0.196** 与 **+0.098** 的净增益。
- *科学口径声明：评测采用腾讯 SongBench 官方评测器与权重（正控制曲四批独立运行均复现 6.9150），仅作为同一标尺下验证 Eimu Harness 抬升上限与收敛方差的工程实证，不作商业排行或“超越人类获奖作品”的主张。*

---

## 🎯 全场景产能矩阵（13 条产线 · 57 个模型）

| 场景 | 你说的话（L1 对话自动挡） | Eimu 编译并交付的时空产物（L2 画布可精调） |
| :--- | :--- | :--- |
| **历史长片 / 小说漫剧** | 「把这章《大明最后的十七年》拆成短剧」 | 角色卡锁定崇祯骨相，21+ 节点一次编排，直出 **64.48 秒**含音轨成片 |
| **史诗奇观短片** | 「生成秦始皇骑北极熊的电影」 | 剧本、角色四视图、分镜、配乐全自动接力，直出 **36 秒**电影级成片 |
| **金曲级原创音乐** | 「来一首华语金曲奖风格的乐曲」 | 3 路子代理并发调研曲风歌词，六层改写 + 集合熵选优交付完整人声单曲 |
| **三维机位预演** | 「先在三维导演台排好运动轨迹」 | Blender 渲染节点 + 142 条镜头语言，三维空间排好机位再驱动成片 |
| **电商上市片 / 视觉包** | 「给这款护肤品做一支 30 秒短片，再来 8 组海报」 | 分镜、成片、配音、字幕 + 同风格批量变体与多投放版位自动裁切 |

<p align="center">
  <img src="docs/preview/03-canvas.png" alt="无限画布" width="49%">
  <img src="docs/preview/07-history.png" alt="生成历史与跨作品资产复用" width="49%">
</p>

---

## 🔌 把 Eimu 接进 Cursor / Claude Code / OpenAI SDK

无需从头搭建渲染集群，改一行 `base_url` 或挂载 Remote MCP，即可将 Eimu 的 57 个模型与实体资产卡直接注入你的工作流（与站内共享同一套幂等计费账本）：

### 1. 一行指令挂载 Remote MCP（Claude Code / Cursor / Codex）
```json
{
  "mcpServers": {
    "eimu-studio": {
      "url": "https://eimu.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer $EIMU_API_KEY"
      }
    }
  }
}
```

### 2. OpenAI 兼容接口（同步出图 · 幂等防重扣 · 交易级 Webhook）
```bash
curl https://eimu.dev/openai/v1/images/generations \
  -H "Authorization: Bearer $EIMU_API_KEY" \
  -H "Idempotency-Key: trace-2026-001" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"@[角色:崇祯] 站在风雪煤山回望紫禁城, 电影级宽银幕光影"}'
```
- **开发者友好特性**：同步等待出图回 `200`（免写轮询代码）；支持 `/v1/batches` 批量与 `/v1/skus` 按规格下单；详见 [图像生成 API 文档](docs/biz-api.md) 与 [B 端调用指南](docs/biz-api-guide.md)。

### 3. 云端开箱即用 vs 本地自建（Cloud vs Self-Hosted）

| 部署方式 | 环境依赖与配置成本 | 适用人群 | 入口 |
| :--- | :--- | :--- | :--- |
| **☁️ Eimu Cloud (官方推荐)** | **零配置**，微信 / GitHub 扫码即送免费算力额度，享底层集采底价（生图进价 ¥0.01） | 独立创作者、漫剧工作室、直接调 API/MCP 的开发者 | **[👉 立即打开 eimu.dev](https://eimu.dev/)** |
| **🛠️ Local Self-Hosted** | 需自行配置 Node 20+、Postgres 租约库、Headless Blender 5.2 (EGL) 及 57 个上游模型凭证 | 研究多 Agent 编排机制与分布式控制平面的系统工程师 | 见下方《架构与本地开发》 |

---

## 🗺️ 模型生态与演进路线图 (Roadmap)

- **已接入多模态矩阵**（完整定义见 `src/lib/generation-model-catalog/catalog.ts`）：
  - **图像与三维**：GPT Image、Nano Banana、Seedream / Dreamina、FLUX、Adobe Firefly、Runway、PixAI 日系、Blender 5.2 渲染
  - **视频与表演**：Veo 3.1、Kling、Seedance 2.0 / 2.5、Runway、Firefly Video、MiniMax、Luma Ray、数字人、对口型
  - **音乐与语音**：Lyria、FlowMusic、YuE2（三通道健康探针与自动降级）、TTS（8 个实测可播音色）
- **工程里程碑与诚实边界**：
  - [x] `Descript DSL` 编译器与 21+ 节点 DAG 画布双向同步
  - [x] `Jev` 百毫秒决策路由与野兽模式五段式物理白名单隔离
  - [x] 图像类实体卡（角色/场景/风格）跨镜头绑定与 Blender 3D 白模参考预演
  - [x] 音乐子代理零特化泛化并在腾讯 SongBench 取得 7.418 (Best-of-8) 与方差砍半实证
  - [x] 网关鉴权正/负缓存隔离（15s 负缓存防瞬时抖动毒化）与 18s 断网 SSE 异步落盘验收
  - [ ] 由 3D 导演台机位轨迹全自动直驱长片渲染（持续验证迭代中）
  - [ ] 音色卡的 `@` 实体跨会话强引用与交付物链接语义化版本命名对齐

**有意不做的事（Anti-Goals）**：不做传统时间轴剪辑软件（助理替你装配）；不做 Photoshop 图层堆砌；不做带抽成的技能市集；不做打卡式社交分享墙。生成是严肃的工业生产。

---

## 🏗️ 系统架构与代码拓扑（90 个工具 · 1,816 项测试）

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
