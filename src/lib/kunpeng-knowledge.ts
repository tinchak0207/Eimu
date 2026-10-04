/**
 * 鲲鹏创作知识注入（Agent Harness 知识层扩充，2026-08-27）。
 *
 * 数据来源：pengfeiqiao/kunpeng（v2.9.16，commit 872a58b，MIT License）
 * 的 aigc-memory/{checklists,shot-patterns,reference} 与 skills/{script-doctor,
 * film-master,scene-image-anchor,storyboard-sketch,video-style-replication}。
 * 正文逐字复制，仅做「接入格式转换 + 外部工具引用剔除/映射」两类白名单改写
 * （逐条清单见各段注释与完工报告；完整对账结论见 KUNPENG_SKILL_AUDIT）。
 *
 * 接入方式：沿现有 agent-templates 的 directive 链路（模板卡点击 →
 * sessionDirective 随首条消息上送 → 网关拼进 system 注入），不建第二条注入通道。
 * 文案一律简体中文。
 */

import { KUNPENG_SOURCE } from "./kunpeng-style-assets";

/** 知识段落：id 用于测试锚定，text 为注入正文。 */
export interface KunpengKnowledgeSection {
  id: string;
  title: string;
  text: string;
}

/** 每个 kunpeng skill 的审计结论（接入/部分接入/不接入 + 工具引用改写明细）。 */
export interface KunpengSkillAuditEntry {
  skill: string;
  decision: "included" | "partial" | "excluded";
  reason: string;
  /** 工具/外部服务引用 → 处置（映射到我们的工具 id / 剔除 / 保留为纯指导）。 */
  toolRewrites: Array<{ from: string; to: string }>;
}

/**
 * ── 生成前检查清单（aigc-memory/checklists/pre-generation.md，17 条语义逐字）──
 *
 * 剔除/改写清单（外部概念 → 我们流程的对应物）：
 * - 第 6 条「飞书表格中的提示词格式」→ 剔除（我们无飞书多维表格阶段；提交 API 阶段
 *   的格式规则已由第 8 条的剩余部分覆盖）
 * - 第 9 条「@ 引用中的文件名在文件系统中确实存在吗？ls 确认」→ 剔除（我们无文件
 *   系统资产阶段；@图片N 位置编号由生成入口按上传顺序自动绑定，无需 ls）
 * - 第 11 条「批量操作前做过单条验证吗？先插 1 条」→ 改写为「先单张生成验证」
 *   （原语义：先插 1 条表格记录；对应我们的流程 = 先出 1 张验证格式再批量）
 * - 第 12 条「使用不熟悉的 lark-cli 命令前看过 --help 吗」→ 剔除（无 lark-cli）
 * - 第 16 条「select 字段值都是已存在选项吗（飞书表格选项）」→ 剔除（无表格 select 字段）
 * - 第 17 条「记录粒度和最终生成维度对齐吗（表格按单镜头还是合并视频建）」→ 剔除
 *   （无表格记录阶段；对应约束已由第 5 条参数完整性覆盖）
 * - 第 2 条 `--param "realPersonMode=true"` → 保留语义，改写为提交参数说明
 *   （realPersonMode 参数本身在 Seedance 模板中保留）
 * - 第 4 条 接口名 multimodal-video / text-to-video → 改写为「多图参考模式 / 纯文本模式」
 *   （我们后端无 bytedance 直连端点）
 */
const CHECKLIST_TEXT = `# 生成任务提交前检查清单

每次调用 Seedance / 即梦 / 生图 API 前，必须逐条自检：

□ 1. 参考图传了几张？顺序和 @ 编号一一对应了吗？
   第1张→@图片一（场景），第2张→@图片二，...，第5张→@图片五

□ 2. 有真人/角色素材吗？
   如果有 → 必须加 realPersonMode=true

□ 3. 所有上传的资产图在提示词里都有 @ 引用吗？
   逐张图片比对提示词，确保无遗漏

□ 4. 模式选对了吗？
   传图 → 多图参考模式
   不传图 → 纯文本模式
   （纯文本模式不支持传图！）

□ 5. 参数完整吗？
   duration / resolution / ratio / generateAudio 是否已设置？

□ 7. 用户确认了吗？
   方案有没有先给用户看过？用户说"做"了吗？

□ 8. 提示词模板类型选对了吗？
   分镜格式：分镜场景设定在 + 镜头行，不是自由发挥
   GPT-Image-2 模板 → 仅用于生图，Seedance 模板 → 仅用于生视频

□ 10. 场景图是按每个镜头的景别分别匹配的吗？
   大远景/远景→远景图、中景→中景图、近景/特写→特写图
   不是所有镜头用同一张场景图吧？

□ 11. 批量生成前做过单张验证吗？
   先出 1 张 → 验证格式正确 → 再批量执行
   没有直接批量全提交吧？

□ 13. VO 行用对了吗？
   画面内人物当场说/唱 → 写进镜头描述行
   只有旁白/画外内心独白才用 VO 行
   没把画面内对白错误提成 VO 行吧？

□ 14. 提交 API 的提示词 @ 引用全是 @图片N 吗？
   通篇无文件名（.png/.jpg）、无自定义名（@人一/@物一）、无 @音频 当图片占位残留？

□ 15. 音频是用文字引用的吗？
   写成 用@音频一的音色用{方言}唱/说：内容，不是 @音频 占位？

全部通过后再执行生成。任何一项未通过 → 修正后再提交。`;

/**
 * ── 镜头模式路由（aigc-memory/shot-patterns/ 全部四个文件逐字）──
 */
const SHOT_PATTERNS_TEXT = `# 镜头模式路由

本节用于给分镜选择镜头结构，不负责引擎提示词格式。

## 使用方式

- 建立世界、交代空间、开场定调：读「建立镜头」
- 对话、视线关系、人物关系：读「对话镜头」
- 追逐、冲突、打斗、强运动：读「动作镜头」

## 写入分镜时必须落到字段

- 景别
- 运镜
- 主体动作
- 情绪外化
- 空间关系
- 时长
- 关联角色/场景/道具

## 冲突优先级

镜头模式只决定"怎么拍"，不覆盖角色一致性、导演 DNA 和 Seedance 权威模板。

## 建立镜头
目的：交代环境和空间关系
景别：大远景/全景
时长：6-12秒
运动：缓慢横移或固定
作用：让观众理解场景空间

## 对话镜头
目的：捕捉人物交流
标准配置：
1. 双人全景（establishing）
2. 过肩 shot（各方向）
3. 单人近景（各角色）
4. 插入特写（关键道具/反应）
剪辑：遵循 180 度法则

## 动作镜头
目的：传递动感和冲击力
标准配置：
1. 全远景建立（动作空间）
2. 中景跟拍（主体运动）
3. 近景特写（反应/细节）
4. 广角仰拍（强化冲击）
剪辑：快切，15-30帧/镜头`;

/**
 * ── @ 图片引用规则（aigc-memory/reference/reference-image-rules.md）──
 *
 * 剔除清单：
 * - 「两阶段 @ 引用规则（飞书表格 vs 生视频提交）」中「阶段一：飞书表格中（给用户看的）」
 *   整段剔除（我们无飞书表格阶段）；「阶段二：生视频提交时」的 @图片N 位置编号规则保留
 *   （dreamina / rhtv API 字样改写为通用「生成 API」）
 * - 「检查方法」中「资产图字段附件 / 视频提示词字段」的表格字段表述 → 改写为「上传的
 *   参考图 / 最终提示词」（对应我们的生成入口）
 * - 「@ 引用编写前置检查」的 ls 文件系统检查整段剔除（无文件系统资产阶段）
 * - 「多主体定义」「官方特殊符号规范」「音频 @ 引用」逐字保留（与 Seedance 模板一致）
 */
const REFERENCE_RULES_TEXT = `# @ 图片引用规则

## 传图顺序 = @ 引用编号

| 传入顺序 | 提示词中引用 | 说明 |
|----------|-------------|------|
| 第 1 张参考图 | @图片一 | **始终是场景参考图** |
| 第 2 张参考图 | @图片二 | 角色/资产图 |
| 第 3 张参考图 | @图片三 | 角色/资产图 |
| 第 4 张参考图 | @图片四 | 角色/资产图 |
| 第 5 张参考图 | @图片五 | 角色/资产图 |

## 强制规则

**有资产图就必须在提示词中有对应的 @ 引用。**
每张上传到参考图的图片，都必须在视频提示词中出现对应的 \`@图片N\`。

## 检查方法

对每个镜头，逐条检查：
1. 查参考图清单有哪些图片
2. 查视频提示词是否包含所有图片的 @ 引用
3. 遗漏的在对应的描述文字后面补上 @ 引用

## 容易遗漏的场景

- 配角/次要角色：即使只出现一次也要 @ 引用
- 手持物品/道具：如果是独立资产图，必须 @ 引用
- 多镜头合并：每个子镜头行内独立写 @ 引用，同一物体在不同子镜头出现要重复写
- 场景图：始终是 @图片一，每个提示词都必须有

## 提交生成时的 @ 引用规则

提交视频生成任务时，根据上传顺序，把 @具体文件名**临时替换**为 @图片N：
- \`@S1_月夜远景_v8.png\` → \`@图片一\`（第 1 张上传的场景图）
- \`@PT1_闰土_v1.png\` → \`@图片二\`（第 2 张上传的资产图）
- \`@PR1_钢叉_v3.png\` → \`@图片三\`（第 3 张上传的资产图）

### 提交前红线（必查）

- 转换后**逐条核对**：最终提示词里所有图片 @ 引用必须是 \`@图片N\` 位置编号
- **不得残留**任何文件名（\`.png\`/\`.jpg\`）、自定义名（\`@人一\`/\`@物一\`）、或把 \`@音频一\` 当图片占位
- 提交前自检：通篇搜 \`.png\` / \`.jpg\` / \`@人\` / \`@物\` / \`@音频\`（作图片引用时）应为 **0 命中**
- Seedance API 只认 \`@图片一\`~\`@图片五\`，残留其他写法一律识别失败

## 音频 @ 引用（不占图片编号）

- 音频**不写 @图片/@音频 作占位引用**，用文字描述音色：\`用@音频一的音色用{方言}唱/说：{内容}\`
- 第 1 个音频 = @音频一，**仅在文字里引用**，不参与 @图片N 编号体系
- ❌ \`用女主年轻声音的音色\` → ✅ \`用@音频一的音色\`

## 官方特殊符号规范（Seedance 2.0）

提示词用符号区分信息类型：**台词 \`{}\`**、**音效 \`<>\`**、**音乐 \`（）\`**、**字幕 \`【】\`**。
- 台词写法：\`人物@图片二用@音频一的音色唱：{歌词内容}\`

## 多主体定义（官方，防双胞胎/ID 漂移）

多人物同画面**必须分别定义唯一标签并贯穿使用**，否则易出现"双胞胎"：
- \`将@图片N中的[2-3个稳定静态特征]定义为<主体N>\`，后续持续用同一标签
- 或人名后标注对应图：\`张三（对应图片一）将存折扔向李四（对应图片二）\`
- 人物参考图优先单人独立照，**不用三视图/多视图**
- 末尾可加全局约束：\`禁止出现外形着装完全一致的人物，禁止同款分身/双胞胎\`

## 反例（错误写法）

\`\`\`
分镜场景设定在：长安火车站 @图片一
镜头1+2 13s 时间: 黄昏。 [全远景/固定] 长安蒸汽火车站外景。陈墨站在站台望向远方。
\`\`\`
→ 陈墨有资产图但提示词中没有 \`@图片二\`，错！

## 正例（正确写法）

\`\`\`
分镜场景设定在：长安火车站 @图片一
镜头1+2 13s 时间: 黄昏。 [全远景/固定] 长安蒸汽火车站外景。陈墨@图片二站在站台望向远方。
\`\`\``;

/**
 * ── skill 1/5：剧本医生（skills/script-doctor/SKILL.md，方法型知识逐字）──
 *
 * 审计：无外部工具/CLI/API 引用（纯分析方法 + 报告格式），零改写接入。
 * Step 1 的 .fdx/.fadein/.pdf 文件读取为纯文本处理说明，保留。
 */
const SCRIPT_DOCTOR_TEXT = `# 剧本医生技能 v2.0 — 专业剧本开发与 Coverage 系统

专为剧本审阅设计的好莱坞标准分析系统。核心逻辑：**先结构解析，再多维量化分析，再生成标准 Coverage 报告**。基于 CML-Bench 量化评估框架 + 麦基/悉德·菲尔德/救猫咪/特鲁比等经典编剧理论。

## 最高优先级：从成片效果出发

下方三幕、节拍和页码位置是诊断参照，不是合格证。不得因为作品没有命中"第 25% 转折"就直接判定有问题，也不得为了补齐节拍把故事改成模板。

审阅时优先回答：
1. 这一场谁想得到什么，阻力来自哪里，失败的私人代价是什么？
2. 人物做了什么选择，场尾的关系、信息或价值状态发生了什么变化？
3. 观众看到和听到了什么？不可拍的心理说明能否转成动作、环境、停顿或选择？
4. 对白是否存在摩擦和潜台词？角色是在争夺、试探、回避、诱导还是谈判？
5. 角色声音是否来自经历、职业、关系、当前目标和主要情绪，而非口头禅堆砌？
6. 悬念是否具备可感知的威胁、后果和时间压力？stakes 是否对人物私人而具体？

专业动作描述应经济、可拍且有语气。换行代表新的动作或节拍，动作段通常不超过 4-5 行。只能写观众可见可听的内容，不用小说式内心解释。

修改流程固定为"证据 → 根因 → 最小有效改动 → 预期效果"。先给最小改动，只有结构根因确实无法局部修复时才建议重构。任何评分都必须服从具体证据，不能用理论名称代替判断。

## 分析流水线

Step 1: 剧本摄入 → Step 2: 结构解析 → Step 3: 多维分析 → Step 4: 诊断报告（→ Step 5-7 深度钻取/修改建议/迭代对比，可选）

### Step 1 — 剧本摄入
- 支持：.txt 纯文本 / 直接粘贴的剧本文本
- 内部表示：场景列表（场景标题、内/外景、时间、地点）、角色列表、对话块（角色名+对话内容）、动作描述（非对话文本）
- 解析方法：使用正则解析（标准格式）+ 启发式降级（非标准格式）

### Step 2 — 结构解析
- 识别场景切换点（INT./EXT./I./E. 等前缀）
- 构建场景序列，计算每场页占比
- 按三幕式划分（25%/50%/25% 原则）
- 识别情节点 I（页 20-30）和情节点 II（页 75-90）
- 映射救猫咪 15 节拍

### Step 3 — 多维分析
并行执行 6+1 维分析，每维度输出分数 + 证据 + 问题列表：

1. **结构完整性（权重 25%）**：三幕检测、情节点位置、救猫咪节拍映射、场景连续性、冗余场景
2. **角色深度与弧线（权重 20%）**：角色原型识别、主角弧线、对话语音一致性、角色互动网络、动机-行动对齐
3. **对话质量（权重 20%）**：自然度、问答相关性、话题集中度、潜台词检测、辨识度、禁忌检查（"As you know, Bob..."倒信息 / 过度解释 / 角色自言自语）
4. **情感冲击力（权重 20%）**：全剧情感弧线、场景价值转折、高潮场景定位（应在 80-90%）、情感多样性、情感节奏
5. **视觉叙事与动作密度（权重 10%）**：动作/对话比、动词丰富度、可拍摄性、被动语态检测、"展示不告知"检查
6. **制作可行性（权重 5%）**：场景数量（90 分钟剧本 40-60 场）、外景/夜戏比例、特效场景、角色规模、地点多样性、时间段跨度
7. **原创性与可比性（加分项）**：概念原创性、可比作品推荐（2-3 部）、类型市场定位

### Step 4 — 诊断报告

综合评分 = 结构完整性×25% + 角色深度×20% + 对话质量×20% + 情感冲击力×20% + 视觉叙事×10% + 制作可行性×5% + 原创性加分(-1 到 +1)

| 综合评分 | 评级 | 含义 | 建议 |
|---------|------|------|------|
| 9.0-10 | 强烈推荐 | 行业顶级，立即推进 | 无需重大修改 |
| 7.5-8.9 | 推荐 | 优秀，少量打磨即可 | 低优先级修改 |
| 6.0-7.4 | 考虑 | 有潜力，需中等改造 | 高优先级修改 |
| 4.0-5.9 | 通过 | 基础尚可，需大幅修改 | 修改后重新评估 |
| <4.0 | 退回 | 基础问题太多 | 建议重写 |

### 修改建议生成策略

1. **定位问题点** — 用精确页号/场号定位
2. **诊断根因** — 区分表层问题和深层问题
3. **生成 2-3 个修改选项**：选项 A（最小改动）/ 选项 B（中等改动）/ 选项 C（重构方案，仅重大问题时）
4. **每个选项附修改示例** — 展示修改前后的对比

### 验证指南

- [ ] 所有 6 个维度都有分数（非空值）
- [ ] 每个问题都附有具体位置（页号/场号）
- [ ] 每个证据都引用具体文本
- [ ] 综合评分与各维度评分逻辑一致
- [ ] 修改建议可操作、有示例
- [ ] 可比作品有明确理由`;

/**
 * ── skill 2/5：电影分镜设计（skills/film-master/SKILL.md + SKILL_STORYBOARD.md）──
 *
 * 审计：
 * - SKILL.md：无外部工具引用（「工坊角色资产模板」「工坊镜头」→ 对应我们的画布/资产流），
 *   「当前生图路由」即我们的 image_generate → 逐字接入。
 * - SKILL_STORYBOARD.md：Step 4 的 `python ~/.openclaw/skills/film-master/main.py`
 *   CLI 调用 → 剔除整段 bash 示例，改写为「用 image_generate 工具逐格提交」
 *   （映射：BananaPro 生图 = image_generate）。三幕九格框架/核心锁定/负面指令/
 *   迭代规则逐字保留。
 */
const FILM_MASTER_TEXT = `# 电影分镜设计

## 目标

先完成导演判断，再写生图提示词。模型只是执行端，不把任何供应商或旧模型写进创作方法。

## 每镜必须明确

1. 本镜叙事任务：新信息、情绪变化或动作结果。
2. 主体与动作瞬间：选择动作最有张力、最容易读懂的一帧。
3. 景别与机位：远景到特写的理由、机位高度、俯仰、正侧逆角度。
4. 镜头与空间：焦段感、前中后景、视线方向、轴线关系、留白。
5. 光线与材质：主光方向、色温、环境反射、时间天气、关键材质。
6. 连续性：人物身份、服装、道具状态、场景结构、动作接点和色彩系统。

## 工作流

1. 读取剧本、工坊镜头和已有资产。缺少关键信息时只询问会改变画面的内容。
2. 先输出镜头表，至少包含镜号、时长、叙事任务、景别、机位、动作、运镜意图和剪辑接点。
3. 有多镜头共享环境时，自动应用内部"分镜生图一致性规则"：先建立环境锚定图，再由锚定图生成角度和动作变体。
4. 人物参考使用工坊角色资产模板；场景、角色、道具和色卡按镜头真实引用，不虚构不存在的 \`@图片\`。
5. 为每镜写可直接生成的完整提示词。色卡只在末句统一说明一次，不在每个短句重复。
6. 用户确认镜头方案后，调用当前选择的生图模型。单镜可以单独生成，不强制整组生成。

## 质量检查

- 景别变化服务叙事，不机械轮换全中近特。
- 特写必须写清被裁切部位、焦点和背景占比，不能只写"特写"。
- 角度必须写机位高度、俯仰和主体朝向，避免模型默认平视正面。
- 同场景镜头保持空间拓扑、光源方向和重要物件位置。
- 不堆导演名、摄影机名和形容词；画面中的动作、关系和可见细节优先。

# 九宫格三幕叙事分镜技能

基于三幕叙事结构的九宫格分镜生成规范。系统自动为每格分配景别、角度、镜头类型，用户只需提供核心叙事和风格参数。

## 三幕九格叙事框架

### 第一幕 · 建立世界（格1-3）

| 格号 | 叙事功能 | 自动分配景别 | 自动分配角度 | 自动分配镜头 | 推荐布光 |
|------|----------|------------|------------|------------|--------|
| 格1 | **开场定调**：建立故事发生的时空环境，定调整体情绪，营造史诗感/孤独感/奔赴感 | 大远景（Extreme Long Shot） | 高角度俯拍 / 航拍 | 广角24mm，深焦全清晰 | 黄金时刻自然光，柯达5207 |
| 格2 | **主体亮相**：完整展示核心主体（人物/车辆/场景），交代主体与环境关系 | 全景（Full Shot） | 低角度仰拍 / 眼平平拍 | 35mm变形宽银幕 | 三点布光，轮廓光勾勒主体 |
| 格3 | **第一幕事件**：故事冲突萌芽或目标确立，情绪开始集中 | 中景（Medium Shot） | 眼平平拍 | 50mm球面标准，浅景深 | 三点布光，暖色调引导线 |

### 第二幕 · 发展冲突（格4-6）

| 格号 | 叙事功能 | 自动分配景别 | 自动分配角度 | 自动分配镜头 | 推荐布光 |
|------|----------|------------|------------|------------|--------|
| 格4 | **冲突升级**：核心矛盾展开，行动开始，节奏加快 | 中景（Medium Shot） | 眼平平拍 / 荷兰斜角（紧张场景） | 35mm变形宽银幕，对角线构图 | 互补色对比，强化冲突感 |
| 格5 | **高压节点**：张力最大，情绪顶点之前，画面最压迫 | 近景（Medium Close Up） | 低角度仰拍（压迫感） / 荷兰斜角 | 50mm / 长焦85mm，极浅景深 | 单光源硬光，冷调，高对比 |
| 格6 | **转折时刻**：情绪或行动发生关键转折，叙事拐点 | 近景（Medium Close Up） | 眼平平拍 | 50mm球面标准 | 伦勃朗光，暗部丰富 |

### 第三幕 · 高潮收尾（格7-9）

| 格号 | 叙事功能 | 自动分配景别 | 自动分配角度 | 自动分配镜头 | 推荐布光 |
|------|----------|------------|------------|------------|--------|
| 格7 | **高潮爆发**：核心高潮，情绪/动作最强烈时刻 | 中景 / 全景 | 低角度仰拍，强化爆发感 | 35mm变形宽银幕，稳定跟拍 | 三点布光+强轮廓光，暖金色 |
| 格8 | **情绪宣泄**：高潮后情绪释放，内心独白，共情时刻 | 近景（聚焦面部） | 眼平平拍 | 长焦85-135mm，极浅景深 | 蝴蝶光 / 伦勃朗光，柔和 |
| 格9 | **升华结局**：主题升华，叙事闭环，史诗感收尾 | 大远景 / 全景 | 高角度俯拍 / 大远景回归开篇视角 | 广角24mm，深焦全清晰 | 蓝色时刻冷调 / 黄金时刻暖调 |

## 全程一致性锚定（每个提示词开头必加）

\`\`\`
【核心锁定】：{主角造型、服饰、面部特征}、{主要道具/车辆型号与颜色}、
整体色调、{胶片型号}、变形宽银幕镜头参数，全9格全程固定不变，
仅改变景别、拍摄角度、人物动作、环境背景。
\`\`\`

实测：加入核心锁定指令后，系列画面一致性提升 85%，是九宫格生成最关键的一步。

## 执行流程

1. 解析参数：核心叙事（故事主线）、电影类型、角色/主体物理描述、胶片质感、画面比例、参考图（可选）
2. 拆解九格脚本：主体在该格做什么、所处什么环境、传递什么情绪、对应叙事功能
3. 构建每格提示词：开头加全程核心锁定，景别/角度/镜头严格按框架自动分配，不得由用户自行修改
4. 批量执行生图：用 image_generate 工具逐格提交（每格独立请求，可单格重做；生成动作需经过用户确认和质量检查）
5. 输出结果：完整9格提示词脚本（含格号、叙事说明、完整提示词）+ 系列一致性迭代建议

## 通用负面指令（每格必加）

\`\`\`
禁止出现：水印、logo、二维码、签名；
严格规避：畸形肢体、五官错位、比例失调、透视错误、穿模；
画面不得包含：过曝、死黑无细节、噪点过多、涂抹感；
所有画面符合现实世界物理光学规律，全9格画面风格、色调、主体造型保持高度一致。
\`\`\`

## 迭代优化（系列一致性核心规则）

- **禁止整格重绘**：单次只改 1 个维度（如「保持画面其他所有内容完全不变，仅将构图从三分法改为对角线」）
- **跨格一致性修复**：若某格与其他格色调偏差，在该格提示词开头强化「核心锁定」指令，重新生成该格
- **分镜节奏调整**：若整体节奏偏快/偏慢，可在格3或格6处增加一个「过渡镜头」，用近景/中景补充情绪衔接`;

/**
 * ── skill 3/5：分镜生图一致性规则（skills/scene-image-anchor/ 三个文件）──
 *
 * 审计：SKILL.md 无外部工具引用（@图片N 规则与我们的多参考图生成入口一致）；
 * workflow.md/examples.md 的 text-to-image / image-to-image / --image / --no-image
 * CLI 语法 → 映射为我们的 image_generate（无参考图）与 image_edit（带参考图）。
 * 逐字保留分组/串并行/锚定图方法论，仅 CLI 字样改写。
 */
const SCENE_IMAGE_ANCHOR_TEXT = `# 分镜生图一致性规则

本规则自动用于工坊、画布和普通对话中的分镜生图。

## 先判断已有参考

1. 有正式分镜板：分镜板负责构图、景别和人物关系，必须排在参考顺序前部；它不是场景图。
2. 有场景资产：场景资产是环境锚点，优先保持空间结构、材质、光源方向和时间天气。
3. 没有场景资产：同一环境第一次生成的合格画面成为锚点，后续同环境镜头以它做图生图变体。
4. 只有一镜时仍检查角色、场景、道具和色卡引用，不强制额外生成锚点图。

## 多镜一致性

- 按地点、时间、天气和主要光源分组。同组共享锚点，不同环境不能强行共用。
- 变体允许改变机位、景别、人物动作和局部陈设，不改变房间拓扑、地貌结构、门窗位置、关键材质和主光方向。
- 人物身份与服装来自工坊角色资产模板；道具状态必须承接前后镜头。
- 色卡只在完整提示词末尾统一引用一次，不在每个短句重复色调。
- \`@图片N\` 必须来自当前真实 reference order。不得猜编号，不得把色卡、角色图或已生成视频误写成场景锚点。

## 生成策略

- 单镜可单独生成，不要求八张或整组。
- 多镜确认后可并行生成；同一环境先确认锚点成功，再并行生成变体。
- 重生成、任务列表重试和画布传递必须保留原参考图数组、顺序、模型、比例和分辨率。
- 使用当前界面选择的生图模型；本规则不绑定供应商。

# 场景图生成工作流 — 环境锚定法

## 第一步：场景分组

将所有镜头按 **环境类型** 分组。同一环境 = 同一空间/场景的多个角度或时间点。

| 判断维度 | 说明 | 示例 |
|---|---|---|
| 空间一致性 | 是否在同一个物理空间内？ | 航天器对接舱内部（镜3+镜4） |
| 色调一致性 | 是否共享同一色调方案？ | 外滩暖黄金色（镜9+镜10+镜11） |
| 光影一致性 | 是否共享同一光源设置？ | 暗黑虚空冷白光（镜1+镜2+镜5+镜6） |

**规则**：只要有两个及以上维度一致，就归为同一组。

## 第二步：串行/并行判断

\`\`\`
同组 = 串行（用锚定图保持一致性）
不同组 = 并行（互不影响，可同时跑）
\`\`\`

| 关系 | 条件 | 原因 |
|---|---|---|
| **并行** | 不同环境类型 | 航天器内部 vs 上海外滩，视觉无关联 |
| **并行** | 同组的不同细节变体 | 基于同一锚定图生成的多个角度，互不依赖 |
| **串行** | 同组且后者依赖前者的空间设定 | 镜3建立航天器内部 → 镜4在同一空间内变体 |

## 第三步：Phase 1 — 锚定图生成（全部并行）

每组生成1张锚定图，使用 image_generate 纯提示词生成（无参考图）。

\`\`\`
每组一条生成任务，全部并行启动：
├── 场景A锚定图  ← 纯文本生成
├── 场景B锚定图  ← 纯文本生成
└── 场景C锚定图  ← 纯文本生成
\`\`\`

锚定图是全组的视觉基准，必须完整描述该环境的所有视觉要素。

## 第四步：Phase 2 — 变体图生成（组间并行）

用 Phase 1 的锚定图作为参考，使用 image_edit（带参考图改图）生成变体。同锚定的多个变体之间也可以并行。

\`\`\`
全部并行启动：
├── 场景A变体1 ← image_edit, ref: 锚定A
├── 场景A变体2 ← image_edit, ref: 锚定A
├── 场景B变体1 ← image_edit, ref: 锚定B
└── 场景C变体1 ← image_edit, ref: 锚定C
\`\`\`

变体图提示词聚焦于该镜头的独特要素（角度、焦点、细节），参考图传入锚定图确保视觉一致性。

## 实战示例：向往 S7《降临》16 镜头分组

库布里克美学短片，三幕结构对应三个环境组：

### 组 A · 暗黑虚空·冷白单光源（第一幕·亮相）
- 镜 01-① ~ 01-⑥：车型局部特写（车标/前脸/尾灯/轮毂/内饰）
- 镜 02：全景亮相，纯黑背景中悬浮
- 共同点：空间一致（纯黑虚空） + 色调一致（冷白单色） + 光影一致（顶部硬光源）。三维度全对，归一组。

### 组 B · 暗黑工坊·聚光灯+机械臂（第二幕·装配）
- 镜 03 ~ 08：暗黑极简工坊内机械臂装配过程
- 共同点：空间一致（工坊场景） + 光影一致（聚光灯）。色调比组 A 略暖（金属反光）。

### 组 C · 上海外滩·暖黄夜景（第三幕·入城）
- 镜 09 ~ 11：车辆在外滩巡游
- 共同点：空间一致（外滩） + 色调一致（暖黄） + 光影一致（夜景灯光）。

### Phase 1 锚定图提示词模板（组 A 示例）

\`\`\`
Stanley Kubrick 风格，纯黑无限虚空空间，单一冷白色顶光源（6500K, 硬光），
极简对称构图，一点透视，画面中心是漂浮的现代汽车（不强调具体型号），
高对比度，几何精确，无任何装饰元素。
35mm 胶片质感，颗粒细腻，Kodak Vision3 500T。

参数：16:9, 无参考图
\`\`\`

→ 产出 \`anchor-A.jpg\`（全组共用基准）

### Phase 2 变体提示词模板（镜 01-①示例）

\`\`\`
极特写镜头，聚焦车标，画面占比 60%，金属反射冷白光，
微距景深，车标边缘锐利，背景全黑虚化。

参数：16:9, 参考图 anchor-A.jpg
\`\`\`

→ 产出 \`shot-01-①.jpg\`（继承组 A 的色调/光影/虚空背景）

### 调度

16 张图，3+13 = 16 次生图调用。若直接 16 次纯文本生成，组内一致性几乎不可能保持。`;

/**
 * ── skill 4/5：电影镜头复刻分镜生成器（skills/storyboard-sketch/SKILL.md，部分接入）──
 *
 * 审计（外部工具剔除 → 自有工具接回；2026-09-28「还工具」）：
 * - Step 0 的 `vision_video_analysis` 工具 → 本站无此外部工具，剔除工具名；
 *   参考片取帧/拼板/切点候选改指本站 `video_evidence`（action=probe/frames/tile/tiles/boundaries）
 * - Step 2/6 的「image 工具」→ 剔除外部工具名，改指「查看 `video_evidence` 产出的帧/拼板 + 视觉通道」
 * - Step 1 的 ffmpeg 抽帧 CLI → 本站已有 ffmpeg 轮子（`video_evidence` 内部即走它），改指 `video_evidence`（action=frames）
 * - Step 3 的「逐帧调用Gemini」→ 剔除外部调用方式，保留线稿 prompt（生图走 image_generate）
 * - Step 4 的 PIL 拼 3x3 网格脚本 → 本站已有 PIL/python 拼板轮子；视频帧拼板走
 *   `video_evidence`（action=tiles），草图网格走本站拼板能力（`shot_grid_batch` / `run_py`）
 * - Step 7 飞书发送 + message action=send channel=feishu → 剔除整段（改写为展示给用户确认）
 * - 「API配置」段（dmxapi.cn 端点 / DMXAPI_KEY）→ 剔除（我们有 image_generate，禁止暴露外部端点）
 * - 「依赖」段 → 剔除（外部 Python 依赖与 DMXAPI_KEY 不适用；ffmpeg/PIL 本站已有轮子）
 * - 远端链接取片：本站在线视频可直接用 `video_evidence`（action=fetch），但要先 `video_fetch`（action=prepare）
 *   预热隔离环境；环境未就绪时 `video_fetch` 回 `video_fetch_unavailable`——正文如实写明，别让 agent 以为必定成功。
 * 保留：核心理念、构图规则、提示词工程公式（人物一致性/主角vs路人/禁文字/质感/剪影）、
 * 3x3 分镜提示词结构、中文文字生成策略、多轮微调。
 */
const STORYBOARD_SKETCH_TEXT = `# 电影镜头复刻分镜生成器（部分接入：方法论保留，工具链已映射到本站能力）

## 核心理念

复刻原片镜头的构图和光影，换上自己的角色。**构图来自原片，一切以此为锚。**

## 完整工作流

### Step 0: 视频风格分析

先用 \`video_evidence\`（action=probe）取得参考片的时长、帧率、音视频流与体积，再按需取帧（action=frames，可 action=tiles 拼板），据此分析原始视频/参考素材，提取视觉风格信息，输出风格档案：

（远端链接：先用 \`video_fetch\`（action=prepare）预热钉版 yt-dlp 隔离环境，再 \`video_evidence\`（action=fetch）抓回本地——视频取证内部用本站 ffmpeg 轮子取帧，不再让用户自己跑命令行。**边界：环境未 prepare 时 \`video_fetch\` 回 \`video_fetch_unavailable\`，此时如实告诉用户抓取不了，不要编造已抓到的内容。**）

\`\`\`json
{
  "lighting": "Cool overcast daylight (6500K)",
  "colorGrading": "cool blue-gray, desaturated",
  "mood": "cinematic, contemplative",
  "filmStock": "Kodak Vision3 500T, fine grain",
  "colorTemperature": "6500K",
  "saturation": "58%",
  "contrast": "medium-high",
  "cameraCharacteristics": "Cooke S4 prime lenses, steady tracking shots"
}
\`\`\`

此风格档案贯穿后续所有步骤，确保最终分镜与原片风格一致。

### 风格复用

如果已有之前生成的风格档案，可以跳过 Step 0，直接在后续步骤中使用。

### Step 1: 原片抽帧

用 \`video_evidence\`（action=frames）从参考视频按节奏抽帧：长段落每 3 秒一帧（\`every: 3\`）；需要细节的段落每秒一帧（\`every: 1\`）；极速搜索每秒 2 帧（\`every: 0.5\`）。也可用 \`at: [...]\` 指定时点、\`every_frame\` 逐帧；\`at\` 与 \`every\`/\`every_frame\` 互斥，\`at\` 必须严格递增且都小于片长。需要一次看多帧时用 \`tile\` 拼板（或 action=tiles，分页网格，\`columns\` 默认 3、\`cell\` 默认按来源帧宽取 min(480, 宽) 且不低于 80）。帧数多就先 \`cut\` 分段或 \`tiles\` 分页，别一次拉满。

### Step 2: 筛选9帧

查看 Step 1 产出的帧/拼板（\`video_evidence\` action=frames 带 \`tile\`，或 action=tiles），筛选**构图差异最大**的9帧：
- 排除构图重复的帧（同一角度、同一景别连续多帧）
- 保留：不同景别、不同角度、有人/无人、特写/远景的多样性
- 必要时可把特定用户要求的帧（如石块刹车、拿滑板）加回来

### Step 3: 批量生成草图

逐帧生成铅笔线稿：

\`\`\`
prompt = "Convert to clean pencil line drawing. Keep ONLY composition. Remove color, shading, text, details."
\`\`\`

保存为：\`{scene}_sk_{1-9}.jpg\`

### Step 4: 拼3x3网格

9张草图 resize 到 427x240，拼成 1281x720 的 3x3 网格图（不足9张时复制最后一帧补齐）。拼板是确定性操作：视频帧板用 \`video_evidence\`（action=tiles，默认 3 行分页）；草图网格用本站拼板能力（\`shot_grid_batch\` 或 \`run_py\` 的 PIL 链）。

保存为：\`{scene}_3x3_grid.jpg\`

### Step 5: 生成3x3分镜

传入：草图网格 + 人物三视图。保存为：\`{scene}_3x3_final.jpg\`

### Step 6: 质量检查

对网格图**逐格分析**（\`video_evidence\` 拼板产出 + 视觉通道），检查：
- 人物一致性（脸、发型、服装）
- 路人服装是否和主角撞衫
- 有无文字/水印/标注
- AI感强的格子（细节模糊、光影不匹配、肢体不自然）

### Step 7: 展示给用户确认 → 存档

3x3 分镜展示给用户确认后存档。

## 提示词工程（通用方法论）

### 人物一致性公式

\`\`\`
CRITICAL COSTUME RULE: Woman wears THE EXACT SAME OUTFIT in EVERY panel:
- {逐项列出每件服装，用中文+英文}
- {每项后面加"ALWAYS on her"或"NEVER remove"}

She keeps her EXACT face from image 2 in every close/medium panel.
\`\`\`

**要点**：
- 逐项列明，不要笼统说"same outfit"
- 用"ALWAYS""NEVER""MUST"等强调词
- 特殊场景单独说明服装变化（如冰川穿红色外套）

### 主角 vs 路人区分公式

\`\`\`
- The WOMAN (from image 2): wears {主角服装}. She has the EXACT face from image 2.
- ALL OTHER PEOPLE: wear COMPLETELY DIFFERENT {路人服装描述}.
  They do NOT wear {主角特有服装项}. They have GENERIC faces (do NOT copy the woman's face).
- The woman's outfit MUST look different from everyone else's.
\`\`\`

**要点**：
- 明确写出路人穿什么
- 明确写出路人不穿什么（主角特有项）
- 路人面部用"generic faces"，禁止AI复制主角脸

### 禁文字标准句（必加）

\`\`\`
ABSOLUTELY NO TEXT of ANY KIND. This means:
- NO letters (no A-Z, no a-z)
- NO numbers (no 0-9)
- NO words, labels, annotations, descriptions
- NO symbols that look like text
- If unsure, leave blank rather than add text
\`\`\`

**要点**：
- 不能只写"NO TEXT"，AI会无视
- 必须展开说明什么类型的内容都不允许
- Gemini特别喜欢加"WIDE""CLOSE""AERIAL"等镜头标注

### 质感/材质强化公式

当需要特定材质效果时（如冰川、水面、岩石）：

\`\`\`
CRITICAL {材质名} TEXTURE: {材质} must look REAL:
- {细节1：如 "deep blue crevasses with jagged irregular edges (NOT smooth geometric lines)"}
- {细节2：如 "natural imperfections, dirt spots, wind-blown patterns"}
- {正面描述}，{反面禁止}（如 "cold, ancient, raw - NOT smooth or polished"）
\`\`\`

### 剪影场景公式

\`\`\`
CRITICAL: ALL people are PURE DARK SILHOUETTES against {背景}.
NO facial details visible. No skin tone visible. Pure black silhouettes.
{描述人物剪影轮廓特征：长发、帽子形状、身高对比等}
\`\`\`

## 构图规则

### 可替换（场景层）
- 地点（城市→新疆→花海）
- 植被（草地→花田→雪地）
- 建筑（现代→毡房→传统民居）
- 天气/时段（阴天→黄金时刻）
- 原片没有但用户想要的细节动作（石块刹车、拿滑板特写等）

### 不可变（构图层）
- 摄影机角度（俯拍/仰拍/平视/航拍）
- 人物在画面中的位置（左1/3、居中、右下角等）
- 景别（远景/中景/近景/特写）
- 画面比例（16:9横幅）

### 原片没有的细节怎么办？
- 在提示词的对应Panel描述中加入新动作
- 草图网格仍然作为整体构图参考
- 新动作用文字精确描述，AI会根据构图框架填入

## 3x3分镜提示词结构

\`\`\`
TWO images:
1st: 3x3 pencil sketches of {场景}. Composition reference only.
2nd: CHARACTER reference - this woman's EXACT face and {服装}. She appears in every panel.

CRITICAL RULES:
{人物一致性公式}
{主角vs路人区分公式（如果有多人）}
{禁文字标准句}

Create 3x3 FILM STILL GRID, 9 panels, thin dark borders, 16:9. ALL panels are {场景统一描述}.

Kodak Vision3 500T ISO 640, 5200K, 58% saturation, {色调}, fine grain.

P1: {景别} - {构图+动作+场景描述}. {情绪}.
P2: {景别} - ...
...
P9: WIDE FINAL - {结尾大景}. {情绪}.

ARRI ALEXA, Cooke S4. 16mm grain. {色调}. ZERO TEXT. NO watermark. NO AI look.
\`\`\`

## 参考图最佳实践

- **数量**：2-3张（草图网格+人物三视图），传太多timeout
- **分辨率**：压缩到600px、quality=50传入，1K比2K稳定
- **草图网格**：1281x720 (9×427x240)，质量85
- **人物三视图**：必须传入，是人物一致性的唯一锚点

## 多轮微调

- R1→分析问题→R2修正，比单轮强
- 例：R1有门→"NO DOORS"→R2修正成功
- 修正时传入R1图片+指出具体问题

## 中文文字生成（底层能力缺陷）

AI不是"写字"是"画像素"，笔画越多越容易画错。

**核心原则**：文字越少越准确，其余抽象化
- 1-3字：大概率正确
- 4-6字：可接受
- 7+字：高风险
- 段落：不可能正确，必须抽象化

**策略**：只保留2-5个核心文字，其余用抽象色块代替。指定黑体，明确禁止自由发挥。`;

/**
 * ── skill 5/5：参考片复刻（skills/video-style-replication/SKILL.md，部分接入）──
 *
 * 审计（外部工具剔除 → 自有工具接回；2026-09-28「还工具」）：
 * - `timeline_analyze_reference_video`（外部剪辑项目工具）→ 剔除工具名；参考视频分析
 *   改指本站 `video_evidence`（action=probe/frames/tile/tiles/boundaries/cut/fetch）
 * - `timeline_kimi_edit_plan`（外部剪辑工具）→ 剔除；剪辑执行计划由 agent 基于
 *   `video_evidence` 产物自行输出
 * - 「外部参考视频分析链路」→ 改写为「参考视频分析」（本站无该外部链路）
 * - 词级转写：本站 `video_transcribe`（{source, language} → 每词 start/end 秒，
 *   `eimu.transcript@1` 形状；ASR 未配置时回 `asr_unavailable`，正文如实写明此边界；
 *   language 不接受 auto/und）
 * - 台词量测：本站 `video_measure`（中文沿用 4.5 字/秒口径：传 rate: 4.5；英文音节启发式估算）
 * - 远端参考片：`video_fetch`（action=prepare/fetch/status，钉版 yt-dlp 隔离环境；
 *   未 prepare 回 `video_fetch_unavailable`）→ `video_evidence`（action=fetch）
 * - 「旧 ConversationGuide 或单张串行脚本」→ 剔除（内部黑话，与我们无关）
 * 保留：方法论（拆规则→分结构/内容→适配方案→交付物清单）、版权与内容安全红线。
 */
const VIDEO_STYLE_REPLICATION_TEXT = `# 参考片复刻（部分接入：方法论保留，分析工具已映射到本站能力）

复刻的是方法，不是复制受版权保护的角色、镜头内容或品牌资产。

## 工作流

1. 先取参考片硬信息：\`video_evidence\`（action=probe）拿时长、帧率、音视频流与体积。远端链接先 \`video_fetch\`（action=prepare）预热隔离环境再 \`video_evidence\`（action=fetch）抓回；**未 prepare 时 \`video_fetch\` 回 \`video_fetch_unavailable\`，如实说明抓不到，不要假装拿到片源。**
2. 取内容与切点：\`video_evidence\`（action=boundaries，\`rate\` 1..120、\`threshold\` 0..1）返回**机械式相邻帧变化候选＋分数**——这是候选不是剪辑判读，镜头切点与平均镜长由你结合画面对候选做人工确认；需要看画面时用 \`video_evidence\`（action=frames，支持 \`at: [...]\`/\`every\`/\`every_frame\`，\`at\` 与后两者互斥且必须严格递增；可 \`tile\`/\`tiles\` 拼板，\`columns\` 默认 3、\`cell\` 按来源帧宽取 min(480, 宽) 且不低于 80），保留关键帧和风格档案。
3. 转写与词级时间：\`video_transcribe\`（{source, language}）返回每个词的 start/end 秒（\`eimu.transcript@1\`：\`passages[].words[{text,start_seconds,end_seconds,score}]\`），用于信息顺序、字幕与表演节奏。**边界：ASR 未配置时该工具回 \`asr_unavailable\`——此时如实告诉用户无法转写，绝不编造台词与时间；缺时间戳就保持缺，不要补。language 不接受 auto/und（auto 由客户端解析并记 warning）。**
4. 台词量测：\`video_measure\`（{text, language, pace|rate, rounding, padding}）量台词时长——**中文要对我们自己的短剧口吻，传 \`rate: 4.5\`（4.5 字/秒）**；不传则用默认表（zh normal 5.25），英文是音节启发式估算，须向用户标明是估算。
5. 把参考片拆成可迁移规则：开场钩子、信息顺序、平均镜长、景别分布、机位与运镜、表演节奏、转场、声音、字幕和图形包装。
6. 区分"必须保留的结构"与"只属于原片的内容"。后者必须换成用户的角色、场景、品牌与叙事素材。
7. 输出 2 至 3 套适配方案，说明每套保留了什么、改变了什么、制作成本和风险。用户确认后再生成分镜或剪辑计划。
8. 需要分镜时使用工坊角色模板、电影分镜规则和内部场景一致性规则；需要剪辑时输出剪辑执行计划。需要把参考片切成多段（有序不重叠）时用 \`video_evidence\`（action=cut，多段 \`keeps\`）；声音转文字走 \`video_transcribe\`（它自己抽音轨，不需要另找音轨工具）。
9. 生图可以并行，单镜也能独立重做。只有用户要逐镜审看时才逐张等待确认。

## 交付

- 参考片结构档案
- 用户内容的镜头表与节奏映射
- 关键画面提示词或正式分镜
- 视频生成提示词与剪辑执行计划
- 版权、真人和内容安全风险说明`;

/** 全部知识段落（注入用）。 */
export const KUNPENG_KNOWLEDGE_SECTIONS: readonly KunpengKnowledgeSection[] = [
  { id: "kunpeng-pre-generation-checklist", title: "生成任务提交前检查清单", text: CHECKLIST_TEXT },
  { id: "kunpeng-shot-patterns", title: "镜头模式路由", text: SHOT_PATTERNS_TEXT },
  { id: "kunpeng-reference-image-rules", title: "@ 图片引用规则", text: REFERENCE_RULES_TEXT },
  { id: "kunpeng-script-doctor", title: "剧本医生", text: SCRIPT_DOCTOR_TEXT },
  { id: "kunpeng-film-master", title: "电影分镜设计", text: FILM_MASTER_TEXT },
  { id: "kunpeng-scene-image-anchor", title: "分镜生图一致性规则", text: SCENE_IMAGE_ANCHOR_TEXT },
  { id: "kunpeng-storyboard-sketch", title: "电影镜头复刻分镜生成器", text: STORYBOARD_SKETCH_TEXT },
  { id: "kunpeng-video-style-replication", title: "参考片复刻", text: VIDEO_STYLE_REPLICATION_TEXT },
];

/** skill 审计结论表（报告锚定用；决策与改写明细见各段注释）。 */
export const KUNPENG_SKILL_AUDIT: readonly KunpengSkillAuditEntry[] = [
  {
    skill: "script-doctor",
    decision: "included",
    reason: "纯分析方法 + 报告格式，无外部工具/CLI/API 引用，零改写接入。",
    toolRewrites: [],
  },
  {
    skill: "film-master",
    decision: "included",
    reason: "SKILL.md 无外部工具引用；SKILL_STORYBOARD.md 的 main.py CLI 调用映射为 image_generate。",
    toolRewrites: [{ from: "python ~/.openclaw/skills/film-master/main.py --api-key ... --prompt ...", to: "image_generate 工具逐格提交" }],
  },
  {
    skill: "scene-image-anchor",
    decision: "included",
    reason: "锚定图方法论无外部依赖；text-to-image / image-to-image CLI 语法映射为 image_generate / image_edit。",
    toolRewrites: [
      { from: "text-to-image（CLI 端点）", to: "image_generate（纯文本生成）" },
      { from: "image-to-image + --image ref（CLI 端点）", to: "image_edit（带参考图）" },
    ],
  },
  {
    skill: "storyboard-sketch",
    decision: "partial",
    reason: "提示词工程公式与构图规则全保留；外部工具（vision_video_analysis / image 工具 / 飞书发送 / dmxapi 端点 / DMXAPI_KEY）剔除；抽帧与拼板改接本站 video_evidence（frames/tile/tiles，参数 at/every/every_frame、columns/cell），逐帧生图走 image_generate，远端参考片抓取走 video_fetch（prepare → video_evidence fetch）。",
    toolRewrites: [
      { from: "vision_video_analysis 工具", to: "video_evidence（action=probe/frames/tile/tiles/boundaries）" },
      { from: "image 工具（帧筛选+质量检查）", to: "video_evidence 产出的帧/拼板 + 视觉通道逐格检查" },
      { from: "ffmpeg 抽帧命令", to: "video_evidence（action=frames；本站已有 ffmpeg 轮子，工具内部即走它）" },
      { from: "逐帧调用Gemini 生成线稿", to: "逐帧生成铅笔线稿（prompt 保留；生图走 image_generate）" },
      { from: "PIL 拼 3x3 网格脚本", to: "视频帧板走 video_evidence（action=tiles，columns 默认 3）；草图网格走本站拼板能力（shot_grid_batch / run_py）" },
      { from: "远端参考片下载（yt-dlp 命令行）", to: "video_fetch（action=prepare 预热 → video_evidence action=fetch）；未 prepare 回 video_fetch_unavailable" },
      { from: "message action=send channel=feishu（飞书发送）", to: "展示给用户确认 → 存档" },
      { from: "dmxapi.cn API 端点 + DMXAPI_KEY", to: "剔除（生图走 image_generate，不暴露外部端点）" },
    ],
  },
  {
    skill: "video-style-replication",
    decision: "partial",
    reason: "方法论全保留；外部链路（timeline_analyze_reference_video / timeline_kimi_edit_plan / Kimi 链路 / ConversationGuide）剔除；参考片分析改接本站 video_evidence + video_transcribe + video_measure + video_fetch。",
    toolRewrites: [
      { from: "timeline_analyze_reference_video（外部剪辑项目工具）", to: "video_evidence（probe/boundaries/frames/tile/tiles/cut/fetch）" },
      { from: "timeline_kimi_edit_plan", to: "基于 video_evidence 产物输出剪辑执行计划" },
      { from: "Kimi 参考视频分析链路", to: "参考视频分析（video_transcribe 词级时间 + video_measure 台词量测）" },
      { from: "外部 ASR/转写链路", to: "video_transcribe（{source, language} → eimu.transcript@1 词级 start/end 秒；未配置回 asr_unavailable）" },
      { from: "外部台词量测/朗读时长估算", to: "video_measure（中文对我方短剧口吻传 rate: 4.5；英文音节启发式估算）" },
      { from: "旧 ConversationGuide 或单张串行脚本", to: "剔除（内部黑话）" },
    ],
  },
];

/**
 * Seedance 规则对账结论（kunpeng vs 现有 higgsfield-seedance 知识）：
 *
 * 一致（无需处理）：
 * - 符号规范：台词{}、音效<>、音乐（）、字幕【】——两边一致
 * - @图片N 中文数字位置编号、场景图必须第一张、逐张核对——一致
 * - 一个镜头只指定 1 种运镜——与「ONE PRIMARY ACTION / name the camera with an endpoint」精神一致
 * - 情绪外化为肌肉动作、禁止开关式瞬变——与 EMOTION = MUSCLE 一致
 * - 时长秒数作节奏参考不强依赖——与我们 durationSeconds 处理一致
 * 补充（kunpeng 独有，作为补充段落引入，不删现有规则）：
 * - VO 行仅用于旁白/画外音；画面内对白写进镜头行（higgsfield 无此区分）
 * - 多主体定义标签防双胞胎（<主体N> 定义 + 贯穿使用 + 全局禁止分身约束）
 * - 人物参考图优先单人独立照、不用三视图/多视图
 * - 音频不占图片编号、仅文字引用音色
 * - realPersonMode 参数
 * 冲突（以不破坏现有生图/生视频链路为凖，处置如下）：
 * - 语言方向：现有 director 要求输出英文 prompt；kunpeng 模板是中文格式（分镜场景设定在：…）。
 *   处置：kunpeng 中文格式仅适用于 Seedance 中文原生链路（多模态参考图提交），
 *   与英文六槽公式并存——按用户是否走 Seedance 分镜格式选择，互不覆盖。
 * - 负面指令：现有规则「POSITIVE PHRASING ONLY」；kunpeng 约束词带「不要生成Logo/水印」。
 *   处置：kunpeng 约束词按 Seedance 官方模板逐字保留（官方行为，短锁尾性质），
 *   不改写现有 invisible-prompt-director 的正向化逻辑。
 */
export const KUNPENG_SEEDANCE_RECONCILIATION = {
  consistent: [
    "特殊符号规范：台词{}、音效<>、音乐（）、字幕【】",
    "@图片N 中文数字位置编号 + 场景图第一张 + 逐张核对",
    "一个镜头只指定 1 种运镜",
    "情绪外化为肌肉动作、禁止开关式瞬变",
    "时长秒数作节奏参考、不强依赖",
  ],
  added: [
    "VO 行仅用于旁白/画外音；画面内对白写进镜头行",
    "多主体定义标签防双胞胎（<主体N> + 全局禁止分身约束）",
    "人物参考图优先单人独立照、不用三视图/多视图",
    "音频不占图片编号、仅文字引用音色",
    "realPersonMode 参数",
  ],
  conflicts: [
    "语言方向：kunpeng 中文分镜格式与现有英文六槽公式并存，按是否走 Seedance 分镜格式选择，互不覆盖",
    "负面指令：kunpeng 约束词（不要生成Logo/水印）按官方模板逐字保留，不改写现有正向化逻辑",
  ],
} as const;

/**
 * 组装完整注入文本：来源声明 + 各知识段落。
 * 沿 agent-templates.directive 同一链路（sessionDirective → 网关 system 注入）。
 */
export function buildKunpengKnowledgeInjection(): string {
  const header = `以下是鲲鹏创作知识库（来源：${KUNPENG_SOURCE.sourceName} @ ${KUNPENG_SOURCE.sourceCommit}，${KUNPENG_SOURCE.license} License）。这些规则与现有生成规范并存：与本站现有规范冲突时，以本站规范为准，kunpeng 规则作为补充。`;

  const sections = KUNPENG_KNOWLEDGE_SECTIONS.map((section) => section.text).join("\n\n---\n\n");

  const toolContract = `工具边界：本站 agent 可用的生成工具只有 image_generate / image_edit / image_upscale / canvas_get_state / canvas_apply_ops（及画布/工作流工具）；影片取证与分析工具为 video_evidence（action=probe/frames/tile/tiles/boundaries/cut/fetch；frames 的 at 与 every/every_frame 互斥，boundaries 回机械式候选+分数不是剪辑判读）、video_transcribe（{source, language} → 每词 start/end 秒，形状 eimu.transcript@1；ASR 未配置时返回 asr_unavailable，缺时间戳就保持缺、不得编造；language 不接受 auto/und）、video_measure（台词量测：中文要对我方短剧口吻传 rate: 4.5，不传则用默认表 zh normal 5.25，英文为音节启发式估算）、video_fetch（action=fetch/prepare/status，钉版 yt-dlp 隔离环境；未 prepare 时回 video_fetch_unavailable，此时 video_evidence 的 fetch 不可用）。知识库中提到的任何其他工具名（如 vision_video_analysis、timeline_*、lark-cli、飞书、runninghub、dmxapi）均已剔除或改写——遇到需要这些能力的场景，用纯指导文字向用户说明，绝不虚构工具调用。`;

  return `${header}\n\n${sections}\n\n---\n\n${toolContract}`;
}
