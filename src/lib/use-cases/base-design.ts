import type { UseCase } from "./types";

export const BASE_DESIGN_USE_CASES: UseCase[] = [
  {
    slug: "design-1",
    keyword: "AI 海报设计",
    title: "AI 海报设计：活动、宣传、社媒一张图搞定：怎么做最省事",
    tagline: "海报一句话生成，登录即用",
    heroDescription: "要做海报，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，海报需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做海报要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出海报效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「AI 海报设计」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：虎嗅网《AI时代，小红书还会继续「红」下去吗？》","url":"https://m.huxiu.com/article/4831829.html"},
    promptExamples: [
  {
    "title": "促销海报",
    "prompt": "促销海报，红金配色，主标题'限时特惠'，现代排版。"
  },
  {
    "title": "音乐节海报",
    "prompt": "音乐节海报，霓虹渐变，激光元素，赛博朋克风格。"
  }
],
    faqs: [
  {
    "question": "AI 海报设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好海报相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 海报设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的海报；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 海报设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张海报的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 海报设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的海报可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 海报设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 海报设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-6","design-2"],
  },
  {
    slug: "design-2",
    keyword: "AI Banner 生成",
    title: "AI Banner：官网、店铺、活动首页视觉：怎么做最省事",
    tagline: "Banner一句话生成，登录即用",
    heroDescription: "要做Banner，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，Banner需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做Banner要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出Banner效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「AI Banner 生成」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：LMArena Text-to-Image Leaderboard","url":"https://lmarena.ai/leaderboard/text-to-image"},
    promptExamples: [
  {
    "title": "官网 Banner",
    "prompt": "科技品牌官网横幅，蓝紫渐变，未来元素，16:9。"
  },
  {
    "title": "电商 Banner",
    "prompt": "电商大促横幅，促销氛围，产品图+文案排版。"
  }
],
    faqs: [
  {
    "question": "AI Banner 生成 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好Banner相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI Banner 生成 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的Banner；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI Banner 生成 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张Banner的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI Banner 生成 能商用吗？",
    "answer": "可以。在 Eimu 生成的Banner可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI Banner 生成 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI Banner 生成 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["design-1","design-3"],
  },
  {
    slug: "design-3",
    keyword: "AI Logo 设计",
    title: "AI Logo 设计：从概念到可用标识：怎么做最省事",
    tagline: "Logo一句话生成，登录即用",
    heroDescription: "要做Logo，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，Logo需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做Logo要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出Logo效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「AI Logo 设计」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：CISPA Helmholtz Center for Information Security 中转站模型指纹审计（2026-03）","url":"https://www.cispa.de"},
    promptExamples: [
  {
    "title": "极简 Logo",
    "prompt": "极简风格品牌 Logo，几何图形，黑白配色，可缩放。"
  },
  {
    "title": "餐饮 Logo",
    "prompt": "餐饮品牌 Logo，手绘风格，暖色调，招牌质感。"
  }
],
    faqs: [
  {
    "question": "AI Logo 设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好Logo相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI Logo 设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的Logo；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI Logo 设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张Logo的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI Logo 设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的Logo可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI Logo 设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI Logo 设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["design-2","design-4"],
  },
  {
    slug: "design-4",
    keyword: "AI 包装设计",
    title: "AI 包装设计：新品包装先出效果图：怎么做最省事",
    tagline: "包装一句话生成，登录即用",
    heroDescription: "要做包装，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，包装需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做包装要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出包装效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「AI 包装设计」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：Google Trends 关键词趋势分析","url":"https://trends.google.com"},
    promptExamples: [
  {
    "title": "护肤品包装",
    "prompt": "护肤品瓶身包装设计图，磨砂质感，极简标签，高级感。"
  },
  {
    "title": "食品包装",
    "prompt": "零食包装设计，明亮配色，插画风，货架吸引眼球。"
  }
],
    faqs: [
  {
    "question": "AI 包装设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好包装相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 包装设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的包装；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 包装设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张包装的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 包装设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的包装可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 包装设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 包装设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["design-3","design-5"],
  },
  {
    slug: "design-5",
    keyword: "AI 名片设计",
    title: "AI 名片设计：商务形象的第一张脸：怎么做最省事",
    tagline: "名片一句话生成，登录即用",
    heroDescription: "要做名片，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，名片需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做名片要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出名片效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：OpenAI GPT Image API 官方文档","url":"https://openai.com/index/image-generation-api/"},
    promptExamples: [
  {
    "title": "商务名片",
    "prompt": "商务名片设计，双面排版，深色底，烫金细节。"
  },
  {
    "title": "创意名片",
    "prompt": "创意名片设计，异形切割，独特材质质感，设计工作室风格。"
  }
],
    faqs: [
  {
    "question": "AI 名片设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好名片相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 名片设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的名片；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 名片设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张名片的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 名片设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的名片可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 名片设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 名片设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["design-4","design-6"],
  },
  {
    slug: "design-6",
    keyword: "电商详情页 AI",
    title: "电商详情页素材：卖点图一页生成：怎么做最省事",
    tagline: "电商详情页一句话生成，登录即用",
    heroDescription: "要做电商详情页，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，电商详情页需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做电商详情页要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出电商详情页效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「电商详情页 AI」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：Google Gemini 图像生成官方文档","url":"https://deepmind.google/technologies/gemini/"},
    promptExamples: [
  {
    "title": "详情页头图",
    "prompt": "产品详情页首屏大图，产品+核心卖点文字，电商视觉。"
  },
  {
    "title": "卖点图",
    "prompt": "产品四大卖点图标图，简洁信息图，配合产品图。"
  }
],
    faqs: [
  {
    "question": "电商详情页 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好电商详情页相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "电商详情页 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的电商详情页；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "电商详情页 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张电商详情页的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "电商详情页 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的电商详情页可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "电商详情页 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "电商详情页 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["design-5","personal-brand-1"],
  },
];
