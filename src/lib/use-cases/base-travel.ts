import type { UseCase } from "./types";

export const BASE_TRAVEL_USE_CASES: UseCase[] = [
  {
    slug: "travel-1",
    keyword: "旅行海报 AI",
    title: "旅行海报：目的地种草：怎么做最省事",
    tagline: "旅行海报一句话生成，登录即用",
    heroDescription: "要做旅行海报，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，旅行海报需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做旅行海报要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出旅行海报效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「旅行海报 AI」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：CISPA Helmholtz Center for Information Security 中转站模型指纹审计（2026-03）","url":"https://www.cispa.de"},
    promptExamples: [
  {
    "title": "海岛海报",
    "prompt": "热带海岛旅行海报，碧海蓝天，椰林，度假氛围。"
  },
  {
    "title": "城市海报",
    "prompt": "欧洲城市旅行海报，地标建筑，复古插画风。"
  }
],
    faqs: [
  {
    "question": "旅行海报 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好旅行海报相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "旅行海报 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的旅行海报；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "旅行海报 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张旅行海报的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "旅行海报 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的旅行海报可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "旅行海报 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "旅行海报 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["finance-6","travel-2"],
  },
  {
    slug: "travel-2",
    keyword: "游记配图 AI",
    title: "游记配图：把旅程写得更美：怎么做最省事",
    tagline: "游记配图一句话生成，登录即用",
    heroDescription: "要做游记配图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，游记配图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做游记配图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出游记配图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「游记配图 AI」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：Google Trends 关键词趋势分析","url":"https://trends.google.com"},
    promptExamples: [
  {
    "title": "游记封面",
    "prompt": "游记封面图，目的地风景，标题排版，旅行感。"
  },
  {
    "title": "旅程插画",
    "prompt": "旅行路线插画，手绘地图风，地标小图标，纪念感。"
  }
],
    faqs: [
  {
    "question": "游记配图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好游记配图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "游记配图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的游记配图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "游记配图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张游记配图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "游记配图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的游记配图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "游记配图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "游记配图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["travel-1","travel-3"],
  },
  {
    slug: "travel-3",
    keyword: "签证照片 AI",
    title: "签证照片：证件照规范与美化：怎么做最省事",
    tagline: "签证照片一句话生成，登录即用",
    heroDescription: "要做签证照片，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，签证照片需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做签证照片要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出签证照片效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：OpenAI GPT Image API 官方文档","url":"https://openai.com/index/image-generation-api/"},
    promptExamples: [
  {
    "title": "证件照",
    "prompt": "标准证件照，白底，正面，规范光线，护照标准。"
  },
  {
    "title": "美签照片",
    "prompt": "美国签证照片，白底，表情自然，尺寸规范。"
  }
],
    faqs: [
  {
    "question": "签证照片 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好签证照片相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "签证照片 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的签证照片；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "签证照片 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张签证照片的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "签证照片 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的签证照片可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "签证照片 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "签证照片 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["travel-2","travel-4"],
  },
  {
    slug: "travel-4",
    keyword: "旅行攻略图 AI",
    title: "旅行攻略图：攻略也讲颜值：怎么做最省事",
    tagline: "旅行攻略一句话生成，登录即用",
    heroDescription: "要做旅行攻略，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，旅行攻略需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做旅行攻略要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出旅行攻略效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「旅行攻略图 AI」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：Google Gemini 图像生成官方文档","url":"https://deepmind.google/technologies/gemini/"},
    promptExamples: [
  {
    "title": "攻略封面",
    "prompt": "旅行攻略封面，目的地拼图，标题醒目，小红书风。"
  },
  {
    "title": "路线图",
    "prompt": "旅行路线示意图，地图+地标插画，清晰标注。"
  }
],
    faqs: [
  {
    "question": "旅行攻略图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好旅行攻略相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "旅行攻略图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的旅行攻略；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "旅行攻略图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张旅行攻略的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "旅行攻略图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的旅行攻略可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "旅行攻略图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "旅行攻略图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["travel-3","travel-5"],
  },
  {
    slug: "travel-5",
    keyword: "民宿宣传图 AI",
    title: "民宿宣传图：订房率靠第一眼：怎么做最省事",
    tagline: "民宿宣传一句话生成，登录即用",
    heroDescription: "要做民宿宣传，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，民宿宣传需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做民宿宣传要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出民宿宣传效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「民宿宣传图 AI」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：Pixiv AI 插画作品趋势与社区分析","url":"https://www.pixiv.net"},
    promptExamples: [
  {
    "title": "民宿房间",
    "prompt": "民宿房间宣传图，舒适氛围，暖光，生活感。"
  },
  {
    "title": "民宿外观",
    "prompt": "民宿外观宣传图，自然环境，建筑特色，度假感。"
  }
],
    faqs: [
  {
    "question": "民宿宣传图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好民宿宣传相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "民宿宣传图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的民宿宣传；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "民宿宣传图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张民宿宣传的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "民宿宣传图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的民宿宣传可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "民宿宣传图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "民宿宣传图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["travel-4","travel-6"],
  },
  {
    slug: "travel-6",
    keyword: "文创设计 AI",
    title: "文创设计：地方特色的变现：怎么做最省事",
    tagline: "文旅文创一句话生成，登录即用",
    heroDescription: "要做文旅文创，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，文旅文创需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做文旅文创要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出文旅文创效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「文创设计 AI」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：36氪《AI 中转站模型指纹审计》报道","url":"https://36kr.com"},
    promptExamples: [
  {
    "title": "文创周边",
    "prompt": "文创产品设计，地域元素，国潮风格，纪念品。"
  },
  {
    "title": "景区海报",
    "prompt": "景区活动海报，风景+活动信息，吸引游客。"
  }
],
    faqs: [
  {
    "question": "文创设计 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好文旅文创相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "文创设计 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的文旅文创；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "文创设计 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张文旅文创的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "文创设计 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的文旅文创可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "文创设计 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "文创设计 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["travel-5","automotive-1"],
  },
];
