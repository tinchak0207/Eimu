import type { UseCase } from "./types";

export const BASE_ARCHITECTURE_USE_CASES: UseCase[] = [
  {
    slug: "architecture-1",
    keyword: "室内设计效果图 AI",
    title: "室内效果图：设计方案先看效果：怎么做最省事",
    tagline: "效果图一句话生成，登录即用",
    heroDescription: "要做效果图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，效果图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做效果图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出效果图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「室内设计效果图 AI」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》","url":"https://developer.jdcloud.com/article/4484"},
    promptExamples: [
  {
    "title": "客厅效果图",
    "prompt": "现代客厅室内效果图，L型沙发，落地窗，材质真实。"
  },
  {
    "title": "卧室效果图",
    "prompt": "极简卧室效果图，木地板，柔和灯光，温馨氛围。"
  }
],
    faqs: [
  {
    "question": "室内设计效果图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好效果图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "室内设计效果图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的效果图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "室内设计效果图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张效果图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "室内设计效果图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的效果图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "室内设计效果图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "室内设计效果图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["gaming-6","architecture-2"],
  },
  {
    slug: "architecture-2",
    keyword: "建筑效果图 AI",
    title: "建筑外观：从概念到渲染：怎么做最省事",
    tagline: "建筑外观一句话生成，登录即用",
    heroDescription: "要做建筑外观，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，建筑外观需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做建筑外观要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出建筑外观效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》","url":"https://caifuhao.eastmoney.com/news/20260604171107949267630"},
    promptExamples: [
  {
    "title": "商业建筑",
    "prompt": "现代商业建筑外观，玻璃幕墙，黄昏天空，建筑摄影。"
  },
  {
    "title": "住宅建筑",
    "prompt": "现代住宅建筑外观，白墙木饰，景观设计，日景。"
  }
],
    faqs: [
  {
    "question": "建筑效果图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好建筑外观相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "建筑效果图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的建筑外观；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "建筑效果图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张建筑外观的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "建筑效果图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的建筑外观可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "建筑效果图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "建筑效果图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-1","architecture-3"],
  },
  {
    slug: "architecture-3",
    keyword: "庭院设计 AI",
    title: "庭院设计：花园方案可视化：怎么做最省事",
    tagline: "庭院花园一句话生成，登录即用",
    heroDescription: "要做庭院花园，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，庭院花园需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做庭院花园要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出庭院花园效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「庭院设计 AI」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：虎嗅网《AI时代，小红书还会继续「红」下去吗？》","url":"https://m.huxiu.com/article/4831829.html"},
    promptExamples: [
  {
    "title": "日式庭院",
    "prompt": "日式枯山水庭院，禅意，砾石纹路，植物点缀。"
  },
  {
    "title": "屋顶花园",
    "prompt": "屋顶花园设计，绿植环绕，户外家具，城市景观。"
  }
],
    faqs: [
  {
    "question": "庭院设计 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好庭院花园相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "庭院设计 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的庭院花园；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "庭院设计 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张庭院花园的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "庭院设计 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的庭院花园可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "庭院设计 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "庭院设计 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-2","architecture-4"],
  },
  {
    slug: "architecture-4",
    keyword: "工装设计 AI",
    title: "工装设计：店铺与办公空间：怎么做最省事",
    tagline: "工装一句话生成，登录即用",
    heroDescription: "要做工装，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，工装需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做工装要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出工装效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「工装设计 AI」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：LMArena Text-to-Image Leaderboard","url":"https://lmarena.ai/leaderboard/text-to-image"},
    promptExamples: [
  {
    "title": "咖啡店设计",
    "prompt": "工业风咖啡店室内，混凝土墙面，木质吧台，复古灯具。"
  },
  {
    "title": "办公空间",
    "prompt": "现代办公空间，开放工位，绿植墙，明亮通透。"
  }
],
    faqs: [
  {
    "question": "工装设计 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好工装相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "工装设计 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的工装；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "工装设计 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张工装的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "工装设计 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的工装可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "工装设计 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "工装设计 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-3","architecture-5"],
  },
  {
    slug: "architecture-5",
    keyword: "软装搭配 AI",
    title: "软装搭配：让空间有灵魂：怎么做最省事",
    tagline: "软装一句话生成，登录即用",
    heroDescription: "要做软装，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，软装需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做软装要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出软装效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「软装搭配 AI」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：CISPA Helmholtz Center for Information Security 中转站模型指纹审计（2026-03）","url":"https://www.cispa.de"},
    promptExamples: [
  {
    "title": "软装搭配",
    "prompt": "客厅软装搭配，布艺沙发，装饰画，地毯，整体配色。"
  },
  {
    "title": "样板间",
    "prompt": "样板间软装，轻奢风格，精致摆件，酒店感。"
  }
],
    faqs: [
  {
    "question": "软装搭配 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好软装相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "软装搭配 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的软装；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "软装搭配 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张软装的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "软装搭配 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的软装可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "软装搭配 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "软装搭配 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-4","architecture-6"],
  },
  {
    slug: "architecture-6",
    keyword: "家具设计图 AI",
    title: "家具设计：新品研发先出图：怎么做最省事",
    tagline: "家具设计一句话生成，登录即用",
    heroDescription: "要做家具设计，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，家具设计需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做家具设计要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出家具设计效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「家具设计图 AI」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：Google Trends 关键词趋势分析","url":"https://trends.google.com"},
    promptExamples: [
  {
    "title": "椅子设计",
    "prompt": "现代椅子设计，独特造型，材料质感，产品渲染图。"
  },
  {
    "title": "灯具设计",
    "prompt": "极简灯具设计，暖光效果，空间陈列，氛围感。"
  }
],
    faqs: [
  {
    "question": "家具设计图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好家具设计相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "家具设计图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的家具设计；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "家具设计图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张家具设计的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "家具设计图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的家具设计可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "家具设计图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "家具设计图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-5","fashion-1"],
  },
];
