# 片场编译器：把运行时从模型手里拿回来

> 2026-10-28。Eimu 全局改造方案。
> 本文档取代 2026-09-29《双真相边界（W5）》里“双真相是取舍，不是缺陷”的结论。双真相就是这次问题的生成源；旧档保留作历史，不再作为改动铁律。

## 0. 一句话

四个观察是同一条因果链的四个截面：**模型被迫当运行时**。

计划、节点 ID、产物位置、执行状态、用户目标，全都放在聊天记录里。上下文一压缩，这些就腐烂；DSL 只是画布的编辑语言，不是执行语言，改它不影响真正跑的那张图，模型只能退回工具；工具结果又把上下文填满；最后只能靠“写穿回执、字段名”这类形式闸收尾。成片自然出不来。

方案不是再加一层提示词或过滤器，而是把中间那一列从模型手里拿走：

**一个可执行的生产图（ProductionGraph）＋一个增量执行器＋一个从状态派生的上下文＋一个产物级交付闸。**

DSL 是这张图的作者面，画布是这张图的视图，模板是这张图的配方。模型只做导演、编剧、评审，不再做调度、内存和验收。

---

## 1. 现场：四个观察各自的硬证据

### 1.1 DSL 没有执行器

- `src/lib/workflow-dsl/schema.ts:27` 的 `kind` 只有 `image | text | video | audio | director`，没有 `film`、`render`、`qc`、`deliver`。
- `src/lib/workflow-dsl/compile.ts:445-460` 的编译产物只有 `add_node / update_node / connect_nodes / delete_* / select_nodes / set_viewport`，没有任何“执行”动作。
- `deploy-staging/opencode-runtime/tools/workflow_start.ts:6` 只接受 6 个模板 id：`single_image / character_sheet / scene_setup / single_video / feature_film / novel_film`。
- 真正执行的是另一套：`deploy-staging/gateway/workflow-service.ts:226` 的 `startSync` 只从模板展开图，`workflow_generate` 只跑这张模板图。

结论：**模型自己写的 DSL 无法执行**。它只能被编译成画布操作，而画布操作不会启动生成。模型要出片，只能走“模板 id”或“逐个调工具”两条路，DSL 不在其中。

### 1.2 画布与执行是两张图

- 写面：`workflow_write` → `/workflow/compile` → `canvas_apply_ops` → 前端 reducer（`deploy-staging/opencode-runtime/tools/workflow_write.ts:68-77,148`）。
- 执行面：`ActiveWorkflow.graph` 存在网关内存/快照里（`deploy-staging/gateway/workflow-service-types.ts:47-62`），`workflow-gw-service.ts:177-179` 按 `kind === "film"` 调 `assembleFilmNode`。
- 本次取证没有找到“画布 ops 回写 `ActiveWorkflow.graph`”的路径。唯一能改执行图的是 `workflow_update_node`（→ `/internal/workflow/node/update` → `workflowService.updateNode`，`workflow-service.ts:391`），但 DSL/画布写面不走它。两套工具各改一张图。也就是说，**模型改 DSL 不保证改到真正会跑的那张图**。

这不是“画布像看板”，而是画布与执行之间没有同一条写路径。模型写得很认真，产物却由另一张图决定，于是它只能反复读、反复写、反复确认，形成形式主义循环。

### 1.3 模板是注释，不是机制

按 `expandTemplate` 实测/同路径推算：

| 指标 | 数值 |
|---|---|
| 模板文件 | 13 个 |
| 展开后节点总数 | 798 |
| 可执行节点（image/video/audio/film） | 66（8.3%） |
| 工具卡/笔记卡/门禁文档卡 | 651 |
| 模板文本量 | 约 101.8 KB |
| `feature_film` 展开 | 70 步，其中 60 步 text，52 步是工具/笔记卡 |
| 可执行步 | 7 |

一个模板 70 步，模型改一个镜头要读写整条“配方文档”。这不是机制卡，是把本该由执行器承担的约束写成了注释。注释越多，模型越难看见真正的可执行骨架，也越容易把“改注释”当成“改片子”。

另外三个模板面互相不一致：13 个模板文件、6 个 `workflow_start` id、8 个面向媒体的配方。模型不知道该信哪一个。

### 1.4 成片路径没有接上

- 对外技能 `public/plugin/eimu/skills/film-production/SKILL.md:12` 明写：“Eimu 的 MCP 没有成片导出工具。”
- 同档 `:52` 明写：“剪辑、拼接与字幕由用户在本地完成；本流程交付到素材为止。”
- `timeline_master` 在 `deploy-staging/opencode-runtime/opencode.json` 出现 14 次，全部 `false`。
- 唯一真正产出 mp4 的是 `assembleFilmNode`（`deploy-staging/gateway/workflow-gw-assemble.ts:13`），它只由 `kind === "film"` 触发，而 DSL 写不出 `film`。
- 时间线路径 `masterExport`（`master.ts:188`）能吃时间线出片，但导出工具对所有 agent 关闭，且和 `assembleFilmNode` 零共享 IR。

结论：**“自然语言进、成片出”在当前公开路径上不存在**。它只在模板引擎的 `feature_film` 侧门里存在，而模型的默认技能告诉它“没有导出工具，交素材就行”。

### 1.5 上下文按设计腐烂

- 冷启动固定开销约 28–30k tokens：工具 schema 14–16k、system 9–10k、当轮注入 4–6k。
- 每轮把记忆、环境、授权、画布指令等约 5k 字追加进**本轮 user message**（`deploy-staging/gateway/messages-gw-types.ts:338-365`、`messages-gw-admission.ts:415-421`），消息被持久化，逐轮重发并累积。
- 压缩触发：40 条消息 / 120k token；压缩输入被截到 60k 字符；**第一条 user 消息只保留前 8000 字**（`deploy-staging/opencode-runtime/lib/context-slim-core.ts:305-393`）。
- 摘要由 opencode 原生 `/summarize` 生成，网关不能传自定义指令；PreCompact 返回的 `newCustomInstructions` 被明文丢弃（`deploy-staging/gateway/messages-gw-compaction.ts:419-424`）。
- 网关自己写的 9 节摘要 prompt（`compaction-policy.ts:226-293`）没有任何调用点，是死代码。
- 第一次不可逆丢失发生在第一次压缩的输入裁剪：简报第 8000 字之后、被 `[...]` 掉的中间证据，摘要模型根本没看见。

结论：**目标不是被“忘记”，是被截断在摘要模型看不见的地方**。换更强的底模只是把第一次崩溃推后，不会改变“状态放在聊天记录里”这个事实。

### 1.6 闸量形式，不量产物

- 画布写穿闸的判据是回执形状：`dry_run !== true && ok !== false` 即算写穿，不看能否执行、有没有产物；每会话只补写一次（`deploy-staging/gateway/canvas-write-gate.ts:111-124,139-146`）。
- 交付闸的判据是契约字段名是否在文本里出现，档头自己写明“这是栏位存在性检查，不是品质检查”（`deploy-staging/gateway/delivery-gate.ts:10-19`）。
- `film` 节点根本不经过交付闸；`assembleFilmNode` 产出的成片也不进 artifact 索引。
- 一段包含 `timeline_ops`、`duration_sec`、`qc` 三个词的文本，配不上任何产物，也能过 editor 的契约。

结论：**闸奖励形式，模型就生产形式**。不是模型爱走形式，是形式是唯一被奖励的东西。

### 1.7 真实语料里的腐烂

来自 `docs/evidence/agent-evolve-20261021/corpus/`（切片，不是完整会话，比例是下限）：

- 主 agent 层 `workflow_write` 161 次，完成且非 dry_run 且 `ok:true` 的 49 次（30.4%）；`dry_run:true` 入参 28 次；`canvas_get_state` 130 次。
- 7 个用过画布的会话，没有一个做到“全部写穿成功”。
- 模型原话：“I don't have the spec in my context”（`packs/pack-0101.md:939`）；“这与我之前摘要不一致……这里明显状态混乱”（`packs/pack-0117.md:884`）；“Possibly it's a run I lost track of.”（`pack-0131.md:9`）。
- 一次会话连续 35 轮凭对话记忆对账、0 工具调用，单步 441,573 tokens（`findings/pack-0140.md:5`）。
- 131 张分镜图任务里，模型把必需的写穿降级成“只读检查一下”，随后转向报价（`pack-0187.md:182-184`）。

### 1.8 换底模没有用

提交 `2ab13dd5c` 把底模实验性切到 `a6claude/claude-sonnet-5-5`，随后 `feee265c9` 回滚。失败形态没有变：仍然是上下文丢目标、工具打转、形式过闸。

原因不神秘：这条任务要求模型在多轮、几十次工具调用、几十分钟生成延迟中，持续记住一张无界的状态图。更强的模型能多记一些，但没有任何模型能保证在任意长度下不丢。**这是角色分配问题，不是智力问题。**

---

## 2. 根因：一条链，五个结构缺陷

```
用户一句话
  → 模型自己编计划（计划只存在上下文里）
  → 逐个调工具（每一步结果回灌上下文）
  → 模型记 ID / URL / 顺序 / 成败（记不住就重读、重问、重试）
  → 上下文涨 → 压缩 → 简报被截断、摘要不可控 → 目标与状态丢失
  → 模型抓住还看得见的形式（写画布、凑字段、反复确认）→ 过闸
  → 没有成片
```

五个结构缺陷：

| # | 缺陷 | 直接后果 |
|---|---|---|
| A | DSL 不是执行语言，只是画布编辑语言 | 模型写的计划跑不起来，只能退回工具 |
| B | 画布图与执行图是两张图 | 改 DSL 不影响产物，画布沦为看板 |
| C | 聊天记录是唯一状态载体 | 压缩即腐烂，目标/ID/回执全丢 |
| D | 模板把机制写成注释 | 改一镜要读写 70 步文档，模型避开 DSL |
| E | 闸量形式不量产物 | 模型学会生产形式，而不是生产片子 |

grok 说“压缩和 harness 的某些 bug”，对了一半。压缩是失血点，但不是病；病是把状态放在会失血的器官里。只修压缩，等于给一个没有内存的进程换更大的 swap。

---

## 3. 目标架构：一个机制，八件东西

```
用户 / 自然语言
   │
   ▼
Contract（任务书：目标/交付/约束/验收/预算，持久、逐字）
   │
   ▼
Director（模型：提案、改图、评审；不执行、不记账）
   │
   ▼
ProductionGraph（唯一真相：节点/端口/状态/产物句柄/版本/锁）
   ├── Canvas（视图 + 控制面）
   ├── DSL（作者面：recipe + 增量补丁）
   └── Executor（增量、缓存、预算、重试、断点续跑）
         │
         ▼
      Artifacts（句柄 + 血缘 + 费用）
         │
         ▼
      QC + Deliver（产物级闸）
         │
         ▼
Context Builder（决策包）──► Director
```

六条不变量：

1. **单一真相**：画布、DSL、执行、产物都从同一张 ProductionGraph 派生。任何事实只写一处。
2. **模型不持有状态**：模型不需要跨回合记住 ID、URL、顺序、成败。每个决策包都从图重建。
3. **声明式增量执行**：一次调用跑一个子图；内容寻址缓存；单节点重跑；回执只回 manifest。
4. **完成是产物属性**：`deliver` 节点探测真实 mp4；文本不能满足闸。
5. **机制卡，不是注释**：模板是类型化配方；知识放 `guidance` 侧栏，不放节点。
6. **人手改过的锁住**：人类编辑产生版本 + 锁；自动补丁不得覆盖。

### 3.1 Contract（任务书）

在首条消息时由网关创建，之后每次用户改口追加新版本。结构：

```json
{
  "version": 3,
  "goal": "做一条 60 秒、8 镜的潮间带短片",
  "deliverable": {
    "type": "film",
    "duration_sec": 60,
    "aspect": "16:9",
    "shots": 8,
    "subtitles": true,
    "audio": "voice+music"
  },
  "constraints": [
    "角色形象跨镜一致",
    "不生成真人肖像",
    "预算 120 币"
  ],
  "acceptance": [
    { "id": "A1", "check": "playable_mp4" },
    { "id": "A2", "check": "duration_within_5pct" },
    { "id": "A3", "check": "audio_stream_present" },
    { "id": "A4", "check": "subtitles_present" }
  ],
  "budget": { "coins": 120, "max_generations": 24 },
  "references": ["art_ref_..."],
  "user_words": ["用户原话逐字保留，不摘要"]
}
```

规则：

- 每次模型调用都**逐字**注入 contract，不压缩、不摘要。
- 用户改口 → 追加版本；旧版本可查；不得模型自行改写验收项。
- 模型可以提出 contract 变更，但必须经用户确认；防止“改写判准后宣称达标”。
- 验收项必须可被 `deliver` 节点机器检查；不可机器检查的，标 `manual`，在交付时明示未验。

### 3.2 ProductionGraph（唯一真相）

```json
{
  "id": "pg_...",
  "version": 12,
  "contract_id": "ct_...",
  "nodes": [
    {
      "id": "shot3.keyframe",
      "type": "keyframe",
      "inputs": {
        "shot": "script.shots[2]",
        "cast": "cast.sheet",
        "scene": "scene.beach"
      },
      "params": {
        "model": "gpt-image-2.5-flare",
        "size": "1920x1080",
        "prompt": "……",
        "seed": 42
      },
      "status": "done",
      "artifact": "art_...",
      "hash": "sha256:...",
      "cost_coins": 1,
      "locked": false,
      "attempt": 1
    }
  ],
  "edges": [
    { "from": "shot3.keyframe.image", "to": "shot3.clip.key" }
  ],
  "outputs": { "film": "film.deliver.film" }
}
```

节点类型（机制卡）：

| type | 输入端口 | 输出端口 | 执行者 | 缓存键 |
|---|---|---|---|---|
| `script` | contract, references | `shots` (json) | LLM worker | prompt + contract hash |
| `cast` | script.characters | `sheet` (image) | 生图供应商 | prompt + refs + model + seed |
| `scene` | script.scenes | `plate` (image) | 生图供应商 | 同上 |
| `shot` | script.shots[i] | `spec` (json) | LLM worker / 直取 | spec hash |
| `keyframe` | shot.spec, cast.sheet, scene.plate | `image` | 生图供应商 | prompt + refs + model + size + seed |
| `clip` | keyframe.image, shot.spec | `video` | 视频供应商 | prompt + key image hash + model + seconds + resolution |
| `voice` | script.dialogue | `audio` | TTS | text + voice + model |
| `music` | contract.mood / music.brief | `audio` | 音乐供应商 | prompt + seconds + model |
| `timeline` | clips[], voice.audio, music.audio | `timeline` (json) | 确定性 | clip hashes + order + transitions |
| `render` | timeline | `film` (mp4) | ffmpeg | timeline hash + preset |
| `qc` | film | `report` (json) | ffprobe/ebur128 | film hash + thresholds |
| `review` | artifacts[] | `verdict` (json) | LLM critic | artifact hashes + rubric |
| `deliver` | film, qc.report | `delivery` (json) | 网关 | film hash + contract version |

稳定 ID 规则：`shot3.keyframe`、`shot3.clip`、`film.render`、`film.qc`、`film.deliver`。不靠 hash 猜身份，不靠 `_origin_node_id` 运输。

**最小编辑单元是单个镜头，不是整份剧本。** `script` 节点只负责首稿：它把剧本拆成 `shot1..shotN` 各自的 `shot` 节点，之后所有修改都打在 `shotN` 上，不重写整份 script。这样改第 3 镜不会让第 1、2、4 镜变 stale。`shot` 节点是文本决策节点，`keyframe`/`clip` 是它的下游；任何一镜的修改只沿自己那条链和最终 render 传播。

节点没有“笔记卡”“工具卡”“门禁文档卡”。知识属于 `NodeSpec.guidance`，只在编辑该节点时展示。

### 3.3 DSL v2：配方 + 补丁

两层，模型平时只写第一层。

**配方层（compact intent）**：

```yaml
use: feature_film
params:
  shots: 8
  seconds: 60
  aspect: "16:9"
  style: "潮间带，阴天，手持，胶片颗粒"
overrides:
  shot3:
    action: "女孩蹲下翻石头，潮水退去"
    camera: "低角度，缓慢推近"
  shot7:
    dialogue: "它还在。"
budget_coins: 120
```

执行器把配方确定性展开成约 25 个可执行节点；画布看到的是展开后的图。

**补丁层（fine edit）**：

```json
{ "op": "set", "node": "shot3.keyframe", "path": "params.prompt", "value": "..." }
```

规则：

- 有类型端口，不是 `needs` 字符串；编译期校验端口是否存在、类型是否匹配。
- 没有 prose 节点；`guidance` 不进图。
- 补丁不需要整份 DSL 往返；模型只交改动，执行器回 `stale` 集合与冲突。
- 配方展开是确定性的；同一配方 + 参数 → 同一图 id。
- 任何节点变更 → 版本 +1；下游标 `stale`；产物缓存不删。

为什么这比单 tool 轻：

- 一次 `plan_run` 跑一个子图，模型只收到一份 manifest（节点 id、状态、句柄、费用），不收每个工具的 schema 和返回体。
- 单镜修改只跑该镜 + 下游 render，不重跑其他镜。
- 相同内容命中缓存，费用 0。

### 3.4 Executor（增量执行器）

对外 API（给模型）：

```
plan_compile(source) -> { graph_id, version, node_count, executable_ratio, warnings }
plan_patch(graph_id, ops) -> { version, stale: [...], conflicts: [...] }
plan_quote(graph_id, targets) -> { coins, per_node: [...] }
plan_run(graph_id, targets?, mode="incremental", budget_coins) -> { run_id, manifest }
plan_status(run_id | graph_id, since_version) -> { changed: [...], summary }
artifact_inspect(handle, kind, budget) -> bounded preview
```

执行语义：

- **dirty set** = targets + 全部下游；`cached` 节点直接返回句柄，不提交供应商。
- **缓存键** = hash(node type, normalized params, 输入 artifact hashes, model, seed)。同键复用，费用 0。
- **并行**：同层 ready 节点并行，受并发上限与预算约束；长任务走现有 job store，不占模型回合。
- **重试/切换**：按节点类型分类；供应商失败重试 2 次，仍失败 → `failed`，费用 0，下游 blocked。
- **断点续跑**：图、状态、job id 持久化；网关重启后恢复 pending/running，不重复扣费。
- **预算**：`plan_quote` 先报价；`plan_run` 超预算拒绝；每节点记 `cost_estimated / cost_actual / supplier_request_id`。
- **锁**：`locked: true` 的节点不可被自动补丁覆盖；冲突返回给人/模型选择。
- **草稿**：`mode="scratch"` 的产物进临时命名空间，带 TTL，不进 plan digest、不可交付；要留就 `promote(artifact)` 进图，否则当场过期销毁。
- **回执**：manifest 只含节点 id、状态、artifact 句柄、费用、一行错误；不含正文、base64、URL 列表。

模型不再“守着生成”。执行器可以跑几十分钟，模型只在检查点醒来。

### 3.5 Context：从状态派生，不从聊天记录摘要

每次模型调用（Worker Session）只给一个决策包：

```
[SYSTEM ROLE] 当前席位的职责、输出 schema、禁止项

[CONTRACT v3] 逐字：goal / deliverable / constraints / acceptance / budget / user_words

[PLAN v12 DIGEST] 只给：
  - 总节点数、各状态计数
  - 当前决策相关节点：id / type / status / artifact 句柄 / 费用
  - stale 集合、failed 节点、open questions
  - 不展开全图，不贴 70 步 JSON

[CURRENT DECISION]
  - node: shot3.keyframe
  - inputs: shot.spec（文本）、cast.sheet（句柄）、scene.plate（句柄）
  - 历史尝试：2 次，最后一次失败原因：安全过滤
  - 可选动作：改 prompt / 换模型 / 换参考图 / 问用户

[EVENT DELTA] 自上次决策以来：
  - 用户原话（逐字）
  - 完成/失败事件（结构化）
  - 评审 verdict（结构化）
  - 预算变化

[ON DEMAND] artifact_inspect(handle) / playbook(node type) / event_search(query)
```

规则：

- **工具返回一律句柄化**：`{ handle, facts, summary }`。正文、base64、长 JSON 落 artifact store；模型要看再 `artifact_inspect`，且预算有上限。
- **生产会话不再用聊天摘要**：上下文从图 + 事件日志重建；事件日志只按保留期裁剪，不做有损摘要。
- **记忆/环境/技能索引不再每轮追加**：静态规则进 system；动态记忆按需 `memory_recall`；技能按需 `skill_get`。
- **Worker Session 按决策创建**：一次决策一个干净上下文；输出是类型化补丁/评审，不是 4000 字散文。父会话只收结构化事件。
- **子代理**：拿决策包，回 JSON + artifact 句柄；主代理不再被 6 条 4000 字唤醒消息淹没。
- **上下文 SLO**：p95 决策包 < 12k tokens；任何单条注入 > 2KB 必须走句柄。

这直接消灭“第 20 轮目标丢了”：目标不在第 20 轮的历史里，它在每一轮的 contract 里。

### 3.6 Gates：只认产物

`deliver` 节点执行：

1. 所有必需节点 `done`，产物 `verified`（hash、bytes、content-type）。
2. `ffprobe`：容器、视频流、音频流、时长、分辨率、fps。
3. 解码测试：`ffmpeg -v error -i film -f null -` 无错误。
4. 响度：EBU R128 在目标 ±2 LU。
5. 黑帧/冻结帧：片头片尾与镜头边界检测。
6. 镜头数/切点：与图里 `timeline` 的期望一致。
7. 字幕：要求的字幕流/文本存在。
8. contract 验收项逐条映射到证据（artifact 句柄 + 探测值）。
9. 账本：节点费用总和 ≤ 预算；每次供应商调用可追溯。
10. 血缘：每个 clip/audio/film 输入必须来自图节点的成功执行，带 node id + artifact hash；scratch 产物、外部下载、手工塞进来的 URL 不得冒充节点产物。想用外部素材，只能作为 `reference` 输入，不能作为 `output`。

交付物不是一个死 mp4，而是四件套：`film.mp4` ＋ `graph.json`（节点、参数、锁、版本）＋ `manifest.json`（每镜 artifact 句柄、hash、时长、费用、供应商 request id）＋ `ledger.json`（实际扣费）。用户可以重新打开、改任意一镜、增量重跑；这才叫“交出去的还能改”。

返回：

```json
{
  "pass": false,
  "deficiencies": [
    {
      "code": "missing_audio_stream",
      "node": "film.render",
      "evidence": "ffprobe: no audio stream",
      "fix": "检查 voice/music 连线与 mix 参数"
    }
  ]
}
```

`turn.done` 只在 `delivery.pass === true` 后放行。写 DSL、写 manifest、写“已完成”都不能过闸。画布写穿闸删除；它不是解药，是形式主义的生成源。

### 3.7 Canvas：同一张图的视图与控制面

默认给用户看的是**分镜板**，不是节点图：一行镜头卡，每张卡有缩略图/首帧、时长、状态、费用、锁；点开看这一镜的参数、参考图、历史版本、重跑按钮。导演不需要先当工程师。

节点图是高级视图，给排障和精确连线用；它和分镜板是同一张 ProductionGraph 的两个渲染，不是两份数据。

- 每张卡：类型、稳定 id、状态（pending/running/done/failed/stale/cached）、缩略图/联系表、实际/预估费用、锁、人话错误。
- 操作：运行该节点及下游、只重跑该节点、查看产物、编辑参数、查看 guidance。
- 人类编辑 → 版本 + 锁；自动补丁冲突可见。
- 没有笔记卡、工具卡、门禁文档卡。知识在侧栏。
- 画布编辑与 DSL 编辑走同一个 `plan_patch`；执行器立刻看到，不存在第二张图。

给人的那一面极简：分镜板、播放器、预算。后面的挽具很密：图、缓存、账本、QC、血缘，但不端到用户面前。

### 3.8 角色：导演不兼摄影、剪辑、验收

| 角色 | 输入 | 输出 | 不做什么 |
|---|---|---|---|
| Director | contract + plan digest | 配方/补丁、评审请求 | 不逐节点调供应商、不记账 |
| Writer | contract + references | `script` 结构化 JSON | 不生成图/视频 |
| Shooter | shot spec + cast/scene 句柄 | keyframe/clip 的 prompt 补丁 | 不排时间线 |
| Editor | clips/audio 句柄 + rhythm | timeline 参数补丁 | 不重新生成素材 |
| Critic | contact sheet + clips + rubric | verdict + 必改项（节点 id） | 不改图、不写交付语 |

每个角色一个 Worker Session，一个决策包，一个类型化输出。这样“一个模型又导又拍又剪，几轮就糊”从结构上消失。

生产席位不再暴露 `image_generate / video_* / music_gen / timeline_*` 这一整排工具；它们变成节点执行器的内部实现。模型只看见 `plan_* / artifact_inspect / review_submit / ask_user`。这不是收权，是把“选供应商、传参考图、轮询、重试、记账”从模型的决策面拿走，让它可以专心写镜头和看片。

---

## 4. 四个观察如何消失

| 观察 | 生成源 | 方案里的消除机制 |
|---|---|---|
| 1. 目标是“自然语言进，成片出” | 公开路径没有导出；模板侧门才有 | `deliver` 节点 + 唯一 render 路径；公开技能重写；媒体意图默认进图 |
| 2. 99% 在成片前上下文腐烂、目标迷失、执着形式 | 状态在聊天记录；压缩截断简报；每轮注入累积 | Contract 逐字常驻；决策包从图派生；生产会话不做聊天摘要；记忆按需 |
| 3. 换更好的底模也一样 | 模型被迫承担无界记忆/调度 | 角色分离；模型不持状态；执行器跑长任务；便宜模型也能用 |
| 4. DSL 沦为形式；模型用工具绕过；8 个模板是注释；全量跑太重 | DSL 无执行器；画布与执行两张图；模板 8.3% 可执行；无增量 | DSL 编译成可执行图；`plan_run` 跑子图 + 缓存；模板变配方；画布同图 |
| 5. 工具调用注入大量上下文 | 工具返回原样回灌；每轮 schema + 注入 | 句柄协议；`artifact_inspect` 按需；席位只暴露少量 plan 工具 |
| 6. 改一镜要全量跑 | 无内容寻址缓存、无 dirty set | 节点 hash + 下游 stale；单镜重跑；其他镜复用 |
| 7. 画布是看板 | 画布 ops 不回写执行图 | 单一 ProductionGraph；画布/DSL 都是它的视图 |

---

## 5. 迁移：先止血，再换引擎，最后拆旧路

不搞大爆炸。每个阶段有独立验收，功能开关按会话灰度，可回滚。

### Phase 0（第 1 周）：止血

1. **Contract 落库**：首条消息生成 contract，逐字注入；用户改口追加版本。
2. **停掉每轮 tail 累积**：记忆/环境/技能索引改为按需或稳定前缀；不再追加进 user message。
3. **句柄协议**：先包 Top 10 大返回（`canvas_get_state`、`workflow_status view=full`、`workflow_history`、`read_image`、`video_evidence`、`timeline_query`、`delivery_assets`、`image_generate` 回执等），统一 `{handle, facts, summary}`；新增 `artifact_inspect`。
4. **产物闸**：媒体会话 `turn.done` 前检查 `delivery`/可播放 mp4；删除画布写穿闸作为完成条件。
5. **修公开矛盾**：`film-production` 技能不再说“没有导出工具、交付到素材”；要么接上 render，要么明确产品边界。
6. **统一成片出口**：`timeline_master` 要么对 editor 开放并接 QC，要么废弃；只保留一个 render 实现。

验收：一条 1 镜测试片，决策上下文 < 12k tokens；工具返回 0 条 > 2KB 原始载荷；没有 mp4 时闸必须失败。

### Phase 1（第 2–4 周）：可执行图纵切

1. ProductionGraph schema + NodeSpec registry。
2. 扩展 `workflowService`：接受任意图，不再只接受模板 id；保留模板展开作为 recipe builder。
3. 节点执行器：`script / keyframe / clip / voice / render / qc / deliver` 七类先跑通；复用 `assembleFilmNode`、`film-qc`、job store、artifact store。
4. `plan_compile / plan_patch / plan_quote / plan_run / plan_status` 工具；`workflow_write` 变成兼容别名。
5. 内容寻址缓存 + dirty set + 单节点重跑 + 预算闸 + 锁。
6. 3 镜、30 秒纵切片：自然语言 → 配方 → 图 → 出片 → QC → 交付。

验收：改 shot2 的 prompt，只重跑 `shot2.keyframe → shot2.clip → film.render → film.qc`；其他镜头与音乐命中缓存、费用 0；交付 mp4 通过解码/时长/音轨检查。

### Phase 2（第 5–6 周）：状态派生上下文

1. Context Builder：contract + plan digest + current decision + event delta。
2. 生产会话关闭聊天摘要；保留事件日志与按需检索。
3. Worker Session：每个决策一个干净上下文；输出类型化补丁/verdict。
4. Critic 接 contact sheet + clips，输出节点级必改项。
5. 记忆/技能/环境全部按需。

验收：20 条真实媒体会话 A/B；p95 决策包 < 12k tokens；日志里 0 次“目标丢失/ID 丢失”导致的返工；子代理唤醒消息不再进入主上下文。

### Phase 3（第 7–8 周）：模板、画布、拆旧路

1. 6 个公开模板重写成 recipe；`feature_film` 先做；可执行节点占比 ≥ 80%；删除工具/笔记/门禁文档卡。
2. 画布卡片、运行控制、锁、费用、错误；guidance 侧栏。
3. 生产模式：可交付产物必须来自图节点；直接生成工具只允许 scratch，不进交付。
4. 删除旧画布写穿闸、字段名交付闸、死代码（9 节摘要 prompt、无消费者的 `editing_manifest` 等）。
5. 监控上线：图运行覆盖率、缓存命中、成片率、单镜返工时长、上下文预算。

验收：staging 媒体会话成片率 ≥ 80%；0 次文本过闸；模板可执行占比 ≥ 80%；单镜返工 < 5 分钟。

---

## 6. SLO

| 指标 | 现状 | 目标 | 测量 |
|---|---|---|---|
| 媒体会话图运行覆盖率 | 约 1%（`canvas-write-gate.ts` 注释/记忆，未复核） | ≥ 80% | `plan_run` 成功会话 / 媒体会话 |
| 成片率（可播放 mp4） | 未统计；公开技能无导出，只有模板侧门 | staging ≥ 80%，生产 ≥ 60% | `deliver` 闸通过率 |
| 单次决策上下文 | 28–30k 固定 + 累积（估算） | p95 < 12k tokens | 网关计量 |
| 原始工具载荷 > 2KB 进入上下文 | 常见 | 0 | 句柄协议审计 |
| 单镜修改缓存命中 | 0（无缓存） | ≥ 60% | 节点 hash 命中 |
| 单镜返工时长 | 全量重跑 | < 5 分钟 | run events |
| 文本过闸 | 可能 | 0 | 交付闸审计 |
| 人类编辑被覆盖 | 未统计 | 0 | 锁冲突日志 |
| 每片费用 | 模型自报 | 预算内、账本 100% 对账 | 节点账本 |

---

## 7. 不做什么

- **不再加提示词规则强迫模型用 DSL**。模型不是不听话，是 DSL 没有因果效果。把机制修好，比写一百条“必须用 DSL”有用。
- **不再加文本闸/过滤器**。闸只量产物，不量措辞。
- **不再调摘要 prompt**。opencode `summarize` 不接受自定义指令；生产会话不依赖它。
- **不把换底模当修复**。底模可以换，但换不掉“模型当运行时”。
- **不保留两套组装真相**。图与时间线只能有一个 render 入口。
- **不把知识做成节点**。模板里不能执行的步就是注释；注释放 guidance。
- **不在生产席位暴露 49 个工具**。模型 API 收敛到 plan/artifact/review/ask。
- **不搞大爆炸**。按会话灰度，旧模板路径保留一个版本，随时回滚。

---

## 8. 风险与未决

1. **VPS 活本与 repo 镜像可能漂移**。`deploy-staging/gateway/` 是镜像，活本在 `/opt/agent-harness/gateway/`；动手前先逐档 md5 比对。双真相文档已警告过这一点。
2. **opencode 内部摘要提示词不可见**。本方案不依赖它；但 Phase 0 仍要处理存量会话，需接受旧摘要的损失。
3. **创作质量**。类型化节点只约束管道，不约束品味；`prompt`、`guidance`、`review` 仍由模型/人写。纵切片要同时验“能出片”和“值得看”。
4. **迁移期双跑**。功能开关按会话；新路径失败可切回旧模板路径；两套不能共享同一份产物命名空间，避免污染。
5. **异步任务与重启**。执行器复用现有 job store；要补“同一 node hash 的 in-flight 去重”，防止重启后重复扣费。
6. **人手编辑冲突**。锁 + 版本 + 冲突提示；自动补丁不得静默覆盖。
7. **产品交互**。用户看到的仍是一条聊天线；内部是多个 Worker Session。需要把“决策包/评审”翻译成人话进度，不暴露内部术语。
8. **2 核 VPS**。执行器本身轻；重活在供应商与 ffmpeg。部署仍走离机预构建，不在生产机全量 build。

---

## 9. 五句判据

1. 需要模型跨回合记住 ID / URL / 顺序 → harness 的 bug。
2. 一段文本能满足的闸 → 假闸。
3. 模板里不能执行的步 → 注释，不是机制。
4. 同一个事实写在两个地方 → 下一次漂移。
5. 模型在跑调度 → 架构错。

---

## 附录 A：文件级改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| DSL | `src/lib/workflow-dsl/schema.ts` | 增加 `film/render/qc/deliver` 等 kind；端口类型；稳定 id 规则 |
| DSL | `src/lib/workflow-dsl/compile.ts` | 编译到 ProductionGraph / 图补丁，不再只产画布 ops |
| DSL | `src/lib/workflow-dsl/decompile.ts` | 从图生成 recipe + overrides，不生成 70 步文档 |
| 执行 | `deploy-staging/gateway/workflow-service.ts` | `startSync` 接受任意图；`executeGraph`；dirty set；缓存 |
| 执行 | `deploy-staging/gateway/workflow-engine.ts` | recipe builder；NodeSpec registry；拓扑与端口校验 |
| 执行 | `deploy-staging/gateway/workflow-gw-service.ts` | 注册 `render/qc/deliver`；复用 `assembleFilmNode` |
| 执行 | `deploy-staging/gateway/workflow-gw-assemble.ts` | 输入改 timeline IR；镜头顺序来自图，不来自 id 字符串 |
| 存储 | `deploy-staging/gateway/artifact-store*.ts` | 内容寻址索引；句柄；血缘 |
| 上下文 | `deploy-staging/gateway/context-injection.ts` | 决策包 builder；删 tail 累积 |
| 上下文 | `deploy-staging/gateway/messages-gw-*.ts` | contract 注入；Worker Session；停用生产摘要 |
| 压缩 | `deploy-staging/opencode-runtime/lib/context-slim-core.ts` | 只保留事件/句柄裁剪；不截 contract |
| 闸 | `deploy-staging/gateway/canvas-write-gate.ts` | 删除作为完成条件 |
| 闸 | `deploy-staging/gateway/delivery-gate*.ts` | 产物探测；deficiency 结构 |
| 工具 | `deploy-staging/opencode-runtime/tools/plan_*.ts` | 新增 compile/patch/quote/run/status |
| 工具 | `deploy-staging/opencode-runtime/tools/artifact_inspect.ts` | 有界预览 |
| 工具 | `deploy-staging/opencode-runtime/tools/workflow_write.ts` | 兼容别名 → plan_patch |
| 配置 | `deploy-staging/opencode-runtime/opencode.json` | 席位工具面收敛；timeline_master 一致性 |
| 对外 | `public/plugin/eimu/skills/film-production/SKILL.md` | 重写成图流程；删“没有导出工具” |
| 画布 | `src/hooks/canvas/*`、`src/components/canvas-workstation/*` | 卡片状态/运行/锁/费用/guidance 侧栏 |
| 文档 | `docs/architecture/dual-truth-boundary.md` | 标记被本文档取代 |

## 附录 B：复核命令

```bash
# DSL 是否有 film/render/qc
rg -n 'kind\?:' src/lib/workflow-dsl/schema.ts

# workflow_start 的模板白名单
sed -n '1,20p' deploy-staging/opencode-runtime/tools/workflow_start.ts

# 画布写面是否只产 ops
rg -n 'add_node|update_node|connect_nodes|run_generation' src/lib/workflow-dsl/compile.ts

# 执行面是否只认模板
rg -n 'startSync|expandTemplate|templateId' deploy-staging/gateway/workflow-service.ts | head

# 成片工具是否全关
rg -n '"timeline_master"' deploy-staging/opencode-runtime/opencode.json

# 每轮 tail 注入
sed -n '330,370p' deploy-staging/gateway/messages-gw-types.ts

# 压缩输入裁剪
sed -n '305,355p' deploy-staging/opencode-runtime/lib/context-slim-core.ts

# 摘要自定义指令被丢
sed -n '405,430p' deploy-staging/gateway/messages-gw-compaction.ts

# 交付闸只查字段名
sed -n '1,30p' deploy-staging/gateway/delivery-gate.ts

# 模板可执行占比（按 expandTemplate 统计）
# 参考：workflow-templates/ + workflow-engine.ts:97
```
