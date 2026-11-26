// 场景模板：为广告/电商/新媒体设计师预置项目上下文、反向提示词与尺寸组合。
// styleId 必须取自 prompt-enhancer 的合法风格 id；sizes 仅允许三档官方尺寸。

export interface ScenarioTemplate {
  id: string;                 // kebab-case 英文 id
  name: string;               // 简体中文，2~6 字，如 "电商主图"
  description: string;        // 一句话说明适用场景（简体中文）
  contextPrompt: string;      // 现成的项目上下文（简体中文，2~4 句，具体可用，像资深美术总监写的 brief，不要空话）
  negativePrompt: string;     // 现成的反向提示词（简体中文，逗号分隔的具体禁忌项）
  workflowPreset: "product-shot" | "character-consistency" | "poster-variants" | "style-transfer";
  productionIntent: "general" | "ecommerce" | "campaign" | "character" | "social";
  qualityProfile: "draft" | "balanced" | "print";
  styleId?: string;           // 必须取自下面的合法风格 id 列表
  sizes: string[];            // 非空，取值仅限 "1024x1024" | "1536x1024" | "1024x1536"
  copies: number;             // 1~8
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: "ecommerce-product-hero",
    name: "电商主图",
    description: "淘宝、京东等平台商品列表页的 1:1 单品主图",
    contextPrompt:
      "为电商平台商品列表页生成 1:1 主图：单品居中占画面约 70%，纯白或浅灰影棚背景，底部预留约 15% 高度给促销角标与价格标签。受众是移动端快速滑动浏览的消费者，要求轮廓清晰、第一眼能认出品类与卖点。柔和顶光加左侧补光，突出材质细节，画面中不得出现任何无关道具。",
    negativePrompt:
      "杂乱背景, 多余道具, 文字水印, 第三方商标, 过曝反光, 浓重阴影, 商品裁切不完整, 手指入镜, 噪点模糊, 畸变变形",
    workflowPreset: "product-shot",
    productionIntent: "ecommerce",
    qualityProfile: "balanced",
    styleId: "ads-retail",
    sizes: ["1024x1024"],
    copies: 2,
  },
  {
    id: "ecommerce-detail-banner",
    name: "详情页横幅",
    description: "商品详情页顶部的场景化横版 banner",
    contextPrompt:
      "为商品详情页顶部横幅做场景化展示：商品置于画面左侧三分之一，右侧留出大面积纯色或浅渐变区域用于排版卖点文案与购买按钮。场景选真实使用环境（家居台面、办公桌面等），色调与店铺主色统一。受众已进入详情页，画面要传达品质感与信任感，克制促销味，不要爆炸贴与大红底。",
    negativePrompt:
      "爆炸促销贴纸, 大红配大黄, 密集文字, 廉价塑料质感, 透视错误, 商品比例失真, 背景喧宾夺主, 水印, 低清噪点",
    workflowPreset: "poster-variants",
    productionIntent: "ecommerce",
    qualityProfile: "balanced",
    styleId: "ads-advertising",
    sizes: ["1536x1024"],
    copies: 2,
  },
  {
    id: "food-delivery-cover",
    name: "外卖头图",
    description: "美团、饿了么等外卖店铺的招牌菜横版头图",
    contextPrompt:
      "为外卖平台店铺横版头图呈现招牌菜：45 度俯拍，主菜居中偏左，热气、酱汁光泽与食材纹理清晰可见，背景用虚化的深色木桌衬托食欲。暖色灯光，饱和度略高于真实但不失真，右侧留出文案位放店名与满减信息。受众在饥饿状态下快速翻列表，画面必须三秒内勾起食欲。",
    negativePrompt:
      "食物发灰发暗, 油腻反光, 塑料感假菜, 脏盘子, 杂乱餐具, 冷色调, 文字水印, 苍蝇蚊虫, 半生不熟的肉色, 模糊失焦",
    workflowPreset: "product-shot",
    productionIntent: "ecommerce",
    qualityProfile: "balanced",
    styleId: "ads-gourmet food photography",
    sizes: ["1536x1024"],
    copies: 3,
  },
  {
    id: "auto-campaign-kv",
    name: "汽车KV",
    description: "新车上市投放的多尺寸广告主视觉",
    contextPrompt:
      "为新车上市制作广告主视觉：车辆呈前 45 度低机位动态视角，占画面右侧三分之二，左上方留出车型名与上市日期的文案区。场景选黄昏山路或都市天际线，车漆高光流畅、轮毂细节锐利，湿润地面反射增强质感。需要横、竖、方三版构图同时落地，车头与品牌识别元素必须保持在各版安全区内。",
    negativePrompt:
      "车身比例失真, 车轮变形, 车标错误, 玻璃反射杂乱, 卡通感, 过度HDR, 多余路人, 电线杆穿头, 文字乱码, 低清噪点",
    workflowPreset: "poster-variants",
    productionIntent: "campaign",
    qualityProfile: "print",
    styleId: "ads-automotive",
    sizes: ["1536x1024", "1024x1536", "1024x1024"],
    copies: 2,
  },
  {
    id: "real-estate-ad",
    name: "地产广告",
    description: "高端住宅项目的楼盘推广视觉",
    contextPrompt:
      "为高端住宅项目制作推广视觉：黄昏时分的建筑外立面或样板间客厅，暖色室内灯光与冷色天空形成对比，传达归家感与品质生活。画面下方三分之一保持简洁，用于排版案名、户型面积与咨询热线。受众是 30-45 岁改善型购房家庭，要避免空旷冷漠的效果图感，加入绿植、暖光、地面材质等生活化细节。",
    negativePrompt:
      "效果图塑料感, 透视畸变, 楼体歪斜, 阴天灰暗, 空无一人的冷清感, 杂乱施工痕迹, 电线外露, 文字水印, 过饱和天空",
    workflowPreset: "poster-variants",
    productionIntent: "campaign",
    qualityProfile: "print",
    styleId: "ads-real estate",
    sizes: ["1536x1024", "1024x1536"],
    copies: 2,
  },
  {
    id: "luxury-editorial",
    name: "奢侈品大片",
    description: "腕表、手袋、香水等奢侈品的品牌形象大片",
    contextPrompt:
      "为奢侈品牌形象大片构图：单一产品置于深色丝绒或大理石材质之上，侧逆光勾勒轮廓，大面积负空间营造静谧的高级感。色调克制，黑金或低饱和莫兰迪，光影过渡细腻、暗部有层次不死黑。版面顶部预留品牌字标位置，整体气质对标时尚杂志内页广告，用于印刷与高端户外媒体。",
    negativePrompt:
      "廉价反光, 色彩艳俗, 道具堆砌, 背景杂乱, 促销标签, 塑料质感, 过度锐化, 死黑暗部, 水印文字, 构图拥挤",
    workflowPreset: "product-shot",
    productionIntent: "campaign",
    qualityProfile: "print",
    styleId: "ads-luxury",
    sizes: ["1024x1536", "1536x1024"],
    copies: 2,
  },
  {
    id: "fashion-lookbook",
    name: "时尚大片",
    description: "服装品牌季度 lookbook 的模特造型整页",
    contextPrompt:
      "为服装品牌季度画册拍摄模特造型整页：全身竖构图，模特站位居中偏右，姿态松弛自然，背景用纯色影棚纸或极简清水混凝土空间。重点表现面料垂坠感与剪裁线条，大柔光箱均匀打光，肤色还原真实不过度磨皮。同一模特要在整个系列中保持脸部与发型一致，画面左侧留窄边文案区标注款号与面料成分。",
    negativePrompt:
      "肢体扭曲, 手部畸形, 多余手指, 面部僵硬, 过度磨皮, 服装褶皱杂乱, 配色冲突, 背景杂物, 水印, 低清噪点",
    workflowPreset: "character-consistency",
    productionIntent: "campaign",
    qualityProfile: "print",
    styleId: "ads-fashion editorial",
    sizes: ["1024x1536"],
    copies: 4,
  },
  {
    id: "app-splash-poster",
    name: "开屏海报",
    description: "APP 启动页 3 秒开屏广告的竖版海报",
    contextPrompt:
      "为 APP 开屏广告设计竖版海报：视觉主体集中在画面中上部，底部 20% 必须保持干净，预留跳过按钮与品牌落版的安全区，顶部状态栏区域也不放关键元素。受众停留仅 3 秒，主体要单一醒目、色彩对比强烈，拒绝信息堆叠。画面气质须与产品调性一致，活动氛围可以浓但不能廉价。",
    negativePrompt:
      "信息堆叠, 文字密集, 底部元素拥挤, 主体过小, 配色灰暗, 边缘裁切关键内容, 水印, 噪点, 多个视觉中心互相打架",
    workflowPreset: "poster-variants",
    productionIntent: "social",
    qualityProfile: "balanced",
    styleId: "sai-digital art",
    sizes: ["1024x1536"],
    copies: 3,
  },
  {
    id: "moments-feed-ad",
    name: "朋友圈广告",
    description: "微信朋友圈信息流广告的原生感方图素材",
    contextPrompt:
      "为微信朋友圈信息流广告生成方图素材：画面要像朋友随手实拍的生活场景，刻意弱化广告感，产品自然融入环境而非居中摆拍。光线用日常自然光，构图底部留一条窄区给外层文案与落地页按钮。一次生成多个差异化版本供 A/B 测试，受众是通勤碎片时间刷朋友圈的都市上班族。",
    negativePrompt:
      "影棚摆拍感, 硬广构图, 促销大字, 过度修图, 完美到失真的光线, 水印 logo, 产品悬浮, 背景假到出戏, 噪点模糊",
    workflowPreset: "poster-variants",
    productionIntent: "social",
    qualityProfile: "draft",
    styleId: "photo-iphone photographic",
    sizes: ["1024x1024"],
    copies: 6,
  },
  {
    id: "xiaohongshu-cover",
    name: "小红书封面",
    description: "小红书笔记在双列瀑布流中的竖版封面",
    contextPrompt:
      "为小红书笔记封面设计竖图：主体清晰占画面下三分之二，顶部三分之一留白用于后期叠加大号标题贴纸。色彩明快通透，奶油色系或高亮饱和风格，贴合站内精致生活感审美。封面在双列瀑布流中以小尺寸展示，元素必须少而大，标题区之外不要出现细碎装饰物。",
    negativePrompt:
      "元素细碎, 色彩浑浊, 顶部被占满, 主体偏小, 杂乱背景, 油腻滤镜, 水印, 文字乱码, 过度锐化, 暗沉色调",
    workflowPreset: "poster-variants",
    productionIntent: "social",
    qualityProfile: "balanced",
    styleId: "misc-kawaii",
    sizes: ["1024x1536"],
    copies: 4,
  },
  {
    id: "wechat-article-banner",
    name: "公众号头图",
    description: "微信公众号文章顶部的横版头图",
    contextPrompt:
      "为微信公众号文章头图设计横版画面：主视觉元素集中在画面中央的 1:1 安全区内，因为列表缩略图会裁掉左右两侧。配色与账号视觉体系统一，左右留出呼吸空间，中央偏下可预留一行标题文字区。风格偏插画或轻质感图形，避免照片直出的廉价感与图库素材味。",
    negativePrompt:
      "关键元素贴边, 图库素材感, 照片直出, 配色脏乱, 文字乱码, 水印, 细节糊成一团, 透视混乱, 过度渐变",
    workflowPreset: "style-transfer",
    productionIntent: "social",
    qualityProfile: "balanced",
    styleId: "sai-digital art",
    sizes: ["1536x1024"],
    copies: 3,
  },
  {
    id: "brand-ip-character",
    name: "IP角色立绘",
    description: "品牌吉祥物或虚拟形象的全身立绘",
    contextPrompt:
      "为品牌吉祥物绘制全身立绘：角色居中竖构图，浅色纯净背景方便后期抠图，四肢、尾巴与配饰完整不裁切。角色性格要贴合品牌设定（亲和、机灵或可靠），表情饱满、轮廓线干净，配色限定为品牌主色加两个辅助色。该角色之后会反复出现在各类物料中，五官比例、服装与配饰细节必须在多张图之间保持一致。",
    negativePrompt:
      "五官走形, 多余手指, 肢体缺失, 配色超标, 背景复杂, 线条毛糙, 风格混搭, 写实恐怖谷, 水印, 裁切不完整",
    workflowPreset: "character-consistency",
    productionIntent: "character",
    qualityProfile: "balanced",
    styleId: "sai-anime",
    sizes: ["1024x1536"],
    copies: 4,
  },
  {
    id: "event-key-visual",
    name: "活动主视觉",
    description: "发布会、大促等活动的多尺寸主视觉",
    contextPrompt:
      "为线下发布会或大促活动设计主视觉：用抽象图形、舞台光效或主题符号构建有张力的中心构图，画面中央偏上预留活动主题与日期的大字排版区。色彩严格跟随活动主题色，明暗对比强烈以保证远距离识别。需要横、竖、方三版延展，核心图形在三版中位置一致，方便落地到舞台背板、易拉宝与线上海报。",
    negativePrompt:
      "图形软弱无力, 对比度不足, 元素堆砌, 主题色跑偏, 文字乱码, 水印, 构图失衡, 细节糊化, 廉价光效, 素材拼贴感",
    workflowPreset: "poster-variants",
    productionIntent: "campaign",
    qualityProfile: "print",
    styleId: "ads-advertising",
    sizes: ["1536x1024", "1024x1536", "1024x1024"],
    copies: 2,
  },
  {
    id: "minimal-product-poster",
    name: "极简海报",
    description: "单品的画廊感极简风格竖版海报",
    contextPrompt:
      "为单品制作极简风格竖版海报：产品以较小比例置于画面下三分之一的黄金点上，其余空间是大面积单色或微渐变留白，营造画廊般的安静氛围。只用一束定向光与一道投影塑造体积，全画面不超过三种颜色且低饱和。顶部留白区域将排一行细字标语，整体克制、呼吸感强，适合品牌向社交媒体与灯箱投放。",
    negativePrompt:
      "元素堆砌, 颜色超过三种, 高饱和撞色, 复杂背景, 装饰纹理, 多光源混乱, 投影生硬, 水印文字, 产品占比过大, 噪点",
    workflowPreset: "poster-variants",
    productionIntent: "general",
    qualityProfile: "balanced",
    styleId: "misc-minimalist",
    sizes: ["1024x1536"],
    copies: 2,
  },
];

const SCENARIO_INDEX: ReadonlyMap<string, ScenarioTemplate> = new Map(
  SCENARIO_TEMPLATES.map((template) => [template.id, template])
);

export function getScenarioById(id: string | null | undefined): ScenarioTemplate | undefined {
  if (!id) return undefined;
  return SCENARIO_INDEX.get(id.trim());
}
