import type { UseCase } from "./types";

export const BASE_ECOMMERCE_USE_CASES: UseCase[] = [
  {
    slug: "ecommerce-1",
    keyword: "AI 商品主图",
    title: "AI 商品主图生成：点击率从第一张图开始：怎么做最省事",
    tagline: "主图一句话生成，登录即用",
    heroDescription: "要做主图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，主图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做主图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出主图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「AI 商品主图」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》","url":"https://developer.jdcloud.com/article/4484"},
    promptExamples: [
  {
    "title": "日用品主图",
    "prompt": "纯净白底商品主图，产品居中，商业打光，细节清晰，适合电商平台展示。"
  },
  {
    "title": "食品主图",
    "prompt": "食品包装主图，新鲜食材环绕，自然光，食欲感，高清电商摄影。"
  }
],
    faqs: [
  {
    "question": "AI 商品主图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好主图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 商品主图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的主图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 商品主图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张主图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 商品主图 能商用吗？",
    "answer": "可以。在 Eimu 生成的主图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 商品主图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 商品主图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-2","ecommerce-2"],
  },
  {
    slug: "ecommerce-2",
    keyword: "AI 白底图 生成",
    title: "AI 白底图生成：批量出图不再等摄影棚：怎么做最省事",
    tagline: "白底图一句话生成，登录即用",
    heroDescription: "要做白底图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，白底图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做白底图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出白底图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》","url":"https://caifuhao.eastmoney.com/news/20260604171107949267630"},
    promptExamples: [
  {
    "title": "电子产品白底图",
    "prompt": "白色背景产品图，正侧45度视角，均匀打光，无阴影，电商标准白底图。"
  },
  {
    "title": "服装白底图",
    "prompt": "模特穿着白底服装图，全身构图，中性姿势，商业棚拍光效。"
  }
],
    faqs: [
  {
    "question": "AI 白底图 生成 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好白底图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 白底图 生成 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的白底图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 白底图 生成 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张白底图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 白底图 生成 能商用吗？",
    "answer": "可以。在 Eimu 生成的白底图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 白底图 生成 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 白底图 生成 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-1","ecommerce-3"],
  },
  {
    slug: "ecommerce-3",
    keyword: "AI 产品场景图",
    title: "AI 产品场景图：一个 SKU 换 N 个场景：怎么做最省事",
    tagline: "场景图一句话生成，登录即用",
    heroDescription: "要做场景图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，场景图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做场景图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出场景图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「AI 产品场景图」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：虎嗅网《AI时代，小红书还会继续「红」下去吗？》","url":"https://m.huxiu.com/article/4831829.html"},
    promptExamples: [
  {
    "title": "咖啡机场景图",
    "prompt": "咖啡机放在北欧风厨房台面，晨光，绿植点缀，生活方式摄影。"
  },
  {
    "title": "护肤场景图",
    "prompt": "精华液在浴室大理石台面上，水珠质感，柔和顶光，高端护肤广告。"
  }
],
    faqs: [
  {
    "question": "AI 产品场景图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好场景图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 产品场景图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的场景图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 产品场景图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张场景图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 产品场景图 能商用吗？",
    "answer": "可以。在 Eimu 生成的场景图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 产品场景图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 产品场景图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-2","ecommerce-4"],
  },
  {
    slug: "ecommerce-4",
    keyword: "AI 产品细节图",
    title: "AI 产品细节图：材质与工艺的高清呈现：怎么做最省事",
    tagline: "细节图一句话生成，登录即用",
    heroDescription: "要做细节图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，细节图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做细节图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出细节图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「AI 产品细节图」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：LMArena Text-to-Image Leaderboard","url":"https://lmarena.ai/leaderboard/text-to-image"},
    promptExamples: [
  {
    "title": "手表细节图",
    "prompt": "手表表盘微距特写，指针与齿轮细节清晰，珠宝级打光。"
  },
  {
    "title": "包袋细节图",
    "prompt": "真皮包袋缝线细节微距，皮质纹理清晰，质感宣传图。"
  }
],
    faqs: [
  {
    "question": "AI 产品细节图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好细节图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 产品细节图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的细节图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 产品细节图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张细节图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 产品细节图 能商用吗？",
    "answer": "可以。在 Eimu 生成的细节图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 产品细节图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 产品细节图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-3","ecommerce-5"],
  },
  {
    slug: "ecommerce-5",
    keyword: "电商主图 多平台 尺寸",
    title: "电商主图多平台适配：亚马逊、淘宝、TikTok 一次出齐：怎么做最省事",
    tagline: "多平台适配一句话生成，登录即用",
    heroDescription: "要做多平台适配，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，多平台适配需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做多平台适配要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出多平台适配效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「电商主图 多平台 尺寸」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：CISPA Helmholtz Center for Information Security 中转站模型指纹审计（2026-03）","url":"https://www.cispa.de"},
    promptExamples: [
  {
    "title": "亚马逊主图",
    "prompt": "亚马逊风格纯白底商品主图，产品占画面85%，无文字无水印。"
  },
  {
    "title": "TikTok 店铺图",
    "prompt": "竖版商品展示图，明亮活泼风格，产品突出，适合短视频电商。"
  }
],
    faqs: [
  {
    "question": "电商主图 多平台 尺寸 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好多平台适配相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "电商主图 多平台 尺寸 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的多平台适配；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "电商主图 多平台 尺寸 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张多平台适配的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "电商主图 多平台 尺寸 能商用吗？",
    "answer": "可以。在 Eimu 生成的多平台适配可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "电商主图 多平台 尺寸 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "电商主图 多平台 尺寸 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-4","ecommerce-6"],
  },
  {
    slug: "ecommerce-6",
    keyword: "AI 新品图",
    title: "新品上架图：AI 出图追上铺货节奏：怎么做最省事",
    tagline: "新奇特产品一句话生成，登录即用",
    heroDescription: "要做新奇特产品，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，新奇特产品需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做新奇特产品要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出新奇特产品效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「AI 新品图」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：Google Trends 关键词趋势分析","url":"https://trends.google.com"},
    promptExamples: [
  {
    "title": "小家电新品图",
    "prompt": "新款桌面风扇产品图，清新配色，家居背景，新品发布会风格。"
  },
  {
    "title": "潮玩新品图",
    "prompt": "潮流手办新品图，炫彩灯光背景，赛博朋克氛围，社交媒体预热。"
  }
],
    faqs: [
  {
    "question": "AI 新品图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好新奇特产品相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 新品图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的新奇特产品；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 新品图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张新奇特产品的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 新品图 能商用吗？",
    "answer": "可以。在 Eimu 生成的新奇特产品可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 新品图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 新品图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-5","content-1"],
  },
];
