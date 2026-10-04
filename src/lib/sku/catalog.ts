// 首批三个营销 SKU——TS 常量目录（冷启动不建 DB 表；量大再迁移，见 docs）。
//
// 定价叙事：SKU 卖的是「人工编排节省 + 投放结构适配」，不是模型单价。目录里的
// pricing 栏位如实标注 v1 的计费方式（per_shot：逐镜头按模型价，走既有
// billing-ledger），per_sku 一口价是商业化定价的后续工作，不提前虚标。

import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import { fieldSchemaView } from "./expand";
import type { MarketingSku, SkuShotTemplate } from "./types";

// ─────────────────────────────────────────── 共用素材

/** 静态产品图的通用质量后缀（所有 prompt 共用，保证输出基线一致）。 */
const PRODUCT_PHOTO_SUFFIX = "商业产品摄影级画质，细节锐利，色彩真实，主体清晰聚焦，画面干净无杂物";
/** 竖屏信息流素材的通用后缀。 */
const VERTICAL_FEED_SUFFIX = "竖屏 9:16 构图，视觉层次分明，适合信息流投放";

function trimVariables(template: string): string {
  return template.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────── SKU 1：电商带货 15s（分镜图组）

const ECOMMERCE_SKU: MarketingSku = {
  id: "sku-ecommerce-15s",
  name: "电商带货 15 秒分镜",
  tagline: "一句话商品信息 → 4-6 张带货短视频分镜图（开箱钩子/卖点特写/场景演示/CTA）",
  channel: "ecommerce",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "product",
      label: "商品名称",
      type: "string",
      required: true,
      description: "商品名与核心品类，如「轻量折叠登机箱 20 吋」。",
      example: "轻量折叠登机箱 20 寸",
    },
    {
      key: "selling_points",
      label: "卖点列表",
      type: "string_list",
      required: true,
      minItems: 1,
      maxItems: 3,
      description: "1-3 条卖点，每条生成一张特写分镜（镜头总数 4-6 随之自适应）。",
      example: ["整机仅 2.6kg", "一键前开盖秒取电脑", "静音万向轮"],
    },
    {
      key: "audience",
      label: "目标受众",
      type: "string",
      required: false,
      description: "投放人群描述；缺省按「通勤出差人群」处理。",
      example: "经常短途出差的通勤上班族",
    },
    {
      key: "product_image_url",
      label: "商品图 URL",
      type: "url",
      required: false,
      description: "可选。v1 仅记录在 run 元数据供人工排查，尚未接入参考图生成管线（如实标注，不假装生效）。",
      example: "https://cdn.example.com/product.jpg",
    },
  ],
  outputSpec: {
    kind: "image",
    aspectRatio: "9:16",
    resolution: "1k",
    shotCount: { min: 4, max: 6 },
  },
  notes: [
    "输出是分镜静帧图组（storyboard stills），不是成片——平台尚未接入 TTS/剪辑/数字人，不虚标成片能力。",
    "product_image_url 目前只入 run 元数据；参考图（image-to-image）接入是后续工作。",
  ],
  buildShotPlan: (input) => {
    const sellingPoints = (input.selling_points as string[]) ?? [];
    const audience = (input.audience as string) || "经常短途出差的通勤人群";

    const shots: SkuShotTemplate[] = [
      {
        id: "hook",
        label: "开箱钩子",
        kind: "image",
        promptTemplate: trimVariables(
          `特写镜头：手正在拆开 {{product}} 的快递包装，包装撕开的瞬间定格，营造开箱悬念感，目标人群是 ${audience}，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
    ];

    sellingPoints.forEach((_point, i) => {
      shots.push({
        id: `feature-${i + 1}`,
        label: `卖点特写 ${i + 1}`,
        kind: "image",
        promptTemplate: trimVariables(
          `微距特写镜头：{{product}} 的 {{selling_point_${i + 1}}} 细节呈现，材质与工艺清晰可见，突出这一核心卖点，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      });
    });

    shots.push(
      {
        id: "scene-demo",
        label: "场景演示",
        kind: "image",
        promptTemplate: trimVariables(
          `生活场景镜头：${audience}在日常出行场景中自然使用 {{product}}，动作真实自然，环境光线明亮，画面传递方便省心的使用体验，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
      {
        id: "cta",
        label: "行动号召收尾",
        kind: "image",
        promptTemplate: trimVariables(
          `收尾镜头：{{product}} 居中陈列于干净纯色背景上，留出上方三分之一空白区域供叠加促销文案与行动号召按钮，构图端庄稳重，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
    );
    return shots;
  },
};

// ─────────────────────────────────────────── SKU 2：痛点广告（五幕结构）

const PAIN_POINT_SKU: MarketingSku = {
  id: "sku-pain-point-ad",
  name: "痛点广告五幕分镜",
  tagline: "痛点 + 解决方案 → 问题钩子/放大/转折/证明/CTA 五张结构化分镜图",
  channel: "short_video",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "pain_point",
      label: "痛点描述",
      type: "string",
      required: true,
      description: "目标用户当前的具体困扰，越具体越有画面感。",
      example: "行李箱轮子在地铁站石板路上拖行时噪音大还卡顿",
    },
    {
      key: "solution",
      label: "解决方案",
      type: "string",
      required: true,
      description: "你的产品/服务如何一句话解决该痛点。",
      example: "静音万向轮行李箱",
    },
    {
      key: "audience",
      label: "受众",
      type: "string",
      required: true,
      description: "投放人群画像。",
      example: "每周通勤往返两城的年轻上班族",
    },
  ],
  outputSpec: {
    kind: "image",
    aspectRatio: "9:16",
    resolution: "1k",
    shotCount: { min: 5, max: 5 },
  },
  notes: [
    "五幕结构（问题钩子→放大→转折→证明→CTA）是短视频投放的经典节奏；输出为每幕一张分镜静帧，不是成片。",
  ],
  buildShotPlan: () => [
    {
      id: "problem-hook",
      label: "问题钩子",
      kind: "image",
      promptTemplate: trimVariables(
        `情景镜头：{{audience}} 正被 {{pain_point}} 困扰的瞬间，表情烦躁无奈，画面色调偏冷偏灰，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "amplify",
      label: "痛点放大",
      kind: "image",
      promptTemplate: trimVariables(
        `冲突放大镜头：{{pain_point}} 带来的连锁麻烦占据整个画面，{{audience}} 疲惫不堪，构图压抑拥挤，色调阴沉，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "turn",
      label: "转折引入",
      kind: "image",
      promptTemplate: trimVariables(
        `转折镜头：{{solution}} 出现在画面中，一束暖光照亮产品，与之前灰暗环境形成强烈明暗对比，情绪由低落转向希望，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "proof",
      label: "效果证明",
      kind: "image",
      promptTemplate: trimVariables(
        `效果镜头：{{audience}} 使用 {{solution}} 后轻松自如的状态，画面明亮通透，表情轻松愉悦，传递问题已解决的事实感，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "cta",
      label: "行动号召",
      kind: "image",
      promptTemplate: trimVariables(
        `收尾镜头：{{solution}} 居中陈列于干净纯色背景，画面上方三分之一留白供叠加行动号召文案，构图简洁有力，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
  ],
};

// ─────────────────────────────────────────── SKU 3：多角度变体（轮换注入）

/** 内建轮换池：角度/光线/场景各 8 档，按变体序号 i % 池长 对位取值。 */
export const VARIANT_ANGLE_POOL: readonly string[] = [
  "正面平视构图",
  "45 度侧俯视构图",
  "低角度仰视构图",
  "微距细节特写",
  "顶部俯拍平铺构图",
  "侧逆光轮廓构图",
  "自然手持随拍构图",
  "三分法侧面构图",
];
const VARIANT_LIGHTING_POOL: readonly string[] = [
  "柔和自然窗光",
  "明亮商业摄影棚灯光",
  "黄昏暖金色侧光",
  "清晨柔和漫射光",
  "高对比戏剧性侧逆光",
  "冷色调清爽背光",
  "暖白柔光箱正面补光",
  "霓虹环境反射光",
];
const VARIANT_SCENE_POOL: readonly string[] = [
  "纯净浅色无缝背景",
  "原木桌面生活场景",
  "大理石台面配绿植",
  "城市街头外景",
  "简约工作室布景",
  "居家沙发一角",
  "户外自然草地",
  "极简几何色块背景",
];

/** 多角度 SKU 的单条变体模板：轮换值由构建器按序号烘焙进模板（确定性）。 */
function variantTemplate(index: number, customAngles?: string[]): SkuShotTemplate {
  const angles = customAngles && customAngles.length > 0 ? customAngles : VARIANT_ANGLE_POOL;
  const angle = angles[index % angles.length];
  const lighting = VARIANT_LIGHTING_POOL[index % VARIANT_LIGHTING_POOL.length];
  const scene = VARIANT_SCENE_POOL[index % VARIANT_SCENE_POOL.length];
  return {
    id: `variant-${index + 1}`,
    label: `变体 ${index + 1}`,
    kind: "image",
    promptTemplate: trimVariables(
      `{{base_subject}}，${angle}，${lighting}，${scene}，${PRODUCT_PHOTO_SUFFIX}`,
    ),
  };
}

const MULTI_ANGLE_SKU: MarketingSku = {
  id: "sku-multi-angle",
  name: "多角度商品变体",
  tagline: "一个主体描述 → N 张同构变体图（角度/光线/场景按内建池轮换注入）",
  channel: "ecommerce",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "base_subject",
      label: "基础主体描述",
      type: "string",
      required: true,
      description: "商品或主体的核心描述，变体在此基础上做角度/光线/场景轮换。",
      example: "磨砂黑便携保温杯",
    },
    {
      key: "variant_count",
      label: "变体条数",
      type: "integer",
      required: false,
      min: 1,
      max: 8,
      description: "生成几条变体（1-8）；缺省 3。轮换池 8 档循环取值。",
      example: 3,
    },
    {
      key: "angles",
      label: "自定义角度池",
      type: "string_list",
      required: false,
      minItems: 1,
      maxItems: 8,
      description: "可选。自带角度描述轮换池（覆盖内建角度池；光线/场景仍按内建池轮换）。",
      example: ["仰视英雄视角", "平贴桌面俯拍"],
    },
  ],
  outputSpec: {
    kind: "image",
    aspectRatio: "1:1",
    resolution: "1k",
    shotCount: { min: 1, max: 8 },
  },
  notes: [
    "同一 base_subject + 同一 variant_count 永远展开出相同的变体序列（角度/光线/场景按序号取模轮换），适合批量素材测试与 A/B 投放。",
  ],
  buildShotPlan: (input) => {
    const variantCount = typeof input.variant_count === "number" ? input.variant_count : 3;
    const customAngles = Array.isArray(input.angles) ? (input.angles as string[]) : undefined;
    return Array.from({ length: variantCount }, (_unused, index) => variantTemplate(index, customAngles));
  },
};

// ─────────────────────────────────────────── 目录

export const SKU_CATALOG: readonly MarketingSku[] = [ECOMMERCE_SKU, PAIN_POINT_SKU, MULTI_ANGLE_SKU];

export function getSkuById(id: string): MarketingSku | null {
  return SKU_CATALOG.find((sku) => sku.id === id) ?? null;
}

export function listSkuIds(): string[] {
  return SKU_CATALOG.map((sku) => sku.id);
}

/**
 * 对外目录视图：输入 schema 可编程消费；能力边界（notes）原样带出。
 * buildShotPlan 是内部实现细节，不外发。
 */
export function toPublicSkuView(sku: MarketingSku): Record<string, unknown> {
  return {
    object: "sku",
    id: sku.id,
    name: sku.name,
    tagline: sku.tagline,
    channel: sku.channel,
    version: sku.version,
    pricing: {
      mode: sku.pricingMode,
      unit:
        sku.pricingMode === "per_shot"
          ? "每镜头按模型单价计费（见 GET /v1/models 的 x_coins_per_image）"
          : "整包一口价（商业化定价待公布）",
    },
    default_model: sku.defaultModelId,
    expansion: sku.expansion,
    input_schema: sku.inputSchema.map(fieldSchemaView),
    output: {
      kind: sku.outputSpec.kind,
      aspect_ratio: sku.outputSpec.aspectRatio,
      resolution: sku.outputSpec.resolution,
      shot_count: sku.outputSpec.shotCount,
      ...(sku.outputSpec.durationSeconds !== undefined
        ? { duration_seconds: sku.outputSpec.durationSeconds }
        : {}),
    },
    notes: sku.notes,
    run_endpoint: `/v1/skus/${sku.id}/runs`,
  };
}
