import type { AgentTemplatePayload } from "./types";

export const novelFilmPipelinePayload: AgentTemplatePayload = 
{
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
  },
  "initialPrompt": "把我的小说影视化：（贴章节或写题材与主角），先拆结构化剧本，再锁角色和场景资产，最后出分镜关键帧，一步步来。",
  "directive": "用户刚从模板库点了「小说影视化」流水线，画布上已铺好 9 步 workflow（拆解剧本→建角色圣经→定美术圣经→锁定分镜→3D 白模预演→渲染关键帧→合成镜头视频→配音配乐→组装成片）。\n后端已注册对应模板：启动工作流时调用 workflow_start 传 template_id=\"novel_film\"（不要即兴拼节点）；其节点流覆盖 8 环，其中配音/成片两环后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这两环成功。\n正确跑法：先确认用户是否已贴小说文本——没有就用 question 工具一次问齐（题材/主角设定/篇幅），别催促也别瞎编。\n文本到手先只做第 1 步拆剧本，产出结构化场次表给用户过目；用户批准后才进角色资产，禁止一步跳到出图。\n每完成一步在画布对应节点回填产出，让用户看到流水线在走；卡在门禁就明说等什么，不装忙。\n进入「3D 白模预演」环节时调用 director_* 工具完成预演再继续后续步骤：先 director_get_state 了解状态，用 director_propose_plans 出方案并等用户确认，确认后用 director_manage_shot/director_upsert_action 细化走位与运镜。",
  "steps": [
    {
      "deliverable": "结构化剧本 JSON（场次表 + 节拍 beat list + 台词表按 4.5 字/秒折算时长 + 每场钩子位标注 + 情绪曲线标注）+ 一页故事大纲",
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
      "deliverable": "分镜表 JSON（逐镜：景别/机位/运镜/时长取自台词折算/转场标记 J-cut 或 L-cut）+ 黑白 sketch-lock 线稿分镜板（低成本低分辨率先行）",
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
      "deliverable": "逐镜头视频片段 MP4（I2V 起止帧驱动）+ 镜头元数据（时长/分辨率/首尾帧缩略图）+ 失败重试记录",
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
      "deliverable": "逐镜头配音音轨（TTS 按台词表生成，语速对齐 4.5 字/秒折算时长）+ BGM 分段音轨（按情绪曲线标注定情绪与入出点）+ 音效点位表",
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
      "deliverable": "成片 MP4（全镜头按时序拼接 + J/L-cut 转场执行 + 音轨混音）+ 字幕轨（SRT 按台词时间码）+ 封面帧 + 逐镜溯源表",
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
}
;
