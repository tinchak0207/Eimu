---
name: fashion-tryon-pipeline
version: 1.0
description: 服装平铺图到模特种草的能力宣告与真实门禁；只把已整合的生成/Canvas能力标为可用。
allowed-tools:
  - shot_grid_batch
triggers:
  - 使用者要把服装平铺图做成模特穿搭、种草图、电商套图
  - 使用者要做服装细节图、身份一致、手部接触修复或平台重排
requires:
  - src/lib/fashion-tryon-tools.ts
  - 现有 generation batch owner（src/lib/generation-core/batch-service.ts）
  - 现有 Canvas artifact boundary（src/lib/canvas/types.ts，只读）
unsupported-tools:
  - garment_extract
  - garment_dna_lock
  - model_identity_lock
  - virtual_tryon
  - hand_contact_repair
  - detail_page_evidence_map
  - platform_reflow
---

# fashion-tryon-pipeline

这个 skill 是领域工具宣告，不是把专用模型的 README 改写成假能力。每个工具都必须先产生可追溯的 Canvas artifact metadata，再进下一个门；unsupported 工具只能回报阻塞原因与 required capability，不能改写 prompt 以假装完成。

## 目前可用边界

唯一标为 `available` 的工具是 `shot_grid_batch`。它只做现有 image generation queue 的批量编排：

- 参考图透传到现有 image edit/reference 路径。
- 每个 shot type 产生一个 batch item，沿用 generation batch 的 idempotency、计费、调度与部分失败回报。
- Canvas artifact 使用 domain metadata 描述 `artifactKind=fashion_tryon`、`toolId=shot_grid_batch`、`workflowId`、来源角色与 gate IDs。
- 这条路径不宣称 garment DNA lock、model identity lock 或真正的 virtual try-on。

## 工具门禁

| 工具 | 状态 | 阻塞理由／必要能力 |
| --- | --- | --- |
| `garment_extract` | unsupported | 未整合 BiRefNet/rembg 分割或 matting adapter，不能由 prompt 产出 mask。 |
| `garment_dna_lock` | unsupported | 没有 garment identity encoder/atlas 与可验证的 masked identity enforcement。 |
| `model_identity_lock` | unsupported | 没有 IP-Adapter FaceID/InsightFace embedding 与 scheduler wiring。 |
| `virtual_tryon` | unsupported | CatVTON、IDM-VTON 未接入 generation worker；通用 image edit 不等于 VTON。 |
| `hand_contact_repair` | unsupported | 没有 MeshGraphormer/MANO 手部 mesh 与局部修复／前后区域验证。 |
| `shot_grid_batch` | available | 既有 generation batch + Canvas batch artifact 可承接。 |
| `detail_page_evidence_map` | unsupported | 没有 OCR/region detector、claim-to-pixel evidence store 或 detail-page assembler。 |
| `platform_reflow` | unsupported | 没有平台模板、safe area、copy fitting、export validation renderer。 |

## 标准资料流

```text
flat-lay garment + model references
  -> garment_extract                 (blocked until segmentation upstream exists)
  -> garment_dna_lock                (blocked until identity encoder exists)
  -> model_identity_lock             (blocked until FaceID upstream exists)
  -> virtual_tryon                   (blocked until CatVTON/IDM-VTON adapter exists)
  -> hand_contact_repair             (blocked until hand mesh + local repair exists)
  -> shot_grid_batch                 (available queue path; no false lock claims)
  -> detail_page_evidence_map        (blocked until evidence mapper exists)
  -> platform_reflow                 (blocked until deterministic renderer exists)
```

若使用者只要求先出一组视觉候选，直接使用 `shot_grid_batch`。若使用者要求「保留衣服版型/Logo」或「同一模特身份」等可验证承诺，先回传对应 unsupported gate，不以提示词替代专用模型能力。

## Canvas artifact metadata

每个工具都必须回传：

- `artifactKind`: 固定 `fashion_tryon`。
- `artifactId`: 稳定 artifact ID。
- `toolId`: 八个工具之一。
- `status`: 可用工具为 `ready`，未整合工具为 `blocked`。
- `workflowId`: 跨 garment/model/shot 的 lineage key。
- `inputRoles` / `outputRoles`: 工具契约中的栏位角色。
- `gateIds`: 执行前后的阻塞门。
- `lineage.sourceArtifactIds` / `sourceAssetRoles`: 来源图与上游 artifact 的可追溯关联。
- unsupported 时额外回传 `blockedReason` 与 `requiredCapabilities`。

这些栏位是 domain metadata，透过现有 Canvas node metadata 承载；不修改 `src/lib/canvas/types.ts` 共用契约。

## Upstream 来源与整合判定

以下来源用于能力边界与 required capability 判定，不代表本专案已整合：

- [CatVTON](https://github.com/Zheng-Chong/CatVTON)：虚拟试穿 diffusion；文件描述 person、garment、agnostic mask 与本地推理/ComfyUI 形式。
- [IDM-VTON](https://github.com/yisol/IDM-VTON)：authentic virtual try-on；文件描述 person、garment、dense pose、agnostic mask 与 Python/Gradio 推理。
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)：前景分割／matting；可产出 mask/matte，但本专案没有接入 adapter。
- [ControlNet](https://github.com/lllyasviel/ControlNet)：OpenPose 受控生成；可作姿态条件能力参考，本专案没有把 OpenPose detector 接进服装工具。
- [IP-Adapter](https://github.com/tencent-ailab/IP-Adapter)：参考图 conditioning；本专案只有一般 reference image 传输，没有 FaceID embedding lock。
- [ComfyUI IPAdapter Plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus)：FaceID 需要 InsightFace 与模型/LoRA 权重；本专案没有该 runtime 或 scheduler wiring。
- [MeshGraphormer](https://github.com/microsoft/MeshGraphormer)：由影像重建人体 pose/mesh，手部依赖 MANO；本专案没有 mesh inference 或局部修复 adapter。

上游 repo 的存在、checkpoint、Gradio demo 或 ComfyUI wrapper 都不是本专案的可用证据。只有本地 adapter、worker routing、artifact persistence 与预期通过的生成证据齐全，才能把工具从 `unsupported` 改为 `available`。
