---
name: agent-lora
version: 1.0.0
description: AI 助理的 LoRA 选型技能——搜索、预览、筛选并装配 LoRA 参数，通过 generate_image 显式携带出图
allowed-tools:
  - lora_search
  - lora_get
  - lora_favorite
  - generate_image
triggers:
  - 用户提到想叠风格 / 换画风 / 用某个 LoRA 出图
  - 用户询问 LoRA 库、收藏的 LoRA 或最近使用的 LoRA
requires:
  - /api/lora-models（PixAI bridge 代理，LoRA catalog 唯一来源）
  - /api/lora-preferences（收藏与最近使用，跨会话权威）
optional: []
---

# agent-lora Skill —— AI 助理的 LoRA 选型技能

> 迁移自专业模式 `LoraLibraryPanel`（2026-08-18，PRD §5）。功能零遗漏承接：搜索、排序、分页、收藏、最近使用、大图预览、单选铁律、PixAI-only 约束、生成参数装配。

## 用途

用户在对话里提到想叠风格 / 换画风 / 用某个 LoRA 时，助理应使用本技能搜索、预览、筛选并装配 LoRA，最终通过 `generate_image` 显式携带 LoRA 参数出图。**禁止只把 LoRA 写进提示词文本不带参**。

## 工具契约

| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `lora_search` | `query?`, `view?(all|favorites|recent)`, `sort?(popular|newest|liked)`, `page?`, `limit?` | `{ models: [{versionId,title,thumb,previewUrl?,tags?,author?,favorite}], total, page }` | 站内 `/api/lora-models`（PixAI bridge 代理）+ `/api/lora-preferences`（收藏/最近过滤与标注） |
| `lora_get` | `versionId` | 单模型详情 + 大图预览 + `favorite` 态 | 站内搜索 `/api/lora-models` 后按 `versionId` 过滤 + `/api/lora-preferences` 合并（**不新增 bridge 面**） |
| `lora_favorite` | `versionId, title, thumb, favorite` | 最新收藏态 | `/api/lora-preferences` PATCH（`lora_user_state` 表 / Blob） |

### generate_image 装配

`loraModelVersionIds: [<versionId>]`（**只保留 1 个**，单选铁律由服务端归一化 `slice(0,1)` 兜底）。可选 `lora_weight` 作为权重提示。

## 行为规则（必须全守）

1. **先搜索再选**：用户要风格时不直接生成，先 `lora_search`；有 `favorite` / `recent` 优先展示供用户挑选。
2. **单选铁律**：一次只给 1 个 LoRA。多选需求拆成"先用 A 出一张、再用 B 出一张"对比，并说明平台限制。
3. **PixAI-only**：当前模型无 LoRA 能力（`capabilities.lora === false`）时，明确告知"所选模型不支持 LoRA，请先换 PixAI 模型"，不得静默忽略或硬传参数。
4. **显式传参**：选定后必须把 `versionId` 放进 `generate_image` 的 `loraModelVersionIds`，不得仅文字提及。
5. **真实使用才更新最近**：`markUsed` 只在**成功生成**后落（`last_used_at` 语义），收藏/最近跨会话可见（服务端权威）。

## 教学片段（消化自 `src/lib/lora-tour-content.ts`）

- LoRA 是轻量风格模型：不换底模就能叠加画风。
- 用户问"什么是 LoRA"时：说明"社区轻量风格模型，选 PixAI 模型后可叠；LoRA 库在造型里"即可，不必展开技术细节。
- 换模型时若新模型不支持 LoRA：必须告知正在用的 LoRA 会被移除（沿用"已移除 LoRA：所选模型不支持 LoRA"语义），不静默清空。

## 失败与降级

- LoRA catalog 上游不可用（502/超时）：返回结构化错误 `lora_catalog_unavailable`，告知"LoRA 库暂时不可用"，**不阻断**不带 LoRA 的普通生成。
- 收藏接口失败（503）：返回 `preference_write_failed`，不伪造成功。
- 参数非法（过长/空）：返回 `invalid_request`，不部分执行。
