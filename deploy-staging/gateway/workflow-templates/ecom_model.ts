import type { WorkflowTemplate } from "./types";

export const ecomModelTemplate: WorkflowTemplate = 
  // ── 模特种草线（7 环全 image 流水线；2026-09-20 注册，对齐前端 agent-ecommerce-model-grid）──
  // 前端承诺 7 环：抠服装→模特人设→虚拟试穿→精修质感→九宫格→详情页→分发尺寸。
  // 落地形态（诚实对齐引擎能力）：七环全部为 image 节点（生成/编辑/重排均为图片产出），
  // 每環配一支 config 生成配置（model/size/count/kind/unit_price_coins），
  // 与 novel_film 的 char_gen→char_card 生成链同构；本模板无 audio/film 環節。
  {
    id: "ecom_model",
    name: "模特种草线",
    description:
      "服装平铺 → 7 环流水线：抠取服装资产(image) → 选定模特人设(image) → 上身虚拟试穿(image) → 精修试穿质感(image) → 拍齐九宫格(image) → 排版详情页(image) → 适配分发尺寸(image)。全链纯 image 节点，无 audio/film 環節，各環按價目表 unit_price_coins 计费。",
    multiShot: true,
    nodes: [
      // 環 1：抠取服装资产（去背景单品 + 服装 DNA 卡）
      { role: "garment_gen", kind: "config", title: "服装提取生成配置", deliverable: "抠服装环节的生图价目与参数配置（model/size/count/单价），透明底服装单品按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "garment_asset", kind: "image", title: "透明底服装单品（去背景）", deliverable: "透明底服装平铺图（RMBG/BiRefNet 细带分割）+ 服装 DNA 卡（材质/版型/颜色/标签）+ 101% 回贴桩", gate: "抠图边缘与颜色还原人工过目，不过则重抠" },
      // 環 2：选定模特人设（FaceID 基线锁脸）
      { role: "model_gen", kind: "config", title: "模特人设生成配置", deliverable: "模特人设环节的生图价目与参数配置（model/size/count/单价），模特人设卡按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "model_card", kind: "image", title: "模特人设卡（FaceID 基线锁定）", deliverable: "模特人设矩阵（客群反推）+ IP-Adapter FaceID 面部基线锁定", gate: "模特人设人工批准后才进试穿" },
      // 環 3：上身虚拟试穿（正/侧/背试穿图组）
      { role: "tryon_gen", kind: "config", title: "虚拟试穿生成配置", deliverable: "虚拟试穿环节的生图价目与参数配置（model/size/count/单价），试穿图组按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "tryon", kind: "image", title: "试穿图组（正/侧/背）", deliverable: "选定模特的试穿图组（正/侧/背，CatVTON/IDM-VTON 主通道）", gate: "试穿形变检查：服装贴合与比例不过则重生" },
      // 環 4：精修试穿质感（手部修复 + 面料物理检查）
      { role: "retouch_gen", kind: "config", title: "精修质感生成配置", deliverable: "精修质感环节的生图价目与参数配置（model/size/count/单价），精修试穿图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "retouch", kind: "image", title: "精修试穿图（手部 + 面料物理）", deliverable: "精修试穿图（MeshGraphormer 手部修复 + ControlNet 分阶段强度 0.4→0.9）+ 面料物理检查", gate: "手部结构无畸变（指数/关节）、面料物理可信" },
      // 環 5：拍齐九宫格（3x3 一致形象网格）
      { role: "grid_gen", kind: "config", title: "九宫格生成配置", deliverable: "九宫格环节的生图价目与参数配置（model/size/count/单价），3x3 种草图按此执行", defaults: { model: "pixai-tsubaki2", size: "2048x2048", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "grid", kind: "image", title: "3x3 九宫格种草图（≥2048px）", deliverable: "3x3 九宫格（远/中/近混排 + 统一影调，≥2048px）", gate: "格间形象一致性人工审核，不过则单格重生" },
      // 環 6：排版详情页（钩子→卖点→细节→场景）
      { role: "detail_gen", kind: "config", title: "详情页生成配置", deliverable: "详情页环节的生图价目与参数配置（model/size/count/单价），长图分镜按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "detail_page", kind: "image", title: "详情页长图分镜", deliverable: "详情页长图分镜（钩子→卖点→细节→场景四段节奏，卖点必须有图内证据）", gate: "VLM 门禁：逐屏检查文字可读、卖点与图内证据对位" },
      // 環 7：适配分发尺寸（多平台画幅重排）
      { role: "reflow_gen", kind: "config", title: "分发尺寸适配配置", deliverable: "分发适配环节的生图价目与参数配置（model/size/count/单价），多平台分发包按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "distribution", kind: "image", title: "多平台分发包（小红书/抖音/淘宝）", deliverable: "分发包：小红书 3:4 / 抖音 9:16 / 淘宝主图 1:1 五张（重排不重生）", gate: "平台安全区/分辨率套检门禁" },
    ],
    connections: [
      { fromRole: "garment_gen", toRole: "garment_asset" },
      { fromRole: "garment_asset", toRole: "model_gen" },
      { fromRole: "model_gen", toRole: "model_card" },
      { fromRole: "model_card", toRole: "tryon_gen" }, // 模特卡 → 试穿（身份锁）
      { fromRole: "tryon_gen", toRole: "tryon" },
      { fromRole: "tryon", toRole: "retouch_gen" },
      { fromRole: "retouch_gen", toRole: "retouch" },
      { fromRole: "retouch", toRole: "grid_gen" },
      { fromRole: "grid_gen", toRole: "grid" },
      { fromRole: "grid", toRole: "detail_gen" },
      { fromRole: "detail_gen", toRole: "detail_page" },
      { fromRole: "detail_page", toRole: "reflow_gen" },
      { fromRole: "reflow_gen", toRole: "distribution" },
    ],
  }
;