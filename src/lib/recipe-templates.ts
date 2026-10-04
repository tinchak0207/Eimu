/**
 * 配方模板 —— 六槽具名 profile（吞并决策主线一第三件）。
 *
 * 「模板」在本项目里的唯一定义：一个具名的六槽参数快照，摊开在工作台表单里可改。
 * 槽位到表单的映射与 workflow-recall 完全同构（画面描述 / 场景 / 构图 / 避免 /
 * 风格 / 质量档），套用走同一条 parseWorkflowRecallConfig 校验路径 —— 模板不是
 * 黑盒封装，而是「填进表单的一组值」。
 *
 * 内置风格模板的风格槽尽量引用 style-library 既有条目（挂既有 owner，不造第二套
 * 风格库）；style-library 没有的风格（水墨、3D手办、Q版）把风格语言写进画面描述槽。
 */

import type { WorkflowRecallConfig } from "./workflow-recall";

/** 模板的六槽内容。字段与 WorkflowRecallConfig 一一对应（composition → regionalPrompts）。 */
export interface RecipeTemplateSlots {
  /** 画面描述槽（主体 + 风格语言，套用后用户可改主体）。 */
  prompt: string;
  /** 场景槽（项目与品牌 / 场景环境）。 */
  contextPrompt?: string;
  /** 构图槽（每条进一条构图要求）。 */
  composition?: string[];
  /** 避免槽。 */
  negativePrompt?: string;
  /** 风格槽：style-library 既有条目 id（生成时注入，不重复写进提示词）。 */
  styleTemplateId?: string;
  /** 质量槽：draft / balanced / print。 */
  qualityProfile?: string;
}

export interface RecipeTemplate {
  id: string;
  name: string;
  /** 一句话说明这个模板适合什么。 */
  note: string;
  slots: RecipeTemplateSlots;
}

/**
 * 内置风格模板（10 个）。
 *
 * 画面描述槽刻意写成「风格语言 + 主体占位提示」而不是成品句子：模板摊开可改的
 * 前提是用户一眼能看出哪里该换成自己的主体。
 */
export const BUILT_IN_RECIPE_TEMPLATES: RecipeTemplate[] = [
  {
    id: "builtin-3d-figure",
    name: "3D手办",
    note: "收藏级手办质感，棚拍陈列，适合角色与 IP 周边",
    slots: {
      prompt: "（把这里换成你的主体）收藏级 3D 手办化处理，PVC 材质光泽，精细涂装与轻微磨损细节，1/7 比例陈列感",
      contextPrompt: "专业手办摄影棚，渐变背景纸，亚克力底座反射",
      composition: ["主体居中占画面 60%，底座下缘留出干净倒影空间"],
      negativePrompt: "廉价塑料感，涂装溢色，接缝明显，比例失真，模糊",
      styleTemplateId: "sai-3d-model",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-claymation",
    name: "黏土手作",
    note: "定格动画黏土质感，可爱治愈，适合儿童向内容",
    slots: {
      prompt: "（把这里换成你的主体）黏土手工雕塑质感，指尖压痕与不完美边缘，定格动画角色气质",
      contextPrompt: "毛毡布景的小型摄影台，温暖柔光",
      composition: ["主体居中，浅景深虚化背景手工道具"],
      negativePrompt: "光滑塑料，锐利边缘，写实照片感，噪点",
      styleTemplateId: "sai-craft clay",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-chibi",
    name: "Q版可爱",
    note: "二头身夸张比例，大头贴式构图，适合表情包与周边",
    slots: {
      prompt: "（把这里换成你的角色）Q 版二头身比例，圆润轮廓，大眼睛，腮红点缀，贴纸式干净造型",
      contextPrompt: "纯色柔和背景，无杂物",
      composition: ["角色全身入画并居中，四周留出贴纸裁切边距"],
      negativePrompt: "写实人脸，身体比例正常化，复杂背景，恐怖谷",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-analog-film",
    name: "胶片质感",
    note: "35mm 胶片色彩与颗粒，日常叙事感，适合社媒人像",
    slots: {
      prompt: "（把这里换成你的主体）35mm 胶片摄影，自然抓拍瞬间，色彩微褪，边角轻微暗角",
      contextPrompt: "午后街边或窗边，自然光斜射",
      composition: ["主体偏离中心三分之一处，前景留一点虚化遮挡"],
      negativePrompt: "数字锐化，HDR，过度饱和，摆拍僵硬",
      styleTemplateId: "sai-analog film",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-ink-wash",
    name: "水墨插画",
    note: "留白与笔触的国画语言，适合文化类封面与海报",
    slots: {
      prompt: "（把这里换成你的主体）水墨插画，宣纸质感，浓淡干湿五色墨阶，可见笔锋与飞白，大量留白",
      contextPrompt: "远景淡墨山影，题款印章位置预留",
      composition: ["主体占画面三分之一，对角留白，右上角留题款空间"],
      negativePrompt: "彩色，厚重油画感，满构图，数字渐变",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-watercolor",
    name: "水彩插画",
    note: "透明水色与纸纹，轻盈文艺，适合书籍与品牌插画",
    slots: {
      prompt: "（把这里换成你的主体）水彩插画，透明叠色，水痕边缘自然晕开，粗颗粒水彩纸纹理",
      contextPrompt: "轻盈的植物或几何小元素点缀四周",
      composition: ["主体居中偏下，上方留出透气空间"],
      negativePrompt: "厚涂，油画质感，锐利矢量边缘，纯黑线条",
      styleTemplateId: "artstyle-watercolor",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-cyberpunk",
    name: "赛博朋克",
    note: "霓虹夜城与高对比冷暖，适合科技感主视觉",
    slots: {
      prompt: "（把这里换成你的主体）赛博朋克夜城氛围，霓虹招牌冷暖对撞，湿润地面反射，体积雾",
      contextPrompt: "雨后夜晚的下沉街道，全息广告与蒸汽管道",
      composition: ["低机位仰拍，主体剪影被霓虹勾勒，背景纵深拉出三层街景"],
      negativePrompt: "白天，自然田园，低饱和，灰蒙蒙",
      styleTemplateId: "futuristic-cyberpunk cityscape",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-minimalist",
    name: "极简主义",
    note: "大量留白与克制配色，适合高端品牌与官网配图",
    slots: {
      prompt: "（把这里换成你的主体）极简主义画面，单一主体，克制的双色配色，大面积留白",
      contextPrompt: "无影棚墙背景，柔和均匀布光",
      composition: ["主体置于黄金分割点，四周留白不少于画面 50%"],
      negativePrompt: "装饰元素，复杂背景，堆砌细节，多彩",
      styleTemplateId: "misc-minimalist",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-cinematic",
    name: "电影感",
    note: "宽画幅叙事光线，适合封面与情绪关键帧",
    slots: {
      prompt: "（把这里换成你的主体）电影静帧质感，浅景深，电影级布光，胶片颗粒与轻微暗角",
      contextPrompt: "黄昏侧逆光，空气中有可见尘埃光束",
      composition: ["16:9 宽画幅，主体三分线入画，前景留虚化遮挡物"],
      negativePrompt: "平面光，游客照，杂乱背景，过度锐化",
      styleTemplateId: "sai-cinematic",
      qualityProfile: "balanced",
    },
  },
  {
    id: "builtin-anime",
    name: "日系动漫",
    note: "赛璐璐动画质感与高饱和，适合二次元内容",
    slots: {
      prompt: "（把这里换成你的角色）日系动画赛璐璐质感，干净线稿，高饱和配色，关键帧级完成度",
      contextPrompt: "放学后的天台或樱花街道，逆光与光斑",
      composition: ["角色半身入画，视线方向留白"],
      negativePrompt: "写实照片，3D 渲染感，脏线稿，低对比",
      styleTemplateId: "sai-anime",
      qualityProfile: "balanced",
    },
  },
];

/** 模板槽位 → workflow-recall 配置（套用与存储共用同一结构）。 */
export function recipeTemplateToRecallConfig(template: RecipeTemplate): WorkflowRecallConfig {
  const slots = template.slots;
  const config: WorkflowRecallConfig = { prompt: slots.prompt };
  if (slots.contextPrompt) config.contextPrompt = slots.contextPrompt;
  if (slots.negativePrompt) config.negativePrompt = slots.negativePrompt;
  if (slots.composition?.length) {
    config.regionalPrompts = slots.composition.map((text) => ({ text }));
  }
  if (slots.styleTemplateId) config.styleTemplate = slots.styleTemplateId;
  if (slots.qualityProfile) config.qualityProfile = slots.qualityProfile;
  return config;
}
