import type { RecipeTemplate } from "./recipe-templates";

/**
 * 助理起手模板领域：每个领域精准对应一个小众强效痛点。
 * 助理初始右侧模板库按此分组展示。
 */
export type AgentTemplateDomain = "novel" | "ecommerce" | "shortdrama" | "art";

export const AGENT_TEMPLATE_DOMAIN_LABELS: Record<AgentTemplateDomain, string> = {
  novel: "小说",
  ecommerce: "电商",
  shortdrama: "短剧",
  art: "艺术",
};

/** 流水线单步蓝图：agent 按此推进多步生产。 */
export interface AgentPipelineStep {
  /** 步骤短名（行业黑话，如 Character Bible / Sketch-lock）。 */
  name: string;
  /** 该步的可落盘产物。 */
  deliverable: string;
  /** 上一步产出如何喂进来：JSON 注入 / cref 参考图 / sref 锚 / 门禁放行。 */
  inputFrom: string;
  /** 该步提示词与执行要点（含一致性技术）。 */
  promptNotes: string[];
  /** 品质门禁：验收什么、不达标怎么办；无门禁则为空。 */
  gate?: string;
}

/** 流水线蓝图：结构化 → 资产先行 → 门禁 → 组装。 */
export interface AgentPipeline {
  /** 一句话概括整条链。 */
  summary: string;
  steps: AgentPipelineStep[];
}

/**
 * 助理起手模板：在 RecipeTemplate（六槽配方）之上加流水线蓝图与领域信息。
 * slots 为流水线首步配方；点卡注入 initialPrompt 后 agent 按 pipeline 自行推进后续步骤。
 */
export interface AgentTemplate extends RecipeTemplate {
  domain: AgentTemplateDomain;
  /** 流水线级痛点（卡片副标题）。 */
  painPoint: string;
  /** 点卡即注入给 agent 的初始提示词（启动整条流水线的用户第一条消息）。 */
  initialPrompt: string;
  /** 多步驟流水线蓝图。 */
  pipeline: AgentPipeline;
  /** 卡面海報區漸變（Tailwind 三色類，格式同 showcase-cases 的 gradient）。 */
  accent: string;
}

/**
 * 范式来源（2026-08-25 双源交叉验证，仅 GitHub 通道 + Grok 调研答案 docs/grok-sota-pipeline-answer.md）：
 * 主干（双源互证，可信）：四领域共性骨架「文本结构化(JSON)→资产先行(角色/产品/风格 bible)→门禁审核(相似度阈值/人工批准)→组装产出」。
 * - novel/shortdrama：HVision-NKU/StoryDiffusion(6452★,一致性模块)、smthemex/ComfyUI_StoryDiffusion(514★)、
 *   ChrisChen667788/wind-comic(452★：Style Bible 关键帧 sref 锚/三视图+DNA 签名/sketch-lock+Vision Audit<70 分重生/
 *   global_assets embedding 身份漂移检测)、chenning9821/Agentic-Novel-Cinema(10-agent 链：NovelParser→CanonBuilder→
 *   Screenplay→Storyboard→PromptDirector 风格锁→AssetAgent 角色锚点包→ContinuityJudge QC→Repair)、
 *   drasstry/shortdrama-pipeline(113★：「剧本批准才生成人物，人物批准才生成视频」门禁状态机)、
 *   wushaojun321/ai-short-film(LLM 分镜+逐镜生成)。Grok 补充：情绪时序链「听见→停顿→眼神→表情→说话」(标注推断)。
 * - ecommerce：xiaoqahax-ui/comfyui-ecommerce-workflows(product-bg-replace=ControlNet Canny+IP-Adapter+RMBG/
 *   ai-model-tryon=OpenPose+Inpainting/product-detail-layout/batch-processor,ESRGAN≥2048)、
 *   ArifAhmed1995/ecommerce_sdxl(SDXL+LoRA 模特图)、aws-samples/sample-ai-powered-product-catalog、
 *   ayazmhmd Flux-UNO 虚拟试穿。Grok 补充：Product Lock/产品 DNA JSON、负空间 CTA 版(标注推断)。
 * - art：Google StyleAligned(注意力共享风格对齐)、illo-skill(~353★,Grok 标注)、jashan-web/awesome-gpt4o-images、
 *   tiktomato/awesome-seedream-prompts(220 条三语风格库)。策展完整拓扑 Grok 自注「多为推断」，主干取 wind-comic
 *   Style Bible Frame 迁移 + StyleAligned 论文范式。
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  // ———— 小说 ————
  {
    id: "agent-novel-film-pipeline",
    name: "小说影视化",
    note: "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
    domain: "novel",
    accent: "from-[#1a1c23] via-[#3B2F4A] to-[#8B7355]",
    painPoint: "文本到分镜全靠人肉，断点在情绪连续性和角色漂移",
    initialPrompt:
      "把我的小说影视化：（贴章节或写题材与主角），先拆结构化剧本，再锁角色和场景资产，最后出分镜关键帧，一步步来。",
    pipeline: {
      summary: "小说文本→结构化剧本JSON→资产先行→锁构图分镜→成组关键帧的影视化流水线",
      steps: [
        {
          name: "Script Breakdown",
          deliverable: "结构化剧本 JSON（场次/节拍/角色表/情绪标签/爽点表/资产清单）",
          inputFrom: "小说原文按章喂入；JSON 字段注入后续所有阶段 prompt",
          promptNotes: [
            "场次-动作/台词交替排列，台词时长按 4.5 字/秒折算",
            "每场带情绪标签与 beat note，钩子放前 3 拍",
          ],
          gate: "人工批准剧本后才生成人物资产，避免在错误资产上浪费生成额度",
        },
        {
          name: "Character Bible",
          deliverable: "角色三视图转面表 + DNA 签名 JSON（8 维外貌）+ 服装/伤势变体参考图",
          inputFrom: "剧本 JSON 角色表；三视图作为 cref/IP-Adapter 锚，DNA 字段逐镜注入 prompt",
          promptNotes: [
            "白底无人无手提示词出角色表，避免干扰元素",
            "DNA 签名结构化（眼型/下颌/发型/标志服装），后续每镜自然语言锚注入",
          ],
          gate: "视觉审计相似度阈值（≥70 分），不达标自动带锚重生",
        },
        {
          name: "Art Bible",
          deliverable: "场景概念图 + 道具白底表 + Look Dev 关键帧（canonical key art）",
          inputFrom: "剧本 JSON 场景表 + 角色资产；key art 作为全片 sref 风格锚",
          promptNotes: [
            "先出一张 canonical key art 定全片影调，再批量铺场景",
            "道具白底表喂分镜，减少分镜阶段的道具即兴",
          ],
        },
        {
          name: "Sketch-lock Storyboard",
          deliverable: "黑白构图草图页 + 每镜切点包（景别/机位/运镜/情绪字段）",
          inputFrom: "剧本 JSON + 资产表；草图锁定构图后才出彩图",
          promptNotes: [
            "黑白线稿先行锁构图，分镜只输出不新增决策",
            "镜头语言字段化：景别、机位、运镜与该镜情绪标签绑定",
          ],
          gate: "构图草图人工锁定后放行最终帧生成",
        },
        {
          name: "Keyframe & 成组产出",
          deliverable: "每镜最终帧 PNG + 情绪表对照页 + 简易 animatic 预览",
          inputFrom: "锁定分镜 + cref/sref 资产锚；最终帧可直接作 I2V 起始帧",
          promptNotes: [
            "情绪时序链入 prompt：听见→停顿→眼神→表情→说话",
            "固定 seed + 相对材质高光比例（金属×1.5、皮肤×0.5）稳风格",
          ],
          gate: "逐镜一致性检查通过后才批量导出成组产出",
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的小说题材与主角设定）影视概念关键帧，主角按角色圣经 DNA 签名锁定，黑白灰关系先行的构图，戏剧性光线时刻，情绪标签驱动画面节拍",
      contextPrompt: "按剧本场景表生成的场景环境，影调与 canonical key art 对齐，光源方向统一",
      composition: [
        "16:9 电影画幅，景别与机位按分镜切点包执行",
        "构图锚定 sketch-lock 草图，情绪焦点置视觉中心",
      ],
      negativePrompt: "角色与 DNA 签名漂移，构图偏离锁定草图，光源方向打架，情绪断裂，风格脱离 key art",
      styleTemplateId: "sai-cinematic",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-novel-ip-visual-pack",
    name: "IP视觉包",
    note: "网文 IP 全案视觉：世界观锚定→主角色卡→名场面组图→封面主视觉一条链出齐",
    domain: "novel",
    accent: "from-[#0F1B2D] via-[#1F3A5F] to-[#4A7C9B]",
    painPoint: "IP 立项要整套视觉物料，约稿拼凑一周，风格还各说各话",
    initialPrompt:
      "我的网文要整套 IP 视觉包：（写世界观与主角），先锁世界观风格锚，再出主角设定卡、名场面组图和封面主视觉。",
    pipeline: {
      summary: "网文 IP 立项视觉全案：风格锚先行→角色资产→名场面组图→封面与多画幅",
      steps: [
        {
          name: "World Bible 锚定",
          deliverable: "世界观情绪板 + canonical key art（全案 sref 锚）+ 色彩/材质规范",
          inputFrom: "题材关键词与参考方向 JSON 化；key art 供全案每步风格锁定",
          promptNotes: [
            "先出一张定调 key art，后续所有产出以它为 sref",
            "色彩、材质、光线规范字段化，作为检查基准",
          ],
          gate: "key art 人工锁定后才批量生成后续资产",
        },
        {
          name: "主角角色卡",
          deliverable: "主角色三视图 + 表情差列 + DNA 签名 JSON",
          inputFrom: "世界观锚注入风格；角色卡作后续名场面 cref 锚",
          promptNotes: [
            "设定页白底排版，三视图等大，DNA 签名逐字段写清",
            "服装标志物与世界观规范对齐",
          ],
          gate: "三视图形象一致性人工审核，不过则重出",
        },
        {
          name: "名场面组图",
          deliverable: "3-5 张名场面概念图（sketch-lock 后成图）",
          inputFrom: "角色卡 cref + 世界观 sref；先黑白构图稿锁构图",
          promptNotes: [
            "每张先草图锁构图再上色，名场面情绪标签对应原著节拍",
            "镜头语言字段化：景别/机位/运镜",
          ],
        },
        {
          name: "封面主视觉",
          deliverable: "竖版封面主视觉 + 书名区留白版",
          inputFrom: "名场面组图选主视觉方向；沿用 key art 影调",
          promptNotes: [
            "顶部三分之一留书名区，人物占下半拉气势",
            "男频低机位仰拍/女频留白气口按频道选构图",
          ],
          gate: "主视觉人工批准后出多画幅适配版",
        },
        {
          name: "多画幅适配",
          deliverable: "封面多画幅包（3:4/1:1/9:16）+ 平台规范核对清单",
          inputFrom: "批准后的主视觉作唯一源图，逐画幅重排",
          promptNotes: [
            "每画幅重新构图而非裁切，书名区随画幅重排",
            "按平台规范核对分辨率与安全区",
          ],
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的世界观与主角）世界观定调 key art，史诗尺度与人物气场的对比，色彩材质按世界观规范，情绪板标签驱动影调",
      contextPrompt: "世界观核心场景，空间纵深与光位统一，为全案视觉立锚",
      composition: ["16:9 定调画幅，视点拉远交代尺度", "唯一情绪锚点置光线引导的视觉中心"],
      negativePrompt: "风格脱离情绪板，光源方向打架，元素堆砌无重点，色彩规范外溢",
      styleTemplateId: "sai-digital art",
      qualityProfile: "print",
    },
  },

  // ———— 电商 ————
  {
    id: "agent-ecommerce-launch-pack",
    name: "新品上市包",
    note: "新品素材流水线：产品锁→场景图→模特图→主视觉→多画幅批量，一次锁定全线一致",
    domain: "ecommerce",
    accent: "from-[#3D2314] via-[#8C5A3B] to-[#E8A87C]",
    painPoint: "一套上市素材散做几十张，商品形变和风格漂移改到崩溃",
    initialPrompt:
      "我的新品要全套上市素材：（写商品与核心卖点），先锁产品资产，再依次出场景图、模特图、主视觉和多画幅批量。",
    pipeline: {
      summary: "白底产品锁→场景组→模特图→英雄主视觉→多画幅多 SKU 批量的电商素材流水线",
      steps: [
        {
          name: "Product Lock",
          deliverable: "白底主图 PNG + 产品 DNA JSON（形状/logo/材质/比例字段）",
          inputFrom: "单张产品原图；DNA 字段强制注入后续所有 prompt",
          promptNotes: [
            "PRODUCT LOCK 段落绝对保留形状、比例、logo、纹理",
            "白底干净边缘，材质特征逐字段写进 JSON",
          ],
          gate: "白底边缘与产品形变 VLM 自动评分，通过才进场景阶段",
        },
        {
          name: "Scene Pack",
          deliverable: "氛围场景图组（按调性预设 3-5 张）",
          inputFrom: "白底图作精确产品参考；场景情绪标签（奢华/日常/节日）从模板注入",
          promptNotes: [
            "ControlNet Canny 锁商品轮廓，IP-Adapter 注入产品特征",
            "场景包预设化，情绪标签决定光位与道具",
          ],
        },
        {
          name: "On-model 模特图",
          deliverable: "模特使用/佩戴图 + 多角度展示板",
          inputFrom: "产品锁 + 模特参考；IP-Adapter 锁脸与体型",
          promptNotes: [
            "OpenPose 控姿，Inpainting 局部重绘放产品",
            "模特与产品比例关系列为必检字段",
          ],
          gate: "产品一致性门禁：logo/纹理比对不过自动重生",
        },
        {
          name: "Hero 主视觉",
          deliverable: "主视觉英雄镜头 + 负空间 CTA 版",
          inputFrom: "场景/模特图选方向；沿用产品锁",
          promptNotes: [
            "低机位逆光景深锁定，商品边缘锐利",
            "另出一版预留 CTA 负空间的排版版",
          ],
          gate: "人工审核主视觉批准后才批量",
        },
        {
          name: "多画幅批量",
          deliverable: "多画幅包（1:1/9:16/16:9）+ 变体 SKU 适配包",
          inputFrom: "批准的主视觉模板；批量节点参数注入 + styleLock",
          promptNotes: [
            "每画幅重排构图而非硬裁，文案区按画幅重规划",
            "变体 SKU 换产品锁即可，风格 seed 全线固定",
          ],
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的商品与材质特性）氛围场景产品图，PRODUCT LOCK 保留商品形状与 logo，低角度微距与逆光透光，材质纤毫可见",
      contextPrompt: "与商品调性匹配的场景，侧后暖光透材质，前景虚化制造纵深",
      composition: ["商品占画面 30-40% 置视觉焦点，边缘锐利", "前景虚化不遮主体，光效不吞商品"],
      negativePrompt: "商品形变，logo 糊，标签文字乱码，棚拍硬光，CGI 塑料感，多 SKU 色彩漂移",
      styleTemplateId: "sai-photographic",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-ecommerce-model-grid",
    name: "模特种草线",
    note: "平铺图到种草图流水线：服装提取→虚拟试穿→一致性网格→详情页排版",
    domain: "ecommerce",
    accent: "from-[#0E3B2E] via-[#2E7D64] to-[#9BD4B4]",
    painPoint: "模特档期贵难约，一套种草图等两周还接不上详情页",
    initialPrompt:
      "给（写商品，如针织开衫）做模特种草流水线：从平铺图提取服装，虚拟试穿出模特种草图，再拼一致性网格和详情页。",
    pipeline: {
      summary: "服装平铺提取→AI 试穿→一致性网格→详情页排版四段式流水线",
      steps: [
        {
          name: "服装资产提取",
          deliverable: "透明底服装平铺图 + 材质/版型字段 JSON",
          inputFrom: "原始平铺照片；RMBG 抠图，字段注入后续 prompt",
          promptNotes: ["抠图边缘干净，材质与版型字段化记录", "服装 DNA 作为试穿阶段的产品锁"],
          gate: "抠图边缘与颜色还原人工过目",
        },
        {
          name: "AI 虚拟试穿",
          deliverable: "选定模特的试穿图组（正/侧/背）",
          inputFrom: "服装资产 + 模特参考；OpenPose 控姿 + Inpainting 换装",
          promptNotes: ["IP-Adapter 锁模特脸与体型，服装纹理按 DNA 注入", "姿势库预设化：站姿/回眸/坐姿"],
          gate: "试穿形变检查：服装贴合与比例不过则重生",
        },
        {
          name: "一致性网格",
          deliverable: "3x3 远中近混排一致性网格图",
          inputFrom: "试穿图组作 cref；同一模特同服装出多景别",
          promptNotes: ["九格同主体同服装，格间留分隔", "全身/半身/细节特写混合编排像真拍一套"],
          gate: "格间形象一致性人工审核",
        },
        {
          name: "详情页排版适配",
          deliverable: "详情页竖排长图组 + 文案排版版",
          inputFrom: "网格图与试穿图多图合成 + 文本叠加",
          promptNotes: ["多图合成节奏：钩子图→卖点图→细节图→场景图", "文案区与图形分层互不侵入"],
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的商品与模特气质）AI 试穿模特种草图，同一模特 IP-Adapter 锁脸，服装版型与材质按服装 DNA 锁定，自然生活方式质感",
      contextPrompt: "可信生活场景（街头/咖啡店），自然光，色系统一",
      composition: ["全身/半身/细节多景别，商品互动自然", "构图留详情页竖排裁切余量"],
      negativePrompt: "模特脸漂移，服装纹理走样，假笑摆拍，棚拍硬光，商品比例失真，过度磨皮",
      styleTemplateId: "ads-fashion editorial",
      qualityProfile: "balanced",
    },
  },

  // ———— 短剧 ————
  {
    id: "agent-shortdrama-visual-assets",
    name: "剧本视觉化",
    note: "剧本到视觉资产工业链：拆场→分镜→主演角色卡→CP剧照→竖屏海报，门禁层层放行",
    domain: "shortdrama",
    accent: "from-[#2B0A12] via-[#7A1F3D] to-[#D46A6E]",
    painPoint: "剧本到开拍全靠嘴对齐，导演脑补的和你不是同一部片",
    initialPrompt:
      "把我的短剧剧本做成视觉资产包：（贴剧本或写剧情梗概与主演设定），按拆场→分镜→角色卡→CP剧照→竖屏海报走完。",
    pipeline: {
      summary: "剧本拆场→锁构图分镜→主演角色资产→CP 剧照→竖屏海报的短剧视觉工业链",
      steps: [
        {
          name: "剧本拆场",
          deliverable: "结构化场表 JSON（场次/角色/情绪节拍/钩子位）+ 台词本",
          inputFrom: "剧本文本；JSON 注入分镜与资产阶段",
          promptNotes: ["每场带情绪标签，钩子前 3 拍", "台词按角色归档供后续 TTS 音色绑定"],
          gate: "人工批准剧本后才生成人物，避免错误资产浪费额度",
        },
        {
          name: "主演角色卡",
          deliverable: "主演三视图转面表 + DNA 签名 JSON + 音色绑定",
          inputFrom: "场表角色列表；三视图作全链 cref 锚",
          promptNotes: ["逐角色单独生成固定形象，不批量混出", "DNA 签名字段化，后续每镜注入"],
          gate: "人物图人工批准后才进分镜与视频环节",
        },
        {
          name: "Sketch-lock 分镜",
          deliverable: "9:16 竖屏分镜草图页 + 每镜切点包（景别/机位/正反打标记）",
          inputFrom: "场表 JSON + 角色锚；黑白构图稿锁定后再出彩帧",
          promptNotes: [
            "竖屏 9:16 每段≤15s 的节奏切分，正反打构图成对设计",
            "情绪时序链入分镜字段：听见→停顿→眼神→表情→说话",
          ],
          gate: "17 道分镜质量门：镜头时长/动作过载/对白过载逐项过",
        },
        {
          name: "CP 剧照包",
          deliverable: "主演 CP 剧照组（张力线构图 3-5 张）",
          inputFrom: "双人 DNA 同锚 + 亲密构图约束",
          promptNotes: ["一近一远走位明确，视线/肢体形成张力线", "上下留裁切余量适配横竖投放"],
        },
        {
          name: "竖屏海报",
          deliverable: "竖屏封面海报 + 花体字效安全区版",
          inputFrom: "CP 剧照/角色卡选方向；沿用分镜影调",
          promptNotes: ["顶部留剧名与花体字效位，字效不得遮脸", "低机位仰拍气场 + 明暗对照布光"],
          gate: "字效遮脸检查与人工过目后交付",
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的剧情与主演设定）短剧分镜概念图，黑白构图稿先行，9:16 竖屏镜头语言，角色按 DNA 签名锁定，情绪节拍推进清晰",
      contextPrompt: "剧情关键场景示意，箭头标注运动方向，关键格加重明暗对比",
      composition: ["竖屏分镜表 6-8 格，每格标景别与正反打", "格间留白分隔，动作方向可读"],
      negativePrompt: "角色 DNA 漂移，成品上色插画感，镜头语言混乱，动作方向不明，正反打构图飘",
      styleTemplateId: "sai-comic book",
      qualityProfile: "draft",
    },
  },
  {
    id: "agent-shortdrama-poster-line",
    name: "投放海报线",
    note: "短剧投放物料流水线：剧设锚定→主演海报→CP对戏图→信息流切片封面批量",
    domain: "shortdrama",
    accent: "from-[#0D1B3E] via-[#2E3A8C] to-[#7E6BD9]",
    painPoint: "投放封面靠从成片截图截到崩，一套物料跟不上日更投放",
    initialPrompt:
      "给我的短剧做投放物料流水线：（写剧设与主演形象），先锁视觉基调，再出主演海报、CP对戏图和信息流切片封面批量。",
    pipeline: {
      summary: "剧设视觉锚→主演海报→CP 对戏→信息流切片封面批量的投放物料链",
      steps: [
        {
          name: "剧设视觉锚",
          deliverable: "全剧视觉基调 key art + 色彩情绪规范 JSON",
          inputFrom: "剧设文本；key art 作全物料 sref 锚",
          promptNotes: ["一张 key art 定影调（如雨夜霓虹/豪门金调）", "色彩情绪字段化，后续每张海报对表"],
          gate: "基调人工锁定后批量",
        },
        {
          name: "主演海报",
          deliverable: "主演单人竖屏海报（气场版/情绪版两向）",
          inputFrom: "key art sref + 主演 DNA cref",
          promptNotes: ["低机位仰拍气场版 + 特写情绪版各一", "明暗对照布光，冷暖对撞直给张力"],
          gate: "主演辨识度与 DNA 比对通过",
        },
        {
          name: "CP 对戏图",
          deliverable: "CP 对戏剧照组（3 张不同张力级）",
          inputFrom: "双人 DNA 同锚 + 亲密构图约束，影调沿 key art",
          promptNotes: ["走位一近一远，张力线明确", "三级张力：对视/逼近/拉扯，供投放 A/B"],
        },
        {
          name: "切片封面批量",
          deliverable: "信息流切片封面包（9:16 多张，带剧名安全区）",
          inputFrom: "海报/剧照作源图；批量参数注入 + 固定 seed",
          promptNotes: ["每张重排而非裁切，剧名位固定安全区", "封面情绪标签与切片剧情对位"],
          gate: "字效遮脸与安全区检查后交付",
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的剧设与主演）短剧竖屏海报，电影写实质感按 key art 影调，主演半身特写气场全开，明暗对照布光，情绪张力直给",
      contextPrompt: "剧情强相关场景暗示（雨夜天台/豪门客厅），背景压暗突出人物",
      composition: ["竖版 9:16，主角占画面 60% 靠下，低机位仰拍", "顶部留剧名与花体字效位，字效不遮脸"],
      negativePrompt: "群演乱入，表情呆滞，文字乱入，字效遮脸，平光游客照，影调脱离 key art",
      styleTemplateId: "sai-cinematic",
      qualityProfile: "balanced",
    },
  },

  // ———— 艺术 ————
  {
    id: "agent-art-curation-series",
    name: "策展式创作",
    note: "主题到个展全链：情绪板→风格锚→成组作品→展陈主视觉，一致性当一等公民",
    domain: "art",
    accent: "from-[#2A1E5C] via-[#5E5AA8] to-[#A8C6E8]",
    painPoint: "系列作品画到第八张风格散架，个展始终立不起来",
    initialPrompt:
      "以（写你的主题，如潮汐与遗忘）做策展式创作：先出情绪板和风格锚定，再出成组作品，最后出展览主视觉。",
    pipeline: {
      summary: "主题→情绪板→canonical key art 风格锚→成组作品→展陈主视觉的策展流水线",
      steps: [
        {
          name: "情绪板",
          deliverable: "情绪板图组 + 关键词 JSON（色彩/材质/情绪标签）",
          inputFrom: "主题描述结构化；情绪标签注入后续风格 prompt",
          promptNotes: ["情绪板先发散再收敛，选定的标签全程传递", "色彩与材质字段化为检查基准"],
          gate: "情绪板人工选定方向后才出风格锚",
        },
        {
          name: "风格锚定",
          deliverable: "canonical key art 一张 + style DNA 描述",
          inputFrom: "情绪板收敛方向；key art 作全系列 sref 锚",
          promptNotes: ["一张 key art 定笔触/色盘/光线语言", "style DNA 字段化，逐张对表"],
          gate: "key art 人工锁定后才批量生成系列",
        },
        {
          name: "成组作品",
          deliverable: "成组作品 5-12 张（sketch-lock 后成图）",
          inputFrom: "key art sref + 主题变体表；先黑白构图稿锁定",
          promptNotes: [
            "StyleAligned 注意力共享 + 固定 seed 稳风格",
            "每张构图先草图锁定，统一呼吸感与留白节奏",
          ],
          gate: "成组色盘/笔触密度统一性检查，outlier 张重生",
        },
        {
          name: "展陈主视觉",
          deliverable: "展览主视觉海报 + 墙面布置模拟 + 图录版式",
          inputFrom: "系列作品选主视觉方向；key art 构图放大复用",
          promptNotes: ["主视觉与字区分层，留白即格调", "墙面模拟按展线节奏排布组图"],
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成你的主题）策展式定调 key art，情绪板标签驱动色彩与材质，笔触光线语言为全系列立锚，叙事焦点明确",
      contextPrompt: "主题核心意象的空间化呈现，三层纵深信息递进，光源方向统一",
      composition: ["定调画幅，视点服务主题的尺度表达", "唯一情绪锚点置光线引导中心，留白即格调"],
      negativePrompt: "风格脱离 key art，色盘外溢，笔触密度不均，元素堆砌，构图平均无重点",
      qualityProfile: "print",
    },
  },
  {
    id: "agent-art-style-immersion",
    name: "风格深研线",
    note: "艺术家风格深度内化流水线：解构→临摹对拍→变体矩阵→原创成组",
    domain: "art",
    accent: "from-[#4A3728] via-[#9C7A5B] to-[#E3C9A8]",
    painPoint: "风格迁移只学到滤镜皮，学不到艺术家观察世界的方式",
    initialPrompt:
      "深度内化（写艺术家或流派，如莫奈）的风格：先解构其语言要素，再临摹对拍验证，然后变体矩阵测试，最后原创成组。",
    pipeline: {
      summary: "风格解构→临摹对拍→变体矩阵→原创成组的风格内化流水线",
      steps: [
        {
          name: "风格解构",
          deliverable: "style DNA JSON（笔触/色盘/光观察/构图习惯/题材偏好）",
          inputFrom: "艺术家代表作拆解；字段注入后续所有 prompt",
          promptNotes: ["五个维度逐字段写清，不止滤镜层", "区分「画什么」与「怎么看」两层"],
          gate: "解构表人工确认后进临摹",
        },
        {
          name: "临摹对拍",
          deliverable: "2-3 张临摹作 + 与原作并排对拍页",
          inputFrom: "style DNA 注入；同题材同构图对拍",
          promptNotes: ["逐维度复现：笔触厚度/颜料堆叠/纸纹", "对拍页标注各维度还原度"],
          gate: "对拍维度还原不达标回到解构表修正",
        },
        {
          name: "变体矩阵",
          deliverable: "3x3 变体矩阵（不同题材/光线/画幅套同一 style DNA）",
          inputFrom: "style DNA + 变量表；固定 seed 逐格对照",
          promptNotes: ["验证风格泛化：换题材是否仍是「他画的」", "矩阵逐格标注哪个维度在漂"],
          gate: "矩阵风格一致人工审定后进原创",
        },
        {
          name: "原创成组",
          deliverable: "原创主题成组作品 4-6 张（风格内化完成证物）",
          inputFrom: "style DNA + 自选主题；StyleAligned + 固定 seed 收尾",
          promptNotes: ["题材完全自选，只保留观察方式", "成组保持统一呼吸感"],
        },
      ],
    },
    slots: {
      prompt:
        "（把这里换成艺术家 + 你的题材）风格解构临摹，按 style DNA 五维（笔触/色盘/光观察/构图/题材）逐维度复现，落在颜料厚度与纸纹材质上",
      contextPrompt: "与艺术家观察方式匹配的光线条件，题材留发挥余裕",
      composition: ["构图习惯向艺术家看齐，主体从你的题材出发", "留白与画面密度按解构表执行"],
      negativePrompt: "风格停留在滤镜层，笔触纸纹缺失，模仿签名落款，维度漂移，两种风格打架",
      qualityProfile: "balanced",
    },
  },
];
