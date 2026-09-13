/**
 * 助理起手模板——顯示 metadata（首屏只載入本檔；2026-09-12 首屏減重拆分）。
 *
 * 卡面渲染所需欄位（標題/領域/痛點/漸變/海報/環節短名）留在本檔；
 * 大段執行文案（slots 六槽、initialPrompt、directive、步驟的
 * promptNotes/deliverable/inputFrom/gate/requiredTools）遷至
 * `agent-templates-payload.ts`，由使用處/回調 `await import()` 動態載入，
 * 經 `hydrateAgentTemplate(card)` 合併為 `AgentTemplateFull` 後再走
 * cropTemplate / templateToCanvasLayout / 注入鏈路。兩檔以模板 id +
 * 步驟索引對齊；hydrate 帶防呆，步數漂移即拋錯。
 * 禁止把執行文案加回本檔——靜態 import 鏈會把它們再灌進 app/page chunk。
 */

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

/**
 * 流水线单步蓝图（显示视角）：agent 按此推进多步生产。
 * name 是卡面步骤链与画布节点标题共用的展示名：短中文动词开头（拆/锁/定/出），
 * 读起来像一条生产指令，不是术语堆叠——用户不该先学会黑话才能看懂卡。
 * 执行字段（promptNotes/deliverable/inputFrom/gate/requiredTools）在
 * agent-templates-payload.ts 的 AgentPipelineStepFull。
 */
export interface AgentPipelineStep {
  /** 步骤短名（行业黑话，如 Character Bible / Sketch-lock）。 */
  name: string;
  /** 环节短名（纯名字，2-3 字；圆环选择器/生成卡标题用）。 */
  shortName: string;
  /** 生成卡節點類型（2026-08-30）：該步產出的形態；缺省 image。
   *  與後端 novel_film 模板映射對齊：文本步=text、視頻步=video、配音=audio。
   *  2026-09-03 增 director：3D 白模预演步，生成卡鋪成導演台節點（CanvasNodeType.Director）。 */
  outputKind?: "image" | "text" | "video" | "audio" | "director";
}

/** 流水线蓝图（显示视角）：summary + 环节名；执行字段见 payload 档。 */
export interface AgentPipeline {
  /** 一句话概括整条链。 */
  summary: string;
  steps: AgentPipelineStep[];
}

/**
 * 助理起手模板（卡面顯示視角；2026-09-12 拆分）：原 RecipeTemplate（六槽配方）
 * 的 slots 與 initialPrompt/directive 等執行欄位移至 payload 檔，
 * 執行側完整形態見 AgentTemplateFull。
 */
export interface AgentTemplate {
  id: string;
  name: string;
  /** 一句话说明这个模板适合什么。 */
  note: string;
  domain: AgentTemplateDomain;
  /** 流水线级痛点（卡片副标题）。 */
  painPoint: string;
  /** 卡面海報區漸變（Tailwind 三色類，格式同 showcase-cases 的 gradient）。 */
  accent: string;
  /** 卡片居中时舞台环境光主色（hex，取 accent 中间档）。 */
  glow: string;
  /**
   * 模範級 AI 成片封面照（2026-08-26）：public/showcase/agent-templates/ 下的
   * 靜態 webp。來源 = 各領域模範 AI 生成成片的封面帧（獲獎/官方精選/高播放），
   * object-cover 鋪滿卡面、atc-info 自帶底部黑漸變保證文字可讀。缺席時退回純漸變。
   */
  showcaseImage?: string;
  /** 模範級 AI 成片影片：8 秒靜音循環 mp4。poster = showcaseImage。 */
  showcaseVideo?: string;
  /**
   * VPS agent-harness 後端已註冊的 workflow 模板 id（2026-08-27）。
   * 前端卡面 8 環承諾與後端 novel_film 模板對齊：劇本/分鏡=text、
   * 角色卡/美術卡/關鍵幀=image、視頻=video、配音=audio、成片=film。
   * agent 調 workflow_start 時應以此 id 啟動，而非即興拼節點。
   */
  harnessTemplateId?: string;
  /** 多步驟流水线蓝图（显示视角）。 */
  pipeline: AgentPipeline;
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
    "id": "agent-novel-film-pipeline",
    "name": "小说影视化",
    "harnessTemplateId": "novel_film",
    "note": "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
    "domain": "novel",
    "accent": "from-[#1a1c23] via-[#3B2F4A] to-[#8B7355]",
    "glow": "#3B2F4A",
    "showcaseVideo": "/showcase/agent-templates/novel-film-3.mp4",
    "showcaseImage": "/showcase/agent-templates/novel-film-3.webp",
    "painPoint": "文本到分镜全靠人肉，断点在情绪连续性和角色漂移",
    "pipeline": {
      "summary": "小说文本→结构化剧本JSON→资产先行→锁构图分镜→成组关键帧的影视化流水线",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "outputKind": "text"
        },
        {
          "name": "建角色圣经",
          "shortName": "角色卡"
        },
        {
          "name": "定美术圣经",
          "shortName": "美术卡"
        },
        {
          "name": "锁定分镜",
          "shortName": "分镜",
          "outputKind": "text"
        },
        {
          "name": "3D 白模预演",
          "shortName": "预演",
          "outputKind": "director"
        },
        {
          "name": "渲染关键帧",
          "shortName": "关键帧"
        },
        {
          "name": "合成镜头视频",
          "shortName": "视频",
          "outputKind": "video"
        },
        {
          "name": "配音配乐",
          "shortName": "配音",
          "outputKind": "audio"
        },
        {
          "name": "组装成片",
          "shortName": "成片",
          "outputKind": "video"
        }
      ]
    }
  },
  {
    "id": "agent-novel-ip-visual-pack",
    "name": "IP视觉包",
    "note": "网文 IP 全案视觉：世界观锚定→主角色卡→名场面组图→封面主视觉一条链出齐",
    "domain": "novel",
    "accent": "from-[#0F1B2D] via-[#1F3A5F] to-[#4A7C9B]",
    "glow": "#1F3A5F",
    "showcaseVideo": "/showcase/agent-templates/ip-pack-3.mp4",
    "showcaseImage": "/showcase/agent-templates/ip-pack-3.webp",
    "painPoint": "IP 立项要整套视觉物料，约稿拼凑一周，风格还各说各话",
    "pipeline": {
      "summary": "网文 IP 立项视觉全案：风格锚先行→角色资产→名场面组图→封面与多画幅",
      "steps": [
        {
          "name": "拆解世界观",
          "shortName": "世界观",
          "outputKind": "text"
        },
        {
          "name": "炼情绪板",
          "shortName": "情绪板"
        },
        {
          "name": "铸风格锚",
          "shortName": "风格锚"
        },
        {
          "name": "建主角资产",
          "shortName": "主角卡"
        },
        {
          "name": "绘名场面组图",
          "shortName": "名场面"
        },
        {
          "name": "造封面主视觉",
          "shortName": "封面"
        },
        {
          "name": "出多画幅",
          "shortName": "多画幅"
        },
        {
          "name": "铺衍生物料",
          "shortName": "物料"
        }
      ]
    }
  },
  // ———— 电商 ————
  {
    "id": "agent-ecommerce-launch-pack",
    "name": "新品上市包",
    "note": "新品素材流水线：产品锁→场景图→模特图→主视觉→多画幅批量，一次锁定全线一致",
    "domain": "ecommerce",
    "accent": "from-[#3D2314] via-[#8C5A3B] to-[#E8A87C]",
    "glow": "#8C5A3B",
    "showcaseVideo": "/showcase/agent-templates/ecom-launch-2.mp4",
    "showcaseImage": "/showcase/agent-templates/ecom-launch-2.webp",
    "painPoint": "一套上市素材散做几十张，商品形变和风格漂移改到崩溃",
    "pipeline": {
      "summary": "白底产品锁→场景组→模特图→英雄主视觉→多画幅多 SKU 批量的电商素材流水线",
      "steps": [
        {
          "name": "锁产品",
          "shortName": "产品卡"
        },
        {
          "name": "铺场景包",
          "shortName": "场景包"
        },
        {
          "name": "出模特图",
          "shortName": "模特图"
        },
        {
          "name": "出主视觉",
          "shortName": "主视觉"
        },
        {
          "name": "排详情页",
          "shortName": "详情页"
        },
        {
          "name": "批量出画幅",
          "shortName": "画幅"
        },
        {
          "name": "放大精修",
          "shortName": "精修"
        },
        {
          "name": "审终交付",
          "shortName": "交付",
          "outputKind": "text"
        }
      ]
    }
  },
  {
    "id": "agent-ecommerce-model-grid",
    "name": "模特种草线",
    "note": "平铺图到种草图流水线：服装提取→虚拟试穿→一致性网格→详情页排版",
    "domain": "ecommerce",
    "accent": "from-[#0E3B2E] via-[#2E7D64] to-[#9BD4B4]",
    "glow": "#2E7D64",
    "showcaseVideo": "/showcase/agent-templates/ecom-model-2.mp4",
    "showcaseImage": "/showcase/agent-templates/ecom-model-2.webp",
    "painPoint": "模特档期贵难约，一套种草图等两周还接不上详情页",
    "pipeline": {
      "summary": "服装平铺提取→AI 试穿→一致性网格→详情页排版四段式流水线",
      "steps": [
        {
          "name": "抠取服装资产",
          "shortName": "服装"
        },
        {
          "name": "选定模特人设",
          "shortName": "模特卡"
        },
        {
          "name": "上身虚拟试穿",
          "shortName": "试穿"
        },
        {
          "name": "精修试穿质感",
          "shortName": "质感"
        },
        {
          "name": "拍齐九宫格",
          "shortName": "九宫格"
        },
        {
          "name": "排版详情页",
          "shortName": "详情页"
        },
        {
          "name": "适配分发尺寸",
          "shortName": "分发"
        }
      ]
    }
  },
  // ———— 短剧 ————
  {
    "id": "agent-shortdrama-visual-assets",
    "name": "剧本视觉化",
    "note": "剧本到视觉资产工业链：拆场→分镜→主演角色卡→CP剧照→竖屏海报，门禁层层放行",
    "domain": "shortdrama",
    "accent": "from-[#2B0A12] via-[#7A1F3D] to-[#D46A6E]",
    "glow": "#7A1F3D",
    "showcaseVideo": "/showcase/agent-templates/drama-visual-2.mp4",
    "showcaseImage": "/showcase/agent-templates/drama-visual-2.webp",
    "painPoint": "剧本到开拍全靠嘴对齐，导演脑补的和你不是同一部片",
    "pipeline": {
      "summary": "剧本拆场→锁构图分镜→主演角色资产→CP 剧照→竖屏海报的短剧视觉工业链",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "outputKind": "text"
        },
        {
          "name": "铸造主演资产",
          "shortName": "主演卡"
        },
        {
          "name": "锁定分镜",
          "shortName": "分镜",
          "outputKind": "text"
        },
        {
          "name": "3D 白模预演",
          "shortName": "预演",
          "outputKind": "director"
        },
        {
          "name": "渲染关键帧",
          "shortName": "关键帧"
        },
        {
          "name": "合成配音",
          "shortName": "配音",
          "outputKind": "audio"
        },
        {
          "name": "生成镜头视频",
          "shortName": "视频",
          "outputKind": "video"
        },
        {
          "name": "剪辑成片",
          "shortName": "成片",
          "outputKind": "video"
        },
        {
          "name": "产出投放物料",
          "shortName": "物料"
        }
      ]
    }
  },
  {
    "id": "agent-shortdrama-poster-line",
    "name": "投放海报线",
    "note": "短剧投放物料流水线：剧设锚定→主演海报→CP对戏图→信息流切片封面批量",
    "domain": "shortdrama",
    "accent": "from-[#0D1B3E] via-[#2E3A8C] to-[#7E6BD9]",
    "glow": "#2E3A8C",
    "showcaseVideo": "/showcase/agent-templates/drama-poster-2.mp4",
    "showcaseImage": "/showcase/agent-templates/drama-poster-2.webp",
    "painPoint": "投放封面靠从成片截图截到崩，一套物料跟不上日更投放",
    "pipeline": {
      "summary": "剧设视觉锚→主演海报→CP 对戏→信息流切片封面批量的投放物料链",
      "steps": [
        {
          "name": "锚定视觉基调",
          "shortName": "基调"
        },
        {
          "name": "提炼主演海报",
          "shortName": "海报"
        },
        {
          "name": "排布CP对戏图",
          "shortName": "对戏"
        },
        {
          "name": "切片封面批量",
          "shortName": "切片"
        },
        {
          "name": "生成变体测试包",
          "shortName": "变体"
        },
        {
          "name": "回流迭代风格",
          "shortName": "迭代",
          "outputKind": "text"
        },
        {
          "name": "锁定交付参数",
          "shortName": "参数"
        }
      ]
    }
  },
  // ———— 艺术 ————
  {
    "id": "agent-art-curation-series",
    "name": "策展式创作",
    "note": "主题到个展全链：情绪板→风格锚→成组作品→展陈主视觉，一致性当一等公民",
    "domain": "art",
    "accent": "from-[#2A1E5C] via-[#5E5AA8] to-[#A8C6E8]",
    "glow": "#5E5AA8",
    "showcaseVideo": "/showcase/agent-templates/art-curation-3.mp4",
    "showcaseImage": "/showcase/agent-templates/art-curation-3.webp",
    "painPoint": "系列作品画到第八张风格散架，个展始终立不起来",
    "pipeline": {
      "summary": "主题→情绪板→canonical key art 风格锚→成组作品→展陈主视觉的策展流水线",
      "steps": [
        {
          "name": "立意结构化",
          "shortName": "立意",
          "outputKind": "text"
        },
        {
          "name": "发散收情绪板",
          "shortName": "情绪板"
        },
        {
          "name": "铸风格锚",
          "shortName": "风格锚"
        },
        {
          "name": "锁定构图稿",
          "shortName": "构图稿"
        },
        {
          "name": "成组渲染",
          "shortName": "渲染"
        },
        {
          "name": "审计一致性",
          "shortName": "审计",
          "outputKind": "text"
        },
        {
          "name": "布置展陈主视觉",
          "shortName": "展陈"
        },
        {
          "name": "交付多规格",
          "shortName": "多规格"
        }
      ]
    }
  },
  {
    "id": "agent-art-style-immersion",
    "name": "风格深研线",
    "note": "艺术家风格深度内化流水线：解构→临摹对拍→变体矩阵→原创成组",
    "domain": "art",
    "accent": "from-[#4A3728] via-[#9C7A5B] to-[#E3C9A8]",
    "glow": "#9C7A5B",
    "showcaseVideo": "/showcase/agent-templates/art-style-2.mp4",
    "showcaseImage": "/showcase/agent-templates/art-style-2.webp",
    "painPoint": "风格迁移只学到滤镜皮，学不到艺术家观察世界的方式",
    "pipeline": {
      "summary": "风格解构→临摹对拍→变体矩阵→原创成组的风格内化流水线",
      "steps": [
        {
          "name": "采代表作",
          "shortName": "代表作"
        },
        {
          "name": "拆DNA",
          "shortName": "DNA"
        },
        {
          "name": "签解构表",
          "shortName": "解构表"
        },
        {
          "name": "拍临摹对照",
          "shortName": "临摹"
        },
        {
          "name": "跑变体矩阵",
          "shortName": "变体"
        },
        {
          "name": "试LoRA",
          "shortName": "LoRA",
          "outputKind": "text"
        },
        {
          "name": "做原创成组",
          "shortName": "原创"
        },
        {
          "name": "归档证物链",
          "shortName": "证物链"
        }
      ]
    }
  }
];
