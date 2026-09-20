import type { WorkflowTemplate } from "./types";

export const ecomLaunchTemplate: WorkflowTemplate = 
  // ── 新品上市包（8 环流水线；2026-09-20 注册，对齐前端 agent-ecommerce-launch-pack）──
  // 前端承诺 8 环：锁产品→铺场景包→出模特图→出主视觉→排详情页→批量出画幅→放大精修→审终交付。
  // 落地形态（诚实对齐交付物）：
  //   锁产品/铺场景包/出模特图/出主视觉/排详情页/批量出画幅/放大精修 = image（各配 _gen config 编排）、
  //   审终交付 = text（12 项终审报告 + 渠道归档索引）。
  //   全流程纯 image/text 两种节点，无 audio/film 环节——若未来延伸配音/成片，
  //   后端会如实回报上游暂不可用，不造假成功、不从模板消失。
  {
    id: "ecom_launch",
    name: "新品上市包",
    description:
      "商品原图 → 8 环上市素材流水线：锁产品(image) → 铺场景包(image) → 出模特图(image) → 出主视觉(image) → 排详情页(image) → 批量出画幅(image) → 放大精修(image) → 审终交付(text)。产品 DNA 锁定为全链根基，批量阶段换画幅重排而非裁切；纯 image/text 节点，无 audio/film 环节。",
    multiShot: true,
    nodes: [
      // 环 1：锁产品（白底主图 + RMBG 抠图 + 产品 DNA 锁定）
      { role: "product_gen", kind: "config", title: "白底产品锁生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "product_card", kind: "image", title: "白底产品锁（DNA 基准图）" },
      // 环 2：铺场景包（棚拍极简/生活方式/材质微距）
      { role: "scene_gen", kind: "config", title: "场景包生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "scene_pack", kind: "image", title: "情绪场景组图" },
      // 环 3：出模特图（全身场景 + 特写佩戴/使用）
      { role: "model_gen", kind: "config", title: "模特图生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "model_shot", kind: "image", title: "模特演绎图" },
      // 环 4：出主视觉（KV 英雄构图 + CTA 负空间版）
      { role: "kv_gen", kind: "config", title: "KV 主视觉生成配置", defaults: { model: "pixai-tsubaki2", size: "1536x1024", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "kv_hero", kind: "image", title: "KV 主视觉 + CTA 版式" },
      // 环 5：排详情页（5-6 屏长图分镜）
      { role: "detail_gen", kind: "config", title: "详情页分屏生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 6, kind: "image", unit_price_coins: 0.001 } },
      { role: "detail_page", kind: "image", title: "详情页长图分镜" },
      // 环 6：批量出画幅（1:1 / 3:1 / 9:16 / 16:9 重排矩阵；multiShot 可复制多 SKU）
      { role: "aspect_gen", kind: "config", title: "多画幅重排生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "aspect_matrix", kind: "image", title: "全画幅矩阵（重排非裁切）" },
      // 环 7：放大精修（≥2048 短边，主图类可 4096）
      { role: "upscale_gen", kind: "config", title: "放大精修配置", defaults: { model: "pixai-tsubaki2", size: "2048x2048", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "final_assets", kind: "image", title: "交付级精修图组（sRGB 统一）" },
      // 环 8：审终交付（纯文本环节：12 项终审 + 渠道归档索引）
      { role: "delivery", kind: "text", title: "上市素材包终审报告与使用索引" },
    ],
    connections: [
      { fromRole: "product_gen", toRole: "product_card" },
      { fromRole: "product_card", toRole: "scene_gen" }, // 产品 DNA → 场景包
      { fromRole: "scene_gen", toRole: "scene_pack" },
      { fromRole: "scene_pack", toRole: "model_gen" }, // 场景 → 模特图
      { fromRole: "model_gen", toRole: "model_shot" },
      { fromRole: "model_shot", toRole: "kv_gen" }, // 锁定模特 → 主视觉
      { fromRole: "kv_gen", toRole: "kv_hero" },
      { fromRole: "kv_hero", toRole: "detail_gen" }, // KV → 详情页分屏
      { fromRole: "detail_gen", toRole: "detail_page" },
      { fromRole: "detail_page", toRole: "aspect_gen" }, // 详情分镜 → 多画幅重排
      { fromRole: "aspect_gen", toRole: "aspect_matrix" },
      { fromRole: "aspect_matrix", toRole: "upscale_gen" }, // 画幅矩阵 → 放大精修
      { fromRole: "upscale_gen", toRole: "final_assets" },
      { fromRole: "final_assets", toRole: "delivery" }, // 交付图组 → 终审归档
    ],
  }
;