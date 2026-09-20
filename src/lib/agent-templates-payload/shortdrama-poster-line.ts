import type { AgentTemplatePayload } from "./types";

export const shortdramaPosterLinePayload: AgentTemplatePayload = 
{
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
  },
  "initialPrompt": "给我的短剧做投放物料流水线：（写剧设与主演形象），先锁视觉基调，再出主演海报、CP对戏图和信息流切片封面批量。",
  "directive": "用户刚从模板库点了「投放海报线」流水线，画布上应铺好 7 步 workflow（锚定视觉基调→提炼主演海报→排布CP对戏图→切片封面批量→生成变体测试包→回流迭代风格→锁定交付参数）；若画布为空，按同样步骤用工作流工具分步搭建，不套用无关模板。\n以下纪律必须遵守，违反即流程错误：\n1. 全程用简体中文回复用户（含卡片文案与画布节点标签），不用繁体；对用户说话不出现内部黑话（sref/cref、higgsfield 等），一律大白话。\n2. 用户没给剧设/主演时，第一轮必须用 question 工具一次问齐（剧设梗概、基调给选项：雨夜霓虹/豪门金调/古风等、主演形象关键词），禁止用纯文字列问题，禁止在信息齐前启动任何生成。\n3. 第一张 key art 出图后必须停在门禁：用 question 工具请用户锁定基调（选项：锁定，继续批量/调整基调），锁定前禁止出后续任何图。\n4. 生图只用 image_generate 工具，禁止用 bash/curl 调生图接口；所有投放物料一律竖版 9:16（如 1024x1536 竖构图），禁止横版。\n5. 基调锁定后按画布 7 步逐张推进：主演海报→CP对戏图→切片封面批量（按切片剧情对位情绪标签），海报字效不得遮脸，安全区检查过才交付；一步一确认，产出回填画布节点。\n启动工作流时调用 workflow_start 传 template_id=\"shortdrama_poster\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程纯 image/text 两种节点，无 audio/film 环节；若未来延伸配音/成片环节，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "剧设 key art 主视觉 1 张（竖版 9:16）+ 色彩情绪规范 JSON（主色/辅色/对比度/光效方向/情绪关键词）",
      "inputFrom": "用户剧设文本结构化为 JSON 注入；本步产物即全链首个资产",
      "promptNotes": [
        "key art 定调：一张图锁全剧气质，后续所有物料以它为 sref 风格锚（--sref 权重最高）",
        "色彩情绪规范写成机器可读 JSON：主色 HEX、辅色、布光模式（明暗对照 chiaroscuro / 伦勃朗光）、情绪标签，供下游步骤引用",
        "上游借鉴 shuohao-skills 美术设定集思路：锚点 + 变体 + 尺度参照，无人无手纯净定调",
        "规范 JSON 字段执行细则：主色 HEX×2（背景基调+人物高光）、辅色 HEX×2、光效字段≥2（如伦勃朗光/轮廓光，各带方向角与强度档 1-5）、情绪词≥2，任一字段缺失按 gate 打回",
        "style_dna_extract 先解构 2-3 张同题材对标爆款海报（笔触/色板/构图三栏 DNA 表），再拼 key art 提示词，不凭空起稿",
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
      "deliverable": "主演海报 2 版：气场版（单人立势压场）| 情绪版（面部特写情绪爆点），各 1 张 9:16",
      "inputFrom": "上一步「锚定视觉基调」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "主演 DNA 锚：主演设定图作 cref（--cref 高权重），跨张保持五官/发型/服装一致",
        "气场版：低角度仰拍 + 明暗对照布光，人物占画面 2/3，气场压过背景",
        "情绪版：面部特写 + 眼神光，情绪对应剧本最大爽点/虐点，供 A/B 对比",
        "出图配额：两版各出 3 候选共 6 张，固定 seed 族只换情绪词不换风格词，择优 1+1 落锁定卡",
        "canonical_key_art_lock 出主演锁定卡：cref 权重 0.85、专属 seed 值、DNA 短语原文三件套写卡，下游所有步骤只引用不重写",
        "背景色只从规范 JSON 取色，禁止自创配色",
        "一致性自检：双版并排比对五官三锚点（瞳距/脸型轮廓/发际线），任一锚点漂移即该张重出，不整批返工"
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
      "deliverable": "CP 对戏图 3 张：对视版 | 逼近版 | 拉扯版（三级张力递进，供投放 A/B 测试）",
      "inputFrom": "上一步「提炼主演海报」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "三级张力构图：对视=对称站位视线相交；逼近=不对称构图一方侵入另一方空间；拉扯=肢体接触+动态失衡+衣发飘动",
        "双 cref 同时挂载，主体与配角权重区分（主 0.9 / 配 0.6），防止脸糊",
        "张力靠肢体语言与负空间表达，不靠夸张表情；背景光效沿 key art 明暗对照方向",
        "三版对应三档投放钩子（甜/虐/爽），出图时打好情绪标签",
        "三张共用同一固定 seed，张力只靠站位/肢体/负空间三个变量控制，风格因子隔离，A/B 数据才能归因到张力本身",
        "story_sequence_consistency 出序列图组后，image_edit 只做微修（手部/衣摆/发丝），构图级问题回生成层重出，禁止在编辑层叠补丁"
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
      "deliverable": "信息流切片封面 6-9 张（9:16）：剧名安全区模板 + 每张对应一个切片剧情点 + 情绪标签对位表",
      "inputFrom": "上一步「排布CP对戏图」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "批量 styleLock：全批固定 seed + 同一 sref 权重组合，只换主体动作与场景词，保证风格零漂移",
        "剧名安全区：顶部 15% 与底部 20% 留白（平台 UI/剧名条遮挡区），主体脸与手不进安全区",
        "情绪标签与切片剧情对位：每张封面=该集最强情绪帧（打脸/反转/告白），标签写入文件名",
        "剧情点一一对位方法：先让用户/剧本侧给每集编号的情绪点清单（格式：集数_剧情点_情绪档 1-5），封面按清单逐张生成后回填对应行，缺一集少一张即对位失败",
        "shot_grid_batch 走批量管线：一次传全部剧情点清单，逐张携带主演 cref 与 sref，输出按清单顺序编号，不散点单张跑",
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
      "deliverable": "投放 A/B 变体包：同一封面底图的 3 类钩子变体（钩子文案位上/中/下 | 花体字效版式 2-3 款 | 大字报冲击版），共 6-9 张",
      "inputFrom": "上一步「切片封面批量」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "单变量原则：每个变体只改一个维度（文案位 或 字效 或 底图），保证 A/B 数据可归因",
        "花体字效：书法体/描边/立体阴影只落在安全区内，字效不得遮脸（遮脸检查是门禁）",
        "钩子文案位：上（标题党）/中（情绪共鸣）/下（悬念留白）三档，对应不同人群心理",
        "变体命名规则：底图ID_文案位_字效ID，便于回流数据对位（如 F03_top_calli = 第3张底图/文案位上/花体书法）",
        "style_aligned_batch 成组渲染：同组变体共享底图与 sref，只有被测维度进变量表，组内其它参数逐字节一致",
        "预算纪律：变体包总量 6-9 张为上限，超预算先砍底图数不砍变体维度（维度砍了 A/B 就废）"
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
      "deliverable": "数据回流迭代报告：高点击封面风格特征提炼（构图/色温/张力级别/文案位）+ 下一批次的 styleLock 参数更新建议",
      "inputFrom": "上一步「生成变体测试包」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "归因拆解：按单变量命名拆出文案位/字效/张力级别各自的 CTR 贡献，不混判",
        "CTR 映射 styleLock 参数规则：CTR 提升幅度最大的维度直接写成参数字段（如 CTR_top 高出均值 30% → winner_文案位=top），同维度劣势档位降权但不删除，保留对照位",
        "outlier_audit_regenerate 输入变体 ID+CTR 数据表，产出赢家/离群审计；CTR 低于组均值 50% 的离群变体直接淘汰出下一轮测试集",
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
      "deliverable": "投放物料交付包：全量物料按平台规格归档（9:16 主图 + 变体包 + 情绪标签对位表）+ 可复用 styleLock 参数卡（sref/cref/seed/色板 JSON）",
      "inputFrom": "上一步「回流迭代风格」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "参数卡沉淀：key art sref ID、主演 cref ID、固定 seed、色板 JSON 打包为 styleLock 卡，下部剧换皮不换骨架",
        "固定 seed 抽查法：交付前随机抽 3 张跨批次物料，用参数卡 seed 复生成并比对色板偏差（主色 HEX 色差 ΔE<5 为合格），验证卡没失真",
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
}
;
