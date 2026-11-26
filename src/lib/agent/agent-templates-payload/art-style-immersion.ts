import type { AgentTemplatePayload } from "./types";

export const artStyleImmersionPayload: AgentTemplatePayload = 
{
  "slots": {
    "prompt": "（把这里换成艺术家 + 你的题材）风格解构临摹，按 style DNA 五维（笔触/色盘/光观察/构图/题材）逐维度复现，落在颜料厚度与纸纹材质上",
    "contextPrompt": "与艺术家观察方式匹配的光线条件，题材留发挥余裕",
    "composition": [
      "构图习惯向艺术家看齐，主体从你的题材出发",
      "留白与画面密度按解构表执行"
    ],
    "negativePrompt": "风格停留在滤镜层，笔触纸纹缺失，模仿签名落款，维度漂移，两种风格打架",
    "styleTemplateId": "sai-craft clay",
    "qualityProfile": "balanced"
  },
  "initialPrompt": "深度内化（写艺术家或流派，如莫奈）的风格：先解构其语言要素，再临摹对拍验证，然后变体矩阵测试，最后原创成组。",
  "directive": "用户刚从模板库点了「风格深研线」流水线，画布上已铺好 8 步 workflow（采代表作→拆DNA→签解构表→拍临摹对照→跑变体矩阵→试LoRA→做原创成组→归档证物链）。请沿用这套泳道，用 canvas_apply_ops 把每步产出回填到对应节点，不要另起炉灶重建结构。\n正确跑法：先确认艺术家/流派名称与用户想应用的题材；名字含糊就用 question 工具给选项确认，同名画家别选错。\n全程用简体中文思考和回复；每步开始先用一句话告诉用户这一步在做什么、需要他做什么，再动手，不要只默默发卡片。\n生图要一张一张来：先用中文说清这张是什么，再调用 image_generate（按本轮网关授权执行：完全访问或自动模式直接生成，无持续授权且预算未覆盖时才等待批准）——出图后简述结果再继续下一张；严禁并行堆叠多个 image_generate，无持续授权时严禁未批准就连发。尺寸只用平台支持规格（1024x1024 / 1536x1024 / 1024x1536），不要自造尺寸导致生成失败。\n解构表五维（笔触/色盘/光观察/构图/题材）逐字段写清；完全访问或自动模式经独立评审自行锁定，用户明确要审方案时才给用户确认——这是后面所有步骤的宪法。\n对拍不达标回解构表修正而不是硬闯；变体矩阵验证换题材仍是「他画的」之后，才放原创成组。一步一回填画布。\n启动工作流时调用 workflow_start 传 template_id=\"art_style\"（不要即兴拼节点）。后端已注册对应模板，直接走 P0 幂等守卫复用骨架。\n本流程纯 image/text 两种节点，无 audio/film 环节；若未来延伸配音/成片环节，后端会如实回报上游暂不可用——向用户说明即可，不要用 prompt 冒充这环成功。",
  "steps": [
    {
      "deliverable": "15-20 张代表作原图与元数据表",
      "inputFrom": "用户提供/搜索艺术家代表作；本步产物即全链首个资产",
      "promptNotes": [
        "只收高清原图；印刷翻拍图会污染笔触与纸纹分析",
        "分期采样，避免把艺术家不同阶段的笔法混成一套 DNA",
        "保留 2-4 张不参与解构的盲测图，防止提示词只记住训练样本",
        "元数据表逐图登记：asset_id、创作期、年份、题材分类、来源 URL、分辨率；长边低于 1024px 的图标注「仅参考不进 DNA」，不参与笔触与纸纹量化",
        "盲测集当场冻结：图号+文件哈希写入冻结清单并回填画布节点，后续解构、临摹、变体各步禁止引用，只留最终盲测比对用"
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
      "deliverable": "五维 DNA 解构 JSON 与证据局部图：笔触/色盘/光观察/构图习惯/题材偏好",
      "inputFrom": "上一步「采代表作」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "五维 DNA 必须拆到笔触厚度/方向/干湿、颜料堆叠、纸纹材质、HEX 色盘、光源方位、明暗交界、视点裁切与负形",
        "题材偏好只记录画什么；观察方式记录怎么看，例如边缘处理、环境色渗入、阴影补色与视觉焦点路径",
        "拒绝大气、唯美、电影感等不可验证套话；每条都要有数值、方向、比例、频率或原作局部证据",
        "色盘量化：HEX 主色 5-8 个按画面占比降序排（主色/辅色/点缀色三档），光源方位用钟点角度写死（如 10 点钟方向、约 45° 侧逆光），禁止只写「暖色调」",
        "证据登记规则：每条特征挂证据 asset_id + 局部定位（如 asset_007 左上 30% 区域的笔触走向），无证据特征标「待补证」不计入 gate 的≥3 条统计"
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
      "deliverable": "用户逐条签核的 style DNA 卡与两张原作局部对位图",
      "inputFrom": "上一步「拆DNA」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "每条 DNA 必须可回看原作局部，不让用户只凭抽象文字签核",
        "用户修正项写入 revision_log；高权重项在后续逐维对拍中权重 x2",
        "无持续授权且未覆盖预算时，没有明确批准不能进入临摹或批量生图；完全访问或自动模式经独立评审后继续",
        "签核定版号 style_dna_approved_v1，版本号写进后续每张临摹的 prompt_snapshot 备查；revision_log 逐条记「谁改的/改了什么/依据哪张原作局部」",
        "两张对位图各圈 3 处高权重特征锚点（笔触走向线、明暗交界带、色盘取样点），签核时由独立评审逐处核对；用户明确要亲自签核时让用户逐处点选确认，不接受整图扫一眼通过"
      ],
      "gate": "逐条核实并锁定版本；完全访问或自动模式由独立评审签核，用户明确要亲自确认时才等用户。存在未决条目、来源不明条目或高权重项未核实时，工作流停留在本步",
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
      "deliverable": "逐维对拍 5 张、综合临摹 2 张、原作并排对照板与逐维还原度表",
      "inputFrom": "上一步「签解构表」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "固定 seed 贯穿同一轮对拍，差异只允许来自 prompt 的单一维度替换；seed 必须同时写入 seed_log 与 prompt_snapshot",
        "笔触复现写厚度、笔触方向、颜料堆叠和干湿边缘；材质复现写可见 paint ridges、干底层覆盖和冷压纸纹显现",
        "逐维还原度=复现成功特征数/该维 DNA 特征总数；低于 60% 回到解构表补写，高权重项低于 85% 不放行",
        "StyleAligned 与 StoryDiffusion 都是研究中的一致性机制，本 harness 未接 upstream，只能用固定 seed、同一 prompt 骨架和人工对拍",
        "逐维替换法控制变量：prompt 骨架（材质短语+观察层短语原文复用）保持不动，一轮只换一个维度的描述词；每维 5 张去掉还原度最高与最低各 1 张，取中间 3 张的中位数计分，防偶然命中",
        "7 张对照图（5 逐维+2 综合）统一尺寸 1024x1024 并排贴板，与原作局部左右对照；每次生图先向用户说明这张在验哪个维度再扣费"
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
      "deliverable": "3x3 泛化矩阵（3 个新题材 x 3 个新构图）与逐格 DNA 泛化判定表",
      "inputFrom": "上一步「拍临摹对照」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "泛化检验必须离开艺术家惯用题材，验证怎么看仍成立，而不是重复画花瓶或同一人物",
        "9 格共用观察层 DNA，变量只改题材与构图；同一 seed 便于对照，但不等同于已获得 StyleAligned 一致性",
        "任一格丢失两个以上 DNA 维度即标为 outlier，检查题材词是否偷偷带回了画什么层",
        "判定表逐格填字段：格号、题材词、构图词、seed、保留维度数（0-5）、丢失维度名、outlier 判定（是/否）、原因备注；9 格全部入表，禁止空格或只记结论",
        "选材硬指标：3 个新题材中至少 1 个与艺术家惯用题材零重叠（如风景画家换工业静物），3 个构图覆盖远/中/近三种景别 + 各自不同视点高度"
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
      "deliverable": "LoRA 可选轨实验记录：数据集/caption/参数/同 seed 对比；若未接 upstream 则交付明确跳过记录",
      "inputFrom": "上一步「跑变体矩阵」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "LoRA 原理上冻结基础权重并注入可训练低秩矩阵，但本 harness 没有训练、上传或挂载 upstream；不能把参数起点写成已可执行能力",
        "若未来接通训练，caption 只写内容不写风格，且必须同 seed 同 prompt 比较纯 prompt 与 prompt+LoRA",
        "当前执行结果应是 unsupported_skip，不生成假模型文件，直接回接已通过矩阵的 prompt 骨架",
        "skip 记录须含可复算字段：skip_reason=upstream_unavailable、替代方案=固定 seed+共享 prompt 骨架（写明骨架版本号）、引用已通过的 3x3 矩阵结论；记录归档后未来真接通训练时可直接被同 seed 对比实验覆盖更新"
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
      "deliverable": "6-8 张原创成组作品与五维一致性自查表",
      "inputFrom": "上一步「试LoRA」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "成组共用怎么看的 DNA（笔触逻辑、色盘纪律、光处理、材质），但题材、构图和叙事必须原创且不复刻代表作",
        "每张生成后逐条核对五维；掉维就重生成或记录人工修复，不把 outlier 混入最终系列",
        "StyleAligned/LoRA 未接通时只报告固定 seed + 共享 prompt 骨架的实际方法，不宣称注意力共享或适配器已生效",
        "自查表四维打分：五维还原度（≥70%、高权重≥85% 复用临摹阈值）、组内色盘纪律（HEX 主色偏移≤2 档）、构图查重（任意两张的景别/视点/负形三项不完全相同）、题材查重（对照代表作库无单一复刻）",
        "成组张数 6-8 张为人工逐张自查的可控上限；一张一张生成、逐张过自查表后再下一张，掉维重生成不超过 2 次即记人工修复待办"
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
      "deliverable": "内化证物档案：代表作图库、签核 DNA 卡、逐维对拍、3x3 矩阵、LoRA 跳过记录、原创成组与可复用 prompt 骨架",
      "inputFrom": "上一步「做原创成组」产物结构化注入；引用其 artifact 作为本步输入",
      "promptNotes": [
        "骨架 prompt 拆成笔触、色盘、光观察、构图、材质五个可复用模块，并保留题材层为变量",
        "每张结果旁登记 seed、prompt snapshot、模型、尺寸、来源节点和 gate 结论，确保能复现也能追责",
        "把 StyleAligned、StoryDiffusion、LoRA、VLM 的 unsupported 状态归档，避免后续用户把研究方法误读成已接能力",
        "证物链用 asset_provenance_archive 按节点-资产映射登记：节点 ID、artifact 类型、asset_id 清单、gate 结论与时间戳；要求任一张成品图 3 跳内可追到源原作 asset_id",
        "可复用 prompt 骨架以 JSON 存档：笔触/色盘/光观察/构图/材质五模块各自带使用说明与适用范围，题材层留空位变量；unsupported 清单四项各附当前真实替代方法，防止误读为已接能力"
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
}
;
