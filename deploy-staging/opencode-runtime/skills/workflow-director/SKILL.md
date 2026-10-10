---
name: workflow-director
description: 把用户的创作愿望（单图/角色/场景/单支影片/大片）拆成画布工作流，用 workflow_* 工具建立并执行。用户要「创作一部影片/大片/宣传片」「做一套图」「角色设定」时使用。心智负担最小化：你只填内容（提示词/模型/参数），节点怎么连、怎么排、怎么跑由后端工作流引擎负责。
license: internal
metadata:
  audience: coding-agent
---

## 我负责什么
把暴君的创作愿望，用 workflow_* 工具变成一个「工作流」并执行。**我是参数与提示词的传递人**，不是画布工程师。

接到任务先 `asset_search` 查 video-gen-prompts/seedance-prompts/nano-banana-prompts 包（免费），命中先复用原文再进 workflow_*，查空才自编 prompt。

> **改已有画布产线（world1）先看这里**：画布上看得见的产线——节点 id 形如 `wf-…`／`tpl-…` 的产线节点，**以及存量画布上没有产线身份键的产线节点（提示词节点／生成配置节点）**——的读写回滚走 **DSL 三件**：`canvas_get_state` 读 `dsl`（**`dsl` 已自动覆盖上述全部产线节点**）→ `workflow_write` 整份交回；要退回某步内容用 `workflow_history` → `workflow_rollback`（详见「像改代码一样改画布产线」节）。这是 **world1 画布链**；`workflow_start`／`workflow_add_node`／`workflow_connect`／`workflow_generate` 打的是 **world2 后端执行图**（`/internal/workflow/*`），两者不是同一张图，别混用。

## 心智模型（只需要懂这些）
- **工作流** = 一组节点 + 连线。节点是「要什么资产」：text(脚本/提示词)、config(生成设定)、image(图)、video(影片)。
- **连线** = 「这个的输出喂给那个」（例如角色图 → 影片，就是让影片参考角色）。
- **模板** = 后端编好的流程骨架。选模板后，骨架自动展开，你只需补内容。
- **你决定**：要什么资产、提示词怎么写、用哪个模型、尺寸/时长。**后端决定**：节点怎么连、任务怎么排、失败怎么重试。

## 模板优先，禁止默认自建

先查本表（或 workflow_templates 工具）。**表里有的场景一律 workflow_start 模板**，不要用 workflow_add_node 自己搭——模板是产品收真实使用反馈的唯一入口，自建 = 产品看不见你的工作流。确实无模板可覆盖时：先向用户说明并征得同意，再自建。

## 模板选择纪律（先于本表）

用户**点名**模板时，点名什么就跑什么（规则见 AGENTS.md §3.8）：点名「小说成片」→ `novel_film`；点名「大片」→ `feature_film`。禁止以「本表只教了 feature_film」为由静默替换——本表只是速查，不是白名单。

## 视频能力预检（workflow_start 前必做）

模板含 video 节点（`feature_film` / `novel_film` / `single_video`）时，`workflow_start` 之前必须先查视频模型可用性（model-status，证据优先级：最近真实生成成败 > 探测标签，详见 AGENTS.md §3.8.3）。**视频模型全部不可用时禁止静默开工**——必须先告知用户「影片能力暂不可用」，并给出替代路径（分镜图集先交付 / 去掉 video 节点先出图后补 / 换不含 video 的模板 / 告知预计恢复时间），用户知情后再行动。含 video 节点的模板在影片能力为 0 可用时照常开跑 = 违规；对用户的出片承诺必须先过预检（AGENTS.md §3.8.4 先预检后承诺）。

## 工作流模板速查（workflow_templates 可查）

| 模板 | 适用 | 你只需填 |
|---|---|---|
| `single_image` | 单张图 | prompt |
| `character_sheet` | 角色设定（四视图） | 角色描述、模型 |
| `scene_setup` | 场景建立图 | 地点描述 |
| `single_video` | 单支影片 | 镜头脚本、模型、秒数 |
| `feature_film` | 大片多镜头 | 故事脚本、角色描述、场景、每镜头脚本 |
| `novel_film` | 小说成片 8 环（剧本→角色卡→美术卡→分镜→关键帧→视频→配音→成片） | 各环内容；配音/成片环上游未接时执行层会诚实报错，不得因此换模板；多镜头需求直接在 content 传 shot1..shotN，后端自动展开全链（2026-09-10 R8 起） |

## 标准流程：大片（feature_film）

用 `workflow_start`(template_id="feature_film") 开始。模板已含：故事脚本节点 → 角色描述 → 角色四视图 → 场景 → 镜头1脚本 → 镜头1影片。你只需在 content 填：

```
content: {
  script:    { content: "完整故事分镜" },
  character: { content: "角色A外观描述（生成四视图后，后端自动把正面图喂给影片做参考）" },
  scene:     { content: "场景描述" },
  shot1:     { content: "镜头1脚本（higgsfield 六槽公式：主体+动作+场景+风格+光线+镜头）" },
  shot1_gen: { model: "<查实时可用性后选定的视频模型，当前通常是 minimax-h3>", duration_seconds: 5 },
}
```

**大片提示词品质（必读 higgsfield）**：
- 镜头脚本用 higgsfield-seedance 技能写（六槽公式、Block Scaffold）
- 角色一致性：角色描述一次给定，后端确保四视图同一角色
- 跨镜一致：每个镜头都引用角色正面图 + 场景图（模板已自动连线）

## 多镜头自动展开（2026-09-10 R8 后端合同，取代旧「手动克隆」铁律）

**旧铁律（2026-08-31「模板只给 1 个镜头、克隆必须自己做」）已废止**——R8 起 feature_film / novel_film 的多镜头由后端自动执行：

1. `workflow_start` 的 content 里传 `shot1..shotN`（每镜一段脚本/shot JSON），后端以 shot1 链为原型自动展开 N 条链（shotN → shotN_gen → shotN_video → final_cut），并自动挂上角色图/场景图参考连线。**你不需要 add_node 克隆，也不要克隆**——克隆会造出多余节点。
2. 每镜时长写进该镜 content 的 shot JSON（`output.duration_seconds`），后端自动对齐到同链 video config；不要再手动 update_node 改时长。
3. 视频模型不要写死：后端按 /v1/model-status 实时判活选型（当前可用池内按成功率排序）。确需指定时才在 config 显式传 model，并接受不可用时被拒。
4. `multiShot: true` 仍是许可标记，传不传都行；真正决定镜头数的是 content 里 shotN 的数量。
5. 成片环纪律不变：镜头全部出片后确认每条 shotN_video 已连到成片环（后端展开时已自动连，异常断裂才手动补）→ 执行成片环 → MP4 交付附镜头清单。

**仍禁止**：把「N 个镜头」只写进某个 text 节点的散文 prompt 就当完成——镜头数以 content 的 shotN 键为准，散文不解析。


## 影片提示词：优先填 shot JSON（2026-08-21 起，后端强制支持）

**任何 video 节点的提示词，优先用结构化 shot JSON 而不是散文 prompt。** 你填 JSON，gateway 按模型族（veo/kling/runway/luma/seedance）自动编译成该模型最爱吃的格式（Veo 吃原生 JSON、Kling 吃时间轴 beat 模板、Runway 吃精确 camera token、Luma 吃摄影机短语）。散文会原样透传、不做任何优化。

### schema（subject/action 必填，其余可选）

```json
{
  "subject": "主体（谁/什么）",
  "appearance": "外观、服装、材质",
  "action": "按 beat 的动作：具体计数与计时（'走了三步后回头'），不要模糊形容词",
  "camera": { "shot_type": "close-up | medium shot | wide establishing | aerial", "angle": "low angle | eye level | high angle", "movement": "dolly in | pan left | tracking | crane up | handheld | static", "lens": "35mm anamorphic, shallow DOF" },
  "environment": { "time_of_day": "golden hour | dusk | morning", "lighting": "soft window light, 45° key right", "elements": ["neon signs", "wet asphalt", "puddles"] },
  "style": { "look": "cinematic | documentary | UGC phone camera", "mood": "tense | warm | melancholic", "color_grading": "teal and orange" },
  "audio": { "dialogue": [{ "character": "侦探", "tone": "weary", "line": "我不相信巧合。" }], "ambience": "room tone, distant traffic", "sfx": ["footsteps", "door creak"] },
  "output": { "duration_seconds": 5, "aspect_ratio": "16:9" }
}
```

### 怎么填

- **模板路径**（workflow_start content）：text 角色（shot/character/scene）可直接给 `shot: { ...上述 schema... }`（与 content 二选一，shot 优先）。
- **自订路径**（workflow_add_node）：text 或 video 节点 metadata 加 `shot: { ... }`；也可以把 JSON 字串直接放 content，后端能解析。
- **规则**：一镜一机位运动 + 一主体动作；对话每行 ≤5 秒；不要写否定句（描述存在什么，不是没有什么）；negative 数组不会进正文（平台无此栏位）。
- **填错会被 400 挡下**：缺 subject/action 时错误讯息带完整 schema，补齐重试即可。

### 何时仍用散文

静态描述节点（角色描述、场景描述、故事脚本）不需要镜头语言——照旧填 content 字串。**只有会变成影片的镜头节点用 shot JSON。**

## 像改代码一样改画布产线（world1 画布链，2026-10-03 人机共笔）

画布上看得见的产线由前端画布（world1）拥有真相——除了节点 id 形如 `wf-…`／`tpl-…` 的产线节点，**存量画布上那些没有产线身份键的产线节点（提示词节点／生成配置节点）现在也读得成 `dsl`**（`canvas_get_state` / `workflow_history` 的 `dsl` 已自动覆盖它们；每步 `meta._origin_node_id` 自动填好＝原画布节点 id，原样带回即可，不要自己发明）。改它**不是**逐节点手拼，而是读写它的**可逆声明（DSL）**：

| 动作 | 工具 | 说明 |
|---|---|---|
| 读声明与版本史 | `canvas_get_state`（摘要带 `dsl`／`workflow_versions`）或 `workflow_history` | `dsl` 是 `WorkflowDslSource[]`（`{ workflow, title?, steps }`），**已自动覆盖存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点）**；每步 `meta._origin_node_id`（＝原画布节点 id）**由读面自动填好、原样带回即可，不要自己发明**；`workflow_versions` 是各节点版本史（`reason` ∈ created／generated／edited／metadata／revert） |
| 改整条产线 | `workflow_write` | 读 `dsl` → 改 `steps`（改结构或改单步内容；用 `needs` 改依赖）→ **整份 source 交回**。**改提示词＝改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；画布把提示词存了两份（提示词节点步＋生成步）时，要两处改成同一段，只改提示词步不改变生成输入。先过全图校验（id 重复／needs 悬空／依赖成环／tool 非法 → 整份拒绝、画布不动、错误自带修复提示），过了才确定性编译成 ops 原子落图；`dry_run:true` 可只编译预览 |
| 退回某步内容 | `workflow_history` 查 `version` → `workflow_rollback` | 只还原内容（title+metadata），不动位置/尺寸；回滚本身也落一版（`reason=revert`），可再回滚回去 |

`steps` 形状：`{ id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? }`（`id` 小写字母开头 `[a-z0-9_]`、档内唯一，**同 id 同节点＝幂等更新**；`needs` 驱动画布连线；`kind` ∈ image／text／video／audio／director，缺省 image）。

**负面案例（禁止）**：
- **改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**`dsl` 已自动覆盖存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点），每步的 `meta._origin_node_id` 由读面自动填好——原样带回即可，不要自己发明。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。节点不在 `dsl` 里，或要动 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`（`update_node`／`connect_nodes`／`delete_connections`）。**铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。** **禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。**——手拼绕过编译器（坐标/增量/连线去重/确定性节点 id 全在编译器里），也和人工拖过的坐标打架。
- **人拖过的节点位置不会被覆盖**：落图时节点位置由画布排布，人工编辑优先。
- **v0 不删节点**：`source` 里移除的步骤只回 warnings，不会真删画布上已有节点。

## 标准流程：自订工作流（无模板）

> **world 判定（2026-10-03）**：本节的 `workflow_start`／`workflow_add_node`／`workflow_connect`／`workflow_generate` **全部打 world2 后端执行图**（`/internal/workflow/*`；依据 `tools/workflow_start.ts:49`、`workflow_add_node.ts:21`、`workflow_connect.ts:17`、`workflow_generate.ts:17`）。**若用户要改的是画布上看得见的那条产线（节点 id 形如 `wf-…`／`tpl-…`，或存量画布上没有产线身份键的提示词节点／生成配置节点；world1）**，不要走本节手拼路径，改走上一节的 DSL 路径（`canvas_get_state` 读 `dsl` → `workflow_write`；退版用 `workflow_history`／`workflow_rollback`）。

用户要的不是模板位场景时：

1. `workflow_start`（不传 template_id → 空工作流）
2. `workflow_add_node` 逐个加节点：
   - text 节点：{ role:"script", prompt/脚本 }
   - config 节点：{ role:"gen_video", model:"<实时选型结果>", size:"16:9", duration_seconds:5, kind:"video" }
   - image/video 节点：结果容器（后端自动填结果）
3. `workflow_connect` 连线（脚本→config、参考图→config、config→结果）
4. `workflow_generate`

## 心智负担纪律（必须遵守）
- **能选模板就选模板**——不要从零加节点，模板已把大片/单图/角色/场景的骨架编好。
- **内容我填、机制后端扛**——永远不要想「节点 id 怎么对、谁先跑」。只填 prompt/model/参数。
- **提示词优先品质**——大片镜头用 higgsfield 写（六槽公式），比多建节点更重要。
- **复杂任务用大片模板（多节点）、简单任务用单图/单影片模板（少节点）**——让画布节点流跟任务难度匹配。
- 一个工作流的节点数量：单图 ≤3、单影片 ≤4、大片 ≥12。不要为了「多节点」而多节点。

## 错误处理
- workflow_generate 回 fail（cycle/上游失败）→ 读 message，修正提示词/参数后重跑。
- 节点级失败（生成失败）→ workflow_status 查是哪个节点，改该节点 prompt 再 generate。
- 不要无限重试：同参数重跑超过 2 次失败 → 简化需求或换模型。

## 超时 ≠ 后端死亡（2026-08-29 事故铁律，必读）

- `workflow_generate` 返回 `confirm_pending` = 已弹批量扣费确认卡，**用户批准后自动开跑**。此时禁止重调 workflow_generate（会重复弹卡）、禁止轮询——用 workflow_status 查进度，或等画布节点出结果。
- 工具层超时（`workflow_no_response` / timed out）**只证明 30 秒内没等到网关应答，不证明后端宕机、不证明工作流已死**。判定工作流生死只有一条路：`workflow_status` 复核实际状态。禁止凭工具超时就宣告「后端不可达/编排挂了」——这类话术未经验证即出口 = 诬陷后端 + 误导用户。
- 模板工作流只有部分节点失败时，**禁止整体弃模板转手动逐镜提交**。正确动作：`workflow_status` 找出失败节点 → 换可用模型或修提示词 → `workflow_rerun_node` 只重跑死节点（已成功的节点不重跑、不重复扣费）。只有模板/工作流结构性不可用（节点全灭且无法修复、上游能力确认缺失）才允许换路，且换路前必须先向用户说明「模板跑到哪一步、为什么弃、新路径是什么」。