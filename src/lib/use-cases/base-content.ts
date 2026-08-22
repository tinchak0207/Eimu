import type { UseCase } from "./types";

export const BASE_CONTENT_USE_CASES: UseCase[] = [
  {
    slug: "content-1",
    keyword: "小红书封面图 AI",
    title: "小红书封面图：算法更爱的完美感：怎么做最省事",
    tagline: "小红书封面一句话生成，登录即用",
    heroDescription: "要做小红书封面，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，小红书封面需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做小红书封面要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出小红书封面效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：OpenAI GPT Image API 官方文档","url":"https://openai.com/index/image-generation-api/"},
    promptExamples: [
  {
    "title": "美食封面",
    "prompt": "草莓蛋糕窗边特写，柔和光线，高食欲感，适合小红书封面。"
  },
  {
    "title": "好物封面",
    "prompt": "极简家居好物场景图，莫兰迪色系，干净高级，种草封面。"
  }
],
    faqs: [
  {
    "question": "小红书封面图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好小红书封面相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "小红书封面图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的小红书封面；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "小红书封面图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张小红书封面的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "小红书封面图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的小红书封面可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "小红书封面图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "小红书封面图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["ecommerce-6","content-2"],
  },
  {
    slug: "content-2",
    keyword: "公众号配图 AI",
    title: "公众号配图：一篇文章一套视觉：怎么做最省事",
    tagline: "公众号配图一句话生成，登录即用",
    heroDescription: "要做公众号配图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，公众号配图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做公众号配图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出公众号配图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索趋势显示「公众号配图 AI」类关键词长期处于上升通道，需求侧从专业设计师扩展到了普通内容创作者。竞品网站大量铺设同类长尾页面也从侧面印证了这一搜索量的存在。",
    citation: {"label":"数据来源：Google Gemini 图像生成官方文档","url":"https://deepmind.google/technologies/gemini/"},
    promptExamples: [
  {
    "title": "文章头图",
    "prompt": "科技感抽象头图，蓝色渐变，光效粒子，适合深度技术文章。"
  },
  {
    "title": "资讯配图",
    "prompt": "新闻资讯风格配图，简洁构图，重点色块，信息图质感。"
  }
],
    faqs: [
  {
    "question": "公众号配图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好公众号配图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "公众号配图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的公众号配图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "公众号配图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张公众号配图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "公众号配图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的公众号配图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "公众号配图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "公众号配图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-1","content-3"],
  },
  {
    slug: "content-3",
    keyword: "短视频封面图 AI",
    title: "短视频封面：三秒决定点不点：怎么做最省事",
    tagline: "短视频封面一句话生成，登录即用",
    heroDescription: "要做短视频封面，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，短视频封面需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做短视频封面要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出短视频封面效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "Google 搜索结果中，「短视频封面图 AI」相关页面的高排位内容普遍包含：场景痛点、具体操作步骤、可直接复制的提示词与案例图。Eimu 的 use-case 页面按此结构组织，同时附带真实来源引用以满足搜索质量评估（E-E-A-T）。",
    citation: {"label":"数据来源：Pixiv AI 插画作品趋势与社区分析","url":"https://www.pixiv.net"},
    promptExamples: [
  {
    "title": "Vlog 封面",
    "prompt": "旅行 Vlog 封面，大景深风景，人物剪影，杂志感排版。"
  },
  {
    "title": "口播封面",
    "prompt": "口播视频封面，人物半身，清晰背景，大字标题，高对比。"
  }
],
    faqs: [
  {
    "question": "短视频封面图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好短视频封面相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "短视频封面图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的短视频封面；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "短视频封面图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张短视频封面的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "短视频封面图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的短视频封面可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "短视频封面图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "短视频封面图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-2","content-4"],
  },
  {
    slug: "content-4",
    keyword: "知乎回答配图 AI",
    title: "知乎回答配图：让长文更好读：怎么做最省事",
    tagline: "知乎配图一句话生成，登录即用",
    heroDescription: "要做知乎配图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，知乎配图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做知乎配图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出知乎配图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "LMArena 文字转图片排行榜中，Nano Banana 系模型长期处于第一梯队，GPT Image 2 则以精准文字渲染著称。两者是当前「知乎回答配图 AI」搜索意图下最高频被提到的模型。",
    citation: {"label":"数据来源：36氪《AI 中转站模型指纹审计》报道","url":"https://36kr.com"},
    promptExamples: [
  {
    "title": "回答示意图",
    "prompt": "简洁示意图风格，线条插画，配合数据可视化元素。"
  },
  {
    "title": "案例配图",
    "prompt": "商业案例对比图，前后对照排版，信息清晰。"
  }
],
    faqs: [
  {
    "question": "知乎回答配图 AI 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好知乎配图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "知乎回答配图 AI 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的知乎配图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "知乎回答配图 AI 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张知乎配图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "知乎回答配图 AI 能商用吗？",
    "answer": "可以。在 Eimu 生成的知乎配图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "知乎回答配图 AI 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "知乎回答配图 AI 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-3","content-5"],
  },
  {
    slug: "content-5",
    keyword: "朋友圈海报 生成",
    title: "朋友圈海报：九宫格与单图都能出：怎么做最省事",
    tagline: "朋友圈海报一句话生成，登录即用",
    heroDescription: "要做朋友圈海报，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，朋友圈海报需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做朋友圈海报要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出朋友圈海报效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "搜索「朋友圈海报 生成」的用户，绝大多数是普通创作者而非开发者。CISPA 亥姆霍兹信息安全中心 2026 年 3 月的中转站模型指纹审计论文指出，市面大量中转站存在模型替换风险——你以为调用的是 GPT Image 2，实际可能被换成便宜模型。选择有明确模型列表、直接对接上游的在线工具更稳妥。",
    citation: {"label":"数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》","url":"https://developer.jdcloud.com/article/4484"},
    promptExamples: [
  {
    "title": "节日海报",
    "prompt": "节日氛围海报，喜庆配色，主题文字，适合朋友圈转发。"
  },
  {
    "title": "活动海报",
    "prompt": "线下活动海报，现代排版，主标题醒目，信息层级清晰。"
  }
],
    faqs: [
  {
    "question": "朋友圈海报 生成 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好朋友圈海报相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "朋友圈海报 生成 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的朋友圈海报；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "朋友圈海报 生成 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张朋友圈海报的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "朋友圈海报 生成 能商用吗？",
    "answer": "可以。在 Eimu 生成的朋友圈海报可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "朋友圈海报 生成 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "朋友圈海报 生成 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-4","content-6"],
  },
  {
    slug: "content-6",
    keyword: "视频缩略图 AI 生成",
    title: "视频缩略图：点击率的隐形战场：怎么做最省事",
    tagline: "视频缩略图一句话生成，登录即用",
    heroDescription: "要做视频缩略图，直接用 Eimu 输入描述就能生成。Eimu 集成 GPT Image 2、Nano Banana Pro 等主流模型，视频缩略图需求无需摄影棚、设计排期或中转站配置——输入描述或参考图，选好风格与比例即可生成，完成后直接下载，适合创作者与中小团队。",
    painPoints: [
  "传统做视频缩略图要靠摄影棚/设计排期，成本高、周期长，跟不上上新节奏。",
  "通用生图工具出视频缩略图效果不稳，缺少针对场景的提示词模板与风格预设。",
  "想用 GPT Image 2 / Nano Banana Pro 但不想配置中转站、申请 API Key，被门槛劝退。"
],
    statInsight: "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统流程从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，AI 生图可将「拍摄→修图→设计」压缩为「提示词→生成→微调」，整个过程缩短至几分钟。",
    citation: {"label":"数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》","url":"https://caifuhao.eastmoney.com/news/20260604171107949267630"},
    promptExamples: [
  {
    "title": "游戏视频缩略图",
    "prompt": "游戏高光时刻缩略图，动态模糊，醒目边框，标题文字。"
  },
  {
    "title": "教程缩略图",
    "prompt": "教学视频缩略图，工具特写，步骤标注，简洁有力。"
  }
],
    faqs: [
  {
    "question": "视频缩略图 AI 生成 怎么做？",
    "answer": "直接在 Eimu 输入描述即可：选择 GPT Image 2 或 Nano Banana Pro，写好视频缩略图相关的提示词（可套用页面里的模板），选比例与画质点生成。登录即可用，无需配置中转站或申请 API Key，完成后直接下载。"
  },
  {
    "question": "视频缩略图 AI 生成 用什么模型效果最好？",
    "answer": "GPT Image 2 文字渲染精准、构图能力强，适合需要文字或复杂构图的视频缩略图；Nano Banana Pro（Gemini 2.5 Flash Image）在 LMArena 文字转图片榜长期前列，风格统一性和编辑能力突出。Eimu 两个都接入，可对比出图后选择。"
  },
  {
    "question": "视频缩略图 AI 生成 要钱吗？",
    "answer": "Eimu 登录后即可使用，生成按张计费（3 币/张），新用户有免费体验额度。相比摄影棚拍摄或设计师外包，单张视频缩略图的成本可忽略不计，且无限重试不烧预算。"
  },
  {
    "question": "视频缩略图 AI 生成 能商用吗？",
    "answer": "可以。在 Eimu 生成的视频缩略图可直接用于电商、营销、内容创作等商用场景。与中转站不同，Eimu 直接对接 GPT Image 2、Nano Banana Pro 等上游模型，不存在模型替换风险（CISPA 2026 审计指出大量中转站存在此问题）。"
  },
  {
    "question": "视频缩略图 AI 生成 和传统方式比快多少？",
    "answer": "传统流程「拍摄→修图→设计→排版」需数天甚至数周（京东云开发者社区实践文章数据），AI 生图可压缩为「提示词→生成→微调」几分钟完成。多 SKU 批量场景下差距更明显。"
  },
  {
    "question": "视频缩略图 AI 生成 出图不满意怎么办？",
    "answer": "可以改提示词重新生成，或对已有图继续用对话式编辑修改（换背景、调风格、改元素）。GPT Image 2 与 Nano Banana Pro 都支持参考图编辑，Eimu 内置六种风格预设减少试错成本。"
  }
],
    author: {"name":"Eimu 创作者工作台","jobTitle":"AI 图片与视频创作平台","url":"https://eimu.dev"},
    relatedSlugs: ["content-5","design-1"],
  },
];
