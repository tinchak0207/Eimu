# eimu.art Agent 富养工具调研（2026-08-22）

调研来源：reddit-miner（arctic-shift，r/StableDiffusion、r/ComfyUI、r/midjourney、r/aiVideo、r/LocalLLaMA，120-240 天窗，240+ 帖）+ GitHub 生态搜索 + X 提到的 6 个工具实锤。

## 一、Reddit 信号结论（FACT）

- **r/midjourney、r/aiVideo 前排全是 showcase，零工具讨论**——工具情报不在 Reddit 主流生图板，而在 GitHub agent-skill 生态（X 上那批就是代表）。
- 真正有用的痛点信号（r/StableDiffusion + r/ComfyUI 高分帖）：
  1. **风格/角色一致性**是最大痛点（"Built a Character Portrait Generator that reads books, identifies characters, and generates consistent portraits" 240⭐；"HappyHorse 1.0 four shot anime sequence with character consistency across cuts" 583⭐）
  2. **脸部修复**独立成系统（"Advanced Face Detail Workflow for Z-Image Turbo" 462⭐；"How I Fixed Bad AI Faces (~1000 generations) — Simple Prompt System" 127⭐）
  3. **提示词系统化**（"SFW Prompt Pack v4.0" 143⭐；Anima json 格式 prompt 讨论 250⭐）
  4. **图→视频流水线**：GPT Image 2.0 生图 + LTX 2.3 生视频组合（167⭐）、3D Layout → Seedance 2（188⭐）

## 二、推荐安装清单（按价值/风险排序）

### A 级：直接提升 eimu.art Agent 生成质量（纯知识型 SKILL.md，零依赖，MIT）

| 工具 | ⭐ | 作用 | 许可 |
|---|---|---|---|
| `nuyoah-ai-works/nuyoah-xiezhen-prompt` | 329 | 中文写真/人像提示词系统：固定成像机制、单张现场光线、皮肤区域反射分层，避免直闪油膜；系列母版+同系列变体 | MIT |
| `nuyoah-ai-works/nuyoah-image-reverse-prompt` | 63 | 图片反推：参考图→结构字段+参考色卡+可生成中文提示词（图片证据驱动，不瞎猜原 prompt） | MIT |
| `creatify-ai/ai-ad-prompt-guide` | 37 | SLCT 提示词框架 + 幻觉防止 5 规则 + 12 镜头运动词汇 + Sora2/Veo/Kling/Flux/Nano Banana 模型差异表 + Pass³ 质检 | MIT |
| `machina-exm/film-studio-skills` | 88 | 7 技能链：剧本→锁定参考→asset passport（逐字复制进每个 prompt）→生成门禁→shot prompt。解决视频多镜头一致性 | 未标（需查） |
| `zhanghaonan777/Seedance2-skill` | 121 | Seedance 2.0 创意总监：100+ 镜头词库、四关创意审核、全模态 CLI（需 ARK_API_KEY） | 未标 |
| `threerocks/hand-drawn-styles` | 848 | 5 种已验证手绘画风配方（儿童涂色/极简线条/蜡笔/吉卜力/小豆人），产出可直接复制的提示词 | MIT |

### B 级：风格一致性（核心痛点，但注意许可）

| 工具 | ⭐ | 作用 | 许可 |
|---|---|---|---|
| `GenielabsOpenSource/style-consistency-ai` | 2 | 训练免费的角色/物体/世界观一致性：最小编辑原则（从最近参考做 delta 编辑而非重述风格）+ 参考 atlas 选最近视角 + 升级门禁 | **PolyForm NC（非商用！）** eimu.art 商用需联系 genielabs.tech 授权或仅借鉴方法论 |

### C 级：生成 API 封装类（eimu.art 已有自有控制面，参考价值为主）

| 工具 | ⭐ | 说明 |
|---|---|---|
| `wuyoscar/GPT-Image2-Skill` | 4795 | GPT Image 2 提示词画廊+库+CLI，MIT，提示词画廊部分可挖 |
| `SamurAIGPT/Generative-Media-Skills` | 4104 | 多模态生成 skill（图/视频/音频），MIT |
| `ConardLi/garden-skills` | 10475 | 综合技能集含生图，MIT |

### 用户 X 搜到但实锤后不推荐直接用的

- `ai-avatar-skill`：GitHub 无此确切仓库；近似物 heygen-com/skills（406⭐，绑定 HeyGen）、creatify-ai/ai-avatar-video（27⭐，绑定 Creatify API）——都是厂商引流壳，不适合自有 Agent。
- `agenthook`：agentic-thinking/agenthook（2⭐，生命周期 hooks 规范）——是 harness 规范不是生图工具，与 eimu 场景无关。

## 三、集成建议（最小有用干预）

eimu.art Agent 走自研网关（store.tinchak0207.xyz/agent），非 Claude Code，所以"安装"= 把 SKILL.md 内容接进 Agent 的技能注入通道（类似现有 skills 目录→系统提示注入）。建议第一批：

1. **nuyoah-xiezhen-prompt + nuyoah-image-reverse-prompt**（中文提示词两端：正向生成+反向拆解，直接匹配 eimu 中文用户群）
2. **creatify-ai/ai-ad-prompt-guide**（通用提示词质量框架，模型差异表对多路由场景有用）
3. **machina-exm/film-studio-skills**（视频多镜头一致性，asset passport 方法论可平移到自有视频管线）
4. style-consistency-ai **只借鉴方法论**（最小编辑+参考 atlas），不复制其 NC 许可文本进商用系统。

## 四、待用户决策

- 是否立即把 A 级 4 项的 SKILL.md 拉取并接入 eimu Agent 的技能注入？
- 接入方式：整包注入 vs 精简蒸馏成 eimu 自有 skill 格式？
