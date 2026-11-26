/**
 * 灵感模板：小程序静态模板库。
 *
 * prompt 正文逐字取自网页版既有文案，未作改写：
 * - src/lib/scenario-templates.ts（contextPrompt）
 * - src/lib/use-case-categories/content.ts（prompts[].prompt）
 * 每条注释标明来源文件与行号；有截取时另行注明。
 *
 * aspectRatio 仅使用小程序已开放的画幅（见 ./models.ts），便于一键回填。
 */
import type { AspectRatio } from './models'

export const TEMPLATE_CATEGORIES = ['电商', '海报', '广告', '人像', '插画', '自媒体'] as const

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export interface InspirationTemplate {
  id: string
  /** 短标题，用于卡片与「套用模板」chip */
  title: string
  category: TemplateCategory
  /** 提示词正文，原样照抄 */
  prompt: string
  aspectRatio?: AspectRatio
}

export const INSPIRATION_TEMPLATES: InspirationTemplate[] = [
  // src/lib/scenario-templates.ts:24
  {
    id: 'shop-hero',
    title: '电商主图',
    category: '电商',
    prompt:
      '为电商平台商品列表页生成 1:1 主图：单品居中占画面约 70%，纯白或浅灰影棚背景，底部预留约 15% 高度给促销角标与价格标签。受众是移动端快速滑动浏览的消费者，要求轮廓清晰、第一眼能认出品类与卖点。柔和顶光加左侧补光，突出材质细节，画面中不得出现任何无关道具。',
    aspectRatio: '1:1',
  },
  // src/lib/scenario-templates.ts:39
  {
    id: 'shop-detail-banner',
    title: '详情页横幅',
    category: '电商',
    prompt:
      '为商品详情页顶部横幅做场景化展示：商品置于画面左侧三分之一，右侧留出大面积纯色或浅渐变区域用于排版卖点文案与购买按钮。场景选真实使用环境（家居台面、办公桌面等），色调与店铺主色统一。受众已进入详情页，画面要传达品质感与信任感，克制促销味，不要爆炸贴与大红底。',
    aspectRatio: '3:2',
  },
  // src/lib/scenario-templates.ts:54
  {
    id: 'food-delivery-cover',
    title: '外卖头图',
    category: '电商',
    prompt:
      '为外卖平台店铺横版头图呈现招牌菜：45 度俯拍，主菜居中偏左，热气、酱汁光泽与食材纹理清晰可见，背景用虚化的深色木桌衬托食欲。暖色灯光，饱和度略高于真实但不失真，右侧留出文案位放店名与满减信息。受众在饥饿状态下快速翻列表，画面必须三秒内勾起食欲。',
    aspectRatio: '3:2',
  },
  // src/lib/scenario-templates.ts:129
  {
    id: 'splash-poster',
    title: '开屏海报',
    category: '海报',
    prompt:
      '为 APP 开屏广告设计竖版海报：视觉主体集中在画面中上部，底部 20% 必须保持干净，预留跳过按钮与品牌落版的安全区，顶部状态栏区域也不放关键元素。受众停留仅 3 秒，主体要单一醒目、色彩对比强烈，拒绝信息堆叠。画面气质须与产品调性一致，活动氛围可以浓但不能廉价。',
    aspectRatio: '2:3',
  },
  // src/lib/scenario-templates.ts:204
  {
    id: 'event-key-visual',
    title: '活动主视觉',
    category: '海报',
    prompt:
      '为线下发布会或大促活动设计主视觉：用抽象图形、舞台光效或主题符号构建有张力的中心构图，画面中央偏上预留活动主题与日期的大字排版区。色彩严格跟随活动主题色，明暗对比强烈以保证远距离识别。需要横、竖、方三版延展，核心图形在三版中位置一致，方便落地到舞台背板、易拉宝与线上海报。',
    aspectRatio: '3:2',
  },
  // src/lib/scenario-templates.ts:219
  {
    id: 'minimal-poster',
    title: '极简海报',
    category: '海报',
    prompt:
      '为单品制作极简风格竖版海报：产品以较小比例置于画面下三分之一的黄金点上，其余空间是大面积单色或微渐变留白，营造画廊般的安静氛围。只用一束定向光与一道投影塑造体积，全画面不超过三种颜色且低饱和。顶部留白区域将排一行细字标语，整体克制、呼吸感强，适合品牌向社交媒体与灯箱投放。',
    aspectRatio: '2:3',
  },
  // src/lib/scenario-templates.ts:69
  {
    id: 'auto-kv',
    title: '汽车 KV',
    category: '广告',
    prompt:
      '为新车上市制作广告主视觉：车辆呈前 45 度低机位动态视角，占画面右侧三分之二，左上方留出车型名与上市日期的文案区。场景选黄昏山路或都市天际线，车漆高光流畅、轮毂细节锐利，湿润地面反射增强质感。需要横、竖、方三版构图同时落地，车头与品牌识别元素必须保持在各版安全区内。',
    aspectRatio: '3:2',
  },
  // src/lib/scenario-templates.ts:99
  {
    id: 'luxury-editorial',
    title: '奢侈品大片',
    category: '广告',
    prompt:
      '为奢侈品牌形象大片构图：单一产品置于深色丝绒或大理石材质之上，侧逆光勾勒轮廓，大面积负空间营造静谧的高级感。色调克制，黑金或低饱和莫兰迪，光影过渡细腻、暗部有层次不死黑。版面顶部预留品牌字标位置，整体气质对标时尚杂志内页广告，用于印刷与高端户外媒体。',
    aspectRatio: '2:3',
  },
  // src/lib/scenario-templates.ts:144
  {
    id: 'moments-ad',
    title: '朋友圈广告',
    category: '广告',
    prompt:
      '为微信朋友圈信息流广告生成方图素材：画面要像朋友随手实拍的生活场景，刻意弱化广告感，产品自然融入环境而非居中摆拍。光线用日常自然光，构图底部留一条窄区给外层文案与落地页按钮。一次生成多个差异化版本供 A/B 测试，受众是通勤碎片时间刷朋友圈的都市上班族。',
    aspectRatio: '1:1',
  },
  // src/lib/scenario-templates.ts:114
  {
    id: 'fashion-lookbook',
    title: '时尚大片',
    category: '人像',
    prompt:
      '为服装品牌季度画册拍摄模特造型整页：全身竖构图，模特站位居中偏右，姿态松弛自然，背景用纯色影棚纸或极简清水混凝土空间。重点表现面料垂坠感与剪裁线条，大柔光箱均匀打光，肤色还原真实不过度磨皮。同一模特要在整个系列中保持脸部与发型一致，画面左侧留窄边文案区标注款号与面料成分。',
    aspectRatio: '2:3',
  },
  // src/lib/use-case-categories/content.ts:87
  {
    id: 'talking-head-cover',
    title: '口播封面底图',
    category: '人像',
    prompt:
      '以上传的本人半身照为参考，保持脸型、发型和服装不变。9:16 竖图，人物位于画面中部偏下，面向镜头，表情自然、带一点惊讶；背景换成纯暖黄色，人物边缘有柔和的白色描边光；画面中上部留出一大块干净区域给标题；上下边缘只放背景，不生成文字。',
    aspectRatio: '2:3',
  },
  // src/lib/scenario-templates.ts:189
  {
    id: 'brand-ip-character',
    title: 'IP 角色立绘',
    category: '插画',
    prompt:
      '为品牌吉祥物绘制全身立绘：角色居中竖构图，浅色纯净背景方便后期抠图，四肢、尾巴与配饰完整不裁切。角色性格要贴合品牌设定（亲和、机灵或可靠），表情饱满、轮廓线干净，配色限定为品牌主色加两个辅助色。该角色之后会反复出现在各类物料中，五官比例、服装与配饰细节必须在多张图之间保持一致。',
    aspectRatio: '2:3',
  },
  // src/lib/use-case-categories/content.ts:115
  {
    id: 'concept-illustration',
    title: '概念示意插画',
    category: '插画',
    prompt:
      '简洁线条插画，白底，只用黑色线条和一种强调色橙色。画面是一座浮在水面上的冰山，水面以上的小部分用橙色描边，水面以下的大部分用黑色细线画出层层结构；水面线清晰，下方留出空间便于后期标注文字；4:3 横图，不生成任何文字和数字。',
    aspectRatio: '3:2',
  },
  // src/lib/use-case-categories/content.ts:64
  {
    id: 'article-illustration',
    title: '正文系列配图',
    category: '插画',
    prompt:
      '扁平矢量插画风格，米白底色，只用墨绿、赭石、浅灰三种颜色，线条粗细一致，无渐变无阴影。本张画一个人坐在堆满纸箱的新公寓地板上，打开笔记本电脑记账，窗外是傍晚的城市。4:3 横图，构图简洁，不出现文字。（前半段风格描述每张复用，只替换最后的场景句。）',
    aspectRatio: '3:2',
  },
  // src/lib/scenario-templates.ts:159
  {
    id: 'xiaohongshu-cover',
    title: '小红书封面',
    category: '自媒体',
    prompt:
      '为小红书笔记封面设计竖图：主体清晰占画面下三分之二，顶部三分之一留白用于后期叠加大号标题贴纸。色彩明快通透，奶油色系或高亮饱和风格，贴合站内精致生活感审美。封面在双列瀑布流中以小尺寸展示，元素必须少而大，标题区之外不要出现细碎装饰物。',
    aspectRatio: '2:3',
  },
  // src/lib/scenario-templates.ts:174
  {
    id: 'wechat-article-banner',
    title: '公众号头图',
    category: '自媒体',
    prompt:
      '为微信公众号文章头图设计横版画面：主视觉元素集中在画面中央的 1:1 安全区内，因为列表缩略图会裁掉左右两侧。配色与账号视觉体系统一，左右留出呼吸空间，中央偏下可预留一行标题文字区。风格偏插画或轻质感图形，避免照片直出的廉价感与图库素材味。',
    aspectRatio: '3:2',
  },
  // src/lib/use-case-categories/content.ts:31
  {
    id: 'food-note-cover',
    title: '美食笔记封面',
    category: '自媒体',
    prompt:
      '3:4 竖图，一块草莓奶油蛋糕放在窗边的木桌上，侧面切开露出层次，旁边一把用过的小叉子和几点蛋糕屑；清晨自然窗光从左侧进来，暖色调，浅景深背景虚化；手机拍摄感，不要过度精修的影棚质感；画面上方三分之一保持干净的浅色背景，不生成文字。',
    aspectRatio: '2:3',
  },
  // src/lib/use-case-categories/content.ts:36
  {
    id: 'home-note-cover',
    title: '家居好物封面',
    category: '自媒体',
    prompt:
      '3:4 竖图，小户型卧室的床头角落，莫兰迪灰绿色墙面，原木床头柜上放一盏奶白色蘑菇台灯和两本书；傍晚台灯亮着，暖光与窗外冷蓝色天光形成对比；画面略带颗粒感，像真实用户拍摄；床头柜是视觉中心，下方留出放标题的空间，不生成文字。',
    aspectRatio: '2:3',
  },
]

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)
}

const ASPECT_RATIO_VALUES: AspectRatio[] = ['1:1', '3:2', '2:3']

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_RATIO_VALUES as string[]).includes(value)
}

/** 校验从 storage 读回的值，避免旧版本或脏数据把页面写崩。 */
export function isInspirationTemplate(value: unknown): value is InspirationTemplate {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.title === 'string' &&
    item.title.length > 0 &&
    typeof item.prompt === 'string' &&
    item.prompt.length > 0 &&
    isTemplateCategory(item.category) &&
    (item.aspectRatio === undefined || isAspectRatio(item.aspectRatio))
  )
}

/** 按分类分组；传入分类时只返回该组。 */
export function groupTemplatesByCategory(): Record<TemplateCategory, InspirationTemplate[]> {
  const groups = {} as Record<TemplateCategory, InspirationTemplate[]>
  TEMPLATE_CATEGORIES.forEach((category) => {
    groups[category] = []
  })
  INSPIRATION_TEMPLATES.forEach((template) => {
    groups[template.category].push(template)
  })
  return groups
}

/** 分类过滤；不传分类返回全部模板。 */
export function filterTemplatesByCategory(
  category?: TemplateCategory,
): InspirationTemplate[] {
  if (!category) return INSPIRATION_TEMPLATES
  return INSPIRATION_TEMPLATES.filter((template) => template.category === category)
}
