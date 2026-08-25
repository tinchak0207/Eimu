---
name: novel-ip-visual-package
version: 1.0.0
description: 小说/IP 视觉包七工具链——世界观、情绪、风格、角色、序列、重排与溯源归档
allowed-tools:
  - world_bible_extract
  - emotion_board_matrix
  - style_anchor_sref
  - character_dna_turnaround
  - story_sequence_consistency
  - multi_aspect_reflow
  - asset_provenance_archive
triggers:
  - 用户要把小说、IP 或故事做成角色设定、分镜、漫画或视觉资产包
  - 用户要求角色/场景/风格跨画面保持一致
  - 用户要求多比例输出、资产溯源或可审计归档
requires:
  - src/lib/novel-ip-visual-tools.ts（七项工具的输入、输出、门禁、unsupported 与 Canvas artifact metadata）
  - src/lib/agent-gateway.ts（现有 harness owner）
  - src/lib/canvas/types.ts（Canvas 节点、referenceRole 与项目结构 owner）
  - src/lib/canvas/semantic-nodes.ts（参考图/提示词注入 owner）
  - src/lib/generation-gates.ts（确定性生成门 owner）
  - src/lib/generation-core/command-service.ts（生成任务提交 owner）
  - src/lib/generation-core/artifact-service.ts（产物校验、哈希与归档 owner）
optional:
  - src/lib/generation-model-catalog/（目标模型比例与能力投影；缺失时跳过比例增强，不伪造支持）
---

# novel-ip-visual-package —— 小说/IP 视觉包七工具链

## 用途

面向小说作者、IP 美术和分镜创作者，把文本中的世界规则、情绪、风格、角色 DNA 和连续镜头收敛为可复用的 Canvas 资产，并经现有 agent harness 与生成队列完成图像任务。工具定义是现有 owner 的声明式投影，不拥有第二套队列、历史、素材 id 或能力目录；资产 id 只能来自现有 Canvas 节点或 generation artifact。

## 工具契约

| 工具 | 入参 | 出参 | 门禁 | Canvas artifact metadata | 后端 owner |
|---|---|---|---|---|---|
| `world_bible_extract` | 文本/文档引用、已有角色/场景 node id | `rules`、`locations`、`props`、`visualDoNot`，每条含 `sourceQuote` 与 `linkedNodeIds` | `world_bible.source_traceable`、`world_bible.required_sections`、`world_bible.node_ids_exist` | `artifactKind=world_bible`、`nodeType=text`、锁定、来源节点/资产与 gate 结果 | `agent-gateway`；Canvas state route；不出图 |
| `emotion_board_matrix` | 世界观、剧情 beat、可选参考 node id、`intensity=1..5` | 有序 `emotion matrix`：情绪、强度、色板、光线、构图、negative cues | `emotion_board.beat_order`、`emotion_board.intensity_range`、`emotion_board.palette_complete` | `artifactKind=emotion_board`、`nodeType=group`、`referenceRoles=style,composition` | `agent-gateway`；Canvas state；不新增 history |
| `style_anchor_sref` | 1-8 张参考图 node/artifact id、风格描述、可选 style template | `style anchor`：参考 id、风格摘要、`role=style` 引用、来源与许可备注 | `style_anchor.reference_exists`、`style_anchor.role_style`、`style_anchor.provenance_present` | `artifactKind=style_anchor`、`nodeType=reference`、`referenceRoles=style` | `canvas/semantic-nodes.ts`；`generation-workflow.ts`；`image-types.ts` |
| `character_dna_turnaround` | character card id、1-4 张角色参考、外观约束、视角集合 | 角色 DNA JSON + turnaround generation task set，回挂同一角色卡并保存 task id/hash | `character_dna.card_binding`、`character_dna.reference_role`、`character_dna.view_set`、`generation.preflight` | `artifactKind=character_turnaround`、`nodeType=character_card`、`referenceRoles=character` | Canvas semantic inputs；现有 image tool；`generation-core/command-service.ts` |
| `story_sequence_consistency` | 有序 shots、角色/场景/风格 node id、每格 prompt、可选 ControlNet 条件图 | 有序 sequence artifact + 每格任务 id、引用角色、输入快照、gate 结果 | `story_sequence.order_unique`、`story_sequence.assets_resolve`、`story_sequence.reference_roles`、`generation.preflight` | `artifactKind=story_sequence`、`nodeType=group`、保存角色/风格/构图引用 | agent gateway；Canvas semantic nodes；现有 generation queue |
| `multi_aspect_reflow` | sequence artifact、catalog 中目标比例、版式约束、每格优先级 | reflow manifest：目标比例、构图变化、保留/裁切/重生原因、必要任务 | `reflow.aspect_supported`、`reflow.order_preserved`、`reflow.reference_bindings_preserved`、`generation.preflight` | `artifactKind=aspect_reflow`、`nodeType=group`、保留 composition/character/style 引用 | `generation-workflow.ts`；`generation-model-catalog/`；现有 generation queue |
| `asset_provenance_archive` | Canvas node/artifact id、generation task id、来源 URL/repo、许可备注；禁止 secret | 不可变归档：关系、来源、许可、task id、mime/尺寸/hash、gate 结果 | `provenance.ids_resolve`、`provenance.hash_present`、`provenance.secret_free`、`artifact.validated` | `artifactKind=provenance_archive`、`nodeType=text`、来源与 sha256 数组 | agent tool result；Canvas state；`generation-core/artifact-service.ts` |

完整 TypeScript 定义见 `src/lib/novel-ip-visual-tools.ts`。`gate` 只声明业务段门；确定性生成前置门仍由 `src/lib/generation-gates.ts` 执行，出图必须继续走现有 generation queue。

## 行为规则

1. 角色、场景和参考图引用必须解析到现有 Canvas 节点或 generation artifact；工具不得创建第二套资产 id。
2. `referenceRole` 只能复用 `src/lib/image-types.ts` 的角色语义；风格参考用 `style`，角色参考用 `character`，构图条件用 `composition`。
3. 任何生成任务必须经现有 generation route、`generation-core/command-service.ts` 和 `generation-gates`；不得直连 StoryDiffusion、IP-Adapter 或 ControlNet 上游。
4. 角色与序列工具必须保留输入 node/artifact id、generation task id、sha256 与 gate results；没有这些证据不得声称一致性完成。
5. `multi_aspect_reflow` 只能使用 model catalog 已声明的比例；不支持的比例阻断对应任务，不静默改成另一个比例。
6. 研究仓库的能力只作为 workflow 依据：StoryDiffusion 的长序列注意力、NovelToComic 的角色记忆/动态 panel、IP-Adapter 的图像提示与 ControlNet 的结构条件，均不等于本站已部署对应推理后端。
7. `asset_provenance_archive` 禁止接收或写入密码、token、cookie、私钥、OTP 或原始认证材料；归档只保留非敏感来源与产物证据。
8. 失败按任务或单格隔离：缺失资产阻断对应工具/镜头，但不伪造整批成功；可独立生成的同批任务仍可继续。

## 失败与降级

- `missing_canvas_reference`：引用节点/产物不存在；阻断当前工具，返回缺失 id，不影响已有 Canvas 项目。
- `gate_failed`：确定性门失败；阻断当前段或镜头，返回 gate id/detail，不能带病提交生成队列。
- `unsupported_model_capability`：模型不支持参考图、比例或对应媒体；阻断该任务，保留结构化 manifest，不换模型、不伪造结果。
- `generation_queue_unavailable`：现有队列或供应商不可用；任务留在既有待提交/失败状态，工具只返回真实状态，不创建第二套 queue。
- `artifact_validation_failed`：`artifact-service` 无法验证 mime、尺寸或 sha256；不归档为完整产物，保留失败原因供重试。
- `provenance_secret_rejected`：输入含敏感认证材料；拒绝写入并返回字段级错误，其他非敏感资产仍可继续归档。
- `optional_catalog_unavailable`：比例/能力增强信息不可用；跳过增强并明确标记 `unsupported`，不阻断纯文本资产提取；任何实际生成仍需现有生成门和队列。

## 研究依据

- [HVision-NKU/StoryDiffusion](https://github.com/HVision-NKU/StoryDiffusion)：一致性自注意力、至少 3 个文本提示的序列生成、漫画生成入口。
- [RD1241/NovelToComic](https://github.com/RD1241/NovelToComic)：小说场景提取、角色记忆、动态 panel、ControlNet/IP-Adapter 组合的实验 workflow。
- [Tencent AI Lab/IP-Adapter](https://github.com/tencent-ailab/IP-Adapter)：图像 prompt、Face/Style 参考、与 ControlNet 的结构条件组合及非方形图限制。
- [lllyasviel/ControlNet](https://github.com/lllyasviel/ControlNet)：Canny、姿态、深度、草图等结构条件与多 ControlNet 组合。
