// 首批三個營銷 SKU——TS 常量目錄（冷啟動不建 DB 表；量大再遷移，見 docs）。
//
// 定價敘事：SKU 賣的是「人工編排節省 + 投放結構適配」，不是模型單價。目錄裡的
// pricing 欄位如實標註 v1 的計費方式（per_shot：逐鏡頭按模型價，走既有
// billing-ledger），per_sku 一口價是商業化定價的後續工作，不提前虛標。

import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import { fieldSchemaView } from "./expand";
import type { MarketingSku, SkuShotTemplate } from "./types";

// ─────────────────────────────────────────── 共用素材

/** 靜態產品圖的通用質量後綴（所有 prompt 共用，保證輸出基線一致）。 */
const PRODUCT_PHOTO_SUFFIX = "商业产品摄影级画质，细节锐利，色彩真实，主体清晰聚焦，画面干净无杂物";
/** 豎屏信息流素材的通用後綴。 */
const VERTICAL_FEED_SUFFIX = "竖屏 9:16 构图，视觉层次分明，适合信息流投放";

function trimVariables(template: string): string {
  return template.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────── SKU 1：電商帶貨 15s（分鏡圖組）

const ECOMMERCE_SKU: MarketingSku = {
  id: "sku-ecommerce-15s",
  name: "電商帶貨 15 秒分鏡",
  tagline: "一句話商品信息 → 4-6 張帶貨短視頻分鏡圖（開箱鉤子/賣點特寫/場景演示/CTA）",
  channel: "ecommerce",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "product",
      label: "商品名稱",
      type: "string",
      required: true,
      description: "商品名與核心品類，如「輕量摺疊登機箱 20 吋」。",
      example: "轻量折叠登机箱 20 寸",
    },
    {
      key: "selling_points",
      label: "賣點列表",
      type: "string_list",
      required: true,
      minItems: 1,
      maxItems: 3,
      description: "1-3 條賣點，每條生成一張特寫分鏡（鏡頭總數 4-6 隨之自適應）。",
      example: ["整机仅 2.6kg", "一键前开盖秒取电脑", "静音万向轮"],
    },
    {
      key: "audience",
      label: "目標受眾",
      type: "string",
      required: false,
      description: "投放人群描述；缺省按「通勤出差人群」處理。",
      example: "经常短途出差的通勤上班族",
    },
    {
      key: "product_image_url",
      label: "商品圖 URL",
      type: "url",
      required: false,
      description: "可選。v1 僅記錄在 run 元數據供人工排查，尚未接入參考圖生成管線（如實標註，不假裝生效）。",
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
    "輸出是分鏡靜幀圖組（storyboard stills），不是成片——平台尚未接入 TTS/剪輯/數字人，不虛標成片能力。",
    "product_image_url 目前只入 run 元數據；參考圖（image-to-image）接入是後續工作。",
  ],
  buildShotPlan: (input) => {
    const sellingPoints = (input.selling_points as string[]) ?? [];
    const audience = (input.audience as string) || "经常短途出差的通勤人群";

    const shots: SkuShotTemplate[] = [
      {
        id: "hook",
        label: "開箱鉤子",
        kind: "image",
        promptTemplate: trimVariables(
          `特写镜头：手正在拆开 {{product}} 的快递包装，包装撕开的瞬间定格，营造开箱悬念感，目标人群是 ${audience}，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
    ];

    sellingPoints.forEach((_point, i) => {
      shots.push({
        id: `feature-${i + 1}`,
        label: `賣點特寫 ${i + 1}`,
        kind: "image",
        promptTemplate: trimVariables(
          `微距特写镜头：{{product}} 的 {{selling_point_${i + 1}}} 细节呈现，材质与工艺清晰可见，突出这一核心卖点，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      });
    });

    shots.push(
      {
        id: "scene-demo",
        label: "場景演示",
        kind: "image",
        promptTemplate: trimVariables(
          `生活场景镜头：${audience}在日常出行场景中自然使用 {{product}}，动作真实自然，环境光线明亮，画面传递方便省心的使用体验，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
      {
        id: "cta",
        label: "行動號召收尾",
        kind: "image",
        promptTemplate: trimVariables(
          `收尾镜头：{{product}} 居中陈列于干净纯色背景上，留出上方三分之一空白区域供叠加促销文案与行动号召按钮，构图端庄稳重，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
        ),
      },
    );
    return shots;
  },
};

// ─────────────────────────────────────────── SKU 2：痛點廣告（五幕結構）

const PAIN_POINT_SKU: MarketingSku = {
  id: "sku-pain-point-ad",
  name: "痛點廣告五幕分鏡",
  tagline: "痛點 + 解決方案 → 問題鉤子/放大/轉折/證明/CTA 五張結構化分鏡圖",
  channel: "short_video",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "pain_point",
      label: "痛點描述",
      type: "string",
      required: true,
      description: "目標用戶當前的具體困擾，越具體越有畫面感。",
      example: "行李箱轮子在地铁站石板路上拖行时噪音大还卡顿",
    },
    {
      key: "solution",
      label: "解決方案",
      type: "string",
      required: true,
      description: "你的產品/服務如何一句話解決該痛點。",
      example: "静音万向轮行李箱",
    },
    {
      key: "audience",
      label: "受眾",
      type: "string",
      required: true,
      description: "投放人群畫像。",
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
    "五幕結構（問題鉤子→放大→轉折→證明→CTA）是短視頻投放的經典節奏；輸出為每幕一張分鏡靜幀，不是成片。",
  ],
  buildShotPlan: () => [
    {
      id: "problem-hook",
      label: "問題鉤子",
      kind: "image",
      promptTemplate: trimVariables(
        `情景镜头：{{audience}} 正被 {{pain_point}} 困扰的瞬间，表情烦躁无奈，画面色调偏冷偏灰，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "amplify",
      label: "痛點放大",
      kind: "image",
      promptTemplate: trimVariables(
        `冲突放大镜头：{{pain_point}} 带来的连锁麻烦占据整个画面，{{audience}} 疲惫不堪，构图压抑拥挤，色调阴沉，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "turn",
      label: "轉折引入",
      kind: "image",
      promptTemplate: trimVariables(
        `转折镜头：{{solution}} 出现在画面中，一束暖光照亮产品，与之前灰暗环境形成强烈明暗对比，情绪由低落转向希望，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "proof",
      label: "效果證明",
      kind: "image",
      promptTemplate: trimVariables(
        `效果镜头：{{audience}} 使用 {{solution}} 后轻松自如的状态，画面明亮通透，表情轻松愉悦，传递问题已解决的事实感，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
    {
      id: "cta",
      label: "行動號召",
      kind: "image",
      promptTemplate: trimVariables(
        `收尾镜头：{{solution}} 居中陈列于干净纯色背景，画面上方三分之一留白供叠加行动号召文案，构图简洁有力，${VERTICAL_FEED_SUFFIX}，${PRODUCT_PHOTO_SUFFIX}`,
      ),
    },
  ],
};

// ─────────────────────────────────────────── SKU 3：多角度變體（輪換注入）

/** 內建輪換池：角度/光線/場景各 8 檔，按變體序號 i % 池長 對位取值。 */
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

/** 多角度 SKU 的單條變體模板：輪換值由構建器按序號烘焙進模板（確定性）。 */
function variantTemplate(index: number, customAngles?: string[]): SkuShotTemplate {
  const angles = customAngles && customAngles.length > 0 ? customAngles : VARIANT_ANGLE_POOL;
  const angle = angles[index % angles.length];
  const lighting = VARIANT_LIGHTING_POOL[index % VARIANT_LIGHTING_POOL.length];
  const scene = VARIANT_SCENE_POOL[index % VARIANT_SCENE_POOL.length];
  return {
    id: `variant-${index + 1}`,
    label: `變體 ${index + 1}`,
    kind: "image",
    promptTemplate: trimVariables(
      `{{base_subject}}，${angle}，${lighting}，${scene}，${PRODUCT_PHOTO_SUFFIX}`,
    ),
  };
}

const MULTI_ANGLE_SKU: MarketingSku = {
  id: "sku-multi-angle",
  name: "多角度商品變體",
  tagline: "一個主體描述 → N 張同構變體圖（角度/光線/場景按內建池輪換注入）",
  channel: "ecommerce",
  version: 1,
  pricingMode: "per_shot",
  defaultModelId: DEFAULT_IMAGE_MODEL_ID,
  expansion: "deterministic",
  inputSchema: [
    {
      key: "base_subject",
      label: "基礎主體描述",
      type: "string",
      required: true,
      description: "商品或主體的核心描述，變體在此基礎上做角度/光線/場景輪換。",
      example: "磨砂黑便携保温杯",
    },
    {
      key: "variant_count",
      label: "變體條數",
      type: "integer",
      required: false,
      min: 1,
      max: 8,
      description: "生成幾條變體（1-8）；缺省 3。輪換池 8 檔循環取值。",
      example: 3,
    },
    {
      key: "angles",
      label: "自定義角度池",
      type: "string_list",
      required: false,
      minItems: 1,
      maxItems: 8,
      description: "可選。自帶角度描述輪換池（覆蓋內建角度池；光線/場景仍按內建池輪換）。",
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
    "同一 base_subject + 同一 variant_count 永遠展開出相同的變體序列（角度/光線/場景按序號取模輪換），適合批量素材測試與 A/B 投放。",
  ],
  buildShotPlan: (input) => {
    const variantCount = typeof input.variant_count === "number" ? input.variant_count : 3;
    const customAngles = Array.isArray(input.angles) ? (input.angles as string[]) : undefined;
    return Array.from({ length: variantCount }, (_unused, index) => variantTemplate(index, customAngles));
  },
};

// ─────────────────────────────────────────── 目錄

export const SKU_CATALOG: readonly MarketingSku[] = [ECOMMERCE_SKU, PAIN_POINT_SKU, MULTI_ANGLE_SKU];

export function getSkuById(id: string): MarketingSku | null {
  return SKU_CATALOG.find((sku) => sku.id === id) ?? null;
}

export function listSkuIds(): string[] {
  return SKU_CATALOG.map((sku) => sku.id);
}

/**
 * 對外目錄視圖：輸入 schema 可編程消費；能力邊界（notes）原樣帶出。
 * buildShotPlan 是內部實現細節，不外發。
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
          ? "每鏡頭按模型單價計費（見 GET /v1/models 的 x_coins_per_image）"
          : "整包一口價（商業化定價待公佈）",
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
