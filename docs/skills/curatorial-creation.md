---
name: curatorial-creation
version: 1.0.0
description: 策展式创作的方向收敛、主视觉与构图锁定、展览交付清单工作流
allowed-tools:
  - moodboard_diverge_converge
  - canonical_key_art_lock
  - sketch_lock
  - exhibition_delivery_manifest
triggers:
  - 用户要做策展系列或展览作品
  - 用户要从 moodboard 收敛到主视觉
  - 用户要锁定草图构图并整理交付文件
requires:
  - src/lib/art-workflows/tool-registry.ts
  - existing generation queue
  - existing Canvas image/reference nodes
optional:
  - IIIF Presentation 3 manifest format
---

## 用途

给需要把一组艺术方向收敛成可核准作品的创作者使用。技能依次产出 moodboard 候选、canonical key art、sketch lock 与 exhibition delivery manifest；每一步都保存 asset id、版本和 Canvas metadata，未通过 gate 不得跳到下一步。

## 工具契约

| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `moodboard_diverge_converge` | `brief`、可选 `referenceImages`、`candidateCount(3-12)` | `candidates`、用户选定的 `selectedDirection` | `src/lib/art-workflows/tool-registry.ts` + existing generation queue/Canvas nodes |
| `canonical_key_art_lock` | 已核准 `approvedDirection`、`styleDna`、`size` | `keyArtAsset`、`lockRecord` | `src/lib/art-workflows/tool-registry.ts` + existing generation queue |
| `sketch_lock` | `compositionBrief`、可选 canonical key art/草图 asset id | `sketchAsset`、`shotSpec` | `src/lib/art-workflows/tool-registry.ts` + existing generation queue/Canvas metadata |
| `exhibition_delivery_manifest` | `approvedAssets`、`exhibition`、可选 `derivatives` | `manifest`、`deliveryChecklist` | `src/lib/art-workflows/tool-registry.ts` + existing Canvas assets；IIIF 仅作格式参考 |

## 行为规则

1. `moodboard_diverge_converge` 必须先保存候选与排除理由；没有 `selectedDirection` 就阻断 key art。
2. `canonical_key_art_lock` 只接受已核准方向与 style DNA，输出必须含 canonical asset id、版本和 prompt snapshot；核准前不得作为后续批次锚点。
3. `sketch_lock` 必须先有草图和完整 `shotSpec`（景别、机位、运镜、比例）；不得用 final render 反推一份虚构草图。
4. 所有工具都要把 `workflow_id`、asset id、status 和关联节点写入 Canvas metadata；引用只能来自既有 image/reference node，不建立第二套 asset id。
5. `exhibition_delivery_manifest` 的 `ready` 需要每笔文件都有 mime、尺寸、色彩空间、bytes、checksum、版本和授权状态；manifest 产生不等于已送达馆方或印刷厂。
6. 能由程序确定性整理的字段由 registry/交付 owner 产生；agent 不得自行捏造 checksum、文件 bytes 或交付成功状态。

## 失败与降级

- `moodboard-input`：缺少 brief 或引用不是实际 image/reference asset 时阻断；不阻断用户补交资料。
- `moodboard-convergence`、`key-art-approval`、`sketch-approval`：未核准时保留当前 Canvas 产物并等待确认；不自动跳步或消耗下一段生成额度。
- `delivery-identity`、`delivery-files`：字段不足时返回未完成 checklist；不标记 `ready`，也不宣称外部交付。
- IIIF、DAM、FTP 或印刷厂未接入时，只生成本地 manifest 草稿；不得假造远程 URL、上传回执或 delivery id。
