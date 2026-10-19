import type { AgentTemplatePayload } from "./types";

export const novelIpVisualPackPayload: AgentTemplatePayload = 
{
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
  },
  "initialPrompt": "我的网文要整套 IP 视觉包：（写世界观与主角），先锁世界观风格锚，再出主角设定卡、名场面组图和封面主视觉。",
  "directive": "用户刚从模板库点了「IP视觉包」流水线，画布上已铺好 8 步 workflow（拆解世界观→炼情绪板→铸风格锚→建主角资产→绘名场面组图→造封面主视觉→出多画幅→铺衍生物料）。\n正确跑法：先问齐世界观关键词与主角设定（question 工具选择题优先），信息不足时不要凭空发挥基调。\n第 1 步只出一张定调 key art 给用户确认，锁定后才批量；后续每步沿用该锚，风格漂移要主动指出。\n封面按频道选构图（男频仰拍/女频留白），交付前留书名区；进度随时对着画布节点讲，一步一停。\n启动工作流时调用 workflow_start 传 template_id=\"novel_ip\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程纯 image/text 两种节点，无 audio/film 环节；若未来延伸配音/成片环节，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "世界观圣经结构化卡（色彩域 HEX + 材质表 + 3 个名场面候选）+ 可绘制元素清单",
      "inputFrom": "用户输入/选题原稿结构化为 JSON 注入；本步产物即全链首个资产",
      "promptNotes": [
        "LLM 先抽取可绘制元素再做情绪板：world_bible_extract 跑全文出关键词库/地理/势力三段 JSON，关键词去重后按出现频次只留前 30 个，超出即砍",
        "世界观色彩域字段化为 5 个 HEX（主色 3 + 点缀 2），材质表按金属/皮肤/布料/环境四类各写一条高光比例（金属×1.5、皮肤×0.5），后续所有生图按此表查",
        "名场面候选固定给 3 个，各配一行钩子说明（悬念/反转/情绪爆点）+ 情绪值（-5~+5），让用户有的比，不搞单选绑架",
        "可绘制元素清单按场景/道具/人物三类编号建档（scene-01/prop-01/char-01），后续步骤引用编号不重写描述，防止转述走样"
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
      "deliverable": "3x3 情绪板 + 情绪坐标轴（题材频道定位）",
      "inputFrom": "上一步「拆解世界观」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "情绪板两轮制：第一轮用 emotion_board_matrix 发散出 3x3 共 9 格，第二轮按频道定位收敛砍到方向唯一的 1 组",
        "收敛判据量化：9 格中 ≥7 格命中同一频道关键词（男频=史诗/战场/权谋，女频=氛围/情感/留白）才算收敛，不达标换种子关键词回炉重炼",
        "色彩收敛到主色 3 HEX + 点缀 2 HEX 写死进配方，后续任何图出现规范外主色即判风格漂移，直接返工",
        "每格配 1-2 词情绪标签且格子间不重复；情绪坐标轴标注本作在「热血↔治愈」「暗黑↔明亮」两轴的落点，给封面构图选型当依据"
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
      "deliverable": "canonical key art 一张（全案定调）+ sref 码/权重/seed 配方冻结",
      "inputFrom": "上一步「炼情绪板」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "key art 只出一张 16:9 定调（视点拉远交代史诗尺度），不过关全组返工，绝不带病下行",
        "sref 权重测试法：0.4/0.5/0.6/0.7 四档各出 1 图，按色彩/质感/笔触三项比对情绪板打分，选命中度最高档冻结",
        "冻结配方三件套写进锁定卡：sref 码 + 权重 + seed，全案后续生图逐字复用，改任一项必须走返工流程并记录原因",
        "配方复测：同配方重跑 2 次肉眼比对色彩方差与构图逻辑，无偏差才算铸成；有偏差说明 seed 不稳，换 seed 后四档重测"
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
      "deliverable": "主角 DNA 签名 8 维表 + 三视图 + 表情差列 6 格",
      "inputFrom": "上一步「铸风格锚」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "DNA 签名 8 维（脸型/发型/瞳色/体型/服装/配饰/肤色/气质）逐字段写死为固定短语，后续所有图复用同一短语，禁止同义替换（换词=换脸）",
        "三视图（正面特写/全身/侧面）用同一 seed 同一次生成锁 face_identity；材质高光比例随 DNA 附带（金属×1.5、皮肤×0.5）防质感漂移",
        "表情差列 6 格固定覆盖喜/怒/哀/惧/狂/静，同 seed 只换情绪关键词，后续 Q 版与表情包物料直接从这 6 格取情绪不重画",
        "每角色记录专属 seed 与参考图 ID 入资产表；主角必须单独成卡，配角 2-3 个可合并建档，被并档的配角进名场面前先补卡"
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
      "deliverable": "3-5 张序列化分镜名场面（先 sketch-lock 黑白构图稿后成图）",
      "inputFrom": "上一步「建主角资产」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "先 sketch-lock 黑白构图稿：3-5 张名场面先全铺线稿验证叙事节奏与构图，构图错重画线稿成本远低于重出成图",
        "序列内共享 DNA 8 维全文 + 场景锚编号，5-6 条 prompt 做版面安排；每张写明景别/机位/光位三字段，光位全程统一不许打架",
        "三景别节奏固定：全景建场→中景关系→特写爆点；特写对应钩子位多出 2 候选择优，落选帧留档不删",
        "用 story_sequence_consistency 做跨图一致性检查：组图并排后角色脸/服装/配色与三视图逐一比对，零漂移才过门禁"
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
      "deliverable": "竖版封面主视觉 + 书名区留白版（男频仰拍/女频留白双构图）",
      "inputFrom": "上一步「绘名场面组图」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "按频道选构图：男频仰拍拉气场（低机位、人物占画面 60%+、透视向上），女频留白造氛围（人物约 40%、负空间承接情绪）",
        "顶部 1/3 留书名区：竖版 3:4 按 600x800 出图，书名区约 y=0-266px 保持低细节近平色，人物主体压下半区拉气势",
        "文字后排版：主视觉区禁 AI 文字，任何乱码不允许出现在封面主视觉；书名/笔名由用户后期排版叠加到预留区",
        "用 canonical_key_art_lock 出仰拍/留白双构图各 1 张给用户二选一，选定即锁卡冻结，多画幅只从锁定版派生不再改设定"
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
      "deliverable": "封面多画幅包（3:4/1:1/9:16）+ 平台安全区核对清单（起点竖版/B 站 16:9 等）",
      "inputFrom": "上一步「造封面主视觉」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "每画幅用 multi_aspect_reflow 重新构图而非裁切：主体与书名区随画幅重排，禁止简单 center-crop 砍头砍手",
        "尺寸基准写死：3:4 = 600x800（起点/QQ阅读竖版）、1:1 = 1080x1080（社媒信息流）、9:16 = 1080x1920（短视频封面/抖音）、16:9 = 1920x1080（B 站/横版 banner）",
        "平台安全区核对清单逐项过：起点竖版避让顶部 25% 书名区、B 站 16:9 右下 15% 区域留空避让时长角标、抖音 9:16 底部 20% 避让账号信息条",
        "每画幅出图后跑套检三项：书名区完整、主体无截断、分辨率达标；任一不过打回重排，全过才入交付包"
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
      "deliverable": "头像/立绘/海报/Q 版表情包 + 归档（附 DNA 表与 sref 配方副本）",
      "inputFrom": "上一步「出多画幅」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "全部衍生物料从锁定资产派生（DNA 表 + key art + 多画幅包），不做新设定不引入规范外色彩，风格漂移当场指出",
        "物料规格固定：头像 512x512、立绘竖版 1024x1536（透明底便于运营抠图）、海报 16:9 1920x1080、Q 版表情包 8-12 张 240x240",
        "Q 版表情包用表情差列 6 格（喜/怒/哀/惧/狂/静）直取情绪扩展到 8-12 张，同 seed 只换情绪关键词，保证 IP 表情体系统一",
        "归档用 asset_provenance_archive 记证物链：每件物料附来源资产 ID/seed/sref 配方/版本号，续作时按链复原不重炼"
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
}
;
