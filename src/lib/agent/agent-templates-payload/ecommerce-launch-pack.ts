import type { AgentTemplatePayload } from "./types";

export const ecommerceLaunchPackPayload: AgentTemplatePayload = 
{
  "slots": {
    "prompt": "（把这里换成你的商品与材质特性）氛围场景产品图，PRODUCT LOCK 保留商品形状与 logo，低角度微距与逆光透光，材质纤毫可见",
    "contextPrompt": "与商品调性匹配的场景，侧后暖光透材质，前景虚化制造纵深",
    "composition": [
      "商品占画面 30-40% 置视觉焦点，边缘锐利",
      "前景虚化不遮主体，光效不吞商品"
    ],
    "negativePrompt": "商品形变，logo 糊，标签文字乱码，棚拍硬光，CGI 塑料感，多 SKU 色彩漂移",
    "styleTemplateId": "sai-photographic",
    "qualityProfile": "print"
  },
  "initialPrompt": "我的新品要全套上市素材：（写商品与核心卖点），先锁产品资产，再依次出场景图、模特图、主视觉和多画幅批量。",
  "directive": "用户刚从模板库点了「新品上市包」流水线，画布上已铺好 8 步 workflow（锁产品→铺场景包→出模特图→出主视觉→排详情页→批量出画幅→放大精修→审终交付）。\n正确跑法：第 0 步先要商品原图或清晰描述——没有实物图就用 question 工具问齐品类/材质/logo 位置，绝不凭空捏造产品。\n出图直接走 image_generate 工具（会自动回填画布节点），不要用 bash/python 调外部 API。\n白底产品锁是全链根基：先出一张白底主图给用户确认形变与边缘，通过后才铺场景与模特。\n批量阶段换画幅重排而非裁切；每步产出回填画布节点，用户喊停就停在当前门禁。\n全程用简体中文与用户对话，不写繁体字。\n启动工作流时调用 workflow_start 传 template_id=\"ecom_launch\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程纯 image/text 两种节点，无 audio/film 环节；若未来延伸配音/成片环节，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "纯净白底产品图 + RMBG 透明底抠图 + 产品 DNA JSON（形状/颜色/材质/包装标签/LOGO位置/不可变特征）",
      "inputFrom": "用户原图/描述结构化为 JSON 注入；本步产物即全链首个资产",
      "promptNotes": [
        "白底棚拍基准图：正面45度产品照，柔光箱双侧补光，阴影柔和落地，突出材质与标签纹理",
        "RMBG 抠图后检查边缘无残留光晕，半透明材质（玻璃/纱）保留 Alpha 通透",
        "DNA JSON 用 Product accuracy 字段显式声明 shape/color/packaging/label/material 等不可变特征",
        "负向约束固定尾缀：no fake text, no label distortion, no extra products, no warp"
      ],
      "gate": "VLM 门禁：对照原图校验形状、标签文字、LOGO 零变形零乱码，任一不符重出，未过禁入下一步",
      "requiredTools": [
        {
          "id": "product_lock",
          "input": "商品图",
          "output": "商品 DNA 锁定（形变/色彩基准）"
        },
        {
          "id": "background_remove",
          "input": "商品图",
          "output": "抠图（透明底商品资产）"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "3 张情绪场景图（棚拍极简 / 生活方式实景 / 材质微距特写），各含自然光影与倒影",
      "inputFrom": "上一步「锁产品」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "ControlNet Canny 锁产品轮廓结构，防形变；IP-Adapter 注入抠图外观，保材质颜色",
        "每张场景图单独定义光照字段（方向/色温/强度），倒影与接触阴影必须落地，产品不悬浮",
        "变体一次只改一个变量：背景/机位/色板，不混改，保证可归因",
        "环境叙事贴用途：电商主图走极简棚拍，详情页走生活方式，种草内容走微距特写",
        "光照字段三段式定义写进每张图：方向（侧后 45°）/色温（棚拍 5500K、生活方式 3800K 暖调）/强度（柔光 0.6、逆光 1.2），倒影与接触阴影方向必须与光源严格反向，scene_pack_batch 同 seed 族一次出全 3 张，跨场景色板方差 >5% 判风格漂移整包重跑"
      ],
      "gate": "VLM 门禁：光影方向与场景自洽、倒影自然、产品与 PRODUCT LOCK 一致性比对通过",
      "requiredTools": [
        {
          "id": "scene_pack_batch",
          "input": "商品 DNA + 场景清单",
          "output": "场景包图组（多场景一致）"
        },
        {
          "id": "image_generate",
          "input": "prompt + 模型 + 尺寸/张数",
          "output": "图片 URL + 实际花费"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "2 张模特演绎图（全身场景 + 特写佩戴/使用），模特姿势可控、产品为视觉焦点",
      "inputFrom": "上一步「铺场景包」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "OpenPose 锁模特骨架姿势，Inpainting 只重绘穿戴/持握区域，不整图重生成",
        "IP-Adapter 产品权重调高，确保穿戴物即锁定的产品而非近似替代品",
        "模特人种/年龄/气质先问用户目标人群，一次定死全系列复用，保持人群一致性",
        "手部与产品接触点是翻车高发区，prompt 显式写 grip/接触细节",
        "product_conditioned_generation 出图后先做手部专项检查：五指关节计数 + 持握接触面积比对，出现畸变仅对 Inpainting 手部区域局部重绘，不整图重生成；OpenPose 骨架文件（手腕/手肘关键点对准产品接触位）存档复用，同系列共用一套骨架防姿势漂移"
      ],
      "gate": "VLM 门禁：手部结构无畸变（指数/关节）、产品在模特身上零形变、脸与人群设定一致",
      "requiredTools": [
        {
          "id": "product_conditioned_generation",
          "input": "商品 DNA + 模特构图",
          "output": "条件化模特图（产品零形变）"
        },
        {
          "id": "image_generate",
          "input": "prompt + 模型 + 尺寸/张数",
          "output": "图片 URL + 实际花费"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "KV 主视觉 1 张（低机位逆光英雄构图）+ 负空间 CTA 版式 1 张（预留文案与按钮区）",
      "inputFrom": "上一步「出模特图」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "低机位仰拍 + 逆光轮廓光制造英雄感，前景产品、背景简洁分层",
        "负空间 CTA 版：画面留出 1/3 干净区域（左或右）给标题/卖点/按钮，禁止产品居中占满",
        "构图遵守最终投放宽高比先定再生成，不事后裁切毁构图",
        "视觉钩子前置：3 秒原则，第一眼看到的是产品+一个记忆点，不是环境氛围",
        "3 秒原则执行判据：把 KV 缩到 200px 缩略图做盲测，3 秒内能说出「产品是什么 + 一个卖点」才通过，说不清就回炉重排视觉层级；canonical_key_art_lock 定稿后把色板/光照/构图参数写进锁定卡，后续画幅重排与详情首屏强制对齐，禁止另行发明风格"
      ],
      "gate": "VLM 门禁：CTA 负空间占比≥30%、视觉层级清晰、产品锐度未因逆光损失",
      "requiredTools": [
        {
          "id": "canonical_key_art_lock",
          "input": "产品 DNA + 锁定模特图",
          "output": "KV 主视觉锁定卡（英雄构图 + CTA 负空间版）"
        },
        {
          "id": "image_generate",
          "input": "prompt + 模型 + 尺寸/张数",
          "output": "图片 URL + 实际花费"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "详情页长图分镜 5-6 屏（痛点开场 → 产品亮相 → 细节特写 → 场景演绎 → 参数对比 → 信任背书收尾）",
      "inputFrom": "上一步「出主视觉」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "多图合成 + 文本叠加：每屏一个信息点，图文比例 7:3，字号在手机端不小于 24pt 等效",
        "细节特写屏调用微距场景图，参数对比屏用白底基准图，素材复用即一致性",
        "长图统一宽 750px 移动端标准，每屏高 800-1200px，图区上文区下；首屏 3 秒内完成「痛点→产品解法」信息闭环",
        "detail_page_manifest 先列模块清单再出图：每屏注明素材来源（哪张场景图/白底图）与文案要点，清单给用户过目后才生成，避免整页返工",
        "参数对比屏只列可验证参数（尺寸/材质/认证），禁止与竞品做无依据功效对比，防虚假 claim 进详情页"
      ],
      "gate": "VLM 门禁：逐屏检查文字可读、无错别字乱码、图文层级清晰、全链素材与 PRODUCT LOCK 一致",
      "requiredTools": [
        {
          "id": "detail_page_manifest",
          "input": "产品锁 + 卖点清单",
          "output": "详情页排版清单（模块/顺序）"
        },
        {
          "id": "image_generate",
          "input": "prompt + 模型 + 尺寸/张数",
          "output": "图片 URL + 实际花费"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "全画幅矩阵：主图 1:1（≥2048）、详情横幅 3:1、社媒 9:16 与 1:1、Banner 16:9，全部重排而非裁切",
      "inputFrom": "上一步「排详情页」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "styleLock：固定 seed + 固定 prompt 骨架，仅替换 SKU 名称与 PRODUCT LOCK 段，多 SKU 风格像素级一致",
        "每个画幅按自身宽高比重排构图（产品位置/留白/视线引导重新设计），禁止中心裁切",
        "画幅像素矩阵写死：主图 1:1 2048×2048、详情横幅 3:1 3072×1024、社媒 9:16 1080×1920、Banner 16:9 2560×1440，aspect_reflow 逐画幅重排",
        "9:16 竖版构图重心上移：产品置上 1/3、文案区留下方 40%，避让信息流 UI 安全区（顶部 12%/底部 20%）",
        "命名规范本步内建落盘：渠道_用途_SKU_画幅_序号（如 tmall_main_SKUA_1x1_01），批量产出即按此命名，交付步零改名"
      ],
      "gate": "抽检门禁：每个 SKU 抽 1 张对照 DNA JSON 校验产品身份，风格相似度低于阈值整批重跑",
      "requiredTools": [
        {
          "id": "aspect_reflow",
          "input": "主视觉 + 详情页分镜",
          "output": "多画幅矩阵（重排非裁切）"
        },
        {
          "id": "image_generate",
          "input": "prompt + 模型 + 尺寸/张数",
          "output": "图片 URL + 实际花费"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "全交付图 ≥2048 短边（主图类可 4096 供印刷）+ 色彩管理统一 sRGB",
      "inputFrom": "上一步「批量出画幅」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "ESRGAN 上采样目标 ≥2048×2048，主图类可到 4096 供印刷，纹理材质区锐化不过冲",
        "放大后再查一次小字与标签：上采样偶尔把标签文字糊化，发现即回退重生成",
        "统一色彩管理：批量输出同一色彩空间（sRGB），避免各画幅色差",
        "image_upscale 分档执行：主图类 2x 上探 4096 供印刷，社媒/横幅 2x 保短边 ≥2048；upscale_audit 上采样前后对比噪点/边缘锐度/色偏三项，任一劣化即换倍数重跑，不许带病交付"
      ],
      "gate": "分辨率门禁：任一交付图短边 <2048 即打回；标签文字放大后仍可读",
      "requiredTools": [
        {
          "id": "upscale_audit",
          "input": "交付图组",
          "output": "放大精修 + 审计报告"
        },
        {
          "id": "image_upscale",
          "input": "图片 URL + 放大倍数",
          "output": "放大后图片 URL"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "上市素材包按渠道归档：主图组 / 场景组 / 模特组 / KV+CTA / 详情长图 / 社媒矩阵，附命名规范与使用索引",
      "inputFrom": "上一步「放大精修」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "发布前 12 项终审：产品形状标签准确、无虚假 claim、无未授权第三方 logo、文字拼写、平台安全区、商用权",
        "命名规范内建：渠道_用途_SKU_画幅_序号，运营拿走即用不再改名",
        "使用索引注明每张图的投放位与替换建议，交付可直接上线的完整包",
        "命名规范全包强制校验：四段下划线分隔、序号三位数字补零（001），任一文件名不合规则整包打回重命名，不许运营手工补救",
        "使用索引按 CSV 交付：每行 = 文件名 + 投放位（主图第几位/详情第几屏/社媒哪个画幅）+ 替换建议，运营照表上传零判断"
      ],
      "gate": "终审门禁：12 项清单全绿才标记交付完成；任一红项回溯对应步骤修复后整包重审",
      "requiredTools": [
        {
          "id": "upscale_audit",
          "input": "全素材包",
          "output": "12 项终审报告 + 渠道归档索引"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    }
  ]
}
;
