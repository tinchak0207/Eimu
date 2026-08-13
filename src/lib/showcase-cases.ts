import type { StylePreset } from "@/lib/prompt-enhancer";

export interface ShowcaseCase {
  id: string;
  title: string;
  category: string;
  style: StylePreset;
  prompt: string;
  resultNote: string;
  gradient: string;
  image?: string;
  /** 该案例在转盘上居中时，舞台背后那层环境光的主色（hex）。取自 gradient 里
      最饱和的那一档 —— 转到谁，背景就被谁染一下，像 Apple TV 的海报底光。 */
  glow: string;
}

export const SHOWCASE_CASES: ShowcaseCase[] = [
  {
    id: "global-skincare-branding",
    title: "当下审美，此刻同步。",
    category: "品牌营销",
    style: "product",
    prompt: "参考 2026 年夏季 Instagram 上最流行的极简主义护肤品拍摄风格，为这款精华液生成一张广告图。要有流动的液体质感、柔和的自然光，以及符合当下潮流的莫兰迪配色。",
    resultNote: "实时参考最新视觉趋势，让每一张护肤大片，\n都拥有恰到好处的当代感。",
    gradient: "from-[#F5F5F5] via-[#E0E0E0] to-[#CFD8DC]",
    image: "/showcase/showcase1.webp",
    glow: "#8FA9B8",
  },
  {
    id: "readable-craft-beer-label",
    title: "每一个字，都清清楚楚。",
    category: "包装设计",
    style: "product",
    prompt: "一瓶放在潮湿木质吧台上的精酿啤酒，标签上清晰显示：‘Midnight Forest’，下方小字标注‘IPA - 6.5% ALC’。要有冰镇的冷凝水珠和电影感的侧光。",
    resultNote: "从品牌名称到成分信息，文字准确呈现。\n看见的，就是可以继续设计的。",
    gradient: "from-[#1B1B1B] via-[#3A3A3A] to-[#2E7D32]",
    image: "/showcase/showcase2.webp",
    glow: "#2E7D32",
  },
  {
    id: "tech-event-poster-dual-lang",
    title: "两种语言，一套好版式。",
    category: "活动视觉",
    style: "poster",
    prompt: "2026 科技创新峰会海报。背景是半透明的量子计算网格，中央文字：‘The Future is Now / 未来已来’。字体要求现代感、高对比度，有足够的留白区域。",
    resultNote: "中英文自然共存，层级、间距与节奏一次到位。\n活动主视觉，从第一版就足够完整。",
    gradient: "from-[#000428] via-[#004e92] to-[#00d2ff]",
    image: "/showcase/showcase3.webp",
    glow: "#0A84FF",
  },
  {
    id: "cinematic-steampunk-train",
    title: "复杂空间，也有秩序。",
    category: "概念设计",
    style: "poster",
    prompt: "一个巨大的维多利亚风格火车站，一辆蒸汽火车正破雾驶来。复杂的钢结构穹顶透视要完全准确，阳光透过彩色玻璃窗斜射下来，形成清晰的丁达尔光瀑，地面的积水倒影出火车头的金属细节。",
    resultNote: "宏大的建筑、交错的结构与层叠的光线，\n都被准确安放在同一个空间里。",
    gradient: "from-[#1a1c23] via-[#8B7355] to-[#EEDC82]",
    image: "/showcase/showcase4.webp",
    glow: "#C68B3C",
  },
  {
    id: "interior-trend-lookup",
    title: "先看见，再决定。",
    category: "室内设计",
    style: "product",
    prompt: "根据 2026 年米兰家具展最新的‘静谧主义’（Quiet Luxury）室内设计趋势，生成一个光影斑驳的客厅。要有侘寂风的纹理质感，家具比例要严格符合人体工学。",
    resultNote: "从空间比例到材质氛围，快速呈现完整构想。\n让灵感在落地之前，先成为画面。",
    gradient: "from-[#EADEDB] via-[#BC948B] to-[#8E5E53]",
    image: "/showcase/showcase5.webp",
    glow: "#B98A7C",
  },
  {
    id: "streetwear-drop-teaser",
    title: "像胶片。更像你的品牌。",
    category: "社媒运营",
    style: "street",
    prompt: "模拟徕卡 M11 的直出色彩，拍摄一张街头卫衣特写。要有浓郁的胶片颗粒感，模特在过马路时的动态模糊，背景是东京涩谷的雨夜霓虹。",
    resultNote: "自然颗粒、真实光感与随手拍般的松弛质感，\n为新品带来更有温度的第一印象。",
    gradient: "from-[#833ab4] via-[#fd1d1d] to-[#fcb045]",
    image: "/showcase/showcase6.webp",
    glow: "#C0399B",
  },
];
