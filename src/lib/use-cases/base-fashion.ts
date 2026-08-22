import type { UseCase } from "./types";

export const BASE_FASHION_USE_CASES: UseCase[] = [
  {
    slug: "fashion-1",
    keyword: "AI 服装设计",
    title: "服装设计：从草图到款式图：怎么做最省事",
    tagline: "服装一句话生成，登录即用",
    heroDescription: "要做服装，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，服装需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做服装要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出服装效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：OpenAI GPT Image API 官方文档","url":"https://openai.com/index/image-generation-api/"},
    promptExamples: [
  {
    "title": "成衣设计",
    "prompt": "时尚成衣设计，模特展示，秀场背景，品牌调性。"
  },
  {
    "title": "设计草图",
    "prompt": "服装设计草图，款式图，人体模特，设计师手稿风。"
  }
],
    faqs: [
  {
    "question": "AI 服装设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好服装相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 服装设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的服装；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 服装设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张服装的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 服装设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的服装可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 服装设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 服装设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["architecture-6","fashion-2"],
  },
  {
    slug: "fashion-2",
    keyword: "AI 穿搭图",
    title: "穿搭图：造型灵感库：怎么做最省事",
    tagline: "穿搭搭配一句话生成，登录即用",
    heroDescription: "要做穿搭搭配，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，穿搭搭配需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做穿搭搭配要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出穿搭搭配效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「AI 穿搭图」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：Google Gemini 图像生成官方文档","url":"https://deepmind.google/technologies/gemini/"},
    promptExamples: [
  {
    "title": "通勤穿搭",
    "prompt": "通勤穿搭图，职业装，简约高级，街拍风格。"
  },
  {
    "title": "休闲穿搭",
    "prompt": "休闲穿搭，胶囊衣橱，干净配色，生活方式。"
  }
],
    faqs: [
  {
    "question": "AI 穿搭图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好穿搭搭配相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 穿搭图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的穿搭搭配；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 穿搭图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张穿搭搭配的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 穿搭图 能商用吗？",
    "answer": "可以。在 Eimu 生成的穿搭搭配可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 穿搭图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 穿搭图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["fashion-1","fashion-3"],
  },
  {
    slug: "fashion-3",
    keyword: "AI 鞋包设计",
    title: "鞋包设计：单品效果图：怎么做最省事",
    tagline: "鞋包一句话生成，登录即用",
    heroDescription: "要做鞋包，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，鞋包需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做鞋包要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出鞋包效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「AI 鞋包设计」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：Pixiv AI 插画作品趋势与社区分析","url":"https://www.pixiv.net"},
    promptExamples: [
  {
    "title": "运动鞋设计",
    "prompt": "新款运动鞋设计，流线造型，配色方案，产品渲染。"
  },
  {
    "title": "包袋设计",
    "prompt": "时尚包袋设计，皮质质感，五金细节，静物摄影。"
  }
],
    faqs: [
  {
    "question": "AI 鞋包设计 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好鞋包相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 鞋包设计 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的鞋包；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 鞋包设计 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张鞋包的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 鞋包设计 能商用吗？",
    "answer": "可以。在 Eimu 生成的鞋包可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 鞋包设计 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 鞋包设计 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["fashion-2","fashion-4"],
  },
  {
    slug: "fashion-4",
    keyword: "AI 配饰图",
    title: "配饰图：耳环、项链、眼镜：怎么做最省事",
    tagline: "配饰一句话生成，登录即用",
    heroDescription: "要做配饰，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，配饰需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做配饰要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出配饰效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「AI 配饰图」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：36氪《AI 中转站模型指纹审计》报道","url":"https://36kr.com"},
    promptExamples: [
  {
    "title": "首饰图",
    "prompt": "珠宝首饰摄影，微距，钻石闪光，黑色背景，奢华。"
  },
  {
    "title": "眼镜图",
    "prompt": "时尚眼镜产品图，渐变镜片，Studio 打光，广告感。"
  }
],
    faqs: [
  {
    "question": "AI 配饰图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好配饰相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 配饰图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的配饰；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 配饰图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张配饰的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 配饰图 能商用吗？",
    "answer": "可以。在 Eimu 生成的配饰可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 配饰图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 配饰图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["fashion-3","fashion-5"],
  },
  {
    slug: "fashion-5",
    keyword: "AI 美妆图",
    title: "美妆图：化妆品的高级呈现：怎么做最省事",
    tagline: "美妆一句话生成，登录即用",
    heroDescription: "要做美妆，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，美妆需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做美妆要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出美妆效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「AI 美妆图」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》","url":"https://developer.jdcloud.com/article/4484"},
    promptExamples: [
  {
    "title": "彩妆大片",
    "prompt": "彩妆时尚大片，模特妆容特写，高饱和，杂志封面感。"
  },
  {
    "title": "口红图",
    "prompt": "口红产品图，膏体质感，柔光，产品广告。"
  }
],
    faqs: [
  {
    "question": "AI 美妆图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好美妆相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 美妆图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的美妆；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 美妆图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张美妆的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 美妆图 能商用吗？",
    "answer": "可以。在 Eimu 生成的美妆可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 美妆图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 美妆图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["fashion-4","fashion-6"],
  },
  {
    slug: "fashion-6",
    keyword: "AI 秀场图",
    title: "秀场大片：T台氛围：怎么做最省事",
    tagline: "秀场一句话生成，登录即用",
    heroDescription: "要做秀场，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，秀场需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做秀场要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出秀场效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》","url":"https://caifuhao.eastmoney.com/news/20260604171107949267630"},
    promptExamples: [
  {
    "title": "秀场走秀",
    "prompt": "时装周秀场，模特走台，T台灯光，抓拍感。"
  },
  {
    "title": "后台花絮",
    "prompt": "秀场后台花絮，模特妆造，纪实摄影，故事感。"
  }
],
    faqs: [
  {
    "question": "AI 秀场图 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好秀场相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "AI 秀场图 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的秀场；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "AI 秀场图 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张秀场的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "AI 秀场图 能商用吗？",
    "answer": "可以。在 Eimu 生成的秀场可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "AI 秀场图 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "AI 秀场图 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["fashion-5","health-1"],
  },
];
