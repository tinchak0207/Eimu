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
      { role: "product_gen", kind: "config", title: "白底产品锁生成配置", deliverable: "锁产品环节的生图价目与参数配置（model/size/count/单价），白底产品锁成图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "product_card", kind: "image", title: "白底产品锁（DNA 基准图）", deliverable: "纯净白底产品图 + RMBG 透明底抠图 + 产品 DNA JSON（形状/颜色/材质/包装标签/LOGO位置/不可变特征）", gate: "VLM 门禁：对照原图校验形状、标签文字、LOGO 零变形零乱码，任一不符重出，未过禁入下一步" },
      // 环 2：铺场景包（棚拍极简/生活方式/材质微距）
      { role: "scene_gen", kind: "config", title: "场景包生成配置", deliverable: "场景包环节的生图价目与参数配置（model/size/count/单价），情绪场景组图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "scene_pack", kind: "image", title: "情绪场景组图", deliverable: "3 张情绪场景图（棚拍极简 / 生活方式实景 / 材质微距特写），各含自然光影与倒影", gate: "VLM 门禁：光影方向与场景自洽、倒影自然、产品与 PRODUCT LOCK 一致性比对通过" },
      // 环 3：出模特图（全身场景 + 特写佩戴/使用）
      { role: "model_gen", kind: "config", title: "模特图生成配置", deliverable: "模特图环节的生图价目与参数配置（model/size/count/单价），模特演绎图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "model_shot", kind: "image", title: "模特演绎图", deliverable: "2 张模特演绎图（全身场景 + 特写佩戴/使用），模特姿势可控、产品为视觉焦点", gate: "VLM 门禁：手部结构无畸变（指数/关节）、产品在模特身上零形变、脸与人群设定一致" },
      // 环 4：出主视觉（KV 英雄构图 + CTA 负空间版）
      { role: "kv_gen", kind: "config", title: "KV 主视觉生成配置", deliverable: "KV 环节的生图价目与参数配置（model/size/count/单价），主视觉与 CTA 版式按此执行", defaults: { model: "pixai-tsubaki2", size: "1536x1024", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "kv_hero", kind: "image", title: "KV 主视觉 + CTA 版式", deliverable: "KV 主视觉 1 张（低机位逆光英雄构图）+ 负空间 CTA 版式 1 张（预留文案与按钮区）", gate: "VLM 门禁：CTA 负空间占比≥30%、视觉层级清晰、产品锐度未因逆光损失" },
      // 环 5：排详情页（5-6 屏长图分镜）
      { role: "detail_gen", kind: "config", title: "详情页分屏生成配置", deliverable: "详情页环节的生图价目与参数配置（model/size/count/单价），长图分屏按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 6, kind: "image", unit_price_coins: 0.001 } },
      { role: "detail_page", kind: "image", title: "详情页长图分镜", deliverable: "详情页长图分镜 5-6 屏（痛点开场 → 产品亮相 → 细节特写 → 场景演绎 → 参数对比 → 信任背书收尾）", gate: "VLM 门禁：逐屏检查文字可读、无错别字乱码、图文层级清晰、全链素材与 PRODUCT LOCK 一致" },
      // 环 6：批量出画幅（1:1 / 3:1 / 9:16 / 16:9 重排矩阵；multiShot 可复制多 SKU）
      { role: "aspect_gen", kind: "config", title: "多画幅重排生成配置", deliverable: "多画幅环节的生图价目与参数配置（model/size/count/单价），全画幅矩阵按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "aspect_matrix", kind: "image", title: "全画幅矩阵（重排非裁切）", deliverable: "全画幅矩阵：主图 1:1（≥2048）、详情横幅 3:1、社媒 9:16 与 1:1、Banner 16:9，全部重排而非裁切", gate: "抽检门禁：每个 SKU 抽 1 张对照 DNA JSON 校验产品身份，风格相似度低于阈值整批重跑" },
      // 环 7：放大精修（≥2048 短边，主图类可 4096）
      { role: "upscale_gen", kind: "config", title: "放大精修配置", deliverable: "放大精修环节的生图价目与参数配置（model/size/count/单价），交付级精修图组按此执行", defaults: { model: "pixai-tsubaki2", size: "2048x2048", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "final_assets", kind: "image", title: "交付级精修图组（sRGB 统一）", deliverable: "全交付图 ≥2048 短边（主图类可 4096 供印刷）+ 色彩管理统一 sRGB", gate: "分辨率门禁：任一交付图短边 <2048 即打回；标签文字放大后仍可读" },
      // 环 8：审终交付（纯文本环节：12 项终审 + 渠道归档索引）
      { role: "delivery", kind: "text", title: "上市素材包终审报告与使用索引", deliverable: "上市素材包按渠道归档：主图组 / 场景组 / 模特组 / KV+CTA / 详情长图 / 社媒矩阵，附命名规范与使用索引", gate: "终审门禁：12 项清单全绿才标记交付完成；任一红项回溯对应步骤修复后整包重审" },
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