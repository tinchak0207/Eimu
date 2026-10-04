# R8 — AI 助理 Harness 架构审计：智能重叠 / MoE+Orchestrator 实现不完全 / Dense 残留

日期：2026-09-10。性质：**唯读审计**，不含修复。审计对象＝野兽模式（beast_mode ON）下的
「Orchestrator + Expert 军团」架构。真源＝VPS `/opt/agent-harness/`（活码）＋本机
`src/lib/`（契约）＋`deploy-staging/expert-gateway/`（提示词稿）。

---

## 0. 执行摘要（结论先行）

**一句话**：MoE 改革交付的是「**宣告面**」（注册表、契约、测试、提示词档），但「**执行面**」
（gateway 的 agent 工具表、路由调用点、交付闸门）没交付；而 Dense 时代的 AGENTS.md
从未被纳入改革范围。三轴问题同源。

| # | 结论 | 性质 | 座标 |
|---|---|---|---|
| E1 | **MoE 路由层在生产端零调用**：`routeExpert` / `EXPERT_REGISTRY` / `buildOrchestratorFrame` / `assertExpertToolAccess` 全 repo 只有测试引用，VPS gateway 全域 grep 零命中 | 未接线 | VPS `gateway/` 全域 grep；本机 `src/**/*.test.ts` |
| E2 | **能力断路只落地 4/25 = 16%**：orchestrator agent 只关 4 个工具，21 个 Expert 域工具仍开在 Orchestrator 手上 | 半接线 | `workspace/.opencode/opencode.json` → `agent.orchestrator.tools` |
| E3 | **Expert 端零工具限制（反向漏洞）**：子会话建立 `POST /session` body `{}`、投递 `prompt_async` body 只有 `parts`，无 `agent` 栏 → 子代理拿到全部 97 工具。宪法「域外工具不在你的工具表里」是**假的** | 未接线 | `gateway/subagent.ts` L256-295 |
| E4 | **交付物闸门完全不存在**：宪法第二条第 3 款＋digest 头行宣告的「组装闸门」，gateway 全域 grep `deliverable\|qcSignature\|DELIVERABLES` 零命中 | 未接线 | VPS `gateway/index.ts`、`subagent.ts` |
| E5 | **digest 仍读静态档**（R7 遗留工单 #1 未动）：`readFileSync(expert/registry-digest.txt)`；本机 `buildExpertRegistryDigest()` 动态生成函数存在但生产不用 | 未接线 | `gateway/index.ts:4210` |
| E6 | **两行 Expert 零独占能力**：director3d 与 web3d-director 的工具表 **0 个独占工具**；`image_quote` 出现在全部 7 行 | 设计缺陷 | `src/lib/expert-registry.ts` + digest |
| E7 | **AGENTS.md 与 playbook 正面矛盾**：AGENTS.md §2「你负责扩写成完整 prompt」 vs playbook 第〇节「你本人不产出任何内容…即违宪」 | Dense 残留 | VPS `workspace/AGENTS.md` L36-48 vs playbook L14 |
| E8 | **两条注入路径互不知情**：gateway 完全不碰 AGENTS.md（grep 零命中），`opencode.json instructions: []` → AGENTS.md 靠 opencode 原生载入，与野兽帧分属不同通道，先后顺序无程式保证 | 架构缺口 | `gateway/index.ts` vs `workspace/AGENTS.md` |
| E9 | **playbook 宣告的作战面 ⊄ registry 宣告的域白名单**：playbook 军团用的 `search_web` / `vision_analyze` / `image_generate` / `workflow_*` / `asset_search` **不属于任何 Expert** | 契约不一致 | playbook 第〇节 step 1/6/7 vs digest 7 行 |
| E10 | **3/7 Expert 配方库为空**：video-director / editor / screenwriter 的 `*_PERSONA_SKILL_PATHS = []`，宪法第三条「进 Expert 即载配方库」对其无法履行 | 未接线 | `src/lib/{video-director,editor,screenwriter}-persona.ts` |

---

## 1. 审计范围与方法

方法：**「宣告 vs 物理事实」对照**。对每一项 MoE 契约声明，追到 gateway 的实际执行点；
追不到即判定为「契约宣言」而非事实。

证据来源（全部第一手，非记忆转述）：

| 层 | 位置 |
|---|---|
| 活码 | VPS `/opt/agent-harness/gateway/{index.ts,subagent.ts}`、`gateway/expert/` |
| 配置 | VPS `/opt/agent-harness/workspace/.opencode/opencode.json`、`workspace/.opencode/tools/`（97 档） |
| 提示词 | VPS `workspace/AGENTS.md`（172 行 / 22874 字）、`gateway/expert/*.md` |
| 契约 | 本机 `src/lib/expert-registry.ts`、`*-persona.ts`、`*-delegate.ts`、`orchestrator-beast-frame.ts` |

前置背景：`docs/beast-army-r7-injection-audit.md`（R7 已修注入管线元数据污染，并留下三条遗留工单——
本审计逐条验证其现况）。

---

## 2. 轴一：智能重叠

### 2.1 工具白名单独占度矩阵

EXPERT_REGISTRY 7 行宣告的域工具共 **25 个去重**，其中 **20 个为某行独占、5 个跨行共享**：

| Expert | 工具数 | 独占工具 | 独占数 | 共享来源 |
|---|---|---|---|---|
| director3d | 4 | —— | **0** | `blender_exec`(+motion)、`blender_export_gltf`(+web3d)、`blender_render`(+motion)、`image_quote`(全部) |
| music | 2 | `music_gen` | 1 | `image_quote`(全部) |
| video-director | 4 | `video_quote`、`last_frame_video_chain` | 2 | `video_upload`(+editor)、`image_quote` |
| editor | 11 | `timeline_ops`/`_query`/`_rhythm`/`_style`/`_mix`/`_master`/`_lint`/`_restore`、`editing_manifest`、`audio_first_timeline` | 10 | `video_upload`(+video) |
| screenwriter | 7 | `script_scene_parse`、`storyboard_qc_17`、`story_sequence_consistency`、`canvas_apply_ops`、`doc_struct`、`world_bible_extract` | 6 | `image_quote` |
| motion-director | 4 | `keyframe_render` | 1 | `blender_exec`/`blender_render`(+director3d)、`image_quote` |
| web3d-director | 2 | —— | **0** | `blender_export_gltf`(+director3d)、`image_quote` |

**判定**：
- `image_quote` 在 7 行全出现 → 它是**全域公共前置**（报价对偶），不是域职能。把它写进每一行的
  域白名单，等于宣告「每个专家都有一样的权限」，稀释白名单语义。
- **director3d 与 web3d-director 零独占**。这两行在工具面不可区分——`web3d-director` 的
  `{blender_export_gltf, image_quote}` 是 `director3d` 的**严格子集**。
- director3d 与 motion-director 共享 3/4 工具，唯一分界是 `keyframe_render` vs `blender_export_gltf`。

### 2.2 路由优先序把最高优先权给独占度最低的行

`routeExpert()` 是 `Object.values(EXPERT_REGISTRY)` **插入序 + 首个命中即返回**
（`src/lib/expert-registry.ts:242-258`）。插入序 = director3d、music、video-director、editor、
screenwriter、motion-director、web3d-director。

配合前缀匹配（边界符集 `-_. /:` 含 `_`），实际后果：

| 输入 taskType | 实际命中 | 直觉期待 | 判定 |
|---|---|---|---|
| `3d_motion` | director3d（`3d` + `_` 边界） | motion-director | **吞掉** |
| `blender_animation` | director3d（`blender` + `_`） | motion-director（`animation`） | **吞掉** |
| `motion_3d` | motion-director | motion-director | 正常 |
| `animation` | motion-director | motion-director | 正常（唯一入口） |

**判定**：独占能力为 0 的行（director3d）拿到最高路由优先权，且其 `3d` / `blender` 前缀会
吞掉本该属于 motion-director 的复合 taskType。路由顺序与能力判别力**反向**。

### 2.3 角色职能边界模糊对

| 对 | 三者关系 | 现存判别式 | 判定 |
|---|---|---|---|
| director3d / motion-director / web3d-director | 同属 3D 生产，工具面重叠 2-3/4 | 无。只有 label（「3D 导演」/「动态设计」/「Web3D 导演」）与 taskTypes 字串差异 | **边界缺失** |
| video-director / editor / screenwriter | 同属影片生产链相邻环节 | 工具面尚可区分（各 2/10/6 独占），但 taskTypes 出现 `film_clip`（video）vs `film_assembly`（editor）这种**人为分化的一对** | **边界可疑**：`film_clip` 与 `film_assembly` 在真实请求中极难区分谁属谁 |

### 2.4 规则文本重复

「诚实铁律」在同一 turn 的上下文出现 **3 处**：

| 处 | 位置 | 内容规模 |
|---|---|---|
| Expert 宪法 第一条 | `gateway/expert/expert-constitution.md` | 5 款（已提交⇔ok:true / 不宣称未验证成功 / 失败带原文 / 连续失败合并播报 / 抄轮子连错误提取层） |
| AGENTS.md §3.7 | `workspace/AGENTS.md` L75 起 | 「能力宣称对帐：没有系统证据不许宣称」 |
| playbook 第三节 | `gateway/expert/orchestrator-dispatch-playbook.md` | 安全红线（secret 卫生 / 禁 headless / 外部副作用 / 覆盖前 diff） |

**判定**：三处同源一致、措辞不冲突 → **冗余但安全**。但三处**均未声明彼此优先序**，
且合计占用可观 prompt 预算。属「可接受的浪费」，不是缺陷——除非后续出现措辞漂移。

### 2.5 交付物契约重叠

7 个 `*_DELIVERABLES` 在 registry 中宣告 `deliverableContract.requiredFields` +
`qcSignatureRequired: true`（7/7 全 true）。契约本身由各 delegate import，无手抄漂移。

**但**：该契约**从未进入任何 prompt**——`buildExpertLine()`（`orchestrator-beast-frame.ts:42-45`）
与 VPS digest 都只输出 `taskTypes` 与 `toolIds`，**不含 `skillPaths` 与 `deliverableContract`**。
后果：Orchestrator 写派遣 spec 时，**无从得知**该 Expert 该载哪个配方库、交付物要哪些栏位——
而 playbook 第一节 spec 七件套要求它写「验收标准」。验收标准的唯一来源（契约）没进它的上下文。

---

## 3. 轴二：MoE + Orchestrator 架构目标实现不完全

### 3.1 三件套接线状态总表

MoE 设计的三件套：**能力断路 / 路由门禁 / 交付物闸门**。

| 件 | 宣告处 | 物理实现 | 状态 |
|---|---|---|---|
| 能力断路（Orchestrator 端） | digest 头行、宪法第二条、`agent.orchestrator` 描述 | `opencode.json` → `agent.orchestrator.tools` 只有 4 个 `false` | **16% 半接线** |
| 能力断路（Expert 端） | 宪法第二条第 1 款「域外工具不在你的工具表里」 | 无 | **未接线（实为虚假声明）** |
| 路由门禁 | `routeExpert()` + `assertExpertToolAccess()` | 生产零调用 | **未接线** |
| 交付物闸门 | 宪法第二条第 3 款、digest | 无 | **未接线** |

### 3.2 能力断路实测（E2）

`workspace/.opencode/opencode.json` → `agent.orchestrator`：

```json
{
  "mode": "all",
  "description": "MOE Orchestrator（野兽模式主会话）：域工具已断路，只能 subagent_dispatch 派发 Expert",
  "tools": {
    "blender_exec": false,
    "blender_render": false,
    "blender_export_gltf": false,
    "music_gen": false,
    "question": true
  }
}
```

对照 EXPERT_REGISTRY 宣告的 25 个域工具，**仍开在 Orchestrator 手上（21 个）**：

- `image_quote`
- `video_quote`、`video_upload`、`last_frame_video_chain`
- `timeline_ops`、`timeline_query`、`timeline_rhythm`、`timeline_style`、`timeline_mix`、
  `timeline_master`、`timeline_lint`、`timeline_restore`
- `editing_manifest`、`audio_first_timeline`
- `script_scene_parse`、`storyboard_qc_17`、`story_sequence_consistency`、`canvas_apply_ops`、
  `doc_struct`、`world_bible_extract`
- `keyframe_render`

**语义批判**：被关掉的 4 个（blender×3 + music_gen）恰好是**只有 director3d/music/motion 三个
Expert 需要**的工具；而**拥有最多独占工具的 editor（10 个）与 screenwriter（6 个）的域工具
一个都没断**。断路密度与 Expert 专业化程度**反向**。

另注：gateway 自己的注释已承认此为留桩——`gateway/index.ts`
「现阶段 gateway 无 per-subagent 工具白名单挂点，物理断路留桩，先靠 prompt 约束」。

### 3.3 Expert 端工具隔离缺失（E3，反向漏洞）

`gateway/subagent.ts` L256-295 `dispatchAttempt()`：

```ts
const res = await fetch(`${deps!.openCodeUrl}/session`, {
  method: "POST", headers: deps!.openCodeHeaders(), body: "{}", ...
})
...
const body: Record<string, unknown> = { parts: [{ type: "text", text: `${constitutionNote}${run.prompt}` }] }
if (model) body.model = model
```

- `POST /session` body `{}` → **无 `agent` 栏**
- `prompt_async` body 只有 `parts` + `model` → **无 `agent` 栏**

子会话因此使用**预设 agent**（`opencode.json` 的 `model: b-ai/qwen3.8-flash` + 无 `tools` 限制）
→ 拿到 `workspace/.opencode/tools/` 全部 **97 个工具**。

**这使宪法第二条第 1 款的宣告成为虚假陈述**：Expert 实际持有全部工具，包括其他 6 个 Expert 的
域工具。能力断路在 Expert 端为 0。

### 3.4 路由层零消费方（E1）

| 符号 | 本机生产码消费方 | VPS gateway 消费方 |
|---|---|---|
| `routeExpert` | 无（仅 `*.test.ts`） | 无（grep 零命中） |
| `assertExpertToolAccess` | 无（仅 `expert-registry.test.ts`） | 无 |
| `EXPERT_REGISTRY` | 无（仅测试） | 无 |
| `buildOrchestratorFrame` | 无 | 无（gateway 自行重写同构逻辑） |
| `buildExpertRegistryDigest` | 无（仅测试） | 无（改读静态档） |

**后果**：`taskTypes` 这套路由键在生产**从未被查询**。实际的「选哪个 Expert」机制是
**Orchestrator 在自然语言 spec 里自己写**（例如「你是 3D 导演 Expert」），没有程式介入。

**因此生产中的「MoE」实质为**：1 个 orchestrator agent + N 个**通用子会话**做角色扮演。
不是专家切换，是**提示词角色扮演**。VPS 的 `opencode.json` `agent` 键下**只有 `orchestrator`
一个 agent**（`['orchestrator']`），不存在 7 个 Expert agent 实例。

### 3.5 digest 仍为静态档（E5）

`gateway/index.ts:4210`：

```ts
digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
```

注释（L4196）自认：「摘要（静态档 gateway/expert/registry-digest.txt，本地
buildExpertRegistryDigest 生成上传）」。

R7 遗留工单 #1「digest 改为 gateway 注入时从 registry 现算」**未执行**。漂移风险仍在：
本机 `EXPERT_REGISTRY` 改一行，VPS digest 不会跟进，除非记得手动重新导出＋上传。

### 3.6 交付物闸门不存在（E4）

```
$ grep -rn "deliverable\|qcSignature\|qc_signature\|DELIVERABLES" gateway/index.ts gateway/subagent.ts
（零命中）
```

宪法第二条第 3 款原文：「你的交付物必须符合契约 schema。缺栏位、缺 QC 签名 = 组装闸门不过 =
视为未交付，不管你实际做没做完。」

**判定**：契约宣言，非事实。子代理回报是一段自由文字 summary（`subagent.ts` `finishRun` →
`summary`），无 schema 校验、无 QC 签名检查。

### 3.7 配方库空缺（E10）

宪法第三条第 1 款：「进 Expert 即载配方库。这是 must-load 常驻，不是『高兴才查』。」

实测：

| Expert | `skillPaths` | 状态 |
|---|---|---|
| director3d | `skills/blender-director/SKILL.md` | 有 |
| music | `skills/music-director/SKILL.md` + files | 有 |
| motion-director | `skills/motion-design/` | 有（指域目录） |
| web3d-director | `skills/web-3d-awwwards/SKILL.md` | 有 |
| **video-director** | `[]` | **空** |
| **editor** | `[]` | **空** |
| **screenwriter** | `[]` | **空** |

3/7 Expert 无配方库可载 → 对它们而言，「配方优先」铁律无法履行。
且如 §2.5 所述，`skillPaths` 根本不进注入帧，Orchestrator 也无从在 spec 里指派。

### 3.8 beast gate 覆盖（本轴唯一无缺口处）

`beast_mode === true` 的判定点（VPS grep）：

| 行 | 用途 |
|---|---|
| `index.ts:809` | 主会话挂 `agent: "orchestrator"` |
| `index.ts:4203` | 主 prompt 野兽帧注入闸门 |
| `index.ts:4241` | `promptBody.agent = "orchestrator"` |
| `index.ts:7429/7437/7451` | settings 读写与 sanitize |
| `index.ts:7702` | `initSubagent` 的 `beastMode` 快照 |
| `subagent.ts:284` | 子会话宪法注入 |

子会话注入走 `dispatchAttempt()`，重试路径 `retryWithNextModel()` → `dispatchAttempt()`
同路径，**无绕过分支**。R7 修的 strip＋状态行在两端均在位（`index.ts:4219-4221`、
`subagent.ts:287`）。

**判定**：注入覆盖完整。本轴的缺口全部在**架构宣告 vs 执行**，不在注入管线。

---

## 4. 轴三：Harness 层残留 Dense 架构提示词

主残留源：VPS `workspace/AGENTS.md`（172 行 / 22874 字）。该档在 MoE 改革（2026-09-08）
**未被修订**，仍描述「单一全能 agent」。

### 4.1 §1 路由决策表（L13-33）逐列盘点

表格 18 列全部是「使用者意图 → 直调工具」的 Dense 指令：

| 列（意图） | AGENTS.md 教的直调 | MoE 下应由 | Expert 存在？ | 判定 |
|---|---|---|---|---|
| 画图（想法层面） | `image_generate` + `image_quote` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 画图（完整 prompt） | `image_generate` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 改图/参考图编辑 | `image_edit` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 复用素材/3D/动作 | `asset_search` → `asset_activate` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 放大 | `image_upscale` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 生影片（单镜） | `video_quote` → `/v1/videos/generations` | video-director | 是 | **Dense 残留-应改派** |
| 生影片（多镜/长片） | `workflow_*` + 读 `attach/workflow-video-rules.md` | 无对应 Expert | **否** | Dense 残留-无承接者＋应派 |
| 看图/读图 | `python3 read_image.py` | 无对应 Expert | **否** | Dense 残留-主脑 bash 动手 |
| 写真/人像摄影 | `skill nuyoah-xiezhen-prompt` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 参考图反推 | read-image + `skill nuyoah-image-reverse-prompt` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 广告/UGC shot 提示词 | `skill ai-ad-prompt-guide` | 无对应 Expert | **否** | Dense 残留-无承接者 |
| 选模型/找替代 | GET `/v1/model-status` | 无对应 Expert | **否** | Dense 残留-合理保留（Orchestrator 职责） |
| 配音/TTS | `tts_speak` | 无对应 Expert | **否** | Dense 残留-应派（editor 域邻近） |
| 剪辑/时间线调整 | `timeline_query` → `timeline_ops` → 回读 diff | editor | 是 | **Dense 残留-应改派** |
| 节奏体检 | `timeline_rhythm` | editor | 是 | **Dense 残留-应改派** |
| 剪辑回退/撤销 | `timeline_query` → `timeline_restore` | editor | 是 | **Dense 残留-应改派** |
| 工具优先级句 | 「原生工具（`image_*` / `canvas_*` / `workflow_*` / `tts_speak` / `timeline_*`）> bash curl」 | —— | —— | **Dense 残留-直接教用 Expert 域工具** |

**统计**：18 列中 **6 列**有明确 Expert 承接者（应改派而未改）、**9 列**根本没有 Expert 承接
（MoE 覆盖缺口，Orchestrator 只能自己做或派给无白名单的通用 subagent，见 §3.3/§4.4）、
**1 列**合理保留（model-status 属 Orchestrator 职责）。

### 4.2 §2 生成 prompt 硬规则（L36-48）——与 playbook 正面冲突

AGENTS.md §2 第 1 款原文：

> **先增强再发送**：禁止把用户原始一句话直接当 prompt，**你负责扩写成完整 prompt**。

playbook 第〇节原文：

> **你本人不产出任何内容**：研究、创作、审核全部下沉给 subagent。
> 「我自己写个 prompt 就行了」这种念头一出现即违宪。

**判定**：**同一个「你」被两份文件下了相反命令**。AGENTS.md 的「你」是 Dense 时代的主脑
（自己扩写 prompt）；playbook 的「你」是 Orchestrator（不准自己扩写）。两份都在
beast ON 时进入上下文。

§2 其余 8 款（六槽公式、一律英文、正向语言、age-blind、Anti-Slop、情绪用肌肉、IP 安全、
音讯槽）是**领域知识**而非职能指令，本身不冲突——但它们的存在暗示「读者会亲自写 prompt」。

### 4.3 §3 / §5 的执行直操指令

| 位置 | 原文要点 | 判定 |
|---|---|---|
| §3（L50-54） | 「跑 workflow 模板、生影片、多镜/长片…**必读** `attach/workflow-video-rules.md`」 | Dense 残留：主脑自己跑模板 |
| §5（L129-138） | 「读图：**必用** `python3 .opencode/skills/read-image/read_image.py`…一次 bash 一档」 | Dense 残留：主脑 bash 动手 |
| §5 | 「影片附件是可剪辑原片…**走** `timeline_query`+`timeline_ops`…**别用** run_py 手搓」 | Dense 残留：教主脑直接剪 |
| `bash 白名单` 段（L156 起） | 主脑可用的 bash 范围 | Dense 残留：假设主脑会执行 bash |

### 4.4 §3.8.6「Orchestrator 律令」（L120-128）——唯一教派遣却自我设限

原文要点：
- 「多步骤任务、大素材加工、可并行的探索/生成，**必须**用 `subagent_dispatch` 派子代理」
- 「**简单单步任务不派，直接做**」 ← 明确授权主脑自己做
- 「并发**上限 3**，满了等一个完成再派」

对照 playbook：
- 第〇节铁律 3「Orchestrator 纯度…发现自己在『亲自写内容/亲自调参/亲自审图』= 立即停下」
  ——**没有「简单任务例外」**
- 第二节第 1 条「**常态保持 ≥3 路并发**。完工一路立刻验收并补派一路」

**判定**（三点）：
1. **范围冲突**：AGENTS.md 用「必派场景清单」界定（窄），playbook 用「一切派遣」界定（宽）。
   模型按较窄的清单执行 → 漏派。这是 R7 观察到「模型自己写 prompt」的制度性来源。
2. **并发语义**：严格说「上限 3」与「常态 ≥3」**相容**（一个是 ceiling，一个是 target），
   但两份都以硬规则语气书写、互不声明 → 模型收到两个数字信号无裁决依据。
3. **措辞污染**：AGENTS.md 该节标题自称「Orchestrator 律令」，与 playbook 的「Orchestrator
   派遣手册」**naming 撞车**。模型看到两份「Orchestrator 律令/手册」被要求自行裁决。

### 4.5 现行补丁：playbook 的「职能边界」段

playbook 第 8-10 行（R7 新增）：

> **职能边界（与 AGENTS.md 的分工裁决，R7）**：工作流执行细节…以 AGENTS.md 与 attach/ 配方
> 为准——但那些是派给 subagent/Expert 的执行配方…**谁做（必须派遣）、怎么派、品质标尺以本手册
> 为准**。两者冲突时：执行细节听 AGENTS.md 配方，指挥权听本手册。

**判定**：这是在**矛盾之上贴标签**，不是在源头消除矛盾。且它要求模型做一个二层判断
（「这句是执行细节还是指挥权？」），把架构层的矛盾**转嫁给模型**。§2 的 prompt 扩写冲突
正是此类：它是「执行细节」（→听 AGENTS.md 自己写）还是「谁做」（→听手册必须派遣）？
两种读法都成立，模型得猜。

### 4.6 两条注入路径互不知情（E8）

| 通道 | 载入者 | 内容 | 程式码位置 |
|---|---|---|---|
| AGENTS.md | opencode 原生（workspace 根目录自动载入；`opencode.json` 的 `instructions: []` 为空） | 22874 字 Dense 主指令 | gateway 内 grep `AGENTS.md` **零命中** |
| 野兽帧 | gateway | state line + playbook + digest | `index.ts:4230-4238`，prepend 进 `promptBody.system` |

**关键事实**：gateway **完全不感知 AGENTS.md 的存在**。没有任何一行程式码保证两者的
先后顺序或裁决规则。R7 的 DB 取证显示 system 栏 10677 字 ≈ 帧本体（playbook 20069 B +
digest 1500 B 量级），而 AGENTS.md 22874 字**不在该栏** → 两者分属不同注入通道。

**未验证**：两者在模型最终上下文中的**实际先后顺序**未能从现有证据断定（需 dump 一次
完整 opencode prompt 组装结果）。若 AGENTS.md 在前、帧在后 → 帧有 recency 优势（有利 MoE）；
反之则 Dense 指令更近（不利）。**这是本审计最大的单一未验证项**，且它决定 §4.2 冲突的实际后果。

### 4.7 Dense 残留的根源判断

AGENTS.md 不是「忘了改」，而是**没有任何机制要求它与 MoE 宣告同步**：

- `EXPERT_REGISTRY` 有测试守卫（`expert-registry.test.ts` 408 行）钉住注册表契约
- persona 有测试守卫（7 个 `*-expert-frame.test.ts`，最大 36713 B）钉住 persona 契约
- **AGENTS.md 没有任何一致性守卫**——它不在 repo 内（在 VPS workspace），不进 CI，不被任何
  程式引用

三者（registry / gateway 工具表 / AGENTS.md）各自演化，无对齐机制。这是三轴问题的共同根因。

---

## 5. 三轴交汇的根因

```
                    ┌─────────────────────────────────────┐
                    │  缺「单一真源」强制对齐三者          │
                    └─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
 ① 注册表（本机契约）        ② gateway 执行面            ③ AGENTS.md 提示词
   EXPERT_REGISTRY             agent.tools / 路由调用       22874 字 Dense 主指令
   有测试守卫                 几乎空白                     无任何守卫
        │                           │                           │
        └──────────► 各自演化，无交叉验证 ◄────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   轴一 智能重叠              轴二 实现不完全              轴三 Dense 残留
   （宣告面内部无人裁决       （宣告有、执行无 →           （从未被纳入改革
     独占度为 0 的行；          三件套只有 16% 落地）         范围，且与 playbook
     路由顺序反向）                                          正面矛盾）
```

**一句话根因**：MoE 改革把「架构声明」写进了 registry 与 prompt 档，但**没有把任何一项声明
接到 gateway 的执行点**，也**没有把 Dense 时代的 AGENTS.md 纳入改革范围**。宣告面与执行面
之间没有校验，所以宣告面自我一致地描述了一个不存在于生产的架构。

---

## 6. 证据索引（可复现命令）

| 编号 | 命令 |
|---|---|
| E1 | `ssh … "cd /opt/agent-harness && grep -rn 'routeExpert\|assertExpertToolAccess\|EXPERT_REGISTRY' gateway/ \| grep -v .bak"` → 零命中（仅 digest.txt 文字） |
| E2 | `ssh … "python3 -c \"import json;print(json.load(open('/opt/agent-harness/workspace/.opencode/opencode.json'))['agent'])\""` |
| E3 | `ssh … "sed -n '256,300p' /opt/agent-harness/gateway/subagent.ts"` |
| E4 | `ssh … "grep -rn 'deliverable\|qcSignature\|DELIVERABLES' /opt/agent-harness/gateway/index.ts /opt/agent-harness/gateway/subagent.ts"` → 零命中 |
| E5 | `ssh … "grep -n 'registry-digest' /opt/agent-harness/gateway/index.ts"` → L4210 |
| E6/E10 | 本机 `src/lib/expert-registry.ts` + `src/lib/*-persona.ts`；digest 全文 |
| E7/E8 | `ssh … "sed -n '13,55p;120,135p' /opt/agent-harness/workspace/AGENTS.md"` |
| E9 | playbook 第〇节 vs `gateway/expert/registry-digest.txt` |
| 工具基数 | `ssh … "ls /opt/agent-harness/workspace/.opencode/tools/ \| grep -v .bak \| wc -l"` → 97 |

---

## 7. 未验证项（禁止当成事实）

1. **AGENTS.md 与野兽帧在模型上下文中的实际先后顺序**（§4.6）。需 dump 一次完整 prompt
   组装结果才能断定。此项决定 §4.2 冲突的实际后果严重度。
2. **`opencode.json` 的 `agent.orchestrator.tools` 是否为唯一工具表**。gateway 内 grep `tools:`
   零命中，但 opencode 配置可能存在其他载入层（plugin / global config）未检查。
3. **VPS `workspace/skills/` 是否实际存在 4 个非空 skillPaths 指向的目录**。本次只验证了
   宣告值，未验证部署实体。
4. **`subagent_dispatch` 工具的 spec 是否能传 `agent` 栏给 gateway**。本次只验证 gateway 端
   `dispatchAttempt()` 不传，未追 workspace 工具实作是否有此栏位而被丢弃。
5. **R7 遗留工单 #3（前端 dispatch prompt 截断显示）** 未在本审计范围内复核。

---

## 8. 本审计未做的事

依审计性质与暴君裁定权，本片**只做诊断，不含修复**。上述 10 条结论（E1-E10）的修复方案、
优先序、以及「能力断路是否应改为 per-Expert agent 实例」这类架构决策，均属暴君裁定范围，
不在本报告。

---

## 9. 复核附录（2026-09-10 晚，五项未验证项全部收口）

### 9.1 §7-1 AGENTS.md 与野兽帧的顺序 —— **已锤：AGENTS.md 在前、帧追加在后，两者共存于每个 beast turn**

证据链（三重算术互洽）：

| 测量 | tokens.input | 说明 |
|---|---|---|
| 无 system 覆写（agent=orchestrator，qwen） | 51,458 | 预设组装 = opencode 基座 system + **AGENTS.md** + env |
| 生产 beast turn 1（ses_f75c9c63，glm） | **58,012** | = 51,458 + 6,554（帧 11039 字 ≈ 6.5k tokens） |
| 生产同会话 turn 2（无帧） | 66,561 | 51.5k 基座 + 历史 → 基座每轮在场 |

opencode v1.18.14 源码（prompt.ts）：instructions（AGENTS.md）是 system 阵列固定第二槽
`[env, instructions, mcp, skills]`；message 级 `system` 栏存在 user message 上、于下游合并——
token 算术证明其为**追加**而非替换。

**行为后果（历史取证，零风险）**：同一 prompt「生成秦始皇骑北极熊的大电影」今天的两个生产
beast 会话——`ses_f7624fe13` 派了 3 路 `subagent_dispatch`（playbook 赢）；
`ses_f75c9c63` 全程直调 `video_quote`/`workflow_start`×3/add_node（AGENTS.md Dense 赢）。
**两份矛盾指令共存导致路由行为不确定**，这是架构冲突的直接代价。

### 9.2 §7-2 agent.orchestrator.tools 唯一性 —— **已锤：唯一层**

全域 `~/.config/opencode/opencode.jsonc` 仅 `$schema`；无 plugin 目录；gateway 内 `tools:` 零命中。
工具闸门只有这一处。

### 9.3 §7-3 skillPaths 部署实体 —— **已锤：比审计判断更糟**

VPS `workspace/skills/` 目录不存在，4 个非空 skillPaths 指向全空；且 VPS gateway/lib **无任何
skillPaths 消费方**（grep 零命中）。即 7/7 Expert 的配方库在生产端都没有执行机制，非仅 3/7 空宣告。

### 9.4 §7-4 subagent_dispatch 能否传 expert 栏 —— **已锤：不能**

工具 args 只有 `label`/`prompt`/`async` 三栏（`workspace/.opencode/tools/subagent_dispatch.ts`）；
gateway `/internal/subagent/dispatch` 同样不收 expert/agent 栏。**模型在派遣时根本无从指定 Expert**，
即使 gateway 想路由也没有输入。

### 9.5 §7-5 前端 dispatch prompt 截断 —— **已锤：R7 遗留#3 已被 09-10 工具卡重设计吸收，不再是缺口**

`src/lib/agent-tool-params.ts`：`WIDE_KEYS` 含 `prompt`，且 `text.length>48` 也触发 `wide`
→ 展开后 `overflow-wrap:anywhere` 全文折行显示；折叠行的暗字截断是一行式重设计的刻意行为。

### 9.6 复核过程的意外发现（如实记录）

1. **AGENTS.md §7（反逆向）会压制一切内省式探针**：orchestrator 拒绝复述/描述自己的 system
   （连结构描述都拒）。今后对 harness 做 prompt 取证只能走 token 算术与行为差分，问模型无效。
2. **b-ai/qwen3.8-flash 中继在带 system 覆写时 usage 计数不可信**（260/419/0 tokens，物理不可能），
   且会产出 0-token 坏 turn。生产 glm-5.3-flash 的计数与算术一致，可信。
3. **opencode 今晚有 part 写入冲突故障**：`Failed query: insert into "part" ... on conflict`
   使 turn 以 upstream error 收场（journalctl 23:03:55 实录）。与本审计无关，但会造成
   「turn 静默死亡」，建议独立排查。
4. **探针事故如实记录**：第二轮生产路径探针的会话选择器（「最新≠建号前最新」）抓错会话，
   误对 `ses_f742c082`（gateway 会话 fcfe1b6b，22:58:39 由他方建立、非本审计所建）执行了
   abort＋DELETE，该会话内容不可恢复；其 turn 本已因 §9.6-3 的 part 冲突在报错重试。
   本审计自建的两个探针会话均已清理，probe 帐号 beast_mode 已复原 false。

---

## 10. A＋B 落地与实弹验证（2026-09-11 凌晨）

暴君裁定：**A（真 Expert 切换）＋ B（不重写 AGENTS.md，靠物理断路自中和）**，并定调
「**MoE 的根本目的是上下文隔离**——AGENTS.md 太重，单次载入过多复杂规则造成模型性能退化」。

### 10.1 已落地（四片全绿）

| 片 | 内容 | 证据 |
|---|---|---|
| 1 | `tools/export-expert-agents.ts` 导出器＋三产物（agents 定义 / digest / expert-ids），幂等 `--check` PASS | editor 86 个 false、orchestrator 26 键、digest 与生成器 byte 等价 |
| 2 | gateway：expert 栏全链（校验三态→`run.agent`→`prompt_async` body.agent）＋帧新增「能力断路·物理事实」句 | bun build EXIT=0；off/未知/清单缺失三态 |
| 3 | `subagent_dispatch` 工具加 `expert` 参数（条件展开，undefined 不带键） | bun build EXIT=0 |
| 4 | VPS 合并（agent 键 8 个）＋上传＋重启；冻结段 `$schema/model/small_model/instructions/permission/provider` 物件级 UNCHANGED | 双服务 active、healthz 200 |

### 10.2 实弹验证结果

| 项 | 结果 | 原始证据 |
|---|---|---|
| T1 Orchestrator 域工具断路 | **PASS** | 剪辑任务首个 tool = `subagent_dispatch`（expert=editor），全程零 `timeline_*` 调用 |
| T5 白名单机制有效（正对照） | **PASS** | editor 子代理对 `blender_exec` 回「我没有 blender_exec 这个工具…也不假装执行」 |
| T2 Expert 白名单覆盖 | **首测 FAIL → 已修 → 复测 PASS** | 首测 `image_generate` 未被挡（补集只取「其他 Expert 的域工具」）；改为「全集 − 自己」后复测：子代理回「我的工具域里没有图片生成通路…不能绕过域隔离用 curl 私自代做生成扣费」，`image_generate` tool part 计数 = 0 |
| T2 正对照（自家域工具未误挡） | **PASS** | editor 仍能调 `timeline_query`，收到真工具回应 `ok:false timeline_not_found`（非工具不存在） |
| T3 beast OFF 零回归 | **PASS** | OFF 会话 `agent=build`、正常回覆；不带 expert 的 dispatch 正常完成 |
| T4 未知 expert 负向 | **PASS** | `POST /internal/subagent/dispatch` 带假 expert → HTTP 400 `未知 expert：not-a-real-expert` |

### 10.3 验证时炸出的新漏洞（**未修，待裁定**）

**Expert 白名单挡不住 builtin `bash` + `skill` 的 HTTP 绕道。** 实录：另一条 editor 子会话
走 `skill{name:"image-gen"}` → `bash` 读 env → 用 harness key 直打
`/v1/images/generations`（seedream-2.0）→ **真的建立任务 `a4710a92-a5ba-491b-9ffb-bb8b7f30d40e`**
（DB 实查 `billing_amount=0`，未实际扣款；status 卡在 `queued`，`supplier_excluded` fail-fast）。
同样工具表的两条 editor 子会话行为相反（一条拒答引宪法第二条、一条绕道）→ **属模型行为差异，
非配置差异**。

**意义**：原生工具的隔离是物理的；**egress 层隔离不是**。同一 OS 进程持有平台 key，
bash/HTTP 天生绕过 config 与 prompt 双重约束。这与 §10.4 的上下文隔离阻塞同源——
**都需要进程级分离**。

### 10.4 二期（上下文隔离）阻塞备忘

实测结论：**`POST /session` 的 `directory` 参数被 opencode 1.18.14 无视**（回传仍钉在
server cwd，`projectID=global`）；`instructions` 配置纯增量、**无关闭 AGENTS.md 的开关**，
唯一总闸是 process 级 `OPENCODE_DISABLE_PROJECT_CONFIG`（会连 project config/tools 一起杀）。
故上下文隔离唯一路径＝**第二个 opencode server（cwd 指向无 AGENTS.md 的专家树 ＋ .opencode symlink）**。
spike 三个未通点：
1. 第二实例 `prompt_async` 回 204 但 **turn 不执行、资料不落盘**（root 起、有 provider key 亦然）；
2. **agentsvc 读不到 root 属主的 `/opt/agent-harness/.env.opencode`**（→ 需走 systemd `EnvironmentFile`，由 systemd 以 root 读取后降权）；
3. VPS 记忆体余量吃紧（事故当晚 free ~600MB、swap 90%），第二实例 +340MB 需先解决资源或改 on-demand 启动。

**注意**：项目进程分离同时可解 §10.3 的 egress 绕道——两个问题一个解。
