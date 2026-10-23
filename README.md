<div align="center">

# Eimu

### 剪辑和分镜已经死了，现在人人都是导演。

随口一扔，编译器吞掉中间所有脏活；端上来的，是一部能直接播的成片。

[**进入工作台**](https://eimu.dev/) · [实机成片](#实机成片) · [单点模型之痛](#单点模型之痛) · [机器怎么跑的](#机器怎么跑的) · [基准跑分](#基准跑分) · [快速上手](#快速上手) · [English](README.en.md)

<p align="center">
  <a href="https://eimu.dev"><img src="https://img.shields.io/badge/Live-eimu.dev-2ea44f?style=flat-square" alt="Live"></a>
  <a href="https://eimu.dev/docs"><img src="https://img.shields.io/badge/Docs-eimu.dev%2Fdocs-4c8bf5?style=flat-square" alt="Docs"></a>
  <a href="https://github.com/tinchak0207/Eimu/stargazers"><img src="https://img.shields.io/github/stars/tinchak0207/Eimu?style=flat-square&color=f5c542" alt="GitHub stars"></a>
  <a href="#开发者接口"><img src="https://img.shields.io/badge/API-OpenAI%20compatible-8250df?style=flat-square" alt="API"></a>
  <a href="#开发者接口"><img src="https://img.shields.io/badge/MCP-Remote-ff7b72?style=flat-square" alt="MCP"></a>
</p>

</div>

---

## 实机成片

手机上随手敲一句话：

<p align="center">
  <img src="docs/preview/14-prompt-marvel-15s.png" alt="手机输入：做一个漫威级别的战斗影片，大概15秒" width="34%">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="docs/preview/15-dam-mech-15s.mp4" title="播放成片：暴雨大坝·义体战士对重装机甲">
    <img src="docs/preview/15-dam-mech-poster.jpg" alt="成片海报：暴雨大坝·义体战士 vs 重装机甲" width="58%">
  </a>
  <br>
  <sub>左：手机输入「做一个漫威级别的战斗影片，大概15秒」 → 右：管线交付的 15 秒成片（点击播放 <a href="docs/preview/15-dam-mech-15s.mp4">mp4</a>）。</sub>
</p>

```text
输入：
「做一个漫威级别的战斗影片，大概 15 秒。」

后台干了什么：
├── 拆解风格：暴雨大坝、义体战士肉搏重装机甲、高对比电影调色
├── 展开 21 节点图：角色定妆、Blender 摆机位、分 6 段分镜、多轨声场
├── 咬死实体卡：绑死 @[角色:女战士] 和 @[机甲:雷神重工]，镜头怎么切脸和涂装都不走样
├── 铺满音频：交响管弦垫底、打击声效按毫秒卡点
└── 严苛审片：逐帧扫坏点和抽搐帧，抽搐了当场重抽；音频统一压到 -16 LUFS 广播级响度
```

端上来的，就是声画严丝合缝、主角始终长一张脸的成片，不是几秒哑巴切片。

---

### 画布长视频样例：64 秒叙事短片

<p align="center">
  <img src="docs/preview/10-film-strip.jpg" alt="《大明最后的十七年》成片关键帧" width="100%">
  <br>
  <sub>喂入小说正文，一句「把它做成 1 分钟短片」，同一张画布直接吐出 64.48 秒完整故事片（6 镜连贯分镜，环境音、配乐、台词全齐）。</sub>
</p>

---

## 单点模型之痛

直接拿单点生视频模型做片子，用过的人都知道有多折磨：

| 现状翻车现场 | Eimu 怎么收拾 |
| --- | --- |
| 跨个镜头直接换脸，衣服发色每秒都在变 | **实体卡机制**：`@[角色:崇祯]` 钉死全片，参考特征从头锁到尾 |
| 第 5 镜崩了，整条片子就得推倒重开盲盒 | **节点化局部重跑**：坏哪一镜就只重跑哪一镜，其余镜头纹丝不动 |
| 配乐经常瞎哼哼，歌词咬字糊成一团 | **ASR 质检把门**：后台拿语音识别逐字核对，字音对不上直接打回重抽 |
| 这一段震耳欲聋、下一段蚊子叫，声画各演各的 | **母带级混音**：全片音量按 -16 LUFS 压实，爆点音效按帧精确对齐 |
| 浏览器必须死死开着盯进度，断网直接前功尽弃 | **离线队列**：手机发完直接锁屏走人，服务端跑完落盘通知 |

---

## 机器怎么跑的

你的自然语言需求一进来，系统直接编译成一张 21+ 节点的有向执行图（DAG），拆开并发干活：

```text
一句话需求
   │
   ▼
[语义解析] ───────> 抠出风格、运镜规则和时长预算
   │
   ▼
[Descript 画布] ──> 展开 21+ 节点流水线（定妆 / 分镜 / 3D 运镜 / 拟音配乐）
   │
   ├─► 实体特征卡：把角色和道具的特征向量死死钉住，跨镜绝不漂移
   ├─► 3D 导演台：无头 Blender 5.2 拿火柴人和白模先跑一遍运镜，先锁死机位透视
   ├─► 分工做片：写歌的碰不到画笔，改词的动不了镜头，各跑各的
   │
   ▼
[审片门禁] ───────> 拿尺子扫肢体崩坏、ASR 听写抠歌词、压平全片音量
   │
   ▼
端出成片（MP4 / 分轨音频工程 / 字幕）
```

### 1. 一句话铺满画布
需求一落地，自动匹配最适合的模型产线，把定妆、分镜图、运镜轨迹、环境音和背景乐排成一张完整的执行管线图。

<p align="center">
  <img src="docs/preview/02-intent-to-canvas.png" alt="工作流图展开" width="100%">
</p>

### 2. 双向同步，改一处不毁全片
聊天框随口改一句话，画布里的节点跟着变；在画布上手动拖动、改改参数，后台状态同步更新。每个节点带历史快照，不满意的镜头发起局部重跑，不用全盘重来。

<p align="center">
  <img src="docs/preview/03-canvas.png" alt="无限画布" width="49%">
  <img src="docs/preview/07-history.png" alt="生成历史" width="49%">
</p>

### 3. 实体卡锁脸，Blender 锁机位
主角、道具、特定场景全部做成实体卡，镜头切得再碎也参考同一张底图。大角度机位和激进运镜，先在 Blender 空间里摆好白模跑通轨迹，透视正确了才递给生成模型。

<p align="center">
  <img src="docs/preview/04-3d-director.png" alt="3D 导演台" width="100%">
</p>

### 4. 谁管什么就拿什么，审片不合格直接打回
写歌的 Agent 拿不到画图工具，改词的碰不到分镜。各干各的，最后专门有个审片 Agent 拿着尺子查坏点、对口型，合格了才合成输出。

<p align="center">
  <img src="docs/preview/ZH-8-mechanism.png" alt="子代理协作与门禁机制" width="100%">
</p>

---

## 基准跑分

### 音乐生成实测（SongBench 官方评测集）

在腾讯 **SongBench**（arXiv:2604.25937）官方基准下，把 Eimu 管线生成的《逆风不灭》与 27 首格莱美/金曲奖母带实录放在同一标尺下打分：

| 样本 | 七维均分 | 旋律 | 编曲 | 音乐性 | 器乐 | 混音 | 结构 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 裸模型 YuE2（无外部编排） | 6.411 | 6.45 | 6.75 | 5.70 | 6.85 | 6.70 | 6.32 |
| 27 首格莱美/金曲奖录音均值 | 6.400 | 6.51 | 6.69 | 5.47 | 6.60 | 6.37 | 6.48 |
| **Eimu 编排管线（4 首均值）** | **6.975** | 7.38 | 7.43 | 6.16 | 7.24 | 6.97 | 7.34 |
| **Eimu《逆风不灭》（Best-of-8）** | **7.418** | **7.60** | **7.87** | **6.41** | **7.51** | **7.44** | **7.85** |

加上前置结构约束、多路候选采样和后置质检过滤之后，最直接的战果是：裸模型换个提示词就抽风的评分极差，从 `0.829` 压到了 `0.436`。品质下限稳住了。

<p align="center">
  <img src="docs/preview/POSTER-grammy-leaderboard.png" alt="评测分数分布" width="100%">
</p>

---

## 快速上手

1. 浏览器打开 [eimu.dev](https://eimu.dev/)，微信或 GitHub 登录。
2. 框里直接贴要求，比如：
   > 「把这段武侠小说高潮片段做成 30 秒短片：月下破庙、暴雨倾盆、长剑出鞘，三个镜头，配古风笛声与打击音效。」
3. 瞄一眼拆解出的节点图，点生成。哪一镜看着不顺眼，单独点进去重抽那一镜，别的镜头绝不动。

---

## 接入的模型与产线

已挂接 **13 条垂直产线、57 个模型、90 个专用工具**：
* **视频**：Veo 3.1、Seedance 2.0 / 2.5、Kling、Runway、MiniMax、Luma Ray
* **图像**：FLUX、GPT Image、Nano Banana、Seedream、Adobe Firefly、PixAI
* **音频**：YuE2、Lyria、FlowMusic、多情感 TTS、对口型算法、数字人
* **空间**：Blender 5.2 Headless EGL 渲染

---

<details>
<summary><strong>开发者接口：API 与 Remote MCP（点击展开）</strong></summary>

### 开发者接口

* **OpenAI 兼容接口**：提供 `/openai/v1/images/generations` 等 31 个标准路由，把你的 SDK Base URL 换掉就能用。
* **Remote MCP**：端点 `https://eimu.dev/api/mcp`，直接喂给 Claude Code、Cursor 或 Codex。
* **自带幂等防重扣**：标配 `Idempotency-Key`，网络超时随便重试，绝不重复扣你的额度。

```bash
curl https://eimu.dev/openai/v1/images/generations \
  -H "Authorization: Bearer $EIMU_API_KEY" \
  -H "Idempotency-Key: job-001" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"@[角色:崇祯] 站在煤山风雪中，电影级景深"}'
```

### 底层架构

```text
前端与 API 网关（Next.js 15.5 App Router + Tailwind CSS）
   │
   ▼
生成控制层（Postgres 事务租约 + SKIP LOCKED 并发调度 + 双向对账）
   │
   ▼
工作流引擎（Descript DSL 编译 + DAG 状态机 + 分布式 Outbox 投递）
   │
   ▼
执行容器与桥接（VPS + Docker Worker + Blender 5.2 Headless + 上游 Provider）
```

</details>

---

## 正在做的东西

* **成片工程 Fork**：跑得好的神仙成片，一键 Fork 整张工作流图。换个角色名字和人设，直接复用原片的镜头张力和踩点配乐。

## 约束边界（不画大饼）

* 3D 白模空间定位已跑通；全自动物理渲染还在打磨。
* 角色画面特征已锁死；音色卡 `@` 跨镜头继承正在收尾。
* 画面放大靠的是扩散模型补细节，不是传统拉伸插值。
* 出来的音频默认按 -16 LUFS 广播级标准压实。
* 我们做的是全自动整片输出，不搞 PS 级别的修瑕修图。

---

## 声明

* **开源与托管**：系统编排架构、执行规范与基准数据全公开；在线开箱即用访问 [eimu.dev](https://eimu.dev/)。
* **版权**：调度框架与业务产线实现为私有代码（Proprietary），版权归作者（陈天泽、徐振华）所有。第三方开源协议与致谢见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

<div align="center">
  <br>
  <a href="https://star-history.com/#tinchak0207/Eimu&Date">
    <img src="https://api.star-history.com/svg?repos=tinchak0207/Eimu&type=Date" alt="Star History Chart" width="80%">
  </a>
</div>
