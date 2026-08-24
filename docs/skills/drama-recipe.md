---
name: drama-recipe
version: 1.0.0
description: 小说→短剧五段管线配方——大纲/角色/美术/剧本/分镜五段 JSON 接力，资产挂 character-cards 卡，出图走平台生成队列
allowed-tools:
  - lora_search
  - lora_get
  - generate_image
triggers:
  - 用户要把小说 / 文本 / 剧本改编成短剧（要分镜、角色设定、场景设定、批量出图）
  - 用户提到短剧、分镜表、五段管线、小说改编
requires:
  - src/lib/character-cards.ts（卡体系：资产 id 唯一来源，锁定注入 applyCharacterCards）
  - src/lib/drama-recipe.ts（确定性推导：清洗 / 秒数 / 批次切分 / 资产清单）
  - generation-gates（段级质量门：本配方只声明门，执行归 generation-gates）
optional:
  - lora_search / lora_get（为角色/场景卡选风格 LoRA 的增强路径，上游不可用时跳过，不影响主流程）
---

# drama-recipe —— 短剧五段管线配方

> 吞并自 [eternityspring/shuohao-skills](https://github.com/eternityspring/shuohao-skills)（Apache 2.0）：其 outline/cast/art/script/storyboard 五段 JSON 接线收敛为本平台**一条配方**。吞并姿势：资产 id 用 character-cards 的卡 id（C 前缀编号对应 character 卡、P 前缀对应 scene 卡），出图全部走平台生成队列，质量门走 generation-gates。确定性部分（秒数折算、批次切分、资产清单）由 `src/lib/drama-recipe.ts` 纯函数执行。

## 用途

用户拿一本小说 / 一份大纲 / 一个剧本想做成短剧时，agent 按五段管线接力产出结构化 JSON，最终由代码把分镜段切成一批生成任务（每分镜一任务、自动拼接角色/场景卡锁定片段）提交平台生成队列。agent 负责**语义**（剧情、台词、画面描述）；**数值与切分由代码推导，不让模型猜**。

五段接力（后段吃前段产物，缺段容忍、明说跳过）：

```
小说/文本 ──▶ outline（改编大纲）
              └─▶ cast（角色设定）───┐
              └─▶ art（美术设定）────┤ 资产 = character-cards 卡 id（C/P 编号）
                                   ▼
              outline ──▶ script（剧本：节拍流）
                                   ▼
              script ──▶ storyboard（分镜）──▶ storyboardToBatchTasks ──▶ 生成队列
```

每段 JSON 的宽松清洗、缺段容忍行为统一由 `normalizeDramaPipeline(payload)` 收口：字段别名兼容、非法条目丢弃不拖垮整段、缺失或清洗后为空的段名进 `skipped` 数组**明说跳过**。

## 工具契约

| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `lora_search` | `query?`, `view?`, `sort?`, `page?`, `limit?` | `{ models: [...], total, page }` | `/api/lora-models` + `/api/lora-preferences`（契约详见 agent-lora 技能） |
| `lora_get` | `versionId` | 单模型详情 + 大图预览 | 同上 |
| `generate_image` | `prompt`, `model`, `size`, `n`, `referenceImages`, `negativePrompt`, `loraModelVersionIds`（单选铁律 `slice(0,1)`） | 任务提交结果（走平台生成队列，非直连上游） | 平台生成队列 + generation-gates |

**出图铁律**：分镜出图只允许经 `generate_image` 走平台生成队列，任务参数由 `storyboardToBatchTasks` 产出，agent 不得手拼第二套参数、不得绕过队列直连供应商。

## 五段字段契约

### 1. outline（改编大纲）

输入：小说文本 / 用户口述的改编意图（模型消费，无结构约束）。输出 JSON：

| 字段 | 类型 | 约束 |
|------|------|------|
| `title` | string | null | 剧名，≤200 字符，可缺省 |
| `logline` | string | null | 一句话梗概，≤4000 字符 |
| `episodes` | array | 分集梗概；每项 `{ ep: number(≥1 整数), synopsis: string }`；ep 不连续/非正数的条目被丢弃 |
| `assetCardIds` | string[] | 资产清单（管线全程要引用的卡 id 全集）；**必须 ⊆ `deriveRequiredAssets(storyboard)` 结果**，多出的即模型凭空捏造 |

资产引用方式：本段只**预告**卡 id（C/P 编号），实际绑定在 cast/art 段完成。

该段跑的 generation-gates 门：

| 门 id | 判定 |
|-------|------|
| `outline.episodes` | `episodes` 非空、集号为 1 起正整数序列、每集梗概非空 |
| `outline.asset_list` | `assetCardIds` 去重后全部能被 character-cards 解析，且 ⊆ 分镜段实际引用集 |

agent 工具对接：无工具调用（纯文本推演段）；确认卡 id 前提是卡已存在于 character-card-store。

### 2. cast（角色设定）

输入：`outline.episodes` 出场人物 + outline 的 `assetCardIds`。输出 JSON（数组，每角色一条）：

| 字段 | 类型 | 约束 |
|------|------|------|
| `cardId` | string | **character-cards 里 kind=character 的卡 id**（惯例 C 前缀编号，如 `C01`）；卡不存在或种类不符 → 本条不成立 |
| `name` | string | 角色名，≤200 字符，必填 |
| `appearancePrompt` | string | 形象提示词，≤4000 字符；建议同步写为该卡 `prompt` 锁定片段 |
| `voicePrompt` | string | null | 音色提示词（对接 TTS），可缺省 |

该段跑的门：

| 门 id | 判定 |
|-------|------|
| `cast.card_binding` | 每条 `cardId` 解析到 kind=character 的卡（id 不存在或指向 scene 卡即门失败） |
| `cast.appearance_prompt` | 每条 `appearancePrompt` 非空 |

agent 工具对接：`lora_search` 可为角色选风格 LoRA，但 LoRA 归属**卡**（写进卡 `loraIds`），不得散装塞进单个生成任务；`lora_get` 预览确认。

### 3. art（美术设定：场景 + 叙事道具）

输入：outline 资产清单 + 剧情空间需求。输出 JSON（数组，每场景/道具一条）：

| 字段 | 类型 | 约束 |
|------|------|------|
| `cardId` | string | **character-cards 里 kind=scene 的卡 id**（惯例 P 前缀编号，如 `P01`） |
| `name` | string | 场景/道具名，必填 |
| `prompt` | string | 场景提示词（无人无手白底设定图规范），可空串=纯参考图卡 |
| `variants` | string[] | 光照/状态变体（如「雨夜」「黄昏」），≤16 项 |

该段跑的门：

| 门 id | 判定 |
|-------|------|
| `art.card_binding` | 每条 `cardId` 解析到 kind=scene 的卡 |
| `art.anchor` | 每条有参考图的卡至少给出一个一致性锚点变体（`variants` 非空） |

agent 工具对接：设定图出图走 `generate_image`（n=1，卡 references 作为 referenceImages）；LoRA 同 cast 段规则——挂卡，不挂任务。

### 4. script（剧本：节拍流）

输入：outline 分集梗概 + cast 角色名。输出 JSON：

| 字段 | 类型 | 约束 |
|------|------|------|
| `episode` | string | null | 集号（如 `E01`） |
| `scenes` | array | 场次数组；每项 `{ sceneId, heading?, beats }`；`sceneId` 必填唯一（如 `S01`） |
| `beats[].type` | "action" \| "dialogue" | 节拍类型；中文别名（动作/台词）兼容；未给但有 speaker 推 dialogue |
| `beats[].speaker` | string \| null | dialogue 的角色名/卡 id，必填；action 为 null |
| `beats[].text` | string | 节拍文本，必填 |

**秒数字段不存在**——分镜/台词时长由代码折算（见「确定性边界」），模型在 script 段输出任何 duration 字段都会被清洗丢弃。

该段跑的门：

| 门 id | 判定 |
|-------|------|
| `script.beat_flow` | 每场次 beats 非空；dialogue 必带 speaker；动作/台词交替流 |
| `script.duration_budget` | `deriveDurations(script)` 折算的每集总时长在预算内（默认单集 ≤120 秒；台词折算默认 4 字/秒，语速可由任务参数覆盖） |

agent 工具对接：无工具调用；台词本按角色聚合（cast 段 voicePrompt）直接对接 TTS，属后续段，不在本配方内。

### 5. storyboard（分镜）

输入：script 场次节拍流 + cast/art 卡绑定。输出 JSON：

| 字段 | 类型 | 约束 |
|------|------|------|
| `shots[].shotId` | string | 分镜编号（如 `E01-01`），必填唯一 |
| `shots[].prompt` | string | 段提示词（画面描述，**不含**角色/场景锁定片段——片段由代码按卡注入） |
| `shots[].characterCardIds` | string[] | 引用角色卡 id（C 编号），每分镜 ≤16 |
| `shots[].sceneCardIds` | string[] | 引用场景卡 id（P 编号），每分镜 ≤16 |
| `shots[].negativePrompt` | string \| null | 段级负面词，与卡负面词自动合并去重 |
| `shots[].size` | string \| null | 尺寸（如 `1024x1024`） |
| `shots[].durationSeconds` | number \| null | 外部给定秒数；未给则按对应场次台词折算 |

该段跑的门：

| 门 id | 判定 |
|-------|------|
| `storyboard.shot_length` | 单分镜 2–5 秒硬门（秒数优先取 `durationSeconds`，否则 `deriveDurations` 台词折算值） |
| `storyboard.segment_length` | 段（一次生成的成组时长）≤15 秒；跨段切分由 `storyboardToBatchTasks` 的批次切分完成 |
| `storyboard.asset_resolution` | 所有引用卡 id 可解析（存在且种类相符）；不可解析的任务标 `needsAsset`，**不提交队列**，先补资产再重切 |

分镜→生成任务（代码推导，每分镜一任务）：

```
storyboardToBatchTasks(storyboard, cards) → [
  {
    shotId,                       // 分镜编号
    prompt,                       // 段提示词 + 卡锁定片段前缀（卡 id 升序稳定拼接，applyCharacterCards 注入、幂等）
    referenceImages,              // 被引用卡参考图（url 去重、角色保留）
    negativePrompt,               // 段级 + 卡级负面词合并（", " 连接去重）
    loraIds,                      // 被引用卡 LoRA 关联合并去重；generate_image 装配仍受单选铁律约束
    size, durationSeconds,
    needsAsset, missingCardIds    // 引用缺失/种类不符 → 阻断该任务，不阻断同批其他任务
  }
]
```

agent 工具对接：任务数组逐条经 `generate_image` 提交平台生成队列（`n=1`；`referenceImages` 透传；LoRA 取 `loraIds[0]` 且遵守 PixAI-only 能力检查）；`needsAsset=true` 的任务先向用户报缺哪些卡，补齐后重切。

## 确定性边界（能算的不让模型猜）

| 数值 | 推导者 | 规则 |
|------|--------|------|
| 分镜/台词秒数 | `deriveDurations(script, { speechRate? })` | 台词秒数 = max(1, ceil(字数/语速))，默认 4 字/秒可覆盖；动作拍 0 秒；总时长 = 各场求和的派生值，**不在任何输入 JSON 里冗余存储** |
| 批次切分 | `storyboardToBatchTasks(storyboard, cards)` | 每个分镜固定一个生成任务；prompt 锁定片段拼接、参考图合并、负面词合并全部代码完成 |
| 资产清单 | `deriveRequiredAssets(storyboard)` | 引用卡 id 全集升序去重；outline 段模型列的 `assetCardIds` 必须是它的子集 |

模型在输出 JSON 里给出的 duration/total/批次字段一律视为建议，最终以代码推导为准。

## 行为规则（必须全守）

1. **卡 id 是唯一资产坐标系**：五段 JSON 里一切角色/场景引用必须是 character-cards 真实存在的卡 id；C 前缀对应 character 卡、P 前缀对应 scene 卡，种类不符视同缺失。
2. **缺段容忍、明说跳过**：五段可部分执行（先跑 outline+cast 也合法）；`normalizeDramaPipeline` 返回的 `skipped` 必须如实告知用户哪些段没跑，不得假装全管线完成。
3. **锁定注入交给代码**：分镜任务 prompt 的角色/场景片段由 `applyCharacterCards` 注入（卡 id 序、幂等），agent 手写外观描述进分镜 prompt 属违规（会导致同角色跨镜不一致）。
4. **needs_asset 不提交**：引用卡缺失的任务不进生成队列；先报缺失清单，补齐资产后重新切批。
5. **出图只走队列**：所有生成经 `generate_image`/平台生成队列，遵守模型能力检查与 LoRA 单选铁律。
6. **门先行**：每段产出先过该段声明的 generation-gates 门再进下一段；门失败回到该段重跑，不带病接力。

## 失败与降级

- 输入 payload 脏（字段别名/非法条目）：`normalizeDramaPipeline` 宽松清洗，丢弃非法条目不抛错；整段为空则进 `skipped`。
- 引用卡不存在或种类不符：任务标 `needsAsset` + `missingCardIds`，该任务阻断、同批其余任务照常提交。
- `deriveDurations` 无有效场次：返回 null，该集时长门判失败，回 script 段重跑，不猜默认值。
- LoRA 上游不可用（`lora_catalog_unavailable`）：跳过 LoRA 增强路径继续主流程（optional 依赖），不阻断管线。
- 生成队列拒绝（容量/模型不可用）：任务停留待提交态并如实上报错误码，不伪造成功、不绕过队列换直连。
