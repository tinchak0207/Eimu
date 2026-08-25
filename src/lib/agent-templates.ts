import type { RecipeTemplate } from "./recipe-templates";

/**
 * 助理起手模板领域：每个领域精准对应一个小众强效痛点。
 * 助理初始右侧模板库按此分组展示。
 */
export type AgentTemplateDomain = "novel" | "ecommerce" | "shortdrama" | "art";

export const AGENT_TEMPLATE_DOMAIN_LABELS: Record<AgentTemplateDomain, string> = {
  novel: "小说",
  ecommerce: "电商",
  shortdrama: "短剧",
  art: "艺术",
};

/**
 * 助理起手模板：在 RecipeTemplate（六槽配方）之上加领域与 agent 注入信息。
 * 点卡即注入 initialPrompt 作为第一条用户消息，同时把 slots 铺成 canvas workflow。
 */
export interface AgentTemplate extends RecipeTemplate {
  domain: AgentTemplateDomain;
  /** 领域内一句话痛点（卡片副标题，用户 1 秒对号入座）。 */
  painPoint: string;
  /** 点卡即注入给 agent 的初始提示词（用户口吻的第一条消息）。 */
  initialPrompt: string;
}

/**
 * 范式来源（2026-08-25 aggregate-search 四领域调研，GitHub/B站/小红书交叉验证）：
 * - novel：xhs 鸿悟AI「Image2 角色设定卡」版式规范、FILMINGIRL「三视图咒语」(2498赞)、
 *   美工岁岁「男频封面」、上海十年「别再让封面毁了你的10万字」、B站星月小丸子「男频女频封面提示词公式」。
 * - ecommerce：GitHub JeremyGDM/awesome-ai-product-photography-prompts（122 图 prompt 库：
 *   product truth first / 低角度微距 / 逆光透光 / 前景 bokeh / 3x3 一致性网格）、
 *   xhs sola「aigc 电商进阶玩法」、阿喵曹「一句话直出双十一海报」、ZH凤梨「产品细节一致性」。
 * - shortdrama：GitHub ChrisChen667788/wind-comic（452★，sketch-lock 分镜 + 走位指令 + 情绪驱动运镜）、
 *   xhs Soongkakit「AI 古装短剧海报」（低角度仰拍/对称构图/明暗对照/丁达尔光/冷月光）、
 *   小渔造梦日记「短剧封面封神花体字」、大喜「AI 真人短剧海报」。
 * - art：GitHub devanshug2307/Awesome-AI-Image-Prompts（247★，水彩风格槽：paper grain /
 *   wet pigment / 镜头与景深分层结构）、xhs 设计实验室「莫奈咒语」(500赞，五段式公式)、
 *   B站无相CG「John Park 气氛图转写实细节」、一刀入肾「影视概念气氛图」。
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  // ———— 小说 ————
  {
    id: "agent-novel-xuanhuan-cover",
    name: "玄幻封面",
    note: "男频玄幻封面，低机位仰拍撑气势，书名区留顶，适合起点式题材",
    domain: "novel",
    painPoint: "男频封面约稿一版三百，交出来还没平台热榜的味",
    initialPrompt:
      "我的玄幻小说要封面，主角是（写主角形象与标志物，如黑袍持剑少年），要男频玄幻封面的气势，顶部留书名区，别做成影楼风。",
    slots: {
      prompt:
        "（把这里换成你的主角与题材关键词）男频玄幻小说封面，史诗奇幻质感，主角立于视觉中心，金红黑高对比配色，服装材质与护甲细节清晰，气场外放",
      contextPrompt: "天地异象背景，山河或宫殿剪影纵深感，顶部三分之一为书名文字预留的深色干净区域",
      composition: [
        "竖版 3:4 封面构图，顶部三分之一留书名区",
        "极端低机位仰拍主角，人物占画面下半拉出压迫感",
      ],
      negativePrompt: "盗版封面廉价感，乱入文字与水印，影楼写真布光，主角比例失真，低对比灰蒙蒙",
      styleTemplateId: "sai-fantasy art",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-novel-guyan-cover",
    name: "古言封面",
    note: "女频古言封面，人物居下题字留上，明暗克制，适合晋江式题材",
    domain: "novel",
    painPoint: "女频古言封面要么土艳要么像盗版，雅致感全靠碰运气",
    initialPrompt:
      "我的古言小说要封面，女主是（写女主形象与意象，如执伞回眸的青衣女子），要晋江古言那种雅致留白，上半留竖排题字位，别做成影楼风。",
    slots: {
      prompt:
        "（把这里换成你的女主与意象，如执伞回眸的青衣女子）女频古言小说封面，工笔与水墨结合的雅致质感，衣袂与飘落花瓣的动势，青白黛低饱和配色，情绪含蓄",
      contextPrompt: "江南庭院或远山云雾，大量留白，上半部留竖排题字位",
      composition: [
        "竖版 3:4，人物占画面下半，上半留题字与书名空间",
        "人物侧影或回眸，视线方向与留白呼应形成气口",
      ],
      negativePrompt: "影楼写真感，过度磨皮，艳俗大红大紫，现代元素穿帮，满构图无留白",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-novel-character-sheet",
    name: "角色设定",
    note: "动画可用级角色设定页，三视图加表情列，白底设定集排版",
    domain: "novel",
    painPoint: "给画师约稿写设定全靠文字，他看完还是自由发挥",
    initialPrompt:
      "帮我把小说角色做成设定页，角色是（写外貌、服装、标志物与气质），要正面侧面背面三视图加一排表情差，拿去约稿当参考。",
    slots: {
      prompt:
        "（把这里换成你的角色：外貌、服装、标志物、气质）角色设定页，同一角色正面、侧面、背面三视图并排，附一排表情差（平静/微笑/惊讶/思考），服装结构逻辑清晰，干净线稿加柔和赛璐璐上色",
      contextPrompt: "纯白设定纸背景，杂志级排版留白，角色旁留细线标注引线空间",
      composition: [
        "横版设定表构图，三个视角等大并排，头脚完整入画",
        "表情列置于三视图下方，角色之间留分隔间距",
      ],
      negativePrompt: "三视图形象不一致，表情崩脸，服装结构漂移，多余手臂，多余人物，复杂背景",
      styleTemplateId: "sai-anime",
      qualityProfile: "balanced",
    },
  },

  // ———— 电商 ————
  {
    id: "agent-ecommerce-scene-shot",
    name: "场景产品图",
    note: "非白底氛围场景图，低角度微距加逆光透光，适合详情页头图",
    domain: "ecommerce",
    painPoint: "详情页全是白底图，转化率上不去又不敢全换模特图",
    initialPrompt:
      "我的商品是（写商品与透光特性，如一瓶琥珀色精华），帮我做一张有氛围的场景图，不要白底，要低角度微距和逆光透出质感，用在详情页头图。",
    slots: {
      prompt:
        "（把这里换成你的商品与材质特性）氛围场景产品图，商品置于真实使用场景中，低角度微距视角，商品材质与光泽纤毫可见，浅景深电影感",
      contextPrompt: "与商品调性匹配的场景，暖光从侧后方打出让材质透光，前景带虚化遮挡物制造纵深",
      composition: [
        "商品占画面 30-40%，置于视觉焦点，边缘锐利干净",
        "前景虚化遮挡制造纵深但不遮商品主体",
      ],
      negativePrompt: "白底棚拍感，商品变形，标签文字乱码，场景杂乱抢主体，CGI 塑料感，硬阴影",
      styleTemplateId: "sai-photographic",
      qualityProfile: "balanced",
    },
  },
  {
    id: "agent-ecommerce-model-shot",
    name: "模特种草图",
    note: "一致性网格模特种草图，远中近景混排，适合投放素材",
    domain: "ecommerce",
    painPoint: "模特档期贵还难约，一套种草图等两周",
    initialPrompt:
      "我要给（写商品，如燕麦色针织开衫）做模特种草图，模特是（写气质，如城市街拍松弛感），要同一人远中近景混排的一致性网格，像真拍了一套。",
    slots: {
      prompt:
        "（把这里换成你的商品与模特气质，如燕麦色针织开衫与松弛感女生）同一模特的一致性网格图，远中近景混排：全身、半身、商品细节特写各占一格，人物与商品自然互动，胶片色调生活方式质感",
      contextPrompt: "城市街头或咖啡店等可信生活场景，自然光，各格背景统一色系",
      composition: [
        "3x3 网格构图，九格同主体同服装，格间留分隔线",
        "每格独立取景，全身、半身、特写、使用动作混合编排",
      ],
      negativePrompt: "各格人物形象不一致，服装细节漂移，棚拍硬光，假笑摆拍，商品细节变形，过度磨皮",
      styleTemplateId: "ads-fashion editorial",
      qualityProfile: "balanced",
    },
  },
  {
    id: "agent-ecommerce-promo-banner",
    name: "大促主视觉",
    note: "大促 banner 主视觉，3D 质感直出，四周留促销文案排版区",
    domain: "ecommerce",
    painPoint: "大促主视觉改到第八版，运营还在说氛围不够炸",
    initialPrompt:
      "做大促 banner 主视觉，主推商品是（写商品），要 3D 质感直出的促销氛围，商品干净不糊，四周留出放利益点和标题的空隙。",
    slots: {
      prompt:
        "（把这里换成你的主推商品）电商大促主视觉，3D 质感直出，商品居中悬浮，光效粒子与飘带从四周向中心聚拢，高饱和渐变氛围，商品边缘干净锐利",
      contextPrompt: "深底高对比氛围，底部与两侧留促销文字排版空间",
      composition: [
        "横版 banner 构图，商品居中占 40%",
        "四角留文案与利益点排版区，光效不遮商品",
      ],
      negativePrompt: "促销文字乱入，商品被光效吞掉，廉价闪烁感，构图塞满，商品变形",
      qualityProfile: "balanced",
    },
  },

  // ———— 短剧 ————
  {
    id: "agent-shortdrama-poster",
    name: "竖屏海报",
    note: "短剧竖屏封面海报，明暗对照塑气场，留剧名与花体字效区",
    domain: "shortdrama",
    painPoint: "短剧海报外包一版五百，还不如信息流里同行的一眼",
    initialPrompt:
      "我的短剧要竖屏海报，主演是（写角色形象与剧设，如西装冷面总裁），要信息流里一眼停下来的气场，顶部留剧名和花体字效的位置。",
    slots: {
      prompt:
        "（把这里换成你的主演形象与剧设，如西装冷面总裁与身后隐忍的女主）短剧竖屏海报，电影写实质感，主角半身特写气场全开，明暗对照布光，冷暖对撞，情绪张力直给",
      contextPrompt: "与剧情强相关的场景暗示，如雨夜天台、豪门客厅，背景压暗突出人物",
      composition: [
        "竖版 9:16，主角占画面 60% 靠下，极端低机位仰拍",
        "顶部留剧名区与花体字效位，底部留平台与 tag 位",
      ],
      negativePrompt: "群演乱入，表情呆滞，文字乱入，构图松散，平光游客照，廉价网大感",
      styleTemplateId: "sai-cinematic",
      qualityProfile: "balanced",
    },
  },
  {
    id: "agent-shortdrama-cp-still",
    name: "CP剧照感",
    note: "主演 CP 氛围剧照，走位与张力线明确，适合投放切片封面",
    domain: "shortdrama",
    painPoint: "剧里 CP 感靠剪辑，投放封面全靠截图截到崩",
    initialPrompt:
      "给我的短剧做一张主演 CP 剧照感封面，两位是（写形象与关系张力，如俯身逼近的总裁与别过脸的她），要有走位感，横竖都要能裁。",
    slots: {
      prompt:
        "（把这里换成两位主演的形象与关系张力）双人 CP 剧照感，两人一近一远的走位关系明确，距离感与情绪拉扯可见，电影级布光，画面里都是剧情",
      contextPrompt: "剧情关键场景一隅，背景压暗虚化只留氛围色",
      composition: [
        "双人同框，一人在画左一人在画中偏右，视线或肢体形成张力线",
        "中景构图，上下留裁切余量适配横竖版",
      ],
      negativePrompt: "两人像互不理睬的合影，僵直站位，平光，背景清晰抢戏，表情呆滞",
      styleTemplateId: "photo-glamour",
      qualityProfile: "balanced",
    },
  },
  {
    id: "agent-shortdrama-storyboard",
    name: "分镜概念图",
    note: "黑白构图稿先行的分镜概念图，一页过导演",
    domain: "shortdrama",
    painPoint: "跟导演沟通镜头全靠嘴说，他脑补的还是另一个片",
    initialPrompt:
      "帮我画一场戏的分镜概念图，戏是（写场景与动作，如天台对峙甩巴掌），要竖屏短剧的镜头语言，先用黑白构图稿定机位，关键景别标出来。",
    slots: {
      prompt:
        "（把这里换成你的场景与动作，如天台对峙甩巴掌）短剧分镜概念图，黑白构图稿先行，每格一个关键镜头，景别与机位角度明确，动作前后关系可读，情绪节拍推进清晰",
      contextPrompt: "简洁场景示意，箭头标注运动方向，关键格加重明暗对比",
      composition: [
        "横版分镜表，6-8 格从左到右从上到下排列",
        "每格独立完整并标注景别（远/全/中/特写），格间留白分隔",
      ],
      negativePrompt: "成品上色插画感，单格过大，镜头语言混乱，人物辨识度不稳定，动作方向不明",
      styleTemplateId: "sai-comic book",
      qualityProfile: "draft",
    },
  },

  // ———— 艺术 ————
  {
    id: "agent-art-concept-illustration",
    name: "概念气氛图",
    note: "影视级概念气氛图，光讲故事，黑白关系先行",
    domain: "art",
    painPoint: "世界观在脑子里很炸，讲给团队只剩干巴巴的设定文档",
    initialPrompt:
      "帮我画一张概念气氛图，世界观是（写设定，如被海洋淹没的钢铁都市），要影视概念那种光讲故事的戏剧性时刻，黑白关系先立住。",
    slots: {
      prompt:
        "（把这里换成你的世界观设定，如被海洋淹没的钢铁都市）影视概念气氛图，黑白灰关系先行的构图，宏大自然与人工造物的尺度对比，戏剧性光线时刻，叙事焦点明确",
      contextPrompt: "广角纵深场景，前景中景背景三层信息递进，光源方向统一",
      composition: [
        "16:9 宽画幅，视点拉远交代尺度",
        "光线引导视线到画面唯一的情绪锚点",
      ],
      negativePrompt: "构图平均无重点，元素堆砌，光源方向打架，颜色脏灰，主体不明",
      styleTemplateId: "sai-digital art",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-art-style-transfer",
    name: "风格迁移",
    note: "五段式公式做艺术家风格迁移，学笔触材质不学滤镜",
    domain: "art",
    painPoint: "想要莫奈那种感觉，跟画师描述半天对不上频道",
    initialPrompt:
      "我想用（写参考艺术家或流派，如莫奈的印象派）的风格画（写主体与场景，如楼下的菜市场），要学到那种笔触和光，不是套滤镜。",
    slots: {
      prompt:
        "（把这里换成参考艺术家 + 你的主体与场景）艺术家风格迁移，按主体描述、环境氛围与色系、艺术风格、镜头视角、精度的顺序组织，风格落在笔触、颜料厚度与纸纹材质上",
      contextPrompt: "与主体匹配的真实场景光线，让参考艺术家的观察方式有发挥余裕",
      composition: ["构图从你的主体出发，取景习惯向参考艺术家看齐"],
      negativePrompt: "风格只停留在滤镜层面，笔触与纸纹质感缺失，模仿签名或落款，两种风格打架，主体形变",
      qualityProfile: "balanced",
    },
  },
  {
    id: "agent-art-exhibition-visual",
    name: "展览主视觉",
    note: "展览海报主视觉，图形与字区分层，克制留白，可直接印刷",
    domain: "art",
    painPoint: "展览主视觉做到印刷所，字区永远压坏图形",
    initialPrompt:
      "我们的展览要主视觉，展览是（写主题，如关于时间与化石的当代艺术展），要克制有格调，图形和字区分层清楚，能直接拿去印刷。",
    slots: {
      prompt:
        "（把这里换成展览主题，如时间与化石的对话）当代展览主视觉，观念性图形语言，克制配色与高级灰阶，核心意象一眼可读，留白即格调",
      contextPrompt: "无干扰的纯净背景，图形与留白构成版式骨架",
      composition: [
        "竖版海报比例，图形区与字区分层明确互不侵入",
        "下缘留展名、日期、场馆信息排版条",
      ],
      negativePrompt: "装饰堆砌，渐变滥用，字区被图形侵入，廉价素材感，构图塞满",
      styleTemplateId: "misc-minimalist",
      qualityProfile: "print",
    },
  },
];
