import type { UseCase } from "./types";

export const BASE_EDUCATION_USE_CASES: UseCase[] = [
  {
    slug: "education-1",
    keyword: "AI 课件配图",
    title: "课件配图：让课堂更生动：怎么做最省事",
    tagline: "课件一句话生成，登录即用",
    heroDescription: "要做课件，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，课件需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做课件要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出课件效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「AI 课件配图」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：Pixiv AI 插画作品趋势与社区分析","url":"https://www.pixiv.net"},
    promptExamples: [
  {
    "title": "课件插画",
    "prompt": "教育课件插画，扁平风格，知识点可视化，明亮配色。"
  },
  {
    "title": "课件封面",
    "prompt": "课件封面设计，主题大字，渐变背景，专业感。"
  }
],
    faqs: [
  {
    "question": "AI 课件配图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好课件相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 课件配图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的课件；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 课件配图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张课件的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 课件配图 能商用吗？",
    "answer": "可以。在 Eimu 生成的课件可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 课件配图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 课件配图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ui-6","education-2"],
  },
  {
    slug: "education-2",
    keyword: "AI 思维导图",
    title: "思维导图：把想法画成结构：怎么做最省事",
    tagline: "思维导图一句话生成，登录即用",
    heroDescription: "要做思维导图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，思维导图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做思维导图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出思维导图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「AI 思维导图」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：36氪《AI 中转站模型指纹审计》报道","url":"https://36kr.com"},
    promptExamples: [
  {
    "title": "知识导图",
    "prompt": "知识体系思维导图，树状结构，彩色分支，清晰。"
  },
  {
    "title": "会议导图",
    "prompt": "会议记录导图，主题中心，逻辑分支，简洁。"
  }
],
    faqs: [
  {
    "question": "AI 思维导图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好思维导图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 思维导图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的思维导图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 思维导图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张思维导图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 思维导图 能商用吗？",
    "answer": "可以。在 Eimu 生成的思维导图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 思维导图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 思维导图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["education-1","education-3"],
  },
  {
    slug: "education-3",
    keyword: "教学海报 AI",
    title: "教学海报：知识传播的门面：怎么做最省事",
    tagline: "教学海报一句话生成，登录即用",
    heroDescription: "要做教学海报，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，教学海报需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做教学海报要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出教学海报效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「教学海报 AI」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》","url":"https://developer.jdcloud.com/article/4484"},
    promptExamples: [
  {
    "title": "课程海报",
    "prompt": "课程招生海报，主讲人+课程卖点，教育风格。"
  },
  {
    "title": "讲座海报",
    "prompt": "学术讲座海报，简洁排版，日期地点信息，学术感。"
  }
],
    faqs: [
  {
    "question": "教学海报 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好教学海报相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "教学海报 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的教学海报；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "教学海报 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张教学海报的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "教学海报 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的教学海报可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "教学海报 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "教学海报 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["education-2","education-4"],
  },
  {
    slug: "education-4",
    keyword: "AI 读书笔记图",
    title: "读书笔记：把精华画成图：怎么做最省事",
    tagline: "读书笔记一句话生成，登录即用",
    heroDescription: "要做读书笔记，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，读书笔记需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做读书笔记要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出读书笔记效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》","url":"https://caifuhao.eastmoney.com/news/20260604171107949267630"},
    promptExamples: [
  {
    "title": "笔记卡片",
    "prompt": "读书笔记卡片，金句排版，莫兰迪背景，ins 分享。"
  },
  {
    "title": "框架图",
    "prompt": "书籍框架图，章节结构，逻辑图，知识管理。"
  }
],
    faqs: [
  {
    "question": "AI 读书笔记图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好读书笔记相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 读书笔记图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的读书笔记；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 读书笔记图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张读书笔记的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 读书笔记图 能商用吗？",
    "answer": "可以。在 Eimu 生成的读书笔记可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 读书笔记图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 读书笔记图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["education-3","education-5"],
  },
  {
    slug: "education-5",
    keyword: "AI 演示配图",
    title: "演示配图：PPT 不再只有文字：怎么做最省事",
    tagline: "作业演示一句话生成，登录即用",
    heroDescription: "要做作业演示，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，作业演示需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做作业演示要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出作业演示效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「AI 演示配图」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：虎嗅网《AI时代，小红书还会继续「红」下去吗？》","url":"https://m.huxiu.com/article/4831829.html"},
    promptExamples: [
  {
    "title": "PPT 配图",
    "prompt": "PPT 商务配图，图表+插画，扁平风，专业配色。"
  },
  {
    "title": "演示封面",
    "prompt": "演示封面设计，主题视觉，公司色系，正式感。"
  }
],
    faqs: [
  {
    "question": "AI 演示配图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好作业演示相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 演示配图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的作业演示；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 演示配图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张作业演示的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 演示配图 能商用吗？",
    "answer": "可以。在 Eimu 生成的作业演示可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 演示配图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 演示配图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["education-4","education-6"],
  },
  {
    slug: "education-6",
    keyword: "证书设计 AI",
    title: "证书设计：仪式感与专业度：怎么做最省事",
    tagline: "证书奖状一句话生成，登录即用",
    heroDescription: "要做证书奖状，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，证书奖状需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做证书奖状要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出证书奖状效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「证书设计 AI」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：LMArena Text-to-Image Leaderboard","url":"https://lmarena.ai/leaderboard/text-to-image"},
    promptExamples: [
  {
    "title": "培训证书",
    "prompt": "培训结业证书，边框装饰，正式排版，烫金元素。"
  },
  {
    "title": "活动证书",
    "prompt": "活动参与证书，现代设计，品牌色，纪念感。"
  }
],
    faqs: [
  {
    "question": "证书设计 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好证书奖状相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "证书设计 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的证书奖状；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "证书设计 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张证书奖状的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "证书设计 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的证书奖状可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "证书设计 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "证书设计 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["education-5","gaming-1"],
  },
];
