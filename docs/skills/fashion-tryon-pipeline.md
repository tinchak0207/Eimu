---
name: fashion-tryon-pipeline
version: 1.0
description: 服裝平鋪圖到模特種草的能力宣告與真實門禁；只把已整合的生成/Canvas能力標為可用。
allowed-tools:
  - shot_grid_batch
triggers:
  - 使用者要把服裝平鋪圖做成模特穿搭、種草圖、電商套圖
  - 使用者要做服裝細節圖、身份一致、手部接觸修復或平台重排
requires:
  - src/lib/fashion-tryon-tools.ts
  - 現有 generation batch owner（src/lib/generation-core/batch-service.ts）
  - 現有 Canvas artifact boundary（src/lib/canvas/types.ts，只讀）
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

這個 skill 是領域工具宣告，不是把專用模型的 README 改寫成假能力。每個工具都必須先產生可追溯的 Canvas artifact metadata，再進下一個門；unsupported 工具只能回報阻塞原因與 required capability，不能改寫 prompt 以假裝完成。

## 目前可用邊界

唯一標為 `available` 的工具是 `shot_grid_batch`。它只做現有 image generation queue 的批量編排：

- 參考圖透傳到現有 image edit/reference 路徑。
- 每個 shot type 產生一個 batch item，沿用 generation batch 的 idempotency、計費、調度與部分失敗回報。
- Canvas artifact 使用 domain metadata 描述 `artifactKind=fashion_tryon`、`toolId=shot_grid_batch`、`workflowId`、來源角色與 gate IDs。
- 這條路徑不宣稱 garment DNA lock、model identity lock 或真正的 virtual try-on。

## 工具門禁

| 工具 | 狀態 | 阻塞理由／必要能力 |
| --- | --- | --- |
| `garment_extract` | unsupported | 未整合 BiRefNet/rembg 分割或 matting adapter，不能由 prompt 產出 mask。 |
| `garment_dna_lock` | unsupported | 沒有 garment identity encoder/atlas 與可驗證的 masked identity enforcement。 |
| `model_identity_lock` | unsupported | 沒有 IP-Adapter FaceID/InsightFace embedding 與 scheduler wiring。 |
| `virtual_tryon` | unsupported | CatVTON、IDM-VTON 未接入 generation worker；通用 image edit 不等於 VTON。 |
| `hand_contact_repair` | unsupported | 沒有 MeshGraphormer/MANO 手部 mesh 與局部修復／前後區域驗證。 |
| `shot_grid_batch` | available | 既有 generation batch + Canvas batch artifact 可承接。 |
| `detail_page_evidence_map` | unsupported | 沒有 OCR/region detector、claim-to-pixel evidence store 或 detail-page assembler。 |
| `platform_reflow` | unsupported | 沒有平台模板、safe area、copy fitting、export validation renderer。 |

## 標準資料流

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

若使用者只要求先出一組視覺候選，直接使用 `shot_grid_batch`。若使用者要求「保留衣服版型/Logo」或「同一模特身份」等可驗證承諾，先回傳對應 unsupported gate，不以提示詞替代專用模型能力。

## Canvas artifact metadata

每個工具都必須回傳：

- `artifactKind`: 固定 `fashion_tryon`。
- `artifactId`: 穩定 artifact ID。
- `toolId`: 八個工具之一。
- `status`: 可用工具為 `ready`，未整合工具為 `blocked`。
- `workflowId`: 跨 garment/model/shot 的 lineage key。
- `inputRoles` / `outputRoles`: 工具契約中的欄位角色。
- `gateIds`: 執行前後的阻塞門。
- `lineage.sourceArtifactIds` / `sourceAssetRoles`: 來源圖與上游 artifact 的可追溯關聯。
- unsupported 時額外回傳 `blockedReason` 與 `requiredCapabilities`。

這些欄位是 domain metadata，透過現有 Canvas node metadata 承載；不修改 `src/lib/canvas/types.ts` 共用契約。

## Upstream 來源與整合判定

以下來源用於能力邊界與 required capability 判定，不代表本專案已整合：

- [CatVTON](https://github.com/Zheng-Chong/CatVTON)：虛擬試穿 diffusion；文件描述 person、garment、agnostic mask 與本地推理/ComfyUI 形式。
- [IDM-VTON](https://github.com/yisol/IDM-VTON)：authentic virtual try-on；文件描述 person、garment、dense pose、agnostic mask 與 Python/Gradio 推理。
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)：前景分割／matting；可產出 mask/matte，但本專案沒有接入 adapter。
- [ControlNet](https://github.com/lllyasviel/ControlNet)：OpenPose 受控生成；可作姿態條件能力參考，本專案沒有把 OpenPose detector 接進服裝工具。
- [IP-Adapter](https://github.com/tencent-ailab/IP-Adapter)：參考圖 conditioning；本專案只有一般 reference image 傳輸，沒有 FaceID embedding lock。
- [ComfyUI IPAdapter Plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus)：FaceID 需要 InsightFace 與模型/LoRA 權重；本專案沒有該 runtime 或 scheduler wiring。
- [MeshGraphormer](https://github.com/microsoft/MeshGraphormer)：由影像重建人體 pose/mesh，手部依賴 MANO；本專案沒有 mesh inference 或局部修復 adapter。

上游 repo 的存在、checkpoint、Gradio demo 或 ComfyUI wrapper 都不是本專案的可用證據。只有本地 adapter、worker routing、artifact persistence 與預期通過的生成證據齊全，才能把工具從 `unsupported` 改為 `available`。
