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

/** 流水线单步蓝图：agent 按此推进多步生产。
 *  name 是卡面步骤链与画布节点标题共用的展示名：短中文动词开头（拆/锁/定/出），
 *  读起来像一条生产指令，不是术语堆叠——用户不该先学会黑话才能看懂卡。 */
export interface AgentPipelineStep {
  /** 步骤短名（行业黑话，如 Character Bible / Sketch-lock）。 */
  name: string;
  /** 环节短名（纯名字，2-3 字；圆环选择器/生成卡标题用）。 */
  shortName: string;
  /** 生成卡節點類型（2026-08-30）：該步產出的形態；缺省 image。
   *  與後端 novel_film 模板映射對齊：文本步=text、視頻步=video、配音=audio。
   *  2026-09-03 增 director：3D 白模预演步，生成卡鋪成導演台節點（CanvasNodeType.Director）。 */
  outputKind?: "image" | "text" | "video" | "audio" | "director";
  /** 该步的可落盘产物。 */
  deliverable: string;
  /** 上一步产出如何喂进来：JSON 注入 / cref 参考图 / sref 锚 / 门禁放行。 */
  inputFrom: string;
  /** 该步提示词与执行要点（含一致性技术）。 */
  promptNotes: string[];
  /** 品质门禁：验收什么、不达标怎么办；无门禁则为空。 */
  gate?: string;
  /**
   * 工具链要求（2026-08-25，2026-08-31 誠實稽核改真源）：该步真正可调用的 harness 工具。
   * 每个 id 必须存在於 harness 真实工具面（harness-tool-registry.ts 的
   * HARNESS_TOOL_IDS，真源 = VPS /opt/agent-harness/workspace/.opencode/tools/）；
   * unsupported=true 表示 harness 尚無 upstream，agent 須明說不可用，
   * 禁止用 prompt 冒充工具成功。
   */
  requiredTools?: AgentPipelineToolRequirement[];
}

/** 單步工具需求：輸入、輸出、門禁、能力邊界一次講清。 */
export interface AgentPipelineToolRequirement {
  id: string;
  input?: string;
  output?: string;
  gate?: string;
  unsupported?: boolean;
  requiredCapability?: string;
  canvasMetadata?: readonly string[];
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
  /**
   * 隱形引導詞（2026-08-25）：點卡後隨首條訊息的 system 欄位注入給 agent，
   * 用戶不可見、不進輸入框、不進 transcript。內容 = 這條流水線的正確跑法
   * 與對用戶的引導方式（先把缺的關鍵信息問齊，不要一上來就瘋狂生成）。
   */
  directive: string;
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
  // ———— 小说 ————,
{
    "id": "agent-novel-film-pipeline",
    "name": "小说影视化",
    "harnessTemplateId": "novel_film",
    "note": "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
    "domain": "novel",
    "accent": "from-[#1a1c23] via-[#3B2F4A] to-[#8B7355]",
    "glow": "#3B2F4A",
    "showcaseVideo": "/showcase/agent-templates/novel-film-2.mp4",
    "showcaseImage": "/showcase/agent-templates/novel-film-2.webp",
    "painPoint": "文本到分镜全靠人肉，断点在情绪连续性和角色漂移",
    "initialPrompt": "把我的小说影视化：（贴章节或写题材与主角），先拆结构化剧本，再锁角色和场景资产，最后出分镜关键帧，一步步来。",
    "directive": "用户刚从模板库点了「小说影视化」流水线，画布上已铺好 9 步 workflow（拆解剧本→建角色圣经→定美术圣经→锁定分镜→3D 白模预演→渲染关键帧→合成镜头视频→配音配乐→组装成片）。\n后端已注册对应模板：启动工作流时调用 workflow_start 传 template_id=\"novel_film\"（不要即兴拼节点）；其节点流覆盖 8 环，其中配音/成片两环后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这两环成功。\n正确跑法：先确认用户是否已贴小说文本——没有就用 question 工具一次问齐（题材/主角设定/篇幅），别催促也别瞎编。\n文本到手先只做第 1 步拆剧本，产出结构化场次表给用户过目；用户批准后才进角色资产，禁止一步跳到出图。\n每完成一步在画布对应节点回填产出，让用户看到流水线在走；卡在门禁就明说等什么，不装忙。\n进入「3D 白模预演」环节时调用 director_* 工具完成预演再继续后续步骤：先 director_get_state 了解状态，用 director_propose_plans 出方案并等用户确认，确认后用 director_manage_shot/director_upsert_action 细化走位与运镜。",
    "pipeline": {
      "summary": "小说文本→结构化剧本JSON→资产先行→锁构图分镜→成组关键帧的影视化流水线",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "deliverable": "结构化剧本 JSON（场次表 + 节拍 beat list + 台词表按 4.5 字/秒折算时长 + 每场钩子位标注 + 情绪曲线标注）+ 一页故事大纲",
          "outputKind": "text",
          "inputFrom": "用户输入/选题原稿结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "按「场」切分而非按章节：地点或时间变化即换场；每场提取起止拍、冲突点、情绪值（-5~+5）",
            "台词全部按 4.5 字/秒折算成秒数写进 JSON，后续分镜时长直接引用不重算",
            "每场标记钩子位（悬念/反转/情绪爆点），标注「留住观众的那一帧」候选",
            "输出同时给机器可读 JSON 和人可读一页大纲，方便用户快速批准"
          ],
          "gate": "剧本人工批准门禁：用户未确认大纲和场次表前，禁止进入任何视觉环节",
          "requiredTools": [
            {
              "id": "script_scene_parse",
              "input": "剧本原文",
              "output": "结构化场次表（场景/节拍/台词按 4.5 字/秒折算时长）"
            },
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "建角色圣经",
          "shortName": "角色卡",
          "deliverable": "角色圣经 JSON（每角色 DNA 签名 8 维：脸型/发型/瞳色/体型/服装/配饰/肤色/气质）+ 每角色三视图关键帧（正面/全身/侧面）",
          "inputFrom": "上一步「拆解剧本」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "DNA 签名 8 维逐项显式写死在提示词里，每个维度一个固定短语，后续所有镜头复用同一短语，禁止同义替换（换词=换脸）",
            "每角色生成三视图：正面特写、全身、侧面，锁定 face_identity 面部基线与 look_lock 造型（发型/服装/配饰）",
            "固定 seed 生成基准图，材质高光比例写进签名（金属×1.5、皮肤×0.5）防止质感漂移",
            "主要角色 2-5 个为宜，配角可合并建档；每个角色记录专属 seed 与参考图 ID 供全片引用"
          ],
          "gate": "角色三视图人工确认门禁：用户逐角色点头后才可进美术阶段（换脸是成片最大返工源）",
          "requiredTools": [
            {
              "id": "cast_asset_lock",
              "input": "角色名单 + 外观描述",
              "output": "角色三视图锁定卡（DNA 签名 + 专属 seed）"
            },
            {
              "id": "character_dna_turnaround",
              "input": "角色设定",
              "output": "角色三视图 + DNA 签名 8 维"
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
          "name": "定美术圣经",
          "shortName": "美术卡",
          "deliverable": "美术圣经 JSON（世界观关键词库 + 色板 + 光照方案 + 材质规范 + 每场景设定图 1-2 张）+ 统一风格参考图组",
          "inputFrom": "上一步「建角色圣经」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "风格提示词做成固定后缀模板（镜头语言+渲染质感+色板+光照），全片所有生图统一追加，等价于 sref 风格锁",
            "每张设定图用同一固定 seed 族生成，只变场景内容不变风格参数，肉眼比对风格漂移",
            "材质高光比例进规范：金属×1.5、皮肤×0.5，避免不同镜头忽油忽干",
            "场景设定图同时充当后续镜头生成的背景参考，建档编号"
          ],
          "gate": "风格统一性审计≥70 分：设定图组跑视觉审计（色彩方差/质感一致性/风格关键词命中），低于 70 分回去重修风格模板",
          "requiredTools": [
            {
              "id": "style_anchor_sref",
              "input": "风格参考图",
              "output": "风格锚（sref 级固定后缀模板）"
            },
            {
              "id": "style_dna_extract",
              "input": "代表作",
              "output": "风格 DNA 解构表（笔触/色板/构图）"
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
          "name": "锁定分镜",
          "shortName": "分镜",
          "deliverable": "分镜表 JSON（逐镜：景别/机位/运镜/时长取自台词折算/转场标记 J-cut 或 L-cut）+ 黑白 sketch-lock 线稿分镜板（低成本低分辨率先行）",
          "outputKind": "text",
          "inputFrom": "上一步「定美术圣经」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "sketch-lock 黑白先行：先用线稿/灰度图铺全部分镜验证构图与叙事节奏，构图错了重画线稿成本远低于重渲关键帧",
            "每镜写清摄影语言：景别（远全中近特）、机位角度、运镜（推拉摇移跟）、秒数=台词折算时长+反应拍",
            "情绪时序链排进镜头设计：「听见→停顿→眼神→表情→说话」，对手戏按此链拆反应镜头，不拍满面瘫对白",
            "转场预埋 J/L-cut：声音先入或延后，剪辑阶段直接按标记执行"
          ],
          "gate": "分镜人工批准门禁：sketch 板 + 分镜表给用户过目，确认节奏与构图后才准进关键帧渲染",
          "requiredTools": [
            {
              "id": "storyboard_qc_17",
              "input": "分镜表",
              "output": "17 项 QC 报告（通过/阻塞逐项）"
            },
            {
              "id": "sketch_lock",
              "input": "构图草稿",
              "output": "黑白线稿锁定（低成本验证构图）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "3D 白模预演",
          "shortName": "预演",
          "deliverable": "白模预演方案（逐镜分镜构图/运镜/走位，3D 白模时间线可回放）+ 用户确认过的镜头方案记录",
          "outputKind": "director",
          "inputFrom": "上一步「锁定分镜」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "先 director_get_state 了解导演台工程状态（已有元素/方案/镜头），再动其它 director 工具，不在空工程上盲写",
            "用 director_propose_plans 按分镜表出预演方案（构图/机位/走位），出完停在门禁等用户确认，未确认不落任何镜头动作",
            "确认后 director_apply_proposal 落方案，再用 director_manage_shot/director_upsert_action 逐镜细化走位与运镜，形成可回放的白模预演"
          ],
          "requiredTools": [
            {
              "id": "director_get_state",
              "input": "导演台工程",
              "output": "工程状态快照（元素/方案/镜头）"
            },
            {
              "id": "director_propose_plans",
              "input": "分镜表",
              "output": "预演方案候选（构图/机位/走位）"
            },
            {
              "id": "director_apply_proposal",
              "input": "用户选定的方案",
              "output": "已应用的镜头方案"
            },
            {
              "id": "director_manage_shot",
              "input": "镜头操作指令",
              "output": "镜头序列更新结果"
            },
            {
              "id": "director_upsert_action",
              "input": "走位/运镜动作",
              "output": "动作时间线更新结果"
            }
          ]
        },
        {
          "name": "渲染关键帧",
          "shortName": "关键帧",
          "deliverable": "逐镜头彩色关键帧 PNG（全镜头覆盖）+ 每镜首帧/尾帧双图（供 I2V 起止帧用）+ 失败镜头重渲记录",
          "inputFrom": "上一步「锁定分镜」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "每镜出首帧+尾帧两张：I2V 用起始帧定入场、结束帧定出场，运镜意图写进两帧差异里（如推镜=尾帧同构图放大）",
            "角色一致性三重锁：DNA 8 维短语原文复用 + 角色专属固定 seed + 三视图参考图；三者任一变动必须记录原因",
            "关键情绪帧优先精修：钩子位对应的镜头多出 2-3 候选帧，这是留住观众的帧",
            "同一镜头多候选时按视觉审计分排序择优，落选帧留档不删除"
          ],
          "gate": "逐镜一致性检查门禁：每镜关键帧与角色三视图比对（脸部/服装/配色），不一致镜头打回重渲，全镜头通过才进视频合成",
          "requiredTools": [
            {
              "id": "keyframe_render",
              "input": "分镜 + 角色锁定卡",
              "output": "逐镜关键帧（首帧/尾帧双图）"
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
          "name": "合成镜头视频",
          "shortName": "视频",
          "deliverable": "逐镜头视频片段 MP4（I2V 起止帧驱动）+ 镜头元数据（时长/分辨率/首尾帧缩略图）+ 失败重试记录",
          "outputKind": "video",
          "inputFrom": "上一步「渲染关键帧」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "I2V 双帧法：起始帧定构图入场，结束帧定落点，提示词只描述两帧之间的运动与情绪变化，不重复描述静态外观",
            "表演镜头按情绪时序链编排动作：「听见→停顿→眼神→表情→说话」，把链写进运动提示词让人物先反应后开口",
            "镜头间链式衔接：下一镜起始帧可引用上一镜尾帧（last-frame 链），保证动作连续场景不跳变",
            "单镜时长 3-8 秒为宜，超长镜头拆多段生成后拼接，避免运动幅度过大崩坏"
          ],
          "gate": "逐镜抽帧质检：每段视频抽首/中/尾 3 帧与关键帧比对，出现明显形变/闪帧/角色漂移即重生成",
          "requiredTools": [
            {
              "id": "last_frame_video_chain",
              "input": "关键帧首尾帧 + 镜头顺序",
              "output": "逐镜镜头视频链"
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
          "name": "配音配乐",
          "shortName": "配音",
          "deliverable": "逐镜头配音音轨（TTS 按台词表生成，语速对齐 4.5 字/秒折算时长）+ BGM 分段音轨（按情绪曲线标注定情绪与入出点）+ 音效点位表",
          "outputKind": "audio",
          "inputFrom": "上一步「合成镜头视频」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "TTS 语速严格对齐台词折算时长：超时则微调语速或申请镜头时长+0.5s，禁止配音和画面对不上",
            "BGM 按剧本情绪曲线分段：每段标注情绪值/入点/出点，转折点对齐钩子位，高潮段落情绪值拉满",
            "音效点位表逐镜列关键音效（脚步/开门/风声），与 J/L-cut 转场点对齐，声音先入或延后 0.5-1s",
            "对白镜头人声优先、BGM 自动 ducking 降 6dB，保证台词清晰"
          ],
          "gate": "音画对齐抽检：随机抽 3 个对白镜头核对人声时长与口型镜头时长偏差≤0.5s，超标回炉",
          "requiredTools": [
            {
              "id": "audio_first_timeline",
              "input": "台词表",
              "output": "配音时间轴（含时长锚点）"
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
          "name": "组装成片",
          "shortName": "成片",
          "deliverable": "成片 MP4（全镜头按时序拼接 + J/L-cut 转场执行 + 音轨混音）+ 字幕轨（SRT 按台词时间码）+ 封面帧 + 逐镜溯源表",
          "outputKind": "video",
          "inputFrom": "上一步「配音配乐」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "转场按分镜表预埋标记执行：J-cut 声音先入 0.5-1s、L-cut 画面先切声音延后，情绪戏优先 J/L-cut 硬切为辅",
            "节奏检查：钩子位前不留空拍，成片前 3 秒必须出现第一个钩子（短剧黄金 3 秒法则）",
            "混音三层分离：人声/BGM/音效独立轨道，最终响度对齐平台规范（如 -14 LUFS）",
            "交付时附逐镜溯源表：每镜关联的关键帧/seed/重渲次数，方便用户点名返工单镜"
          ],
          "gate": "出厂终检：成片完整播放一遍核对口型/字幕/响度/钩子位节奏，统计表随片交付；用户验收通过即归档全流水线资产",
          "requiredTools": [
            {
              "id": "editing_manifest",
              "input": "镜头清单",
              "output": "剪辑清单（ffmpeg/剪映引擎声明）"
            },
            {
              "id": "delivery_assets",
              "input": "成品清单",
              "output": "交付包 URI 清单（多格式）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        }
      ]
    },
    "slots": {
      "prompt": "（把这里换成你的小说题材与主角设定）影视概念关键帧，主角按角色圣经 DNA 签名锁定，黑白灰关系先行的构图，戏剧性光线时刻，情绪标签驱动画面节拍",
      "contextPrompt": "按剧本场景表生成的场景环境，影调与 canonical key art 对齐，光源方向统一",
      "composition": [
        "16:9 电影画幅，景别与机位按分镜切点包执行",
        "构图锚定 sketch-lock 草图，情绪焦点置视觉中心"
      ],
      "negativePrompt": "角色与 DNA 签名漂移，构图偏离锁定草图，光源方向打架，情绪断裂，风格脱离 key art",
      "styleTemplateId": "sai-cinematic",
      "qualityProfile": "print"
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
    "initialPrompt": "我的网文要整套 IP 视觉包：（写世界观与主角），先锁世界观风格锚，再出主角设定卡、名场面组图和封面主视觉。",
    "directive": "用户刚从模板库点了「IP视觉包」流水线，画布上已铺好 8 步 workflow（拆解世界观→炼情绪板→铸风格锚→建主角资产→绘名场面组图→造封面主视觉→出多画幅→铺衍生物料）。\n正确跑法：先问齐世界观关键词与主角设定（question 工具选择题优先），信息不足时不要凭空发挥基调。\n第 1 步只出一张定调 key art 给用户确认，锁定后才批量；后续每步沿用该锚，风格漂移要主动指出。\n封面按频道选构图（男频仰拍/女频留白），交付前留书名区；进度随时对着画布节点讲，一步一停。",
    "pipeline": {
      "summary": "网文 IP 立项视觉全案：风格锚先行→角色资产→名场面组图→封面与多画幅",
      "steps": [
        {
          "name": "拆解世界观",
          "shortName": "世界观",
          "deliverable": "世界观圣经结构化卡（色彩域 HEX + 材质表 + 3 个名场面候选）+ 可绘制元素清单",
          "outputKind": "text",
          "inputFrom": "用户输入/选题原稿结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "LLM 先抽取可绘制元素（场景/道具/名场面候选），再做情绪板与风格锚",
            "世界观色彩域与材质表字段化，作为全案检查基准"
          ],
          "gate": "世界观关键元素清单人工确认后才进情绪板",
          "requiredTools": [
            {
              "id": "world_bible_extract",
              "input": "小说文本",
              "output": "世界观 JSON（关键词库/地理/势力）"
            },
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "炼情绪板",
          "shortName": "情绪板",
          "deliverable": "3x3 情绪板 + 情绪坐标轴（题材频道定位）",
          "inputFrom": "上一步「拆解世界观」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "情绪板两轮制：第一轮发散、第二轮按立意收敛，锁定唯一方向",
            "色彩收敛到主色 3 HEX + 点缀 2 HEX，写死不允许漂移"
          ],
          "gate": "情绪板盲测门禁：拿给无关者猜题材频道，猜不对回炉重炼",
          "requiredTools": [
            {
              "id": "emotion_board_matrix",
              "input": "情绪关键词",
              "output": "情绪板矩阵图组"
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
          "name": "铸风格锚",
          "shortName": "风格锚",
          "deliverable": "canonical key art 一张（全案定调）+ sref 码/权重/seed 配方冻结",
          "inputFrom": "上一步「炼情绪板」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "key art 只出一张定调，不过关全组返工，绝不带病下行",
            "sref 权重测试法：0.4-0.7 区间逐档测，选风格命中最高档冻结"
          ],
          "gate": "风格锚配方复测门禁：同配方复测 2 次无偏差才算铸成",
          "requiredTools": [
            {
              "id": "style_anchor_sref",
              "input": "风格参考图",
              "output": "风格锚（sref 级固定后缀模板）"
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
          "name": "建主角资产",
          "shortName": "主角卡",
          "deliverable": "主角 DNA 签名 8 维表 + 三视图 + 表情差列 6 格",
          "inputFrom": "上一步「铸风格锚」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "DNA 签名逐字段写死，后续所有镜头复用同一短语，禁止同义替换",
            "三视图同一 seed 同一次生成，表情差列覆盖 IP 需要的主要情绪"
          ],
          "gate": "洗牌盲认门禁：三视图与表情列打乱后用户仍能认出同一角色",
          "requiredTools": [
            {
              "id": "character_dna_turnaround",
              "input": "角色设定",
              "output": "角色三视图 + DNA 签名 8 维"
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
          "name": "绘名场面组图",
          "shortName": "名场面",
          "deliverable": "3-5 张序列化分镜名场面（先 sketch-lock 黑白构图稿后成图）",
          "inputFrom": "上一步「建主角资产」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "序列内共享 DNA 全文 + 场景锚，5-6 条 prompt 做版面安排",
            "三景别节奏：全景建场→中景关系→特写爆点，镜头语言字段化"
          ],
          "gate": "并排零漂移门禁：组图并排后角色/风格零漂移才算过",
          "requiredTools": [
            {
              "id": "story_sequence_consistency",
              "input": "名场面清单 + 角色卡",
              "output": "序列图组（跨图一致性）"
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
          "name": "造封面主视觉",
          "shortName": "封面",
          "deliverable": "竖版封面主视觉 + 书名区留白版（男频仰拍/女频留白双构图）",
          "inputFrom": "上一步「绘名场面组图」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "顶部三分之一留书名区，人物占下半拉气势",
            "文字后排版：AI 乱码绝不出现在封面主视觉区"
          ],
          "gate": "主视觉人工批准后出多画幅适配版",
          "requiredTools": [
            {
              "id": "canonical_key_art_lock",
              "input": "风格锚 + 主体",
              "output": "主视觉锁定卡"
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
          "name": "出多画幅",
          "shortName": "多画幅",
          "deliverable": "封面多画幅包（3:4/1:1/9:16）+ 平台安全区核对清单（起点竖版/B 站 16:9 等）",
          "inputFrom": "上一步「造封面主视觉」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "每画幅重新构图而非裁切，书名区随画幅重排",
            "按平台规范核对分辨率与安全区，套检通过才交付"
          ],
          "gate": "多画幅套检门禁：任一画幅安全区/分辨率不达标即打回重排",
          "requiredTools": [
            {
              "id": "multi_aspect_reflow",
              "input": "主视觉",
              "output": "多画幅切图（横/竖/方）"
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
          "name": "铺衍生物料",
          "shortName": "物料",
          "deliverable": "头像/立绘/海报/Q 版表情包 + 归档（附 DNA 表与 sref 配方副本）",
          "inputFrom": "上一步「出多画幅」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "全部衍生物料从锁定资产派生，不做新设定",
            "归档附 DNA 表与 sref 配方副本，保证 IP 可续作"
          ],
          "gate": "归档完整性门禁：DNA 表/sref 配方/衍生物料三者齐备才算完成",
          "requiredTools": [
            {
              "id": "asset_provenance_archive",
              "input": "物料清单",
              "output": "证物链归档（来源/seed/版本）"
            },
            {
              "id": "multi_aspect_reflow",
              "input": "主视觉",
              "output": "多画幅切图（横/竖/方）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        }
      ]
    },
    "slots": {
      "prompt": "（把这里换成你的世界观与主角）世界观定调 key art，史诗尺度与人物气场的对比，色彩材质按世界观规范，情绪板标签驱动影调",
      "contextPrompt": "世界观核心场景，空间纵深与光位统一，为全案视觉立锚",
      "composition": [
        "16:9 定调画幅，视点拉远交代尺度",
        "唯一情绪锚点置光线引导的视觉中心"
      ],
      "negativePrompt": "风格脱离情绪板，光源方向打架，元素堆砌无重点，色彩规范外溢",
      "styleTemplateId": "sai-digital art",
      "qualityProfile": "print"
    }
  },
  // ———— 电商 ————,
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
    "initialPrompt": "我的新品要全套上市素材：（写商品与核心卖点），先锁产品资产，再依次出场景图、模特图、主视觉和多画幅批量。",
    "directive": "用户刚从模板库点了「新品上市包」流水线，画布上已铺好 8 步 workflow（锁产品→铺场景包→出模特图→出主视觉→排详情页→批量出画幅→放大精修→审终交付）。\n正确跑法：第 0 步先要商品原图或清晰描述——没有实物图就用 question 工具问齐品类/材质/logo 位置，绝不凭空捏造产品。\n出图直接走 image_generate 工具（会自动回填画布节点），不要用 bash/python 调外部 API。\n白底产品锁是全链根基：先出一张白底主图给用户确认形变与边缘，通过后才铺场景与模特。\n批量阶段换画幅重排而非裁切；每步产出回填画布节点，用户喊停就停在当前门禁。\n全程用简体中文与用户对话（镜像用户语言），不写繁体字。",
    "pipeline": {
      "summary": "白底产品锁→场景组→模特图→英雄主视觉→多画幅多 SKU 批量的电商素材流水线",
      "steps": [
        {
          "name": "锁产品",
          "shortName": "产品卡",
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
          "name": "铺场景包",
          "shortName": "场景包",
          "deliverable": "3 张情绪场景图（棚拍极简 / 生活方式实景 / 材质微距特写），各含自然光影与倒影",
          "inputFrom": "上一步「锁产品」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "ControlNet Canny 锁产品轮廓结构，防形变；IP-Adapter 注入抠图外观，保材质颜色",
            "每张场景图单独定义光照字段（方向/色温/强度），倒影与接触阴影必须落地，产品不悬浮",
            "变体一次只改一个变量：背景/机位/色板，不混改，保证可归因",
            "环境叙事贴用途：电商主图走极简棚拍，详情页走生活方式，种草内容走微距特写"
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
          "name": "出模特图",
          "shortName": "模特图",
          "deliverable": "2 张模特演绎图（全身场景 + 特写佩戴/使用），模特姿势可控、产品为视觉焦点",
          "inputFrom": "上一步「铺场景包」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "OpenPose 锁模特骨架姿势，Inpainting 只重绘穿戴/持握区域，不整图重生成",
            "IP-Adapter 产品权重调高，确保穿戴物即锁定的产品而非近似替代品",
            "模特人种/年龄/气质先问用户目标人群，一次定死全系列复用，保持人群一致性",
            "手部与产品接触点是翻车高发区，prompt 显式写 grip/接触细节"
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
          "name": "出主视觉",
          "shortName": "主视觉",
          "deliverable": "KV 主视觉 1 张（低机位逆光英雄构图）+ 负空间 CTA 版式 1 张（预留文案与按钮区）",
          "inputFrom": "上一步「出模特图」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "低机位仰拍 + 逆光轮廓光制造英雄感，前景产品、背景简洁分层",
            "负空间 CTA 版：画面留出 1/3 干净区域（左或右）给标题/卖点/按钮，禁止产品居中占满",
            "构图遵守最终投放宽高比先定再生成，不事后裁切毁构图",
            "视觉钩子前置：3 秒原则，第一眼看到的是产品+一个记忆点，不是环境氛围"
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
          "name": "排详情页",
          "shortName": "详情页",
          "deliverable": "详情页长图分镜 5-6 屏（痛点开场 → 产品亮相 → 细节特写 → 场景演绎 → 参数对比 → 信任背书收尾）",
          "inputFrom": "上一步「出主视觉」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "多图合成 + 文本叠加：每屏一个信息点，图文比例 7:3，字号在手机端不小于 24pt 等效",
            "细节特写屏调用微距场景图，参数对比屏用白底基准图，素材复用即一致性"
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
          "name": "批量出画幅",
          "shortName": "画幅",
          "deliverable": "全画幅矩阵：主图 1:1（≥2048）、详情横幅 3:1、社媒 9:16 与 1:1、Banner 16:9，全部重排而非裁切",
          "inputFrom": "上一步「排详情页」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "styleLock：固定 seed + 固定 prompt 骨架，仅替换 SKU 名称与 PRODUCT LOCK 段，多 SKU 风格像素级一致",
            "每个画幅按自身宽高比重排构图（产品位置/留白/视线引导重新设计），禁止中心裁切"
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
          "name": "放大精修",
          "shortName": "精修",
          "deliverable": "全交付图 ≥2048 短边（主图类可 4096 供印刷）+ 色彩管理统一 sRGB",
          "inputFrom": "上一步「批量出画幅」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "ESRGAN 上采样目标 ≥2048×2048，主图类可到 4096 供印刷，纹理材质区锐化不过冲",
            "放大后再查一次小字与标签：上采样偶尔把标签文字糊化，发现即回退重生成",
            "统一色彩管理：批量输出同一色彩空间（sRGB），避免各画幅色差"
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
          "name": "审终交付",
          "shortName": "交付",
          "deliverable": "上市素材包按渠道归档：主图组 / 场景组 / 模特组 / KV+CTA / 详情长图 / 社媒矩阵，附命名规范与使用索引",
          "outputKind": "text",
          "inputFrom": "上一步「放大精修」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "发布前 12 项终审：产品形状标签准确、无虚假 claim、无未授权第三方 logo、文字拼写、平台安全区、商用权",
            "命名规范内建：渠道_用途_SKU_画幅_序号，运营拿走即用不再改名",
            "使用索引注明每张图的投放位与替换建议，交付可直接上线的完整包"
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
    },
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
    "initialPrompt": "给（写商品，如针织开衫）做模特种草流水线：从平铺图提取服装，虚拟试穿出模特种草图，再拼一致性网格和详情页。",
    "directive": "用户刚从模板库点了「模特种草线」流水线，画布上已铺好 7 步 workflow（抠取服装资产→选定模特人设→上身虚拟试穿→精修试穿质感→拍齐九宫格→排版详情页→适配分发尺寸）。\n正确跑法：先要服装平铺原图；没有图先问（question 工具）商品品类与模特气质偏好，等信息齐了再动手。\n用户明确没有平铺图时：先说明虚拟试穿需真实服装图才能保证版型/颜色不跑偏，然后用 image_generate 按描述生成一张白底平铺参考图（回复中注明「依据文字描述生成的参考图，非实物图」），不要用 bash/python 调外部 API；参考图经用户确认后才进抠图与试穿。\n抠图边缘给用户过目后才试穿；试穿图锁同一模特脸与体型，形变不过就重生，别交糊图。\n九宫格与详情页节奏（钩子→卖点→细节→场景）对着画布节点推进，一步一确认。\n全程用简体中文与用户对话（镜像用户语言），不写繁体字。",
    "pipeline": {
      "summary": "服装平铺提取→AI 试穿→一致性网格→详情页排版四段式流水线",
      "steps": [
        {
          "name": "抠取服装资产",
          "shortName": "服装",
          "deliverable": "透明底服装平铺图（RMBG/BiRefNet 细带分割）+ 服装 DNA 卡（材质/版型/颜色/标签）+ 101% 回贴桩",
          "inputFrom": "用户平铺原图结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "RMBG/BiRefNet 抠图优于 SAM 的细带分割，边缘无残留光晕",
            "服装 DNA 卡锁材质/版型/颜色/标签，试穿阶段当产品锁",
            "101% 回贴桩：把原图回贴到干净底上人工比对，藏分割线"
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
          "name": "选定模特人设",
          "shortName": "模特卡",
          "deliverable": "模特人设矩阵（客群反推）+ IP-Adapter FaceID 面部基线锁定",
          "inputFrom": "上一步「抠取服装资产」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "客群反推模特矩阵：人种/年龄/气质一次定死全系列复用",
            "IP-Adapter FaceID + 固定 seed 锁身份，后续所有图同脸"
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
          "name": "上身虚拟试穿",
          "shortName": "试穿",
          "deliverable": "选定模特的试穿图组（正/侧/背，CatVTON/IDM-VTON 主通道）",
          "inputFrom": "上一步「选定模特人设」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "CatVTON/IDM-VTON 主通道 + OpenPose 姿势库，结构prompt 模板（CFG 6-8）",
            "只重绘穿戴区域，手部与产品接触点显式写 grip/接触细节",
            "「only one person」后缀防多人混入"
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
          "name": "精修试穿质感",
          "shortName": "质感",
          "deliverable": "精修试穿图（MeshGraphormer 手部修复 + ControlNet 分阶段强度 0.4→0.9）+ 面料物理检查",
          "inputFrom": "上一步「上身虚拟试穿」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "MeshGraphormer + scribble 手套防手指拉长",
            "ControlNet 分阶段强度（0.4→0.9），双 LoRA 思路锁面料与款式",
            "面料物理检查：垂坠/褶皱/透明度自然"
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
          "name": "拍齐九宫格",
          "shortName": "九宫格",
          "deliverable": "3x3 九宫格（远/中/近混排 + 统一影调，≥2048px）",
          "inputFrom": "上一步「精修试穿质感」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "IP-Adapter 锁脸批量出图，远/中/近混排",
            "统一影调：同一光照与色温，像真拍一套"
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
          "name": "排版详情页",
          "shortName": "详情页",
          "deliverable": "详情页长图分镜（钩子→卖点→细节→场景四段节奏，卖点必须有图内证据）",
          "inputFrom": "上一步「拍齐九宫格」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "四段节奏：钩子→卖点→细节→场景，每屏一个信息点",
            "卖点必须有图内证据：claim 与图中细节一一对应"
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
          "name": "适配分发尺寸",
          "shortName": "分发",
          "deliverable": "分发包：小红书 3:4 / 抖音 9:16 / 淘宝主图 1:1 五张（重排不重生）",
          "inputFrom": "上一步「排版详情页」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "每画幅重新构图而非裁切，文案区随画幅重排",
            "平台安全区与分辨率核对，套检通过才交付"
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
    },
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
    }
  },
  // ———— 短剧 ————,
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
    "initialPrompt": "把我的短剧剧本做成视觉资产包：（贴剧本或写剧情梗概与主演设定），按拆场→分镜→角色卡→CP剧照→竖屏海报走完。",
    "directive": "用户刚从模板库点了「剧本视觉化」流水线，画布上应铺好 9 步 workflow（拆解剧本→铸造主演资产→锁定分镜→3D 白模预演→渲染关键帧→合成配音→生成镜头视频→剪辑成片→产出投放物料）；若画布为空，按同样步骤用工作流工具分步搭建，不套用无关模板。\n以下纪律必须遵守，违反即流程错误：\n1. 全程用简体中文回复用户（含卡片文案与画布节点标签），不用繁体；对用户说话不出现内部黑话（feature_film、sref/cref、higgsfield 等），一律大白话。\n2. 用户没给剧本/梗概时，第一轮必须用 question 工具一次问齐（剧本或梗概、主演数量与设定、基调，附可选选项），禁止用纯文字列问题，禁止在信息齐前启动任何生成。\n3. 剧本批准前禁止任何出图：拆解剧本产出结构化场次表后，先用中文向用户展示要点，再用 question 工具停在门禁请用户批准（选项：批准/修改）；批准后才允许生成人物资产。\n4. 主演三视图与 DNA 签名出图后再次停在门禁：用 question 工具请用户确认主演资产，确认前禁止进分镜、禁止批量出图。\n5. 竖屏 9:16 节奏每段≤15s，情绪时序链（听见→停顿→眼神→表情→说话）写进分镜字段；每步产出回填画布节点，一步一确认，不擅自跳步。\n6. 进入「3D 白模预演」环节时调用 director_* 工具完成预演再继续后续步骤：先 director_get_state 了解状态，用 director_propose_plans 出方案并等用户确认，确认后用 director_manage_shot/director_upsert_action 细化走位与运镜。",
    "pipeline": {
      "summary": "剧本拆场→锁构图分镜→主演角色资产→CP 剧照→竖屏海报的短剧视觉工业链",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "deliverable": "结构化场次 JSON（每场：场景/人物/道具/服装/情绪拍点/钩子位）+ 按角色聚合的台词本（每句标 TTS 音色与语速）",
          "outputKind": "text",
          "inputFrom": "用户剧本文本结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "场次拍点化：动作与台词交替成拍，台词时长按 4.5 字/秒确定性折算，每集总时长反推拍数",
            "前 3 拍冷开场兑现钩子是硬门：第 1 拍必须抛冲突，不许铺垫超过 10 秒",
            "台词本按角色聚合并带音色提示词，直接对接 TTS，不许后期再对一次角色名",
            "资产清单当场去重：同名人物/场景合并为单一实体，为一致性资产库打地基"
          ],
          "gate": "剧本人工批准：用户逐场确认或整体批准后才允许生成任何人物图；拒绝则带理由回流重写，禁止自动越门",
          "requiredTools": [
            {
              "id": "script_scene_parse",
              "input": "剧本原文",
              "output": "结构化场次表（场景/节拍/台词按 4.5 字/秒折算时长）"
            },
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "铸造主演资产",
          "shortName": "主演卡",
          "deliverable": "每位主演的角色设定集：正/侧/背三视图 + 面部与服装的 DNA 签名描述串 + 情绪九宫格 + 道具状态变体",
          "inputFrom": "上一步「拆解剧本」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "三视图同一 seed 同一次生成，DNA 签名串写进每次出图 prompt 首行——一致性靠「固定 seed + 特征串复述」双保险，不靠运气",
            "场景设定图给一致性锚点（固定机位参照物）+ 尺度参照（门高/桌高），出无人无手白底图，避免手部崩坏污染资产",
            "情绪九宫格必须覆盖本剧情绪拍点表里出现过的所有情绪，后续 I2V 表情靠它当参考图",
            "道具要出「状态变体」：崭新/破损/血渍，剧情里道具变形时直接换图不换描述"
          ],
          "gate": "人物批准：主演三视图 + DNA 签名经用户确认后才进分镜；单角色可单独重铸不推倒全部",
          "requiredTools": [
            {
              "id": "cast_asset_lock",
              "input": "角色名单 + 外观描述",
              "output": "角色三视图锁定卡（DNA 签名 + 专属 seed）"
            },
            {
              "id": "character_dna_turnaround",
              "input": "角色设定",
              "output": "角色三视图 + DNA 签名 8 维"
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
          "name": "锁定分镜",
          "shortName": "分镜",
          "deliverable": "逐场分镜表：段（一次生成 ≤15 秒）→ 镜（每镜 2-5 秒硬门）→ 每镜 9:16 构图描述 + 机位（正打/反打/过肩）+ 转场标记",
          "outputKind": "text",
          "inputFrom": "上一步「铸造主演资产」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "9:16 竖屏原生构图：主体占画面 2/3，头顶留 8% 安全区（字幕位），每段 ≤15 秒是生成模型硬上限，超了必拆",
            "正反打成对出：A 视角镜头与 B 视角镜头的视线方向、轴线、背景必须互为镜像，一次生成一对防跳轴",
            "每镜标切点时刻并逐字对账：镜头时长 = 台词字数 ÷ 4.5 + 表演留白，听见→停顿→眼神→表情→说话的情绪时序链在分镜表里就写死",
            "分镜只做输出不做新决定：叙事决定全部在剧本阶段做完，分镜阶段发现的坑记录为剧本批注回流，不擅自改戏"
          ],
          "gate": "17 道分镜质量门全过：段≤15s/镜 2-5s/9:16/正反打成对/轴线连续/切点-台词对账/钩子位前置/资产引用完整/情绪链完整/无手部特写缺失预案/转场标记齐备",
          "requiredTools": [
            {
              "id": "storyboard_qc_17",
              "input": "分镜表",
              "output": "17 项 QC 报告（通过/阻塞逐项）"
            },
            {
              "id": "sketch_lock",
              "input": "构图草稿",
              "output": "黑白线稿锁定（低成本验证构图）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "3D 白模预演",
          "shortName": "预演",
          "deliverable": "白模预演方案（逐镜分镜构图/运镜/走位，3D 白模时间线可回放）+ 用户确认过的镜头方案记录",
          "outputKind": "director",
          "inputFrom": "上一步「锁定分镜」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "先 director_get_state 了解导演台工程状态（已有元素/方案/镜头），再动其它 director 工具，不在空工程上盲写",
            "用 director_propose_plans 按分镜表出预演方案（构图/机位/走位），出完停在门禁等用户确认，未确认不落任何镜头动作",
            "确认后 director_apply_proposal 落方案，再用 director_manage_shot/director_upsert_action 逐镜细化走位与运镜，形成可回放的白模预演"
          ],
          "requiredTools": [
            {
              "id": "director_get_state",
              "input": "导演台工程",
              "output": "工程状态快照（元素/方案/镜头）"
            },
            {
              "id": "director_propose_plans",
              "input": "分镜表",
              "output": "预演方案候选（构图/机位/走位）"
            },
            {
              "id": "director_apply_proposal",
              "input": "用户选定的方案",
              "output": "已应用的镜头方案"
            },
            {
              "id": "director_manage_shot",
              "input": "镜头操作指令",
              "output": "镜头序列更新结果"
            },
            {
              "id": "director_upsert_action",
              "input": "走位/运镜动作",
              "output": "动作时间线更新结果"
            }
          ]
        },
        {
          "name": "渲染关键帧",
          "shortName": "关键帧",
          "deliverable": "每镜起始帧（0.00 秒主图）+ 镜内切点子帧图 + 主演 CP 剧照（情绪高潮位双人构图）+ 每场色调参照帧",
          "inputFrom": "上一步「锁定分镜」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "I2V 起始结束帧双锁：起帧 = 本镜起始帧，尾帧 = 下一镜起始帧（或本镜切点子帧），首尾帧锁定后镜头间才不跳变",
            "参考图权重分层：DNA 签名串放 prompt 首行，三视图控制脸部，场景锚点图控制背景，材质高光比例写死（如「缎面高光 30%/皮肤 60%」）",
            "CP 剧照选情绪拍点表最高分位生成，构图学海报：双人视线引导线交叉，留投放标题位",
            "关键帧出图后立刻与三视图并排比对，脸部相似度肉眼不过关当场重roll，不带病进视频"
          ],
          "requiredTools": [
            {
              "id": "keyframe_render",
              "input": "分镜 + 角色锁定卡",
              "output": "逐镜关键帧（首帧/尾帧双图）"
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
          "name": "合成配音",
          "shortName": "配音",
          "deliverable": "全剧旁白与台词音轨：按角色聚合的 TTS 成片音频（每句独立文件带时长戳）+ BGM 情绪段标记表（进场/退场秒点）+ 音效点位表",
          "outputKind": "audio",
          "inputFrom": "上一步「渲染关键帧」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "语速锁 4.5 字/秒：TTS 输出实测时长与台词预折算时长偏差 >10% 的句子单独调语速重出，不许后期硬拉伸（会破音）",
            "情绪时序链的「听见→停顿」段落在音轨侧体现：台词间留白 = 表演留白时长，停顿本身是戏，不许压缩",
            "每个角色全剧用一个音色 ID + 固定 seed，跨集不变声；群杂用次要音色池防串音",
            "音频先行于视频：先锁音轨时长，视频段时长向音轨对齐，而不是反过来"
          ],
          "requiredTools": [
            {
              "id": "audio_first_timeline",
              "input": "台词表",
              "output": "配音时间轴（含时长锚点）"
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
          "name": "生成镜头视频",
          "shortName": "视频",
          "deliverable": "每镜一段竖屏原生视频（9:16，I2V），按 shot_order 命名的片段序列 + 失败镜头重试清单",
          "outputKind": "video",
          "inputFrom": "上一步「合成配音」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "竖屏原生模型优先（Seedance/Kling/MiniMax 竖屏模式），不要横屏出图再裁——裁切会毁构图安全区与主体占比",
            "情绪时序链写进视频 prompt 的时间轴：0s 听见（微转头）→0.5s 停顿（静止）→1s 眼神（看向对方）→1.5s 表情（起情绪）→2s 开口",
            "镜头间连续性用首尾帧链：本镜尾帧 = 下镜首帧（last_frame_url 链式生成），对话正反打共享同一背景帧",
            "运动指令一镜一动词：推/拉/摇/跟/固定，复合运动会糊；单镜时长贴分镜表 2-5 秒，不贪长"
          ],
          "requiredTools": [
            {
              "id": "last_frame_video_chain",
              "input": "关键帧首尾帧 + 镜头顺序",
              "output": "逐镜镜头视频链"
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
          "name": "剪辑成片",
          "shortName": "成片",
          "deliverable": "每集成片视频（9:16，含字幕/音轨/BGM 混音）+ 剪映可继续编辑的草稿工程",
          "outputKind": "video",
          "inputFrom": "上一步「生成镜头视频」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "J-cut/L-cut 情绪剪辑：下一镜声音先入 0.3-0.5 秒再切画面（J-cut），或画面先走声音拖尾（L-cut），对话戏与情绪转折戏优先",
            "台词字幕逐字对齐 TTS 时间戳，字号占屏宽 8%/底部安全区，竖屏字幕最多两行",
            "每集成片时长回归剧本折算目标（±10%），超了先剪空镜与留白，不剪台词",
            "导出双轨：成片 mp4 交付 + 剪映草稿工程（字幕/配音/节奏/转场全部可继续编辑）"
          ],
          "gate": "成片验收：用户看片尾通过或标出秒点问题位；通过前不批量生成后续集",
          "requiredTools": [
            {
              "id": "editing_manifest",
              "input": "镜头清单",
              "output": "剪辑清单（ffmpeg/剪映引擎声明）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "产出投放物料",
          "shortName": "物料",
          "deliverable": "每集投放包：竖屏封面图 3 张（钩子位/CP 剧照/反转位各一）+ 15 秒竖屏切片预告（钩子前置版）+ 标题-简介文案",
          "inputFrom": "上一步「剪辑成片」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "封面标题位预留在上 1/3（9:16 信息流首屏只露上半），人物脸部 + 冲突元素必现，纯氛围图点击率必死",
            "15 秒预告结构：0-3s 冲突钩子（从第 1 拍抽）→3-12s 悬念升级（正反打快剪）→12-15s 断崖卡点留悬念，不剧透反转",
            "文案 A/B/C 同钩子不同角度写（冲突直给/悬念提问/身份反差），配对应封面组测投",
            "全部物料标注来源集数与镜头号，回流资产库可复用"
          ],
          "requiredTools": [
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
    },
    "slots": {
      "prompt": "（把这里换成你的剧情与主演设定）短剧分镜概念图，黑白构图稿先行，9:16 竖屏镜头语言，角色按 DNA 签名锁定，情绪节拍推进清晰",
      "contextPrompt": "剧情关键场景示意，箭头标注运动方向，关键格加重明暗对比",
      "composition": [
        "竖屏分镜表 6-8 格，每格标景别与正反打",
        "格间留白分隔，动作方向可读"
      ],
      "negativePrompt": "角色 DNA 漂移，成品上色插画感，镜头语言混乱，动作方向不明，正反打构图飘",
      "styleTemplateId": "sai-comic book",
      "qualityProfile": "draft"
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
    "initialPrompt": "给我的短剧做投放物料流水线：（写剧设与主演形象），先锁视觉基调，再出主演海报、CP对戏图和信息流切片封面批量。",
    "directive": "用户刚从模板库点了「投放海报线」流水线，画布上应铺好 7 步 workflow（锚定视觉基调→提炼主演海报→排布CP对戏图→切片封面批量→生成变体测试包→回流迭代风格→锁定交付参数）；若画布为空，按同样步骤用工作流工具分步搭建，不套用无关模板。\n以下纪律必须遵守，违反即流程错误：\n1. 全程用简体中文回复用户（含卡片文案与画布节点标签），不用繁体；对用户说话不出现内部黑话（sref/cref、higgsfield 等），一律大白话。\n2. 用户没给剧设/主演时，第一轮必须用 question 工具一次问齐（剧设梗概、基调给选项：雨夜霓虹/豪门金调/古风等、主演形象关键词），禁止用纯文字列问题，禁止在信息齐前启动任何生成。\n3. 第一张 key art 出图后必须停在门禁：用 question 工具请用户锁定基调（选项：锁定，继续批量/调整基调），锁定前禁止出后续任何图。\n4. 生图只用 image_generate 工具，禁止用 bash/curl 调生图接口；所有投放物料一律竖版 9:16（如 1024x1536 竖构图），禁止横版。\n5. 基调锁定后按画布 7 步逐张推进：主演海报→CP对戏图→切片封面批量（按切片剧情对位情绪标签），海报字效不得遮脸，安全区检查过才交付；一步一确认，产出回填画布节点。",
    "pipeline": {
      "summary": "剧设视觉锚→主演海报→CP 对戏→信息流切片封面批量的投放物料链",
      "steps": [
        {
          "name": "锚定视觉基调",
          "shortName": "基调",
          "deliverable": "剧设 key art 主视觉 1 张（竖版 9:16）+ 色彩情绪规范 JSON（主色/辅色/对比度/光效方向/情绪关键词）",
          "inputFrom": "用户剧设文本结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "key art 定调：一张图锁全剧气质，后续所有物料以它为 sref 风格锚（--sref 权重最高）",
            "色彩情绪规范写成机器可读 JSON：主色 HEX、辅色、布光模式（明暗对照 chiaroscuro / 伦勃朗光）、情绪标签，供下游步骤引用",
            "上游借鉴 shuohao-skills 美术设定集思路：锚点 + 变体 + 尺度参照，无人无手纯净定调",
            "规范 JSON 与 key art 同步冻结，后续步骤禁止漂移"
          ],
          "gate": "色彩规范 JSON 字段齐全（含 HEX/光效/情绪词各≥2），key art 与剧名题材气质对位，否则重出",
          "requiredTools": [
            {
              "id": "style_dna_extract",
              "input": "key art/参考图",
              "output": "风格 DNA 解构表（笔触/色板/构图）"
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
          "name": "提炼主演海报",
          "shortName": "海报",
          "deliverable": "主演海报 2 版：气场版（单人立势压场）| 情绪版（面部特写情绪爆点），各 1 张 9:16",
          "inputFrom": "上一步「锚定视觉基调」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "主演 DNA 锚：主演设定图作 cref（--cref 高权重），跨张保持五官/发型/服装一致",
            "气场版：低角度仰拍 + 明暗对照布光，人物占画面 2/3，气场压过背景",
            "情绪版：面部特写 + 眼神光，情绪对应剧本最大爽点/虐点，供 A/B 对比",
            "背景色只从规范 JSON 取色，禁止自创配色"
          ],
          "gate": "两版五官一致性肉眼比对通过（同一个人）；取色全部落在规范 JSON 色板内",
          "requiredTools": [
            {
              "id": "canonical_key_art_lock",
              "input": "风格锚 + 主演形象设定",
              "output": "主演海报锁定卡（气场/情绪双版）"
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
          "name": "排布CP对戏图",
          "shortName": "对戏",
          "deliverable": "CP 对戏图 3 张：对视版 | 逼近版 | 拉扯版（三级张力递进，供投放 A/B 测试）",
          "inputFrom": "上一步「提炼主演海报」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "三级张力构图：对视=对称站位视线相交；逼近=不对称构图一方侵入另一方空间；拉扯=肢体接触+动态失衡+衣发飘动",
            "双 cref 同时挂载，主体与配角权重区分（主 0.9 / 配 0.6），防止脸糊",
            "张力靠肢体语言与负空间表达，不靠夸张表情；背景光效沿 key art 明暗对照方向",
            "三版对应三档投放钩子（甜/虐/爽），出图时打好情绪标签"
          ],
          "gate": "三级张力肉眼可辨递进；双主演脸不互串（cref 各归各位）；不合格单张重出不整批重跑",
          "requiredTools": [
            {
              "id": "story_sequence_consistency",
              "input": "对戏构图清单 + 主演锁定卡",
              "output": "对戏序列图组（张力递进 + 跨图一致性）"
            },
            {
              "id": "image_edit",
              "input": "原图 URL + 改图描述",
              "output": "修改后图片 URL"
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
          "name": "切片封面批量",
          "shortName": "切片",
          "deliverable": "信息流切片封面 6-9 张（9:16）：剧名安全区模板 + 每张对应一个切片剧情点 + 情绪标签对位表",
          "inputFrom": "上一步「排布CP对戏图」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "批量 styleLock：全批固定 seed + 同一 sref 权重组合，只换主体动作与场景词，保证风格零漂移",
            "剧名安全区：顶部 15% 与底部 20% 留白（平台 UI/剧名条遮挡区），主体脸与手不进安全区",
            "情绪标签与切片剧情对位：每张封面=该集最强情绪帧（打脸/反转/告白），标签写入文件名",
            "上游借鉴 Jellyfish readiness 思路：批量前逐张 pre-check（构图/角色/安全区）再生成，减少废图"
          ],
          "gate": "安全区检查：9:16 内剧名区/平台 UI 区无关键元素入侵；固定 seed 抽查 3 张风格一致；切片情绪标签与剧情点一一对位",
          "requiredTools": [
            {
              "id": "shot_grid_batch",
              "input": "主演海报 + 切片剧情点清单",
              "output": "切片封面批量图组（剧名安全区版）"
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
          "name": "生成变体测试包",
          "shortName": "变体",
          "deliverable": "投放 A/B 变体包：同一封面底图的 3 类钩子变体（钩子文案位上/中/下 | 花体字效版式 2-3 款 | 大字报冲击版），共 6-9 张",
          "inputFrom": "上一步「切片封面批量」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "单变量原则：每个变体只改一个维度（文案位 或 字效 或 底图），保证 A/B 数据可归因",
            "花体字效：书法体/描边/立体阴影只落在安全区内，字效不得遮脸（遮脸检查是门禁）",
            "钩子文案位：上（标题党）/中（情绪共鸣）/下（悬念留白）三档，对应不同人群心理",
            "变体命名规则：底图ID_文案位_字效ID，便于回流数据对位"
          ],
          "gate": "字效遮脸检查：所有文字与字效不覆盖演员面部关键区；变体命名规则完整可追溯",
          "requiredTools": [
            {
              "id": "style_aligned_batch",
              "input": "风格锚 + 清单",
              "output": "成组渲染（风格对齐批量）"
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
          "name": "回流迭代风格",
          "shortName": "迭代",
          "deliverable": "数据回流迭代报告：高点击封面风格特征提炼（构图/色温/张力级别/文案位）+ 下一批次的 styleLock 参数更新建议",
          "outputKind": "text",
          "inputFrom": "上一步「生成变体测试包」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "归因拆解：按单变量命名拆出文案位/字效/张力级别各自的 CTR 贡献，不混判",
            "把赢家特征回写成色彩规范 JSON 的增量字段（如 winner_张力=拉扯、winner_文案位=上），下次批量直接继承",
            "上游借鉴 shuohao-skills「大纲收敛结构、下游不做新决定」：回流只改参数层，不改 key art 锚，风格根稳定",
            "日更节奏：回流报告轻量化，只更新参数不重开流水线"
          ],
          "gate": "每条迭代建议都能追溯到具体变体 ID 的 CTR 数据，无数据支撑的猜测标记为待验证",
          "requiredTools": [
            {
              "id": "outlier_audit_regenerate",
              "input": "变体测试包 + 投放数据",
              "output": "赢家/离群审计报告 + 参数更新建议"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "锁定交付参数",
          "shortName": "参数",
          "deliverable": "投放物料交付包：全量物料按平台规格归档（9:16 主图 + 变体包 + 情绪标签对位表）+ 可复用 styleLock 参数卡（sref/cref/seed/色板 JSON）",
          "inputFrom": "上一步「回流迭代风格」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "参数卡沉淀：key art sref ID、主演 cref ID、固定 seed、色板 JSON 打包为 styleLock 卡，下部剧换皮不换骨架",
            "上游借鉴 ArcReel「可审核可中断」：交付前出单页总览（张数/规格/门禁通过状态），用户验收后再归档",
            "日更续产：切片剧情点清单换新一批，参数卡不动，直接回到第四步批量，形成日更闭环"
          ],
          "gate": "全量门禁复核：安全区检查 + 字效遮脸检查 100% 通过；参数卡字段齐全可被机器读取",
          "requiredTools": [
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        }
      ]
    },
    "slots": {
      "prompt": "（把这里换成你的剧设与主演）短剧竖屏海报，电影写实质感按 key art 影调，主演半身特写气场全开，明暗对照布光，情绪张力直给",
      "contextPrompt": "剧情强相关场景暗示（雨夜天台/豪门客厅），背景压暗突出人物",
      "composition": [
        "竖版 9:16，主角占画面 60% 靠下，低机位仰拍",
        "顶部留剧名与花体字效位，字效不遮脸"
      ],
      "negativePrompt": "群演乱入，表情呆滞，文字乱入，字效遮脸，平光游客照，影调脱离 key art",
      "styleTemplateId": "sai-cinematic",
      "qualityProfile": "balanced"
    }
  },
  // ———— 艺术 ————,
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
    "initialPrompt": "以（写你的主题，如潮汐与遗忘）做策展式创作：先出情绪板和风格锚定，再出成组作品，最后出展览主视觉。",
    "directive": "用户刚从模板库点了「策展式创作」流水线，画布上已铺好 8 步 workflow（立意结构化→发散收情绪板→铸风格锚→锁定构图稿→成组渲染→审计一致性→布置展陈主视觉→交付多规格）。请沿用这套泳道，用 canvas_apply_ops 把每步产出回填到对应节点，不要另起炉灶重建结构。\n正确跑法：主题只有一个关键词也够——先出 4-6 张情绪板让用户挑方向（question 工具带选项），别问论文级调研问题。\n全程用简体中文思考和回复；每步开始先用一句话告诉用户这一步在做什么、需要他做什么，再动手，不要只默默发卡片。\n生图要一张一张来：先用中文说清这张是什么，再调用 image_generate（会弹扣费确认卡，等用户批准）——出图后简述结果再继续下一张；严禁并行堆叠多个 image_generate，严禁未批准就连发。尺寸只用平台支持规格（1024x1024 / 1536x1024 / 1024x1536），不要自造尺寸导致生成失败。\n风格锚 key art 锁定后全系列对表：色盘/笔触/留白节奏统一，outlier 张主动指出并重生。\n成组作品先草图锁构图再上色；展陈主视觉留白即格调，交付节奏对着画布走。",
    "pipeline": {
      "summary": "主题→情绪板→canonical key art 风格锚→成组作品→展陈主视觉的策展流水线",
      "steps": [
        {
          "name": "立意结构化",
          "shortName": "立意",
          "deliverable": "主题关键词 JSON（题材/时代/情绪/冲突各 3-5 词）+ 一句话策展立意（这个展主张什么）+ 目标观众与展览调性",
          "outputKind": "text",
          "inputFrom": "用户主题描述结构化为 JSON 注入；本步产物即全链首个资产",
          "promptNotes": [
            "先问用户：这个展想让人记住哪一句话？立意先于一切画面",
            "关键词分四层字段化：题材层/视觉层/情绪层/观念层，禁止混杂",
            "立意写成可陈述句而非名词堆砌，例：『城市的孤独在霓虹下更亮』"
          ],
          "gate": "策展立意必须是一句可陈述的主张句；关键词 JSON 四层字段齐全才放行",
          "requiredTools": [
            {
              "id": "moodboard_diverge_converge",
              "input": "主题词",
              "output": "情绪板（发散→收敛）"
            },
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "发散收情绪板",
          "shortName": "情绪板",
          "deliverable": "情绪板一组（9-12 格参考图）+ 三类字段化标签：色彩（主色 3 + 点缀色 2，HEX 值）、材质（如哑光颗粒/丝绸）、情绪词",
          "inputFrom": "上一步「立意结构化」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "两轮制：第一轮纯发散（每层关键词各搜一轮），第二轮按策展立意砍掉一半以上",
            "每格参考图必须打上三类标签，无标签的图不进板",
            "色彩收敛到唯一方向：主色 3 个 HEX + 点缀 2 个，写死不允许漂移"
          ],
          "gate": "色彩/材质/情绪三类标签齐备且已收敛为唯一方向；存在两套打架的主色即打回",
          "requiredTools": [
            {
              "id": "emotion_board_matrix",
              "input": "情绪关键词",
              "output": "情绪板矩阵图组"
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
          "name": "铸风格锚",
          "shortName": "风格锚",
          "deliverable": "canonical key art 一张（全展定调之作）+ style DNA 文字描述（笔触/光源/构图法则/渲染质感）",
          "inputFrom": "上一步「发散收情绪板」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "key art 只出一张定调，这张不过关全组返工，绝不带病下行",
            "style DNA 描述四个维度：笔触肌理、光源法则（方向/硬度/色温）、构图法则、渲染质感",
            "key art 定稿后锁定为 sref / 风格参考锚，成组阶段所有图共用此锚",
            "prompt 里显式写『本作为本展 canonical key art，气质 = 立意句』"
          ],
          "gate": "key art 与 style DNA 互证：拿描述反查画面，四个维度全部可指认才算铸成",
          "requiredTools": [
            {
              "id": "style_anchor_sref",
              "input": "风格参考图",
              "output": "风格锚（sref 级固定后缀模板）"
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
          "name": "锁定构图稿",
          "shortName": "构图稿",
          "deliverable": "全组每张的黑白构图稿（thumbnail sketch）+ 统一呼吸感说明（留白占画面比例区间、视线动线走向）",
          "inputFrom": "上一步「铸风格锚」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "sketch-lock：每张先出纯黑白构图稿，色彩完全后置，只谈黑白灰分布与视觉重量",
            "统一呼吸感：全组留白占比定一个区间（如 30%-45%），张与张之间留白节奏差异不超过一档",
            "规划观展动线：把 5-6 张构图按起承转合排序，开场留白最足、高潮密度最高（StoryDiffusion 实测 5-6 条 prompt 布局）",
            "每张构图稿标注：主体位置九宫格坐标 + 视觉焦点数（1-2 个，不超）"
          ],
          "gate": "黑白稿并排时留白节奏统一、视觉焦点不超标；任一张黑白灰关系跳脱全组即重画该张",
          "requiredTools": [
            {
              "id": "sketch_lock",
              "input": "构图草稿",
              "output": "黑白线稿锁定（低成本验证构图）"
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
          "name": "成组渲染",
          "shortName": "渲染",
          "deliverable": "成组彩色成稿 5-6 张（全组同 seed 域、同风格锚）",
          "inputFrom": "上一步「锁定构图稿」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "StyleAligned 注意力共享：全组同 batch 生成，去噪早期步共享 self-attention 的 Q/K，让各张在风格层互相校准",
            "共享强度调平衡：注意力共享太少风格不一致，太多图像趋同——早期步共享、后期步放任自采，保布局差异",
            "固定 seed 策略：全组共用同一 seed 基准，保证色彩系统与笔触基因同源",
            "逐张对表：每张成稿出来立即对照 style DNA 四维 + 色板 HEX，不对表不进组"
          ],
          "gate": "全组并排：色温一致、光源方向一致、笔触密度目测同级；两张放在一起像同一个展的作品才算过",
          "requiredTools": [
            {
              "id": "style_aligned_batch",
              "input": "风格锚 + 清单",
              "output": "成组渲染（风格对齐批量）"
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
          "name": "审计一致性",
          "shortName": "审计",
          "deliverable": "一致性审计表（每张的色盘偏离度、笔触密度、留白占比数值）+ outlier 张重生命令清单",
          "outputKind": "text",
          "inputFrom": "上一步「成组渲染」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "色盘审计：逐张提取主色 HEX，与锁定的 3 主色 + 2 点缀比对，色相偏移超阈值即标记 outlier",
            "笔触密度审计：统计画面纹理/笔触覆盖密度，与 key art 基准比对，密度差超一档即标记",
            "outlier 只重生标记张，不带病重跑全组：重生时沿用同 seed 域 + 同风格锚 + 同黑白构图稿",
            "审计不过的张退回上一步的构图稿，检查是否构图本身引入了不可救的偏离"
          ],
          "gate": "全组零 outlier：每张色盘偏离度、笔触密度、留白占比三项数值全部落入门禁区间，不达标张必须重生并复审",
          "requiredTools": [
            {
              "id": "outlier_audit_regenerate",
              "input": "成组图",
              "output": "离群审计 + 重生指令"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "布置展陈主视觉",
          "shortName": "展陈",
          "deliverable": "展览海报 1 张（key art 为主视觉 + 展名 + 立意句排版）+ 墙面布置模拟图（成组作品挂墙观展动线）+ 图录版式",
          "inputFrom": "上一步「审计一致性」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "海报 = key art + 立意句：主视觉直接复用风格锚，展名字体气质与 style DNA 同源，不另起炉灶",
            "墙面模拟按观展动线排：把起承转合的成组排序落到墙面，留白节奏延续到挂画间距",
            "图录版式：每件作品配展签文案（作品名/媒介/尺寸/一句话阐释），阐释从立意句派生",
            "展陈视觉的排版留白与作品留白节奏同频，观感是同一个展而不是拼盘"
          ],
          "gate": "海报、墙面模拟、图录三者并排观感统一：同色系、同留白节奏、同立意表达；任何一个像另一个展的物料即重排",
          "requiredTools": [
            {
              "id": "canonical_key_art_lock",
              "input": "风格锚 + 主体",
              "output": "主视觉锁定卡"
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
          "name": "交付多规格",
          "shortName": "多规格",
          "deliverable": "印刷级成品包（300 DPI 印刷分辨率作品文件 + 展签成品文案）+ 线上 3D 展厅素材包（展厅空间图 + 挂点布置图）",
          "inputFrom": "上一步「布置展陈主视觉」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "印刷规范：作品按 300 DPI 出印刷分辨率，按目标画幅（如 A2/A1）计算像素量，不做低清放大",
            "展签成品：每件作品一张展签（作品名/媒介/尺寸/年份/一句话阐释），字号规范统一",
            "线上 3D 展厅：生成展厅空间 + 挂点图，作品位置沿用墙面模拟的动线，灯光方案延续 key art 光源法则",
            "交付前逐张核对色彩：印刷用途做 CMYK 预检提示，线上素材保持 HEX 色板原样"
          ],
          "gate": "抽查任一印刷文件的分辨率达 300 DPI 且画幅像素量正确；线上展厅挂点数与作品数一致；缺一项即补齐后才算交付完成",
          "requiredTools": [
            {
              "id": "exhibition_delivery_manifest",
              "input": "展陈主视觉",
              "output": "多规格交付清单"
            },
            {
              "id": "multi_aspect_reflow",
              "input": "主视觉",
              "output": "多画幅切图（横/竖/方）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        }
      ]
    },
    "slots": {
      "prompt": "（把这里换成你的主题）策展式定调 key art，情绪板标签驱动色彩与材质，笔触光线语言为全系列立锚，叙事焦点明确",
      "contextPrompt": "主题核心意象的空间化呈现，三层纵深信息递进，光源方向统一",
      "composition": [
        "定调画幅，视点服务主题的尺度表达",
        "唯一情绪锚点置光线引导中心，留白即格调"
      ],
      "negativePrompt": "风格脱离 key art，色盘外溢，笔触密度不均，元素堆砌，构图平均无重点",
      "qualityProfile": "print"
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
    "initialPrompt": "深度内化（写艺术家或流派，如莫奈）的风格：先解构其语言要素，再临摹对拍验证，然后变体矩阵测试，最后原创成组。",
    "directive": "用户刚从模板库点了「风格深研线」流水线，画布上已铺好 8 步 workflow（采代表作→拆DNA→签解构表→拍临摹对照→跑变体矩阵→试LoRA→做原创成组→归档证物链）。请沿用这套泳道，用 canvas_apply_ops 把每步产出回填到对应节点，不要另起炉灶重建结构。\n正确跑法：先确认艺术家/流派名称与用户想应用的题材；名字含糊就用 question 工具给选项确认，同名画家别选错。\n全程用简体中文思考和回复；每步开始先用一句话告诉用户这一步在做什么、需要他做什么，再动手，不要只默默发卡片。\n生图要一张一张来：先用中文说清这张是什么，再调用 image_generate（会弹扣费确认卡，等用户批准）——出图后简述结果再继续下一张；严禁并行堆叠多个 image_generate，严禁未批准就连发。尺寸只用平台支持规格（1024x1024 / 1536x1024 / 1024x1536），不要自造尺寸导致生成失败。\n解构表五维（笔触/色盘/光观察/构图/题材）逐字段写清并给用户确认——这是后面所有步骤的宪法。\n对拍不达标回解构表修正而不是硬闯；变体矩阵验证换题材仍是「他画的」之后，才放原创成组。一步一回填画布。",
    "pipeline": {
      "summary": "风格解构→临摹对拍→变体矩阵→原创成组的风格内化流水线",
      "steps": [
        {
          "name": "采代表作",
          "shortName": "代表作",
          "deliverable": "15-20 张代表作原图与元数据表",
          "inputFrom": "用户提供/搜索艺术家代表作；本步产物即全链首个资产",
          "promptNotes": [
            "只收高清原图；印刷翻拍图会污染笔触与纸纹分析",
            "分期采样，避免把艺术家不同阶段的笔法混成一套 DNA",
            "保留 2-4 张不参与解构的盲测图，防止提示词只记住训练样本"
          ],
          "gate": "人工确认清单完整：至少两个创作期各有≥5张高清图、题材≥2类、盲测集已冻结；缺图时停在本步，不调用生图",
          "requiredTools": [
            {
              "id": "canvas_get_state",
              "input": "画布",
              "output": "节点/连线快照 JSON"
            },
            {
              "id": "image_generate",
              "input": "prompt + 模型 + 尺寸/张数",
              "output": "图片 URL + 实际花费"
            }
          ]
        },
        {
          "name": "拆DNA",
          "shortName": "DNA",
          "deliverable": "五维 DNA 解构 JSON 与证据局部图：笔触/色盘/光观察/构图习惯/题材偏好",
          "inputFrom": "上一步「采代表作」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "五维 DNA 必须拆到笔触厚度/方向/干湿、颜料堆叠、纸纹材质、HEX 色盘、光源方位、明暗交界、视点裁切与负形",
            "题材偏好只记录画什么；观察方式记录怎么看，例如边缘处理、环境色渗入、阴影补色与视觉焦点路径",
            "拒绝大气、唯美、电影感等不可验证套话；每条都要有数值、方向、比例、频率或原作局部证据"
          ],
          "gate": "五维每维≥3条可验证特征，所有特征均有证据 asset_id，且画什么/怎么看分栏无混淆；VLM 不可用时必须由用户或人工依据原图补齐",
          "requiredTools": [
            {
              "id": "style_dna_extract",
              "input": "代表作",
              "output": "风格 DNA 解构表（笔触/色板/构图）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "签解构表",
          "shortName": "解构表",
          "deliverable": "用户逐条签核的 style DNA 卡与两张原作局部对位图",
          "inputFrom": "上一步「拆DNA」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "每条 DNA 必须可回看原作局部，不让用户只凭抽象文字签核",
            "用户修正项写入 revision_log；高权重项在后续逐维对拍中权重 x2",
            "没有明确批准不能进入临摹或批量生图"
          ],
          "gate": "用户逐条确认并锁定版本；存在未决条目、来源不明条目或高权重项未确认时，工作流停留在本步",
          "requiredTools": [
            {
              "id": "style_dna_extract",
              "input": "代表作 + DNA 草稿",
              "output": "正式解构表（笔触/色板/构图/光照四栏）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        },
        {
          "name": "拍临摹对照",
          "shortName": "临摹",
          "deliverable": "逐维对拍 5 张、综合临摹 2 张、原作并排对照板与逐维还原度表",
          "inputFrom": "上一步「签解构表」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "固定 seed 贯穿同一轮对拍，差异只允许来自 prompt 的单一维度替换；seed 必须同时写入 seed_log 与 prompt_snapshot",
            "笔触复现写厚度、笔触方向、颜料堆叠和干湿边缘；材质复现写可见 paint ridges、干底层覆盖和冷压纸纹显现",
            "逐维还原度=复现成功特征数/该维 DNA 特征总数；低于 60% 回到解构表补写，高权重项低于 85% 不放行",
            "StyleAligned 与 StoryDiffusion 都是研究中的一致性机制，本 harness 未接 upstream，只能用固定 seed、同一 prompt 骨架和人工对拍"
          ],
          "gate": "五维还原度全部≥70%、高权重项≥85%，综合临摹通过人工并排审查；任何低于阈值的维度必须回退到 style_dna_approved_v1 修订，不得硬闯",
          "requiredTools": [
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
          "name": "跑变体矩阵",
          "shortName": "变体",
          "deliverable": "3x3 泛化矩阵（3 个新题材 x 3 个新构图）与逐格 DNA 泛化判定表",
          "inputFrom": "上一步「拍临摹对照」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "泛化检验必须离开艺术家惯用题材，验证怎么看仍成立，而不是重复画花瓶或同一人物",
            "9 格共用观察层 DNA，变量只改题材与构图；同一 seed 便于对照，但不等同于已获得 StyleAligned 一致性",
            "任一格丢失两个以上 DNA 维度即标为 outlier，检查题材词是否偷偷带回了画什么层"
          ],
          "gate": "9 格至少 7 格保留四个以上 DNA 维度，且 outlier 原因已记录；未达到即回退修订 style_dna，不进入原创成组",
          "requiredTools": [
            {
              "id": "style_aligned_batch",
              "input": "风格锚 + 清单",
              "output": "成组渲染（风格对齐批量）"
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
          "name": "试LoRA",
          "shortName": "LoRA",
          "deliverable": "LoRA 可选轨实验记录：数据集/caption/参数/同 seed 对比；若未接 upstream 则交付明确跳过记录",
          "outputKind": "text",
          "inputFrom": "上一步「跑变体矩阵」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "LoRA 原理上冻结基础权重并注入可训练低秩矩阵，但本 harness 没有训练、上传或挂载 upstream；不能把参数起点写成已可执行能力",
            "若未来接通训练，caption 只写内容不写风格，且必须同 seed 同 prompt 比较纯 prompt 与 prompt+LoRA",
            "当前执行结果应是 unsupported_skip，不生成假模型文件，直接回接已通过矩阵的 prompt 骨架"
          ],
          "gate": "可选轨门禁：只有 upstream LoRA 训练、挂载和同 seed 对比都真实可用且 LoRA 显著胜出才启用；当前必须交付 skip_reason 并继续原创路线",
          "requiredTools": [
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
          "name": "做原创成组",
          "shortName": "原创",
          "deliverable": "6-8 张原创成组作品与五维一致性自查表",
          "inputFrom": "上一步「试LoRA」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "成组共用怎么看的 DNA（笔触逻辑、色盘纪律、光处理、材质），但题材、构图和叙事必须原创且不复刻代表作",
            "每张生成后逐条核对五维；掉维就重生成或记录人工修复，不把 outlier 混入最终系列",
            "StyleAligned/LoRA 未接通时只报告固定 seed + 共享 prompt 骨架的实际方法，不宣称注意力共享或适配器已生效"
          ],
          "gate": "6-8 张全部通过五维自查，组内风格统一、构图不重复、题材未复刻单一代表作，且每张均有 seed/prompt/来源节点记录",
          "requiredTools": [
            {
              "id": "style_aligned_batch",
              "input": "风格锚 + 清单",
              "output": "成组渲染（风格对齐批量）"
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
          "name": "归档证物链",
          "shortName": "证物链",
          "deliverable": "内化证物档案：代表作图库、签核 DNA 卡、逐维对拍、3x3 矩阵、LoRA 跳过记录、原创成组与可复用 prompt 骨架",
          "inputFrom": "上一步「做原创成组」产物结构化注入；引用其 artifact 作为本步输入",
          "promptNotes": [
            "骨架 prompt 拆成笔触、色盘、光观察、构图、材质五个可复用模块，并保留题材层为变量",
            "每张结果旁登记 seed、prompt snapshot、模型、尺寸、来源节点和 gate 结论，确保能复现也能追责",
            "把 StyleAligned、StoryDiffusion、LoRA、VLM 的 unsupported 状态归档，避免后续用户把研究方法误读成已接能力"
          ],
          "gate": "六类核心 artifact 齐全、每一步 gate 决策可追溯、所有 seed/prompt/source node 已登记、unsupported 清单完整、prompt 骨架可单独复用；缺一项不得宣称内化完成",
          "requiredTools": [
            {
              "id": "asset_provenance_archive",
              "input": "物料清单",
              "output": "证物链归档（来源/seed/版本）"
            },
            {
              "id": "canvas_apply_ops",
              "input": "节点/连线操作指令",
              "output": "画布更新结果"
            }
          ]
        }
      ]
    },
    "slots": {
      "prompt": "（把这里换成艺术家 + 你的题材）风格解构临摹，按 style DNA 五维（笔触/色盘/光观察/构图/题材）逐维度复现，落在颜料厚度与纸纹材质上",
      "contextPrompt": "与艺术家观察方式匹配的光线条件，题材留发挥余裕",
      "composition": [
        "构图习惯向艺术家看齐，主体从你的题材出发",
        "留白与画面密度按解构表执行"
      ],
      "negativePrompt": "风格停留在滤镜层，笔触纸纹缺失，模仿签名落款，维度漂移，两种风格打架",
      "qualityProfile": "balanced"
    }
  },
];

/**
 * 按选中环节裁剪模板：只保留选中 steps，initialPrompt/directive 追加执行范围说明；全选时原样返回（零改动）。
 * - selectedIndices 升序去重；空数组或覆盖全部步骤 → 视为全选，返回原对象。
 * - 裁剪后 pipeline.steps 只含选中步骤，pipeline.summary 不动。
 */
export function cropTemplate(template: AgentTemplate, selectedIndices: number[]): AgentTemplate {
  if (selectedIndices.length === 0) return template;
  const indices = [...new Set(selectedIndices)].sort((a, b) => a - b);
  if (indices.length >= template.pipeline.steps.length) return template;
  const steps = indices
    .map((i) => template.pipeline.steps[i])
    .filter((step): step is AgentPipelineStep => Boolean(step));
  const shortNames = steps.map((s) => s.shortName);
  return {
    ...template,
    initialPrompt: `${template.initialPrompt}\n本次只执行这些环节：${shortNames.join("、")}。`,
    directive: `${template.directive}\n本次执行范围已裁剪：只做 ${shortNames.join("、")}，不要碰未选中的环节。`,
    pipeline: { ...template.pipeline, steps },
  };
}
