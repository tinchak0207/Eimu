import type { AgentTemplatePayload } from "./types";

export const ecommerceModelGridPayload: AgentTemplatePayload = 
{
  "slots": {
    "prompt": "（把这里换成你的商品与模特气质）AI 试穿模特种草图，同一模特 IP-Adapter 锁脸，服装版型与材质按服装 DNA 锁定，自然生活方式质感",
    "contextPrompt": "可信生活场景（街头/咖啡店），自然光，色系统一",
    "composition": [
      "全身/半身/细节多景别，商品互动自然",
      "构图留详情页竖排裁切余量"
    ],
    "negativePrompt": "模特脸漂移，服装纹理走样，假笑摆拍，棚拍硬光，商品比例失真，过度磨皮",
    "styleTemplateId": "ads-fashion editorial",
    "qualityProfile": "balanced"
  },
  "initialPrompt": "给（写商品，如针织开衫）做模特种草流水线：从平铺图提取服装，虚拟试穿出模特种草图，再拼一致性网格和详情页。",
  "directive": "用户刚从模板库点了「模特种草线」流水线，画布上已铺好 7 步 workflow（抠取服装资产→选定模特人设→上身虚拟试穿→精修试穿质感→拍齐九宫格→排版详情页→适配分发尺寸）。\n正确跑法：先要服装平铺原图；没有图先问（question 工具）商品品类与模特气质偏好，等信息齐了再动手。\n用户明确没有平铺图时：先说明虚拟试穿需真实服装图才能保证版型/颜色不跑偏，然后用 image_generate 按描述生成一张白底平铺参考图（回复中注明「依据文字描述生成的参考图，非实物图」），不要用 bash/python 调外部 API；参考图经用户确认后才进抠图与试穿。\n抠图边缘给用户过目后才试穿；试穿图锁同一模特脸与体型，形变不过就重生，别交糊图。\n九宫格与详情页节奏（钩子→卖点→细节→场景）对着画布节点推进，一步一确认。\n全程用简体中文与用户对话（镜像用户语言），不写繁体字。\n启动工作流时调用 workflow_start 传 template_id=\"ecom_model\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程纯 image/text 两种节点，无 audio/film 环节；若未来延伸配音/成片环节，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "透明底服装平铺图（RMBG/BiRefNet 细带分割）+ 服装 DNA 卡（材质/版型/颜色/标签）+ 101% 回贴桩",
      "inputFrom": "用户平铺原图结构化为 JSON 注入；本步产物即全链首个资产",
      "promptNotes": [
        "RMBG/BiRefNet 抠图优于 SAM 的细带分割：细带/流苏/蕾丝等易断结构优先跑 BiRefNet，边缘残留光晕用 alpha 阈值 0.3 以上才计实体，逐边复核",
        "服装 DNA 卡锁材质/版型/颜色/标签四维：颜色取平铺图 3 处主色写死 HEX 值，版型量衣长/胸围/袖长比例（如衣长:袖长=1:0.75），试穿阶段当产品锁逐项复用，禁止同义改写",
        "101% 回贴桩：把抠出的服装按 101% 缩放回贴到干净白底与原图人工比对，边缘误差 ≤1% 视为藏住分割线，超标换分割模型重抠",
        "输入图最短边 ≥1024px，不足先 image_upscale 2x 再抠，低分辨率抠图必丢纹理",
        "抠图输出双格式：透明底 PNG（alpha 通道，给试穿通道）+ 纯色底 JPEG（给详情页证据图）各一份"
      ],
      "gate": "抠图边缘与颜色还原人工过目，不过则重抠",
      "requiredTools": [
        {
          "id": "garment_extract",
          "input": "服装图",
          "output": "服装资产（去背景单品）"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "模特人设矩阵（客群反推）+ IP-Adapter FaceID 面部基线锁定",
      "inputFrom": "上一步「抠取服装资产」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "客群反推模特矩阵：人种/年龄/气质/体型四维一次定死全系列复用，每维写固定短语（如「25-30 岁亚洲女性、清冷文艺、165cm/52kg 标准码」），后续禁止同义替换，换词=换脸",
        "IP-Adapter FaceID + 固定 seed 双锁：FaceID 权重 0.6-0.8 起步（低于 0.5 锁不住脸、高于 0.9 表情僵），seed 写进模特卡全系列复用",
        "模特卡配三张基准图：正面特写/全身/侧面，作为后续试穿与九宫格的 face_identity 参考图组，任一图与基准脸比对不过即重生",
        "人设矩阵出 2-3 个候选让用户选，选定后锁定不换；中途换模特=全链返工，是最贵的回头路",
        "negativePrompt 显式排除「多人物、五官漂移、脸部畸变」，与锁脸策略配套防串脸"
      ],
      "gate": "模特人设人工批准后才进试穿",
      "requiredTools": [
        {
          "id": "model_identity_lock",
          "input": "模特参考图组",
          "output": "模特身份锁定卡（FaceID 基线 + 固定 seed）"
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
      "deliverable": "选定模特的试穿图组（正/侧/背，CatVTON/IDM-VTON 主通道）",
      "inputFrom": "上一步「选定模特人设」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "CatVTON/IDM-VTON 主通道 + OpenPose 姿势库：正/侧/背三姿势各出 ≥2 张候选，姿势骨架从库选现成的，不自造畸形骨架",
        "生成参数：CFG 6-8（低了服装细节糊、高了面料过硬），只重绘穿戴区域 mask 内像素，背景与手部原样保留",
        "手部与产品接触点显式写 grip/接触细节（如「左手自然抓握衣摆下缘」），接触点悬空或穿模是试穿图最大穿帮源",
        "「only one person」后缀防多人混入；服装颜色与 DNA 卡 HEX 值比对，色差 ΔE>5 判定跑色重生",
        "每姿势留 2-3 候选，贴合不过整组重生不做局部修补——修补留给下一步精修"
      ],
      "gate": "试穿形变检查：服装贴合与比例不过则重生",
      "requiredTools": [
        {
          "id": "virtual_tryon",
          "input": "服装 DNA + 模特卡",
          "output": "试穿图（上身合成）"
        },
        {
          "id": "garment_dna_lock",
          "input": "服装资产",
          "output": "服装 DNA 签名（版型/材质/色）"
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
      "deliverable": "精修试穿图（MeshGraphormer 手部修复 + ControlNet 分阶段强度 0.4→0.9）+ 面料物理检查",
      "inputFrom": "上一步「上身虚拟试穿」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "MeshGraphormer + scribble 手套防手指拉长：手部区域先跑手部网格重建再局部重绘，六指/关节反折零容忍",
        "ControlNet 分阶段强度 0.4→0.9：先 0.4 低强度铺整体姿势，再 0.9 高强度锁服装版型轮廓，两段生成而非一次到位",
        "双 LoRA 思路锁面料与款式：面料 LoRA（垂坠/针织纹理）与款式 LoRA（版型轮廓）分开挂，权重各 0.5-0.7，混挂会互相污染",
        "面料物理检查清单逐图打勾：垂坠方向顺重力、褶皱密度符合材质（针织少褶/亚麻多褶）、透明度合理（纱质透内层肤色而非透背景）",
        "精修只在 mask 内动刀：image_edit 描述限定服装与手部区域，脸部与背景不动，避免精修把锁好的脸改掉"
      ],
      "gate": "手部结构无畸变（指数/关节）、面料物理可信",
      "requiredTools": [
        {
          "id": "hand_contact_repair",
          "input": "试穿图",
          "output": "手部接触修正图"
        },
        {
          "id": "image_edit",
          "input": "原图 URL + 改图描述",
          "output": "修改后图片 URL"
        },
        {
          "id": "canvas_apply_ops",
          "input": "节点/连线操作指令",
          "output": "画布更新结果"
        }
      ]
    },
    {
      "deliverable": "3x3 九宫格（远/中/近混排 + 统一影调，≥2048px）",
      "inputFrom": "上一步「精修试穿质感」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "IP-Adapter 锁脸批量出图：九格共用同一 FaceID 基线 + seed 族，任一格与基准脸比对不过单格重生，不全组重跑",
        "远/中/近混排：3 远景（环境氛围）/3 中景（穿搭全身）/3 近景（面料细节与商品互动），近景至少 1 格拍材质纹理特写",
        "统一影调：九格同一光照方向与色温（如「窗边自然光 5500K、顺光 45°」），出图后跑色板比对，主色 HEX 偏差 >10% 的格子判影调跳格重生",
        "分辨率链路：单格 ≥2048px 起步，九宫格按每格 683px（2048/3≈683）拼版——先出高清单格再拼，不先拼后放大",
        "九格构图互不重复：机位/姿势/场景至少两项不同，同姿势同景别的雷同格替换重生"
      ],
      "gate": "格间形象一致性人工审核，不过则单格重生",
      "requiredTools": [
        {
          "id": "shot_grid_batch",
          "input": "试穿图组",
          "output": "九宫格种草图"
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
      "deliverable": "详情页长图分镜（钩子→卖点→细节→场景四段节奏，卖点必须有图内证据）",
      "inputFrom": "上一步「拍齐九宫格」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "四段节奏量化：钩子 1 屏（前 10% 高度内出钩）→卖点 2-3 屏→细节 2-3 屏→场景 1-2 屏，总 6-9 屏；每屏只装一个信息点，卖点屏字数 ≤20 字",
        "钩子屏用九宫格最优远景/中景格，前 3 秒注意力法则：第一屏图+一句痛点文案定生死",
        "卖点必须有图内证据：claim 与图中细节一一对应，用 detail_page_evidence_map 输出 region 坐标，缺失证据的卖点要么补拍细节屏要么删文案，禁止图文两张皮",
        "详情页竖排基准宽度 750px（移动端标准），单屏图高 800-1200px，整页长图 ≤10 屏防加载过长",
        "细节屏图源来自近景格放大：image_upscale 2x 后取局部，纹理清晰度不足的细节屏直接判不合格"
      ],
      "gate": "VLM 门禁：逐屏检查文字可读、卖点与图内证据对位",
      "requiredTools": [
        {
          "id": "detail_page_evidence_map",
          "input": "试穿图 + 卖点清单",
          "output": "卖点→图内证据映射（region 坐标 + 缺失清单）"
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
      "deliverable": "分发包：小红书 3:4 / 抖音 9:16 / 淘宝主图 1:1 五张（重排不重生）",
      "inputFrom": "上一步「排版详情页」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "五张具体像素：小红书 3:4（1080x1440）、抖音 9:16（1080x1920）、淘宝主图 1:1（800x800 共 5 张）；每画幅重新构图而非裁切，主体在每画幅中都完整不贴边",
        "重排不重生：同一精修图源做画幅适配，文案区随画幅重排（3:4 文案居下 1/4、9:16 文案避开顶部/底部各 250px 安全区、1:1 主图无文案纯商品）",
        "平台安全区核对：小红书/抖音底部 UI 遮挡区预留 15% 高度，关键卖点字与商品主体不落遮挡区，套检不过的画幅重排",
        "交付前 image_upscale 补足分辨率：任一画幅短边低于目标像素先放大到目标尺寸再交，禁止低分辨率硬缩",
        "每画幅出图后跑文字可读性检查：字号 ≥24px（1080 宽基准），低于 24px 的文案判不可读需重排"
      ],
      "gate": "平台安全区/分辨率套检门禁",
      "requiredTools": [
        {
          "id": "platform_reflow",
          "input": "成图组（九宫格/详情页）",
          "output": "多平台尺寸适配（安全区/分辨率核对）"
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
    }
  ]
}
;
