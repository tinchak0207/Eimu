# PRD：3D 导演工作站（Astra 前置建设）

> 2026-09-06 裁定。暴君定位：**Astra = 专属 3D 导演 subagent**——主脑递委托单（想要的效果），Astra 自主用 Blender 设计骨架动画，隔离上下文，只回传结果。
> 本 PRD 范围：**后台 + 前台建设（P0+P1），模型渠道接入殿后**。测试期用现有模型顶位，渠道经不起大量使用 → 全程带成本护栏。

---

## 0. 架构总图

```
用户（剧本/参考图/一句话）
   │
主脑（现有 agent，上下文不膨胀）
   │  委托单（效果描述+参考+约束，≤2k token）
   ▼
┌─────────────────────────────────────┐
│ 3D 导演 subagent（persona 绑模型位）      │
│  测试期：现有便宜模型顶位                │
│  生产期：gpt-6-astra（渠道限流护栏）      │
│                                       │
│  L2 CG 执行：Blender headless 桥（唯一主力）│
│   bpy 脚本 → .blend/glTF/帧/mp4       │
│   blocking/骨架动画/材质/灯光/渲染全在此  │
└─────────────────────────────────────┘
   │  回传（资产引用+摘要，不回传过程）
   ▼
画布「3D 场景卡」+ 资产包持久化 + 计费 ledger
   │
   ▼（既有管线）image/video 生成 → timeline 成片
```

**分工裁定（09-06 二审：Blender 上位）**：**Blender 为唯一主力工作站位**——blocking/骨架动画与真 CG 全在 Blender 内完成。director-engine **停止新增能力投资**，降级保留两个剩余价值：①既有 viewport 展示壳（P1 吃 glTF 做浏览器预览）②机位/运动模板作为 bpy keyframe 的种子数据。不再为白模引擎写任何新功能。

**委托单契约**（上下文控制的关键）：
- 主脑 → 3D 导演：`{效果描述, 参考图引用, 镜头数/时长, 风格约束, 交付物清单}`（结构化，≤2k token）
- 3D 导演 → 主脑：`{资产包引用(.blend/glTF/脚本), turntable mp4, stills[], 场景树摘要(≤500 token), 渲染耗时/成本}`——**过程不出 subagent 隔离层**。

---

## 1. 轮子锚定总表（PRD 铁律：每 spec 必钉轮子源）

| 轮子钉（源档） | 复制到 | 白名单栏位（数据源/文案/接入点） | 判定 |
|---|---|---|---|
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)（27k★，执行协议/场景状态读回/错误形状） | `bridge/blender-bridge/` 执行器 | 协议讯息形状、场景 tree dump 格式；交互逻辑按 headless CLI 改写 | diff 除 headless 适配外逐行等价 |
| [arjun988/blender-skills](https://github.com/arjun988/blender-skills)（94 专业 skill：blockout→lookdev→render 管线配方） | 3D 导演 SKILL 的脚本配方库（移植 previz 子集 10–15 个） | 脚本模板全文、参数、阶段门禁文案 | cp 原文改白名单 |
| `src/lib/director-engine/`（L1 引擎） | **不动**；P1 仅新增 glTF 载入入口 | engine.ts/types.ts 既有介面 | 禁改既有行为 |
| `src/lib/harness-tool-registry.ts` 注册模式 | `blender_*` 工具族注册 | 既有 registry 栏位形状 | 同构复制 |
| generation worker 并发池模式 | 渲染伫列（P1） | 并发数 env 化、lease 语义 | 同构复制 |
| tool-progress SSE 机制 | 逐阶段渲染进度（P1） | 事件形状 | 同构复制 |
| asset-packs persistence | .blend/glTF/脚本入包（P1） | 资产类型栏位 | 同构复制 |
| control-plane billing paradigm | GPU 分钟计费（P1） | reserve/commit/refund 语义 | 同构复制 |
| new-supplier-integration skill「new-api 渠道 5 分钟配方」 | Astra 渠道接入（P1 殿后） | 配方全文 | 照抄 |
| [squall01337/mixamo-llm-mocap](https://github.com/squall01337/mixamo-llm-mocap)（视频→Mixamo→Blender） | P2 埋桩不施工 | — | — |

---

## 2. P0：本机全闭环（后台骨架，零 VPS 改动，零渠道呼叫）

**预期 2–4 天工。验收门见各项；全绿标准 = smoke 成片 + 断点 0。**

### P0-1 Blender runtime（≤30 分钟）
- 安装 Blender 5.2：flatpak（`flatpak install flathub org.blender.Blender`，免 sudo，agent 可自装）或暴君一行 `sudo pacman -S blender`。
- 验证 headless GPU：`blender --background --factory-startup --python-expr` 出一帧 Eevee（EGL 验 RTX 5070 可用）；Cycles CPU 后备。
- 产物：版本钉死 + 一页启动配方（进 runbook，不入 AGENTS.md）。

### P0-2 blender-bridge 执行器（核心后台件）
- 新建 `bridge/blender-bridge/`：本地服务，收 `{bpy 脚本, 资产引用, 渲染参数}` → 起 Blender 进程执行 → 回 `{产物清单, 场景树摘要, stdout 尾段, 耗时}`。
- 轮子：blender-mcp 的指令/回执形状 + blender-skills 的管线脚本模板。
- **沙箱红线**：`--factory-startup`、无网（进程级）、timeout（预设 300s）、磁碟配额、产物白名单路径。脚本只准写 workspace 目录。
- 验收门：恶意脚本（`import urllib`/死循环/越路径写）三连测试全被拦；正常脚本出帧。

### P0-3 3D 导演 SKILL（顶位模型能写对 bpy）
- 新建 skill：管线五阶段（blockout → 相机 → 灯光 → 骨架动画 → 渲染），每阶段带 blender-skills 移植的脚本配方；Eevee previz 预设 / Cycles lookdev 预设； director-engine L1 数据（机位/运动曲线）可转 bpy keyframe 的对照表。
- 顶位 = 现有便宜模型（deepseek-v4-flash-vision-exp 级）；Astra 只是日后 persona 换绑，**SKILL/工具/委托单契约全部模型无关**。
- 验收门：顶位模型按 SKILL 生成 bpy，≤3 次迭代内 bridge 执行通过并出帧。

### P0-4 工具族注册（本地形态）
- `harness-tool-registry.ts` 注册 `blender_exec`（建场景/改场景）、`blender_render`（出帧/mp4）、`blender_export_gltf`（P1 前台用，P0 先交付档案）。
- 工具文案**一律简体**（gateway 文案铁律）。
- 验收门：本地 agent 会话中呼叫我三件套全通；deny 表新增 Blender 沙箱例外条目。

### P0-5 smoke（终验）
- 输入：一段剧本（例：雨夜屋顶追逐，2 镜）。输出：.blend + glTF + turntable mp4 + 3 stills，全部落盘并列清单。
- 门：单镜渲染 ≤5 分钟（Eevee/RTX）；断点 0；**渲染帧过视觉审核闭环（毒舌审核 PASS）才算交付**——防假成功铁律。

**P0 明确不做**：VPS 部署、前台 UI、计费、Astra 渠道、资产包入库。

---

## 3. P1：生产化（VPS + 前台 + 资产 + 计费，渠道殿后）

**预期 1–2 周工，分片派工。**

### P1-1 渲染节点 + 伫列
- 本机 GPU 节点先行（bridge 容器化， podman）；上量后按分钟租 GPU（RunPod 级）——**渲染节点选型是暴君拍板点①**。
- 伫列：复制 generation worker 并发池（env 可调并发、lease、失败自愈）。

### P1-2 VPS gateway 工具族
- blender_* 四件套上 VPS gateway（bridge 走内网/隧道）；patch 配方照 opencode gateway 手术配方（backup→tee→python 补丁→bun build→重启）。
- 进度：tool-progress SSE 逐阶段回传（blockout/相机/灯光/渲染百分比）。

### P1-3 前台「3D 场景卡」
- 画布新卡型：turntable 视频 + stills 网格 + 场景树 + 资产下载；交互范围 P1 只读+播放（可拖拽相机沿用 L1 director-engine viewport，不重造）。
- **铁律**：新 metadata 栏位族必同步两处白名单（`toNodeMetadata` + `compactMetadataForAgent`），配往复合同测试（snapshot compressor 事故教训）。
- director-engine 新增 glTF 载入：白模 viewport 升级为真资产预览。

### P1-4 委托单 UI（subagent 接入面）
- subagent 选单加「3D 导演」项（复制既有 subagent menu 轮子）；委托单表单 = 契约 schema 的 UI 化；回传渲染为 3D 场景卡。

### P1-5 资产包入库
- .blend/glTF/脚本/贴图按资产包 schema 持久化（复制 asset-packs persistence）；**脚本带指纹索引**——相似委托先命中脚本模板，零 token 复用（成本护栏核心）。

### P1-6 计费
- 渲染 GPU 分钟 + 储存进 ledger（reserve/commit/refund 同构）；**价目表先加价再上线**（价目表是唯一价格权威，禁猜价）。

### P1-7 模型渠道接入（殿后，暴君点头才开工）
- new-api 渠道 5 分钟配方接 `gpt-6-astra`（$10/$50 每百万 token）；persona 换绑即完成。
- **成本口径（2026-09-06 暴君裁定，替代原「月预算帽」设计）**：
  - 单请求成本：≤100k 上下文＋80% 缓存命中 → **0.04–0.05 RMB/请求**；**0.12 RMB/请求为「太贵」红线**（观测指标，超线场景走 P2 机制）
  - subagent 隔离设计天然守住成本：委托单 ≤2k token＋SKILL＋场景摘要，不吃满上下文——**隔离即省钱**
  - 产品计费：**单请求 2 币静态收费**（成本让不出去的特例；落实归 P2）
- **渠道护栏（保留项）**：伫列限流（并发帽＋排队）；脚本模板库命中优先（P1-5，同类场景零渠道呼叫）；Astra 只做首次设计、迭代走便宜模型。原「逐 session token 帽超额降级」设计**作废**。

### P1 终验门
eimu.dev 端到端：委托单 → 3D 导演出片 → 场景卡 → 资产包 → 计费对帐零漏 → 视觉审核 PASS；Vercel READY + production alias（暴君接管视觉验收时到此为止）。

---

## 4. 成本结构（对帐底稿）

| 项目 | 测试期（P0） | 生产期（P1 后） |
|---|---|---|
| 骨架动画 | L1 director-engine，0 成本 | 同左 |
| bpy 脚本生成 | 顶位模型（现有渠道） | Astra 首次 $0.3–2/场景；迭代走便宜模型 |
| 渲染 | 本机 RTX，电费级 | GPU 分钟计费（租用约 $0.3/hr 级） |
| 资产复用 | — | 脚本/场景命中模板 = 0 边际成本（复利层） |

## 5. P2 埋桩（不施工）
- **Astra 上下文压缩与续命（2026-09-06 暴君裁定归 P2）**：单请求成本超 0.12 RMB 红线时，便宜模型压缩上下文后**隐形给 Astra 开新对话**继续工作（「没什么用还可能出 bug，其他东西都做完才做」）。
- **2 币静态计费落实**：3D 导演单请求 2 币（产品特例，成本让不出去），与 GPU 分钟计费一起接进 ledger。
- mixamo-llm-mocap：视频→角色动画（真角色骨架，非 mannequin）。
- UE5 L3：walkable 实时漫游（Astra 官方 demo 已验证 Blender→UE5 通道）。
- 多镜 previz → image/video 生成 → timeline 成片**全管线**（3D 资产喂现有生成渠道控品质——终极护城河闭环）。

## 6. 待暴君拍板
1. **渲染节点**：暴君裁定方向＝搜 free tier 高、不占本机的方案（研究片 U/V 扫描中）；本机 RTX 5070 为对照基线（一帧 Eevee ~4s）。
2. ~~Astra 月预算帽~~ **作废（2026-09-06）**：改为单请求成本观测口径（0.04-0.05 RMB 正常／0.12 红线）＋2 币静态收费，均归 P2 落实。
