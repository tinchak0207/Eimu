A. 小说影视化（novel → 情节拆解 → 分镜 → 角色资产 → 场景概念 → 成组视觉产出 → 视频）

第1节：完整流水线拓扑
| 阶段 | 名称（行业黑话） | 输入 | 输出产物（可落盘） | 衔接方式 |
|------|------------------|------|---------------------|----------|
| 1 | Script Breakdown / Outline Extraction | 小说原文章节.txt / 结构化大纲需求 | 结构化剧本JSON（场次、节拍、角色表、爽点表、资产清单） | JSON字段注入下一阶段prompt；人工审核门禁后放行 |
| 2 | Character Bible & Stage-aware Asset | 大纲JSON + 角色列表 | 角色三视图转面表.png + DNA签名JSON + 阶段参考图（服装/伤势变体） | 参考图作为cref/IP-Adapter锚；DNA字段逐镜注入prompt |
| 3 | Art Bible / Scene & Prop Sheet | 大纲JSON + 角色资产 | 场景概念图 + 道具白底表 + Look Development关键帧 | sref锚点；无人无手白底提示词喂分镜 |
| 4 | Sketch-lock Storyboard | 剧本JSON + 资产表 | 分镜构图草图（黑白/线稿）+ 关键帧锁定包（主图钉0.00s + 子切点） | 草图锁定后才出彩图；切点时刻对齐视频提示词 |
| 5 | Keyframe Generation & Animatic | 锁定分镜 + 资产参考 | 每镜最终帧.png + 简易animatic预览 | 最终帧作为I2V起始/结束帧；一致性检查后批量 |
| 6 | Shot Video Synthesis & Assembly | 关键帧 + 视频提示词 | 单镜视频.mp4 + 拼接成片 + 剪映草稿 | FFmpeg/剪映按shot_order组装；情绪beat驱动J/L-cut |

拓扑核心：文本结构化 → 资产先行 → 门禁 → 组装。代表仓库：Jellyfish（end-to-end workspace）、shuohao-skills、ArcReel、Story Claw、wind-comic、NovelVids。

第2节：每阶段最优模型/工具与提示词写法
阶段1：LLM（Claude Code / DeepSeek-V4 / Qwen-3.8-Max / GPT系列）+ shuohao-skills novel-outline / drama-skills。提示词：字段化JSON（场次、动作/台词交替、时长按4.5字/秒折算、钩子前3拍）。
阶段2-3：Seedream / Flux / GPT-Image + IP-Adapter / StoryMaker；ComfyUI_StoryDiffusion。提示词：DNA签名（8维外貌）+ 白底无人无手 + 一致性锚。
阶段4：LLM + ControlNet/软边缘；sketch-lock优先黑白构图。提示词：镜头语言字段（景别、机位、运镜）+ 情绪标签。
阶段5-6：Seedance 2.x / Kling 3.0 / MiniMax H3 / Veo；StoryDiffusion自注意力。提示词：起始/结束状态一行定义 + 参考图锁 + 相对材质高光比例。

开源：StoryDiffusion（6.5k星）、ComfyUI_StoryDiffusion（514星）、shuohao-skills、Jellyfish（6.2k星）、ArcReel（4.2k星）、wind-comic（~453星）。

第3节：流水线品质关卡
最易翻车：分镜角色漂移、情绪断裂、阶段资产未更新（伤势/服装不匹配）、长序列一致性崩溃。  
验收标准：角色相似度阈值（视觉审计≥70分自动regen）；构图草图锁定后再出最终帧；剧本人工批准后才生成人物；分镜只输出不做新决定；17道质量门脚本检查（shuohao-storyboard）。

第4节：跨步骤一致性技术
角色**：提示词层——DNA签名结构化后逐镜注入 + cref绝对锁；工作流层——IP-Adapter / StoryMaker主体绑定、阶段参考图（仅服装变体时再生）、集中实体模型复用（Jellyfish）。
情绪连续性**：剧本层beat note / 情绪标签 → 分镜情绪字段 → 视频提示词“听见→停顿→眼神→表情→说话”时序链；Editor按情绪beat做J/L-cut。
风格锚定**：先出一张canonical key art作为全片sref；sketch-lock黑白构图锁定；StyleAligned注意力共享；固定seed + 相对高光比例（金属×1.5、皮肤×0.5）。

第5节：信息来源标注
GitHub：Jellyfish（Forget-C，6.2k星）、shuohao-skills（eternityspring）、ArcReel（4.2k）、StoryDiffusion（HVision-NKU，6.5k）、wind-comic（ChrisChen667788，453）、StoryMaker（~722）。X：@eternityspring 2026-08分镜skill开源帖；@Gorden_Sun 2026-08短剧自动化复盘；@thebitcode 2026-08流水线成本帖。部分阶段衔接为从多仓库拓扑推断。

B. 电商营销素材（产品白底图 → 场景图 → 模特图 → 营销主视觉 → 多画幅/多SKU批量适配）

第1节：完整流水线拓扑
| 阶段 | 名称 | 输入 | 输出产物 | 衔接方式 |
|------|------|------|----------|----------|
| 1 | Product Lock / White-bg Extraction | 单张产品原图 | 白底主图.png + 产品DNA（形状/logo/材质JSON） | 产品锁字段强制注入所有后续prompt |
| 2 | Scene Pack Generation | 白底图 + Scene Pack模板 | 氛围场景图组（Etsy/Shopify/Jewelry等预设） | 参考图作为精确产品锁；批量节点 |
| 3 | On-model / Lifestyle Shoot | 产品锁 + 模特参考 | 模特佩戴/使用图 + 多角度板 | IP-Adapter脸/体 + 产品一致性门禁 |
| 4 | Hero / Marketing Key Visual | 场景/模特图 | 主视觉英雄镜头 + 负空间CTA版 | 低机位/逆光/景深锁定 |
| 5 | Multi-aspect & Multi-SKU Batch | 主视觉模板 | 多画幅（1:1/9:16/16:9）+ 变体SKU适配包 | 批量渲染节点 + 元数据清理 |

代表：product-shots skills、NVIDIA Retail-Catalog-Enrichment、ProductScenes AI、ComfyUI batch workflows。

第2节：每阶段最优模型/工具与提示词写法
阶段1：rembg / BiRefNet + Flux/Seedream。提示词：PRODUCT LOCK绝对保留形状/比例/logo/纹理。
阶段2-3：GPT-Image / Seedream + IP-Adapter。提示词：字段化场景包 + 精确产品身份。
阶段4-5：MiniMax Design Agent / ComfyUI imageBatch → styleLock。提示词：英雄构图 + 负空间 + 画幅适配。

开源：motiful/product-shots（~31星，2026）、NVIDIA-AI-Blueprints/Retail-Catalog-Enrichment、ComfyUI相关batch节点。

第3节：流水线品质关卡
最易翻车：商品形变/logo糊、模特与产品比例失真、多SKU颜色漂移。  
验收：产品相似度阈值（VLM自动评分）；白底干净边缘检查；人工审核主视觉后才批量。

第4节：跨步骤一致性技术
角色/产品**：提示词层——PRODUCT LOCK段落强制；工作流层——单图参考贯穿 + IP-Adapter + 批量styleLock。
情绪连续性**：场景包预设情绪标签（奢华/日常/节日）从模板注入。
风格锚定**：canonical白底作为全链路锚；固定seed + 商业光效比例。

第5节：信息来源标注
GitHub：product-shots（motiful，~31星）、NVIDIA Retail-Catalog-Enrichment。X：@GeekCatX 2026-08电商无限画布工作流；@Hailuo_AI 2026-08 MiniMax Design商业工作流（高赞）。批量逻辑为从工具描述与X复盘推断。

C. 短剧制作（剧本拆场 → 分镜 → 主演角色资产 → CP剧照 → 竖屏海报 → 成片）

第1节：完整流水线拓扑
与A高度重叠但更垂直短剧节奏（≤15s/段、竖屏9:16、台词驱动）。  
阶段：novel-outline/script → characters/art bible → storyboard（段→刀）→ keyframe + CP剧照/海报 → video synthesis → assembly。  
输入输出与A类似，额外输出：CP剧照包、竖屏海报（留字效安全区）、TTS音色绑定台词本。  
衔接：分镜投产包一键喂视频模型；起始/结束状态锁链式传递。

代表：shuohao-skills、Jellyfish、drama-skills、shortdrama-pipeline、wind-comic、ArcReel。

第2节：每阶段最优模型/工具与提示词写法
同A，强化：Seedance 2.5 / Kling 3.0 / MiniMax H3（竖屏原生）；提示词强调“听见→停顿→眼神反应→表情→说话”时序 + 材质高光相对比例 + 9:16留字区。

第3节：流水线品质关卡
最易翻车：角色漂移、情绪断裂、正反打构图飘、字效遮脸。  
验收：17道分镜质量门；视觉审计分数；人工批准剧本/人物后生成；起始结束状态文本锁。

第4节：跨步骤一致性技术
同A，额外：故意破坏全脸参考强制特写生成；配音驱动节奏而非纯视觉；CP剧照用同一DNA + 亲密构图约束。

第5节：信息来源标注
同A + X @eternityspring 2026-08（分镜skill开源，高互动）；@Gorden_Sun 2026-08（工厂化短剧复盘，Views~1.2万）；@Chengzilhy/@liyue_ai 2026-08情绪时序prompt。GitHub星数同A。

D. 艺术策展式创作（主题 → 情绪板 → 风格锚定 → 成组作品 → 展览主视觉）

第1节：完整流水线拓扑
| 阶段 | 名称 | 输入 | 输出产物 | 衔接方式 |
|------|------|------|----------|----------|
| 1 | Theme & Moodboard | 主题描述 | 情绪板.png组 + 关键词JSON | 情绪标签注入风格prompt |
| 2 | Style Bible / Canonical Key Art | 情绪板 | 一张canonical key art + style DNA | 作为全系列sref锚 |
| 3 | Series Generation (Sketch-lock) | key art + 主题变体 | 成组作品（5-12张）+ 线稿锁 | StyleAligned共享注意力；固定seed |
| 4 | Exhibition Key Visual & Packaging | 系列作品 | 展览主视觉海报 + 墙面布置模拟 + 图录 | 主视觉复用key art构图放大 |

代表：wind-comic Style Bible Frame逻辑扩展、illo-skill、generatedgallery moodboard packs。工业级相对少，多从短剧风格锚定迁移。

第2节：每阶段最优模型/工具与提示词写法
LLM做情绪板结构化；Flux/Seedream/GPT-Image + StyleAligned / ComfyUI_Style_Aligned。提示词：上下双层（摄影+插画重构）或单一动态场 + 大留白；style DNA字段。

开源：StoryDiffusion、ComfyUI_Style_Aligned、illo-skill（~353星）。

第3节：流水线品质关卡
最易翻车：风格前后不一、系列缺乏统一呼吸感。  
验收：key art人工锁定后才批量；视觉相似度检查；成组作品统一色盘/笔触密度。

第4节：跨步骤一致性技术
角色**（若有mascot）：DNA + cref。  
情绪**：情绪板标签全程传递。  
风格**：canonical key art作为sref；StyleAligned；sketch-lock；固定seed。

第5节：信息来源标注
GitHub：wind-comic（Style Bible Frame描述）、illo-skill（~353星）、StoryDiffusion。X与短剧风格锚定帖重叠。策展完整拓扑多为从风格圣经实践推断。

四领域共性规律
工业流水线共同骨架：文本结构化（JSON/字段化剧本/大纲）→ 资产先行（角色/产品/风格bible先锁定）→ 门禁审核（人工或脚本质量门，相似度阈值）→ 组装产出（关键帧→视频/批量适配）。  
一致性被当作一等公民（集中实体模型、DNA签名、sref/cref链、相对材质比例）；生成被拆成“准备态”与“执行态”；多Agent或Skill模块化，每阶段可独立重跑；优先2025-2026仓库与X复盘（Jellyfish、shuohao-skills、ArcReel、product-shots等），老基座（StoryDiffusion 2024）仅作一致性模块保留。