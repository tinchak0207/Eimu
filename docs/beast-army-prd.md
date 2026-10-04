# 野兽模式「专家军团作战」大 PRD（暴君 09-10 亲定范式）

> 目标：beast ON 时，任务按「专家军团作战方法论」真实运转——研究军团先行（web 搜索弹药）、交叉契合度分析、多毒蛇并发评审（视觉审核通路）、agent-evolve 式返工、成片毒舌终审。
> 三类工作：①纯提示词（playbook v1.3 已上 VPS ✅）②Harness 工具增强（本 PRD 主体）③后端+Harness 配合（实测后迭代）。
> 三路并发铁律推进到做完；每片 20-40 分钟，2x 杀线。

## 现状与缺口（09-10 验尸）

- ✅ playbook v1.3 军团范式已注入（第〇节：研究先行/世界第一标尺/Orchestrator 纯度/极专业细分技能/多轮闭环）
- ❌ 研究 subagent 没有 web 搜索工具——「研究 2026 日本动漫」只能靠模型内部知识（过时且无实证）
- ❌ 毒蛇评审 subagent 没有读图通路——「美观/构图/色彩」审核无从下手
- ❌ playbook 范式未挂接具体工具名（模型不知道研究该调 web_search、审核该调 vision_analyze）
- ⏳ 3D 预演环节：blender Expert 已可用（blender_exec/render），playbook 已指派——待实测验证
- ⏳ agent-evolve 式返工循环：纯提示词可指导，待工具到位后实测

## 片清单

| 片 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| R0 | 本地 Harness 素材库盘点 → 军团化接入清单（见文末 R0 节） | - | ✅ 完成 |
| R1 | web_search harness 工具（Tavily 上游，本地 key 已有）→ staging 导出 → VPS 部署 → env 注入 | - | 进行中 |
| R2 | vision_analyze harness 工具（Gemini API 读图，审美审核维度 prompt 模板）→ 部署 → 复用现有 GEMINI_API_KEY | - | 进行中 |
| R3 | playbook v1.4：第〇节挂接 web_search/vision_analyze 工具名＋研究/评审 subagent spec 模板 | R1+R2 | ✅ 完成（09-10，本地+VPS 已部署，md5 对齐） |
| R4 | beast ON 全链实测原例「2026 日本动漫 MV」→ 逐环节取证（研究军团真派？契合度分析真做？多毒蛇真审？）→ 缺口清单 | R3 | 排队 |
| R5 | 按 R4 缺口迭代（后端+Harness 配合类） | R4 | 排队 |

## 成功标准

beast ON 发「制作一个和 2026 年日本动漫风格切合的动画片头曲 MV」后，真实观察到：
1. 研究军团 subagent 派出且引用 web_search 结果（有 URL 出处的研究结论）
2. 曲/分镜创作引用研究结论（配方可追溯）
3. 契合度分析与模型风险映射 subagent 跑过（成功门槛成文）
4. 多毒蛇评审 subagent 并发≥2 且引用 vision_analyze 读图证据
5. 返工循环至少 1 轮（评审结论→修复→复审）
6. 成片＋毒舌终审结论

## 凭证弹药（已盘点）

- Tavily：本地 `/home/lenovo/.agents/skills/aggregate-search/.env`（tvly- 开头，1 条）→ R1 传 VPS（0600）
- Gemini：VPS `.env`/`.env.opencode` 已注入 → R2 直接用

---

# R0 盘点节：本地 Harness 素材库 → 军团化接入清单（09-10）

> 盘点方法：每项只读 SKILL.md 头部 description＋目录/段落结构，未通读。凡未亲眼读到的内容一律标「未读」，不脑补。
> 接入方式三选一定义：【嵌入 spec】= 内容复制进 subagent prompt（一次性、零运行时依赖）；【skill path】= 引用 repo/skill 目录路径由 subagent 现场读（有先例：expert-registry `skillPaths` 字段 + music-director/blender-director 挂载）；【工具化】= 造 harness 工具（重成本，仅高频复用才值得）。

## 前置实锤：现有挂载机制（R3 引用即成立）

- `src/lib/expert-registry.ts` 每个 Expert 行有 `skillPaths: readonly string[]` 字段（L106），7 个 Expert 全有（music → `skills/music-director/SKILL.md` + files/ 目录；web3d → `skills/web-3d-awwwards/SKILL.md`；motion → `skills/motion-design/` 域目录）。**军团 subagent 沿用此模式 = 零新机制**。
- VPS 真源在 `/opt/agent-harness/workspace/.opencode/tools/`（harness-tool-registry.ts L1-9），本地 `skills/` 目录是否同步上 VPS 由部署流程管，R3 引用前需确认目标路径在 VPS 存在。

## 表一：军团环节 → 素材映射

### 研究军团（世界观/作曲理论/受众情绪）

| 环节 | 素材 | 位置 | 内容（读过的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| Web 搜索主力 | **R1 web_search 工具**（进行中） | harness 工具 | Tavily 上游，key 已在本地 aggregate-search/.env | 【工具化】R1 已在做 | 军团每次作战都要搜索，必须是 harness 工具而非 prompt 素材 |
| Tavily key 与用法 | tavily skill（`tavily-search-1.0.0`，名 `tavily`） | `~/.agents/skills/tavily-search-1.0.0/SKILL.md` | AI 优化 web 搜索 API 封装，env `TAVILY_API_KEY` | 【嵌入 spec】3 行 | 只需告知「R1 工具已封装 Tavily」，不需要 skill 全文 |
| Reddit 深挖（受众情绪/流行语料） | reddit-miner | `~/.agents/skills/reddit-miner/SKILL.md`（150 行） | arctic-shift 存档 API（`https://arctic-shift.photon-reddit.com/api`，免 key、官方 reddit 全 403 仅此入口可靠）、意图×态度交叉表、高频短语提取、踩坑清单（L134-143） | 【嵌入 spec】只嵌 L24-30（API base+要点）+ L134-143（踩坑），或全档 150 行也可接受 | 免 key、纯 HTTP → 研究军团 subagent 可直接 curl；150 行小于一份 spec 模板，嵌入无稀释风险 |
| 多平台聚合（B站/小红书/Telegram） | aggregate-search | `~/.agents/skills/aggregate-search/SKILL.md`（73 行） | B站 WBI 签名/Reddit arctic-shift/GitHub API 免登录可用；Tavily/Telegram(Telethon)/小红书(xhs-cli)/X(twikit) 需配置；含 `scripts/` 本地脚本 | 【工具化】❌ 暂不 / 【嵌入 spec】❌ 太薄 → **裁定：嵌入「能力声明」2 行，平台矩阵留 skill path** | scripts 在本机不在 VPS；研究 subagent 只需知道「B站/Reddit/GitHub 免 key 可挖」，细节等 R4 实测暴露缺口再升级 |
| 边缘情报（地下论坛） | edge-knowledge | `~/.agents/skills/edge-knowledge/SKILL.md` | 依赖 browser-use 自动化+视觉识别产出 Markdown 报告 | 【嵌入 spec】❌ | 依赖本机 browser-use，VPS harness subagent 跑不动 → 短期不可用，标记「未接入，等有 VPS 浏览器通路再议」 |
| 通用视觉识别后备 | read-image | `~/.agents/skills/read-image/SKILL.md` | 本机脚本 gemini-3.7-flash 主/groq 后备，SSH 隧道链 | 【嵌入 spec】❌ | 本机专属链路，VPS 侧对应物就是 R2 vision_analyze，不重复造 |

### 创作军团（分镜/镜头 prompt/视觉锚定）

| 环节 | 素材 | 位置 | 内容（读过的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| 分镜卡→镜头 prompt | **shot-prompt 15-block**（film-studio-skills 七件套之一） | `~/.agents/skills/film-studio-skills/skills/shot-prompt/SKILL.md`（103 行） | 15 块结构（L46-60）：scene context→active references→location map→blocking→format→optics→camera body→action timing(0.3-0.8s beats)→physics→lighting→audio→acting→style prefix(60:30:10)→quality bar→positive constraints；明令不加负面 prompt 段 | 【嵌入 spec】（15 块标题+一句话，约 20 行） | 15-block 是「检查清单」不是「操作手册」，核心可压缩；完整档依赖 `/prompts/`、passport 档案系统（studio 树），VPS subagent 没有该树 → 整档 skill path 反而误导 |
| 资产一致性（角色/场景不漂移） | asset-passport | 同上 `skills/asset-passport/SKILL.md`（124 行） | 生成前建资产护照，角色/地点/道具/状态变体可重复视觉身份 | 【skill path】或嵌核心规则 | 护照理念=「verbatim 复制进每个 prompt」，与 harness `character_dna_turnaround`/`model_identity_lock`/`garment_dna_lock`（registry L46/L134/L132）天然同构 → 优先映射到已有工具，skill 只作方法论补充 |
| 通用 prompt 工程（SLCT/幻觉防治/镜头语言） | ai-ad-prompt-guide | `~/.agents/skills/ai-ad-prompt-guide/SKILL.md`（411 行，三段结构已实读） | Part1 通用规则（SLCT L17、幻觉防治 5 条 L52、镜头运动词汇表 L79、UGC L109、产品镜头 L145、pass³ L168）；Part2 模型分支（选型矩阵 L196：Sora2/Veo3/Kling/Flux/Nano Banana/Seedance）；Part3 API 自动化（L256-403，本地 credit 计费，与 harness 无关） | 【嵌入 spec】：Part1 全嵌（L15-193，约 180 行）；Part2 只嵌 Seedance/Kling 相关节；Part3 不嵌 | 视频军团每个分镜 subagent 都该带 SLCT+幻觉防治+镜头词汇——这是「写法基因」，必须逐字在 prompt 里；Part3 是别家 API 说明，嵌进去是毒药 |
| 图反推（参考图→结构词） | nuyoah-image-reverse-prompt | `~/.agents/skills/nuyoah-image-reverse-prompt/SKILL.md` | 参考图解构、色卡、反推中文 prompt | 【嵌入 spec】❌ / 待 R2 | 其价值一半在「生成返图校准」循环（需本机反覆生图）；VPS 有 vision_analyze 后可提取其分析维度段嵌入，现阶段标「素材已有，接入待 R4 实测」 |
| 平面设计产物 | canvas-design | `~/.agents/skills/canvas-design/SKILL.md` | 设计哲学→canvas 产出 png/pdf，两步法 | 【嵌入 spec】❌ | 产出物是本地档案绘制，MV 军团链路用不上；仅当终审要「海报类宣传物」时以 skill path 引用，非主线 |
| 音乐域配方 | music-director（已在 registry 挂载） | `skills/music-director/SKILL.md` + `files/` SunoForge 12 档 | 「音乐生成类请求必载本库，禁止凭记忆写音乐 prompt」 | 【skill path】✅ 已挂 | 既有资产，研究军团产出的作曲理论结论应写进其输入，不动配方库 |
| 3D 预演 | blender-director / blender-agent-os / make-blender-education-video | `skills/` 内三库（白名单复制上游，带 Blender 5.2 雷区注释） | 五阶段管线+12 份配方（blender-director）；agent-os 含 core/img2threejs/knowledge | 【skill path】✅ 已挂（blender-director-persona） | 既有资产，PRD 已指派 blender Expert，R4 验证即可 |

### 审核军团（多毒蛇并发评审）

| 环节 | 素材 | 位置 | 内容（读过的部分） | 接入方式 | 理由 |
|---|---|---|---|---|---|
| 读图证据 | **R2 vision_analyze 工具**（进行中） | harness 工具 | Gemini API 读图+审美审核维度 prompt 模板 | 【工具化】R2 已在做 | 毒蛇必须引用读图证据（PRD 成功标准 4） |
| 审美审核标准 | impeccable | `~/.agents/skills/impeccable/SKILL.md`（79 行）+ reference/ 子档 | 79 行主档是「设计总纲」（bounded passes 纪律/modes）；具体审核条目在 reference/ 子档（**未读**，仅确认存在） | 【嵌入 spec】：只嵌主档核心原则 ~30 行；毒蛇 spec 引 vision_analyze 的审美维度模板为主 | impeccable 面向 web UI（brief/modes/command 路由），与「动漫 MV 帧审核」域不匹配，全文嵌入是噪音；其「验证有界、不无限自审」纪律值得嵌 |
| 过程审核（资产锁定前压测） | stress-test（film-studio 七件套） | `~/.agents/skills/film-studio-skills/skills/stress-test/SKILL.md` | 「Combat-test draft film assets before locking」——passport/reference 存在后、场景生成前 | 【嵌入 spec】 | 这就是 agent-evolve 式返工循环在影片域的现成轮子：压测不过→回炉，正是 PRD 成功标准 5 |
| 方法论循环（评测→修复→复测） | agent-evolve | `~/.agents/skills/agent-evolve/SKILL.md` | 三阶段流水线：真轮子评测→暴君第一人称毒舌报告→逐句修复派工→复测闭环（沉淀自 2026-08-27 小说成片实战） | 【嵌入 spec】：嵌「三阶段+判决格式」骨架 | Orchestrator 级纪律而非 subagent 素材；playbook 第〇节已含其精神，R3 在毒蛇→返工环节点名引用 |
| 排版/UI 资料库 | ui-ux-pro-max（名 `ui`） | `~/.agents/skills/ui-ux-pro-max/SKILL.md` | 67 风格/96 色板/57 字体配对/99 UX 准则检索库，Python 检索 | 【嵌入 spec】❌ / 【skill path】❌ | 本机 Python 依赖+web UI 域不匹配；仅其「色彩/字体配对」资料未来或可提取，现阶段不接入 |

## 表二：接入方式裁定汇总（R3 直接抄）

| 素材 | 裁定 | 成本 | 一句话理由 |
|---|---|---|---|
| R1 web_search | 【工具化】（进行中） | 已沉没 | 军团基础设施，每战必用 |
| R2 vision_analyze | 【工具化】（进行中） | 已沉没 | 毒蛇读图唯一通路 |
| reddit-miner API 段 | 【嵌入 spec】 | ~30 行 | 免 key 纯 HTTP，嵌入即用，无部署 |
| aggregate-search | 【嵌入 spec】2 行能力声明 | 2 行 | 脚本在本机，VPS 不可跑；先声明后实测 |
| ai-ad-prompt-guide Part1 | 【嵌入 spec】 | ~180 行 | 写法基因必须逐字随行 |
| shot-prompt 15-block | 【嵌入 spec】 | ~20 行 | 检查清单性质；整档依赖 studio 档案树 |
| stress-test | 【嵌入 spec】 | 短（未逐行读） | 返工循环的影片域现成轮子 |
| impeccable 核心原则 | 【嵌入 spec】 | ~30 行 | 只取纪律与品味标尺，弃 web UI 域内容 |
| agent-evolve 骨架 | 【嵌入 spec】（playbook 层） | ~15 行 | Orchestrator 级纪律 |
| music-director / blender-director | 【skill path】✅ 已挂 | 0 | expert-registry 先例，零新机制 |
| asset-passport | 【skill path】＋映射已有 DNA 工具 | 0 | 护照理念已被 harness 工具实现 |
| nuyoah-image-reverse-prompt | 待 R4 | - | 价值在返图校准循环，VPS 暂无通路 |
| edge-knowledge / read-image / canvas-design / ui-ux-pro-max | 不接入 | - | 本机依赖或域不匹配 |

裁定总则：**研究/创作/审核三军的 subagent spec 全走【嵌入 spec】；域 Expert（music/blender/motion/web3d）沿【skill path】；只给「每战必用的基础能力」造工具（R1/R2 已在做，军团化不再新增工具化项）。**

## 表三：R3 spec 模板弹药（档名+行号，皆已实读）

### 研究军团 spec 模板嵌入清单
1. `~/.agents/skills/reddit-miner/SKILL.md` L26（API base URL）＋L134-143（实测踩坑 8 条，含降级 pullpush.io）——研究 subagent 的 Reddit 通路配方
2. `~/.agents/skills/tavily-search-1.0.0/SKILL.md` 头部 env 声明——仅提示 key 由 R1 工具注入，不嵌全文
3. `~/.agents/skills/aggregate-search/SKILL.md` L8-12（功能特点免登录矩阵）——B站/Reddit/GitHub 免 key 能力声明
4. R1 web_search 工具调用签名（R1 交付后补进模板）

### 创作军团 spec 模板嵌入清单
1. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L17-50（SLCT 框架+示例）＋L52-77（幻觉防治 5 条+触发表）＋L79-107（镜头运动词汇表）——分镜 subagent 必载
2. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L168-192（pass³ 质量测试）——分镜 subagent 自检＋毒蛇复用
3. `~/.agents/skills/film-studio-skills/skills/shot-prompt/SKILL.md` L46-60（15 块定义逐条）——镜头 prompt 的硬结构，明令「不加负面 prompt 段」（L62）
4. `~/.agents/skills/film-studio-skills/skills/asset-passport/SKILL.md` 核心规则——与 `character_dna_turnaround`（registry L46）绑定使用
5. `skills/music-director/`（skill path 引用）——音乐 subagent，研究军团作曲理论结论作输入

### 毒蛇评审 spec 模板嵌入清单
1. R2 vision_analyze 审美维度模板（R2 交付后补）——证据主体
2. `~/.agents/skills/ai-ad-prompt-guide/SKILL.md` L168-192（pass³）＋L52-77（幻觉防治）——毒蛇按此逐项开罚，与创作者共用同一标尺（双方都嵌 = 评审与被评审对表）
3. `~/.agents/skills/impeccable/SKILL.md` 核心原则节（~L20-33：brief wins / refinement preserves / bounded passes 纪律）——只嵌纪律，弃 web UI modes
4. `~/.agents/skills/agent-evolve/SKILL.md` 三阶段骨架——返工循环的判决格式（评分+逐句修复派工），供 Orchestrator 并入 playbook 而非毒蛇本体
5. `~/.agents/skills/film-studio-skills/skills/stress-test/SKILL.md`——「资产锁定前压测」岗位的操作依据（此档未逐行读，R3 引用前先读全文）

### 诚实备注（09-10 R3 更新：原「未读」项已逐个通读 SKILL.md 全文，嵌入裁定如下）

**已通读并嵌入 playbook v1.4 模板的**：
- stress-test（109 行全文）：嵌入精华=压测矩阵八栏（Test/Angle/Shot size/Scene lighting/Paired asset/Prompt/Result/Verdict）＋「角色 10/10 全过才锁定、miss 不可被好图平均」门禁→ 模板二【锁定前压测】节；档案操作（registry/passport 档读写）依赖 studio 树，未嵌。
- shot-prompt（103 行全文）：15-block 逐块定义＋「不加负面 prompt 段」→ 模板二【15-block 镜头 prompt 硬结构】；/prompts/ 树依赖未嵌。
- film-breakdown（112 行全文）：三 lane 22 栏（9+6+7）＋「单 clip 单动作 10-15s、画面文字分离」→ 模板二【分镜卡三 lane 22 栏】；breakdown.md 档案流未嵌。
- reference-board（118 行全文）：「参考是规格不是灵感、先有图后有描述、anti-reference 入 ban list（like this — not allowed）」→ 模板二【资产一致性】节；bible.md/图片数量配额未嵌。
- asset-passport（124 行全文）：canonical descriptor 完整 prose verbatim 复制、状态变体独立护照 → 模板二【资产一致性】节；与 harness DNA 工具同构，映射已在模板标明。
- setup / studio-init（104/110 行全文）：纯访谈式配置＋建树流程，**依赖本机 studio 档案树，VPS subagent 用不上 → 不嵌入，无可嵌规则精华**（四黄金规则「lock before generate / verbatim / one-line edit / version everything」精神已被模板二/三覆盖）。
- agent-evolve（301 行，关键节 L12-71/L145-197 已读）：判决格式（评分+逐条修复指令+未观察项声明）→ 模板三【verdict 规则】【产出格式】；三阶段骨架留在 playbook 军规 5，附录 A（VPS harness 教学）不嵌。
- impeccable 主档（79 行全文）：「验证有界（bounded passes，一轮批读+至多一轮复核）＋brief wins＋refinement preserves」→ 模板三【纪律】节；reference/ 子档群与 commands/modes 为 web UI 域，确认不嵌。

**维持不接入（理由不变）**：edge-knowledge / read-image / canvas-design / ui-ux-pro-max（本机依赖或域不匹配）；nuyoah-image-reverse-prompt（待 R4 返图校准循环）。
