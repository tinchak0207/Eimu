import type { AgentTemplatePayload } from "./types";

export const shortdramaVisualAssetsPayload: AgentTemplatePayload = 
{
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
  },
  "initialPrompt": "把我的短剧剧本做成视觉资产包：（贴剧本或写剧情梗概与主演设定），按拆场→分镜→角色卡→CP剧照→竖屏海报走完。",
  "directive": "用户刚从模板库点了「剧本视觉化」流水线，画布上应铺好 9 步 workflow（拆解剧本→铸造主演资产→锁定分镜→3D 白模预演→渲染关键帧→合成配音→生成镜头视频→剪辑成片→产出投放物料）；若画布为空，按同样步骤用工作流工具分步搭建，不套用无关模板。\n以下纪律必须遵守，违反即流程错误：\n1. 全程用简体中文回复用户（含卡片文案与画布节点标签），不用繁体；对用户说话不出现内部黑话（feature_film、sref/cref、higgsfield 等），一律大白话。\n2. 用户没给剧本/梗概时，第一轮必须用 question 工具一次问齐（剧本或梗概、主演数量与设定、基调，附可选选项），禁止用纯文字列问题，禁止在信息齐前启动任何生成。\n3. 剧本批准前禁止任何出图：拆解剧本产出结构化场次表后，先用中文向用户展示要点，再用 question 工具停在门禁请用户批准（选项：批准/修改）；批准后才允许生成人物资产。\n4. 主演三视图与 DNA 签名出图后再次停在门禁：用 question 工具请用户确认主演资产，确认前禁止进分镜、禁止批量出图。\n5. 竖屏 9:16 节奏每段≤15s，情绪时序链（听见→停顿→眼神→表情→说话）写进分镜字段；每步产出回填画布节点，一步一确认，不擅自跳步。\n6. 进入「3D 白模预演」环节时调用 director_* 工具完成预演再继续后续步骤：先 director_get_state 了解状态，用 director_propose_plans 出方案并等用户确认，确认后用 director_manage_shot/director_upsert_action 细化走位与运镜。\n启动工作流时呼叫 workflow_start 传 template_id=\"shortdrama_visual\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程含配音环——配音为 TTS 原语，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "结构化场次 JSON（每场：场景/人物/道具/服装/情绪拍点/钩子位）+ 按角色聚合的台词本（每句标 TTS 音色与语速）",
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
      "deliverable": "逐场分镜表：段（一次生成 ≤15 秒）→ 镜（每镜 2-5 秒硬门）→ 每镜 9:16 构图描述 + 机位（正打/反打/过肩）+ 转场标记",
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
      "deliverable": "白模预演方案（逐镜分镜构图/运镜/走位，3D 白模时间线可回放）+ 用户确认过的镜头方案记录",
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
      "deliverable": "全剧旁白与台词音轨：按角色聚合的 TTS 成片音频（每句独立文件带时长戳）+ BGM 情绪段标记表（进场/退场秒点）+ 音效点位表",
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
      "deliverable": "每镜一段竖屏原生视频（9:16，I2V），按 shot_order 命名的片段序列 + 失败镜头重试清单",
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
      "deliverable": "每集成片视频（9:16，含字幕/音轨/BGM 混音）+ 剪映可继续编辑的草稿工程",
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
}
;
