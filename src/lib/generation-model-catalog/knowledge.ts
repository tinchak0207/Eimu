/**
 * 模型卡三字段数据（吞併決策清單主線四首件）：擅长 strengths / 已知缺陷
 * knownDefects / 建议 usageTips。纯数据、纯加法——catalog.ts 在模块初始化时
 * 一次性挂到对应条目，消费端经 modelKnowledge(modelId) 读取，无数据的模型
 * 返回 null，卡片优雅降级。
 *
 * 内容纪律（与 use-cases 语料同源同标准）：
 * - 每条宣称必须可溯源：工作区 reddit-use-cases 语料（Reddit 实测讨论）、
 *   内置广告投放提示词指南（ai-ad-prompt-guide）的模型实测结论、或模型
 *   公开能力特征。无法溯源的结论宁可不写。
 * - 已知缺陷写「会怎么坏 + 怎么绕」，不写贬损对比。
 * - usageTips 带 params 时，params 必须落在该模型目录声明的比例/分辨率/
 *   时长集合内（knowledge.test.ts 有契约测试锁住）。
 */
import type { ModelKnowledge } from "./types";
import {
  DEFAULT_IMAGE_MODEL_ID,
  GPT_IMAGE_MODEL_ID,
  GPT_IMAGE_15_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  IMAGE_5_PRO_MODEL_ID,
  IMAGE_5_LITE_MODEL_ID,
  SEEDREAM_20_MODEL_ID,
  SENSENOVA_U1_FAST_MODEL_ID,
  ADOBE_FIREFLY_MODEL_ID,
  FLUX_2_MODEL_ID,
  FLUX_2_PRO_MODEL_ID,
  FLUX_11_PRO_MODEL_ID,
  FLUX_11_ULTRA_MODEL_ID,
  FLUX_KONTEXT_PRO_MODEL_ID,
  FLUX_KONTEXT_MAX_MODEL_ID,
  RUNWAY_GEN4_IMAGE_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  VEO_31_MODEL_ID,
  VEO_31_FAST_MODEL_ID,
  KLING_30_MODEL_ID,
  KLING_30_OMNI_MODEL_ID,
  KLING_25_TURBO_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  SEEDANCE_20_FAST_MODEL_ID,
  RUNWAY_GEN4_VIDEO_MODEL_ID,
  RUNWAY_GEN45_VIDEO_MODEL_ID,
  ADOBE_FIREFLY_VIDEO_MODEL_ID,
  LUMA_RAY2_MODEL_ID,
  LUMA_RAY2_FLASH_MODEL_ID,
  LUMA_RAY3_MODEL_ID,
  LUMA_RAY3_HDR_MODEL_ID,
  LUMA_RAY314_MODEL_ID,
  LUMA_RAY314_HDR_MODEL_ID,
} from "../image-model-ids.js";

export const MODEL_KNOWLEDGE: Record<string, ModelKnowledge> = {
  // ── OpenAI 图像 ──
  [DEFAULT_IMAGE_MODEL_ID]: {
    strengths: [
      "指令遵循第一梯队，能按文字要求精确控制排版与构图",
      "中英文标题、招牌等短文案渲染准确，适合海报与包装",
      "参考图编辑保持主体，改元素不动全局",
    ],
    knownDefects: [
      "手指特写容易崩坏，需要手部细节时优先半身/全身构图，并在负面提示里排除畸形手指",
      "生成速度偏慢，长提示词下更明显",
    ],
    usageTips: [
      { text: "带文字的交付图直接上 2K：短标题 + 大字号 + 高对比背景能显著降低乱码率", params: { outputResolution: "2k" } },
      { text: "长段落文字不要一次生成，先出无字底图或只留短标题，正文交给后期排版" },
    ],
  },
  [GPT_IMAGE_15_MODEL_ID]: {
    strengths: [
      "承接 GPT Image 家族的指令遵循与文字渲染",
      "单价约为 GPT Image 2 的一半，日常批量任务性价比高",
    ],
    knownDefects: ["只有 1K 输出，放大交付会损失细节", "手指与局部特写仍需抽卡"],
    usageTips: [{ text: "日常配图与批量变体用它跑，最终交付图切 GPT Image 2 的 2K/4K" }],
  },
  [GPT_IMAGE_MODEL_ID]: {
    strengths: ["老牌旗舰，提示词理解与复杂指令执行全面"],
    knownDefects: ["全目录最高单价，速度慢", "大部分任务已被 GPT Image 2 / 1.5 覆盖"],
  },

  // ── Google 图像（Nano Banana 系） ──
  [NANO_BANANA_2_MODEL_ID]: {
    strengths: [
      "速度与画质的平衡点：改图、多参考图合成稳定，主体一致性好",
      "支持 4K，成图细节经得起放大",
    ],
    knownDefects: ["小字号长文本仍可能拼错，文案越短越准", "多人场景身份属性偶发混淆"],
    usageTips: [
      { text: "换背景/改场景时把身份锚点（脸型、发型、服装）单独写成一句，只描述要改变的部分" },
      { text: "满意的构图再升 4K 出交付版，日常迭代留在 2K 省币", params: { outputResolution: "4k" } },
    ],
  },
  [NANO_BANANA_PRO_MODEL_ID]: {
    strengths: [
      "文字渲染第一梯队，海报级排版与多行文案表现好",
      "4K 细节扎实，多图参考合成与风格迁移稳定",
    ],
    knownDefects: ["单价较高，抽卡成本大", "出图耗时比 Flash 版长"],
    usageTips: [{ text: "带长文案/中英双语的包装与海报直接上 4K + 大字号", params: { outputResolution: "4k" } }],
  },
  [NANO_BANANA_MODEL_ID]: {
    strengths: [
      "全目录最低价的改图入口：抠图、换背景、商品图变体快且稳",
      "招牌、logo 等短文字渲染可靠",
    ],
    knownDefects: ["只有 1K，放大交付会糊", "复杂多人场景身份容易混"],
    usageTips: [{ text: "商品图先用它出白底/场景变体，满意后作为首帧参考图交给图生视频模型" }],
  },

  // ── Dreamina 图像 ──
  [IMAGE_5_PRO_MODEL_ID]: {
    strengths: ["中文文字渲染强，双语海报一次成型", "2K 人像与商品棚拍质感扎实"],
    knownDefects: ["长段落中文仍会漏字，交付前逐字校对"],
    usageTips: [{ text: "中文海报与电商主图优先 2K", params: { outputResolution: "2k" } }],
  },
  [IMAGE_5_LITE_MODEL_ID]: {
    strengths: ["低价快速，草稿迭代与批量变体省币"],
    knownDefects: ["画质上限低于 Pro 档，细节放大后发软"],
    usageTips: [{ text: "先用 Lite 锁构图和配色，满意的再切 Image 5 Pro 出 2K 成图" }],
  },
  [SEEDREAM_20_MODEL_ID]: {
    strengths: ["中文提示词理解好，构图与排版一次到位", "4K 出图价格低于同级"],
    knownDefects: ["风格化极强的画面色彩偶发过饱和，建议在提示词里限定色板"],
    usageTips: [{ text: "中文海报与社媒配图用 2K 起步，需要放大展示再切 4K", params: { outputResolution: "2k" } }],
  },
  [SENSENOVA_U1_FAST_MODEL_ID]: {
    strengths: ["全图像目录最低价（0.1 币/张），出图快"],
    knownDefects: ["只有 1:1 / 3:2 / 2:3 三种比例", "不支持参考图，无法做图生图"],
    usageTips: [{ text: "适合大批量草稿、占位图与风格试验，别用于需要参考图或特殊比例的任务" }],
  },

  // ── Adobe 图像 ──
  [ADOBE_FIREFLY_MODEL_ID]: {
    strengths: ["训练数据授权链路清晰，商用交付有授权兜底", "写实人像与产品棚拍风格稳"],
    knownDefects: ["风格化与插画表现弱于专门模型", "文字渲染一般，长文案易错"],
    usageTips: [{ text: "2K 与 1K 同价，直接选 2K 不亏", params: { outputResolution: "2k" } }],
  },

  // ── FLUX 图像 ──
  [FLUX_2_PRO_MODEL_ID]: {
    strengths: ["摄影质感与大标题排版（FLUX.2 主打能力）强", "提示词宽容，长描述也能保持构图"],
    knownDefects: ["人物皮肤偶发过度平滑；放大后眼睛、手部有塑料感（Reddit 用户多次报告）"],
    usageTips: [{ text: "出图后局部修脸别整图重抽；提示词里写「保留自然皮肤纹理」能压住磨皮倾向" }],
  },
  [FLUX_2_MODEL_ID]: {
    strengths: ["与 FLUX.2 Pro 同源的质感与排版，价格更低"],
    knownDefects: ["细节密度与提示词遵循略弱于 Pro 档"],
    usageTips: [{ text: "批量抽卡用标准版，最终成图切 FLUX.2 Pro" }],
  },
  [FLUX_KONTEXT_MAX_MODEL_ID]: {
    strengths: ["指令式改图还原度高：换背景、挪物、增删元素听指挥", "主体保持好，改背景不动人脸"],
    knownDefects: [
      "重打光与换背景容易把皮肤修成塑料感（Reddit 实测讨论）",
      "连续多轮编辑会累积漂移，第二轮起人脸可能走样",
    ],
    usageTips: [{ text: "改图指令里写「保留自然皮肤纹理，不磨皮」，并把修补限制在局部而不是反复重抽整图" }],
  },
  [FLUX_KONTEXT_PRO_MODEL_ID]: {
    strengths: ["指令式编辑的性价比档，换背景/改元素稳定"],
    knownDefects: ["与 Max 同源的问题：重打光后皮肤塑料感、多轮编辑漂移"],
    usageTips: [{ text: "日常改图用 Pro，最终交付那一步再切 Max 重跑一次" }],
  },
  [FLUX_11_PRO_MODEL_ID]: {
    strengths: ["出图快、写实人像自然，单价低"],
    knownDefects: ["排版能力弱于 FLUX.2", "多人场景不同人物的属性容易串（Reddit 报告 LoRA 触发词打到所有人）"],
    usageTips: [{ text: "多人画面给每个角色单独一句描述并写明位置（左/右/前景/背景）" }],
  },
  [FLUX_11_ULTRA_MODEL_ID]: {
    strengths: ["1.1 系最高细节密度，写实质感经得起放大"],
    knownDefects: ["与 1.1 Pro 同源的多人属性串扰问题"],
    usageTips: [{ text: "最终成图用 Ultra，抽卡阶段用 1.1 Pro 省一半币" }],
  },

  // ── Runway 图像 ──
  [RUNWAY_GEN4_IMAGE_MODEL_ID]: {
    strengths: ["人物一致性强，与 Gen-4 视频共享角色基础", "电影感构图与光影氛围"],
    knownDefects: ["文字渲染弱，不适合带文案的海报"],
    usageTips: [{ text: "给 Gen-4 / Gen-4.5 视频做首帧或角色设定图时优先选它", params: { outputResolution: "2k" } }],
  },

  // ── PixAI（二次元） ──
  [PIXAI_TSUBAKI2_MODEL_ID]: {
    strengths: ["二次元立绘与动漫插画第一梯队，色彩干净、线条稳定", "平台主推模型，风格出片率高"],
    knownDefects: ["写实人像与摄影质感不是它的主场"],
    usageTips: [{ text: "竖版角色立绘用 3:4 出全身，头部细节更稳", params: { aspectRatio: "3:4" } }],
  },
  [PIXAI_HARUKA_V2_MODEL_ID]: {
    strengths: ["二次元插画稳定，价格低于旗舰档"],
    knownDefects: ["写实风格与长文本排版弱"],
  },
  [PIXAI_HOSHINO_V2_MODEL_ID]: {
    strengths: ["二次元插画与角色图，日常产出省币"],
    knownDefects: ["写实风格与长文本排版弱"],
  },
  [PIXAI_TSUBAKI_V11_MODEL_ID]: {
    strengths: ["Tsubaki 系前代版本，画风与 2 代接近"],
    knownDefects: ["细节与稳定性弱于 Tsubaki.2"],
  },
  [PIXAI_REFERENCE_PRO_MODEL_ID]: {
    strengths: ["参考图驱动：同一角色出多张图时人设锁定最好", "支持参考图，适合角色一致性任务"],
    knownDefects: ["无参考图时与普通二次元模型拉不开差距"],
    usageTips: [{ text: "同一角色要出多张不同场景图时用它，先上传角色参考图再改场景描述" }],
  },

  // ── Google 视频 ──
  [VEO_31_MODEL_ID]: {
    strengths: ["电影感镜头语言与物理一致性第一梯队", "原生音画同步：对白、环境音、音效一次生成"],
    knownDefects: ["默认偏电影感，拍 UGC/随手拍会显得太精致", "单价高，抽卡成本大"],
    usageTips: [
      { text: "要 UGC 质感就在提示词里写明「手机拍摄、非电影感」" },
      { text: "品牌主视觉与交付片用 1080p，草稿阶段切 Veo 3.1 Fast", params: { outputResolution: "1080p" } },
    ],
  },
  [VEO_31_FAST_MODEL_ID]: {
    strengths: ["与 Veo 3.1 同源的镜头语言，速度更快、单价减半"],
    knownDefects: ["细节与音质不如完整版"],
    usageTips: [{ text: "先用 Fast 锁运镜和分镜，满意的镜头再用完整版重跑", params: { outputResolution: "720p" } }],
  },

  // ── Kling 视频 ──
  [KLING_30_MODEL_ID]: {
    strengths: ["动态幅度大、人物动作有力", "图生视频主体保持好，产品动画与人物都稳", "支持音轨生成，对白与环境音一次出"],
    knownDefects: ["大幅运动时手部与肢体细节偶发扭曲", "带音轨单价上浮约四成"],
    usageTips: [
      { text: "图生视频先给一张高质量首帧（可用 Nano Banana 出图），动态描述单独写一句", params: { outputResolution: "1080p" } },
    ],
  },
  [KLING_30_OMNI_MODEL_ID]: {
    strengths: ["Kling 3.0 系最高档，动态、细节与一致性最好", "默认 1080p，支持音轨"],
    knownDefects: ["与 3.0 同源的肢体细节问题，大幅运动时偶发扭曲"],
    usageTips: [{ text: "最终交付片用 Omni，草稿用 Kling 3.0 或 2.5 Turbo 省币" }],
  },
  [KLING_25_TURBO_MODEL_ID]: {
    strengths: ["全视频目录最低单价，出片快"],
    knownDefects: ["复杂物理与人物一致性弱于 3.0 系", "只有 1080p 一档、5/10 秒两档"],
    usageTips: [{ text: "批量出分镜草稿与动态试验选它，成片再切 Kling 3.0 系" }],
  },

  // ── Dreamina 视频 ──
  [SEEDANCE_20_MODEL_ID]: {
    strengths: ["人物动作与舞蹈等肢体运动自然（广告投放实测指南结论）", "中文提示词理解好，时长档位最全"],
    knownDefects: ["非人物主体（产品、机械）的动态弱于人物"],
    usageTips: [
      { text: "UGC 口播与舞蹈类内容选它，产品 B-roll 切 Kling", params: { outputResolution: "1080p" } },
    ],
  },
  [SEEDANCE_20_FAST_MODEL_ID]: {
    strengths: ["Seedance 2.0 的高速档，分镜草稿省币"],
    knownDefects: ["细节上限低于标准版，最高 720p"],
    usageTips: [{ text: "先用 Fast 定分镜与运镜，成片镜头用标准版 1080p 重跑", params: { outputResolution: "480p" } }],
  },

  // ── Runway 视频 ──
  [RUNWAY_GEN45_VIDEO_MODEL_ID]: {
    strengths: ["跨镜头角色一致性强，同一角色多机位不换脸", "运镜控制（推拉摇移）听话"],
    knownDefects: ["不生成音轨，需要配音走后期", "只有 720p 一档"],
    usageTips: [{ text: "同一角色的多镜头叙事短片选它，10 秒档给足转场时间", params: { durationSeconds: 10 } }],
  },
  [RUNWAY_GEN4_VIDEO_MODEL_ID]: {
    strengths: ["首帧图生视频稳定，角色一致性好", "单价低，多镜头序列的性价比选择"],
    knownDefects: ["不生成音轨，仅 720p 一档"],
    usageTips: [{ text: "批量首帧动画与分镜序列用它，关键镜头升 Gen-4.5" }],
  },

  // ── Adobe 视频 ──
  [ADOBE_FIREFLY_VIDEO_MODEL_ID]: {
    strengths: ["商用授权链路清晰", "图生视频画面稳，镜头运动克制"],
    knownDefects: ["只有 5 秒一档", "动态幅度保守，大动作会软"],
    usageTips: [{ text: "给静态产品图加轻动态，540p/720p 足够且省币", params: { outputResolution: "540p" } }],
  },

  // ── Luma 视频 ──
  [LUMA_RAY2_FLASH_MODEL_ID]: {
    strengths: ["Luma 系最低价的高速档，光影氛围保留多"],
    knownDefects: ["细节与运动幅度低于 Ray2/Ray3"],
    usageTips: [{ text: "分镜草稿与氛围试验选它，成片切 Ray3 系" }],
  },
  [LUMA_RAY2_MODEL_ID]: {
    strengths: ["光影氛围与梦幻质感是招牌", "分辨率档位全（540p~4K）"],
    knownDefects: ["人物大幅度动作偶发形变"],
  },
  [LUMA_RAY3_MODEL_ID]: {
    strengths: ["Ray 家族画质主力：光影、材质与构图扎实", "分辨率档位全（360p~4K）"],
    knownDefects: ["单价高于 Ray2 系，草稿阶段不划算"],
    usageTips: [{ text: "草稿用低档位省钱，成片再切 1080p/4K", params: { outputResolution: "1080p" } }],
  },
  [LUMA_RAY3_HDR_MODEL_ID]: {
    strengths: ["HDR 高光滚转，逆光与夜景动态范围大"],
    knownDefects: ["全目录最高单价，草稿阶段极不划算"],
    usageTips: [{ text: "只在成片级光影镜头（日落、霓虹、逆光）上用 HDR，草稿切 Ray2 Flash", params: { outputResolution: "720p" } }],
  },
  [LUMA_RAY314_MODEL_ID]: {
    strengths: ["Ray3 系新一代：画质与稳定性兼顾，价格低于 HDR 档"],
    knownDefects: ["只有 5/10 秒两档"],
    usageTips: [{ text: "日常成片选它，HDR 场景再升 Ray3.14 HDR" }],
  },
  [LUMA_RAY314_HDR_MODEL_ID]: {
    strengths: ["Ray3.14 系 HDR 档，画质天花板", "4K 可选"],
    knownDefects: ["单价高，只有 5 秒一档"],
    usageTips: [{ text: "最终交付的 HDR 镜头才用它，其余镜头用标准版" }],
  },
};
