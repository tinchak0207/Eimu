import type { WorkflowTemplate } from "./types";

export const ecomLaunchTemplate: WorkflowTemplate = 
  // ── 新品上市包（8 环流水线；2026-09-20 注册，对齐前端 agent-ecommerce-launch-pack）──
  // 前端承诺 8 环：锁产品→铺场景包→出模特图→出主视觉→排详情页→批量出画幅→放大精修→审终交付。
  // 落地形态（诚实对齐交付物）：
  //   锁产品/铺场景包/出模特图/出主视觉/排详情页/批量出画幅/放大精修 = image（各配 _gen config 编排）、
  //   审终交付 = text（12 项终审报告 + 渠道归档索引）。
  //   全流程纯 image/text 两种节点，无 audio/film 环节——若未来延伸配音/成片，
  //   后端会如实回报上游暂不可用，不造假成功、不从模板消失。
  // tools/notes 真源 = 前端 payload ecommerce-launch-pack.ts 的
  //   steps[].requiredTools / promptNotes，逐字回填到每环主产出节点。
  {
    id: "ecom_launch",
    name: "新品上市包",
    description:
      "商品原图 → 8 环上市素材流水线：锁产品(image) → 铺场景包(image) → 出模特图(image) → 出主视觉(image) → 排详情页(image) → 批量出画幅(image) → 放大精修(image) → 审终交付(text)。产品 DNA 锁定为全链根基，批量阶段换画幅重排而非裁切；纯 image/text 节点，无 audio/film 环节。",
    multiShot: true,
    nodes: [
      // 环 1：锁产品（白底主图 + RMBG 抠图 + 产品 DNA 锁定）
      { role: "product_gen", kind: "config", title: "白底产品锁生成配置", deliverable: "锁产品环节的生图价目与参数配置（model/size/count；价格由当前目录取得），白底产品锁成图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "product_card",
        kind: "image",
        title: "白底产品锁（DNA 基准图）",
        // 实体宣告（2026-09-24）：白底产品锁 + 产品 DNA 是**一张道具卡**的交付物，
        // 画布侧据此自动落卡（后续可 @ 引用该产品）。
        defaults: { emitsEntity: { kind: "prop", nameFrom: "input" } },
        deliverable: "纯净白底产品图 + RMBG 透明底抠图 + 产品 DNA JSON（形状/颜色/材质/包装标签/LOGO位置/不可变特征）",
        gate: "VLM 门禁：对照原图校验形状、标签文字、LOGO 零变形零乱码，任一不符重出，未过禁入下一步",
        notes: [
          "白底棚拍基准图：正面45度产品照，柔光箱双侧补光，阴影柔和落地，突出材质与标签纹理",
          "RMBG 抠图后检查边缘无残留光晕，半透明材质（玻璃/纱）保留 Alpha 通透",
          "DNA JSON 用 Product accuracy 字段显式声明 shape/color/packaging/label/material 等不可变特征",
          "负向约束固定尾缀：no fake text, no label distortion, no extra products, no warp",
          "交付本节点时把产品名写进节点 metadata 的 input 字段——画布侧据它自动落成道具卡并当卡名，缺了卡名只能退回节点标题「白底产品锁（DNA 基准图）」",
        ],
        tools: [
          { id: "product_lock", input: "商品图", output: "商品 DNA 锁定（形变/色彩基准）" },
          { id: "background_remove", input: "商品图", output: "抠图（透明底商品资产）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 2：铺场景包（棚拍极简/生活方式/材质微距）
      { role: "scene_gen", kind: "config", title: "场景包生成配置", deliverable: "场景包环节的生图价目与参数配置（model/size/count；价格由当前目录取得），情绪场景组图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 3, kind: "image"} },
      {
        role: "scene_pack",
        kind: "image",
        title: "情绪场景组图",
        deliverable: "3 张情绪场景图（棚拍极简 / 生活方式实景 / 材质微距特写），各含自然光影与倒影",
        gate: "VLM 门禁：光影方向与场景自洽、倒影自然、产品与 PRODUCT LOCK 一致性比对通过",
        notes: [
          "ControlNet Canny 锁产品轮廓结构，防形变；IP-Adapter 注入抠图外观，保材质颜色",
          "每张场景图单独定义光照字段（方向/色温/强度），倒影与接触阴影必须落地，产品不悬浮",
          "变体一次只改一个变量：背景/机位/色板，不混改，保证可归因",
          "环境叙事贴用途：电商主图走极简棚拍，详情页走生活方式，种草内容走微距特写",
          "光照字段三段式定义写进每张图：方向（侧后 45°）/色温（棚拍 5500K、生活方式 3800K 暖调）/强度（柔光 0.6、逆光 1.2），倒影与接触阴影方向必须与光源严格反向，scene_pack_batch 同 seed 族一次出全 3 张，跨场景色板方差 >5% 判风格漂移整包重跑",
        ],
        tools: [
          { id: "scene_pack_batch", input: "商品 DNA + 场景清单", output: "场景包图组（多场景一致）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 3：出模特图（全身场景 + 特写佩戴/使用）
      { role: "model_gen", kind: "config", title: "模特图生成配置", deliverable: "模特图环节的生图价目与参数配置（model/size/count；价格由当前目录取得），模特演绎图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 2, kind: "image"} },
      {
        role: "model_shot",
        kind: "image",
        title: "模特演绎图",
        deliverable: "2 张模特演绎图（全身场景 + 特写佩戴/使用），模特姿势可控、产品为视觉焦点",
        gate: "VLM 门禁：手部结构无畸变（指数/关节）、产品在模特身上零形变、脸与人群设定一致",
        notes: [
          "OpenPose 锁模特骨架姿势，Inpainting 只重绘穿戴/持握区域，不整图重生成",
          "IP-Adapter 产品权重调高，确保穿戴物即锁定的产品而非近似替代品",
          "模特人种/年龄/气质先问用户目标人群，一次定死全系列复用，保持人群一致性",
          "手部与产品接触点是翻车高发区，prompt 显式写 grip/接触细节",
          "product_conditioned_generation 出图后先做手部专项检查：五指关节计数 + 持握接触面积比对，出现畸变仅对 Inpainting 手部区域局部重绘，不整图重生成；OpenPose 骨架文件（手腕/手肘关键点对准产品接触位）存档复用，同系列共用一套骨架防姿势漂移",
        ],
        tools: [
          { id: "product_conditioned_generation", input: "商品 DNA + 模特构图", output: "条件化模特图（产品零形变）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 4：出主视觉（KV 英雄构图 + CTA 负空间版）
      { role: "kv_gen", kind: "config", title: "KV 主视觉生成配置", deliverable: "KV 环节的生图价目与参数配置（model/size/count；价格由当前目录取得），主视觉与 CTA 版式按此执行", defaults: { model: "pixai-tsubaki2", size: "1536x1024", count: 2, kind: "image"} },
      {
        role: "kv_hero",
        kind: "image",
        title: "KV 主视觉 + CTA 版式",
        deliverable: "KV 主视觉 1 张（低机位逆光英雄构图）+ 负空间 CTA 版式 1 张（预留文案与按钮区）",
        gate: "VLM 门禁：CTA 负空间占比≥30%、视觉层级清晰、产品锐度未因逆光损失",
        notes: [
          "低机位仰拍 + 逆光轮廓光制造英雄感，前景产品、背景简洁分层",
          "负空间 CTA 版：画面留出 1/3 干净区域（左或右）给标题/卖点/按钮，禁止产品居中占满",
          "构图遵守最终投放宽高比先定再生成，不事后裁切毁构图",
          "视觉钩子前置：3 秒原则，第一眼看到的是产品+一个记忆点，不是环境氛围",
          "3 秒原则执行判据：把 KV 缩到 200px 缩略图做盲测，3 秒内能说出「产品是什么 + 一个卖点」才通过，说不清就回炉重排视觉层级；canonical_key_art_lock 定稿后把色板/光照/构图参数写进锁定卡，后续画幅重排与详情首屏强制对齐，禁止另行发明风格",
        ],
        tools: [
          { id: "canonical_key_art_lock", input: "产品 DNA + 锁定模特图", output: "KV 主视觉锁定卡（英雄构图 + CTA 负空间版）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 5：排详情页（5-6 屏长图分镜）
      { role: "detail_gen", kind: "config", title: "详情页分屏生成配置", deliverable: "详情页环节的生图价目与参数配置（model/size/count；价格由当前目录取得），长图分屏按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 6, kind: "image"} },
      {
        role: "detail_page",
        kind: "image",
        title: "详情页长图分镜",
        deliverable: "详情页长图分镜 5-6 屏（痛点开场 → 产品亮相 → 细节特写 → 场景演绎 → 参数对比 → 信任背书收尾）",
        gate: "VLM 门禁：逐屏检查文字可读、无错别字乱码、图文层级清晰、全链素材与 PRODUCT LOCK 一致",
        notes: [
          "多图合成 + 文本叠加：每屏一个信息点，图文比例 7:3，字号在手机端不小于 24pt 等效",
          "细节特写屏调用微距场景图，参数对比屏用白底基准图，素材复用即一致性",
          "长图统一宽 750px 移动端标准，每屏高 800-1200px，图区上文区下；首屏 3 秒内完成「痛点→产品解法」信息闭环",
          "detail_page_manifest 先列模块清单再出图：每屏注明素材来源（哪张场景图/白底图）与文案要点，清单给用户过目后才生成，避免整页返工",
          "参数对比屏只列可验证参数（尺寸/材质/认证），禁止与竞品做无依据功效对比，防虚假 claim 进详情页",
        ],
        tools: [
          { id: "detail_page_manifest", input: "产品锁 + 卖点清单", output: "详情页排版清单（模块/顺序）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 6：批量出画幅（1:1 / 3:1 / 9:16 / 16:9 重排矩阵；multiShot 可复制多 SKU）
      { role: "aspect_gen", kind: "config", title: "多画幅重排生成配置", deliverable: "多画幅环节的生图价目与参数配置（model/size/count；价格由当前目录取得），全画幅矩阵按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "aspect_matrix",
        kind: "image",
        title: "全画幅矩阵（重排非裁切）",
        deliverable: "全画幅矩阵：主图 1:1（≥2048）、详情横幅 3:1、社媒 9:16 与 1:1、Banner 16:9，全部重排而非裁切",
        gate: "抽检门禁：每个 SKU 抽 1 张对照 DNA JSON 校验产品身份，风格相似度低于阈值整批重跑",
        notes: [
          "styleLock：固定 seed + 固定 prompt 骨架，仅替换 SKU 名称与 PRODUCT LOCK 段，多 SKU 风格像素级一致",
          "每个画幅按自身宽高比重排构图（产品位置/留白/视线引导重新设计），禁止中心裁切",
          "画幅像素矩阵写死：主图 1:1 2048×2048、详情横幅 3:1 3072×1024、社媒 9:16 1080×1920、Banner 16:9 2560×1440，aspect_reflow 逐画幅重排",
          "9:16 竖版构图重心上移：产品置上 1/3、文案区留下方 40%，避让信息流 UI 安全区（顶部 12%/底部 20%）",
          "命名规范本步内建落盘：渠道_用途_SKU_画幅_序号（如 tmall_main_SKUA_1x1_01），批量产出即按此命名，交付步零改名",
        ],
        tools: [
          { id: "aspect_reflow", input: "主视觉 + 详情页分镜", output: "多画幅矩阵（重排非裁切）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 7：放大精修（≥2048 短边，主图类可 4096）
      { role: "upscale_gen", kind: "config", title: "放大精修配置", deliverable: "放大精修环节的生图价目与参数配置（model/size/count；价格由当前目录取得），交付级精修图组按此执行", defaults: { model: "pixai-tsubaki2", size: "2048x2048", count: 1, kind: "image"} },
      {
        role: "final_assets",
        kind: "image",
        title: "交付级精修图组（sRGB 统一）",
        deliverable: "全交付图 ≥2048 短边（主图类可 4096 供印刷）+ 色彩管理统一 sRGB",
        gate: "分辨率门禁：任一交付图短边 <2048 即打回；标签文字放大后仍可读",
        notes: [
          "ESRGAN 上采样目标 ≥2048×2048，主图类可到 4096 供印刷，纹理材质区锐化不过冲",
          "放大后再查一次小字与标签：上采样偶尔把标签文字糊化，发现即回退重生成",
          "统一色彩管理：批量输出同一色彩空间（sRGB），避免各画幅色差",
          "image_upscale 分档执行：主图类 2x 上探 4096 供印刷，社媒/横幅 2x 保短边 ≥2048；upscale_audit 上采样前后对比噪点/边缘锐度/色偏三项，任一劣化即换倍数重跑，不许带病交付",
        ],
        tools: [
          { id: "upscale_audit", input: "交付图组", output: "放大精修 + 审计报告" },
          { id: "image_upscale", input: "图片 URL + 放大倍数", output: "放大后图片 URL" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 8：审终交付（纯文本环节：12 项终审 + 渠道归档索引）
      {
        role: "delivery",
        kind: "text",
        title: "上市素材包终审报告与使用索引",
        deliverable: "上市素材包按渠道归档：主图组 / 场景组 / 模特组 / KV+CTA / 详情长图 / 社媒矩阵，附命名规范与使用索引",
        gate: "终审门禁：12 项清单全绿才标记交付完成；任一红项回溯对应步骤修复后整包重审",
        notes: [
          "发布前 12 项终审：产品形状标签准确、无虚假 claim、无未授权第三方 logo、文字拼写、平台安全区、商用权",
          "命名规范内建：渠道_用途_SKU_画幅_序号，运营拿走即用不再改名",
          "使用索引注明每张图的投放位与替换建议，交付可直接上线的完整包",
          "命名规范全包强制校验：四段下划线分隔、序号三位数字补零（001），任一文件名不合规则整包打回重命名，不许运营手工补救",
          "使用索引按 CSV 交付：每行 = 文件名 + 投放位（主图第几位/详情第几屏/社媒哪个画幅）+ 替换建议，运营照表上传零判断",
        ],
        tools: [
          { id: "upscale_audit", input: "全素材包", output: "12 项终审报告 + 渠道归档索引" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
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
