export interface UseCaseCitation {
  label: string;
  url: string;
}

export interface UseCasePromptExample {
  title: string;
  prompt: string;
}

export interface UseCase {
  slug: string;
  keyword: string;
  title: string;
  tagline: string;
  heroDescription: string;
  painPoints: string[];
  statInsight: string;
  citation: UseCaseCitation;
  promptExamples: UseCasePromptExample[];
  relatedSlugs: string[];
}

export const USE_CASES: UseCase[] = [
  {
    slug: "cross-border-ecommerce",
    keyword: "AI生图 跨境电商产品图",
    title: "跨境电商产品图：用 AI生图 取代摄影棚排期",
    tagline: "白底图、场景图、细节图一次生成，不用等摄影棚排期",
    heroDescription:
      "跨境电商最先被成本卡住的一步是产品图：白底图、场景图、细节图、多平台适配，每个 SKU 都要单独拍。Emu 用 GPT Image 2、Nano Banana Pro 直接从文字描述生成这些图，同一款产品换场景不用重新布景，也不用为亚马逊、独立站、TikTok Shop 分别再排一次拍摄。",
    painPoints: [
      "传统流程要租影棚、请摄影师和设计师，一个 SKU 走完主图、细节图、场景图全套素材，成本可达数千元。",
      "亚马逊、独立站、TikTok Shop 的图片规范不同（白底要求、尺寸标准、商品占比各异），人工重复适配容易出错甚至被下架。",
      "新品上新周期紧，等摄影排期往往跟不上铺货节奏，尤其是多 SKU 批量上架时。",
    ],
    statInsight:
      "京东云开发者社区在跨境商品套图 AI 生成技术实践文章中给出的行业观察是：传统跨境商品图制作单个 SKU 完成主图、细节图、场景图、尺寸图等全套素材，成本可达数千元，且从拍摄、修图、翻译到排版定稿往往需要数天甚至数周，无法跟上批量铺货和多平台适配的节奏。",
    citation: {
      label: "数据来源：京东云开发者社区《跨境套图 AI 生成技术实践与展望》",
      url: "https://developer.jdcloud.com/article/4484",
    },
    promptExamples: [
      {
        title: "无线蓝牙耳机白底图",
        prompt:
          "一副高端无线蓝牙耳机摆放在现代办公桌上，阳光透过落地窗照射，极简科技风格，商业摄影，8K超清画质。",
      },
      {
        title: "护肤精华场景图",
        prompt:
          "参考当下极简主义护肤品拍摄风格，为这款精华液生成一张广告图。要有流动的液体质感、柔和的自然光，以及莫兰迪配色。",
      },
    ],
    relatedSlugs: ["independent-site-banner", "social-ad-creative"],
  },
  {
    slug: "xiaohongshu-cover",
    keyword: "AI生图 小红书封面图",
    title: "小红书封面图：算法更爱的完美感，AI生图怎么用才不假",
    tagline: "封面决定点击率，AI生图先把光影和构图做对",
    heroDescription:
      "小红书的推荐机制会优先分发数据表现更好的内容，而封面图的第一眼质感直接影响点击和收藏。用 GPT Image 2、Nano Banana Pro 生成封面图，不需要摄影基础，也不需要每次都重新找模板。",
    painPoints: [
      "手机随手拍的封面图很难做出稳定的光影和构图，容易被更精致的内容盖过。",
      "垫图、修图工具堆叠使用效率低，改一版风格要重新走一遍流程。",
      "不同品类（美妆、家居、穿搭）需要不同的封面调性，人工出图很难批量覆盖。",
    ],
    statInsight:
      "虎嗅网在《AI时代，小红书还会继续「红」下去吗？》一文中指出：当 AI 生成的完美内容成为常态，这类内容的点赞、收藏率比普通人随手拍的内容高出 30% 以上，算法也更倾向于分发数据表现更好的内容。另据运营平台青瓜传媒引用的小红书官方数据，超过 70% 的用户通过搜索框主动寻找解决方案，封面图和标题共同决定了搜索结果里的点击意愿。",
    citation: {
      label: "数据来源：虎嗅网《AI时代，小红书还会继续「红」下去吗？》",
      url: "https://m.huxiu.com/article/4831829.html",
    },
    promptExamples: [
      {
        title: "甜点社交封面图",
        prompt:
          "做一张适合发社交平台的甜点照片，草莓蛋糕放在窗边桌上，光线柔和，让人看了就想下单。",
      },
      {
        title: "居家好物种草图",
        prompt:
          "侘寂风客厅一角，暖色调自然光，桌面摆放一件家居好物，画面干净但有生活气息，适合小红书种草笔记封面。",
      },
    ],
    relatedSlugs: ["cross-border-ecommerce", "social-ad-creative"],
  },
  {
    slug: "independent-site-banner",
    keyword: "AI生图 独立站Banner设计",
    title: "独立站首页 Banner：不用等设计排期也能出图",
    tagline: "Shopify、独立站首屏视觉当天出稿",
    heroDescription:
      "独立站首页 Banner 通常决定访客的第一印象，但设计排期往往是最后才排上的一环。用 Emu 生成 Banner 素材，写清楚场景、风格、比例就能直接出图，换季或换活动主题时也不用重新找设计师。",
    painPoints: [
      "首页 Banner 改版频率高（换季、大促、新品），每次都排队等设计资源不现实。",
      "多语言、多站点独立站需要适配不同尺寸和文化审美，人工重复设计成本高。",
      "小团队没有专职设计师，只能用现成模板，很难做出符合品牌调性的首屏视觉。",
    ],
    statInsight:
      "东方财富网财富号文章《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》给出了具体的提示词结构建议——「主体 + 场景 + 风格 + 光线 + 镜头 + 画质要求」，并指出传统「产品拍摄→修图→设计→输出」的流程，用 AI 生图可以压缩为「提示词输入→图片生成→调整优化→发布」，整个过程缩短至几分钟。",
    citation: {
      label: "数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》",
      url: "https://caifuhao.eastmoney.com/news/20260604171107949267630",
    },
    promptExamples: [
      {
        title: "科技品牌首页横幅",
        prompt:
          "现代科技品牌首页横幅，蓝色渐变背景，未来科技元素，高端电子产品展示，专业电商Banner设计，16:9比例。",
      },
      {
        title: "活动海报主视觉",
        prompt:
          "2026 科技创新峰会海报。背景是半透明的量子计算网格，中央文字：'The Future is Now / 未来已来'。字体要求现代感、高对比度，有足够的留白区域。",
      },
    ],
    relatedSlugs: ["cross-border-ecommerce", "social-ad-creative"],
  },
  {
    slug: "social-ad-creative",
    keyword: "AI生图 短视频广告素材",
    title: "抖音／TikTok 广告素材：批量出图不卡素材瓶颈",
    tagline: "开箱图、场景图、对比图，投放前一次备齐",
    heroDescription:
      "短视频广告投放最容易被卡住的环节是素材：一条广告往往要测试多版画面才能找到跑量的组合。Emu 让你按场景批量生成开箱图、使用场景图和对比展示图，不用每次都重新拍摄或找素材网站。",
    painPoints: [
      "广告素材需要频繁测试不同版本，人工拍摄或修图跟不上投放节奏。",
      "开箱图、使用场景图、对比展示图这类广告常用素材类型，靠拼素材网站图片很难做到统一风格。",
      "多账号、多地区投放需要不同风格的素材，团队人力有限时很难覆盖。",
    ],
    statInsight:
      "同一篇东方财富网财富号文章列出了短视频广告素材的常见 AI 生图应用场景，包括产品使用场景图、用户体验画面、开箱展示图片和品牌视觉素材，并指出批量生成内容能够显著提升广告素材的更新频率——这正是短视频投放测试多个创意版本时最需要的能力。",
    citation: {
      label: "数据来源：东方财富网财富号《GPT Image 2 高效作图工具：跨境电商卖家的AI出图利器》",
      url: "https://caifuhao.eastmoney.com/news/20260604171107949267630",
    },
    promptExamples: [
      {
        title: "美容仪使用场景图",
        prompt:
          "年轻女性正在使用美容仪，现代家居环境，自然光线，高级感摄影风格，短视频广告素材，真实人物，高清细节。",
      },
      {
        title: "潮牌街拍预热图",
        prompt:
          "模拟徕卡 M11 的直出色彩，拍摄一张街头卫衣特写。要有浓郁的胶片颗粒感，模特在过马路时的动态模糊，背景是东京涩谷的雨夜霓虹。",
      },
    ],
    relatedSlugs: ["xiaohongshu-cover", "independent-site-banner"],
  },
];

export function getUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((item) => item.slug === slug);
}

export function relatedUseCases(useCase: UseCase): UseCase[] {
  return useCase.relatedSlugs
    .map((slug) => getUseCase(slug))
    .filter((item): item is UseCase => Boolean(item));
}
