---
name: style-deep-research
version: 1.0.0
description: 以参考图证据整理风格 DNA，并对未接入的对齐、审计、训练 upstream 诚实阻断
allowed-tools:
  - style_dna_extract
  - style_aligned_batch
  - outlier_audit_regenerate
  - style_lora_train_optional
triggers:
  - 用户要深挖一组作品的风格 DNA
  - 用户要做风格一致的批次研究
  - 用户要审计离群图或训练风格 LoRA
requires:
  - src/lib/art-workflows/tool-registry.ts
  - existing Canvas image/reference nodes
optional:
  - StyleAligned attention-sharing adapter
  - VLM or CLIP image audit adapter
  - LoRA training adapter
---

## 用途

给需要从参考作品建立可核准风格研究记录的创作者使用。技能先将参考图与人工证据整理成 style DNA，再按 upstream 状态决定是否能执行 StyleAligned 批次、VLM/CLIP 离群审计或 LoRA 训练；缺 upstream 时返回结构化 unsupported，不用 prompt 拼接冒充算法。

## 工具契约

| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `style_dna_extract` | `referenceImages`、可选 `styleQuestions` | `styleDna` 草稿、逐栏 `evidence` | `src/lib/art-workflows/tool-registry.ts`；VLM/CLIP 未接入，需人工核准 |
| `style_aligned_batch` | canonical key art asset id、`batchPrompts`、`count(1-32)` | 真实 StyleAligned adapter 才能产生的 `batchJob` | `src/lib/art-workflows/tool-registry.ts`；StyleAligned upstream 未接入 |
| `outlier_audit_regenerate` | `batchAssets`、`auditRubric`、可选 `regenerateLimit` | 真实 audit evidence、离群项、只重生离群项 | `src/lib/art-workflows/tool-registry.ts`；VLM/CLIP audit upstream 未接入 |
| `style_lora_train_optional` | `datasetAssets`、一一对应 `captions`、`trainerConfig` | 真实 trainer 的 `trainingJob`，成功后才有 `loraArtifact` | `src/lib/art-workflows/tool-registry.ts`；LoRA trainer 未接入 |

## 行为规则

1. `style_dna_extract` 的每个字段必须引用至少一个 reference asset，或明确标成 `needs_review`；结构化草稿不等于 VLM 推论结果。
2. `style_aligned_batch` 只有在 StyleAligned attention-sharing adapter health=ready 且返回真实 batch id 时才可执行；canonical key art 不得被改写成普通 prompt 文本后宣称已对齐。
3. `outlier_audit_regenerate` 只有在 VLM 或 CLIP adapter 提供可验证 evidence 后才可决定离群；没有模型输出就不产生百分比、相似度或质量分数。
4. 离群重生只允许针对 audit 标记的 asset id，保留原文件与 audit report；不可整批重跑掩盖失败。
5. `style_lora_train_optional` 必须确认数据集、caption、授权和 trainer config 的一一对应；不得把 LoRA 名称、权重或 trigger 写进 prompt 来冒充训练。
6. 所有中间结果写入 Canvas metadata：`workflow_id`、来源 asset ids、adapter/job id、gate status 和版本；不存在的 upstream/job id 不得写入成功状态。

## 失败与降级

- `style-dna-evidence`：缺乏图片证据时阻断该字段并标 `needs_review`；不阻断用户补上参考图或人工注记。
- `style-aligned-upstream`：StyleAligned 未接入时返回 `unsupported` 与缺少的 adapter；不退化成 prompt concatenation，也不建立假 batch job。
- `audit-upstream`：VLM/CLIP 未接入时返回 `unsupported`；不返回虚构分数、不自动挑离群、不重生任何图片。
- `lora-upstream`：LoRA trainer 未接入时返回 `unsupported`；保留已验证数据集与 caption 草稿，不产生权重、不更新 LoRA catalog。
- 研究来源只作方法与字段参考，不等于本地已安装：StoryDiffusion、StyleAligned、OpenAI CLIP、Diffusers LoRA training 都必须在 adapter health 与真实输出存在时才可解除阻断。
