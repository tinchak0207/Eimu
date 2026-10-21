# Novel/IP visual package Canvas contract handoff

日期：2026-08-25

## 已落地

`src/lib/novel-ip-visual-tools.ts` 已新增七项小说/IP 视觉工具的声明式契约。每项均包含 input、output、gate、unsupported、Canvas artifact metadata、现有 harness owner 与研究来源。`docs/skills/novel-ip-visual-package.md` 已按 `docs/skills/README.md` 的 skill 标准落档。

## 共用契约缺口

现有 `CanvasNodeMetadata`（`src/lib/canvas/types.ts`）已经能承载 prompt、参考角色、workflow、任务 id、存储键、mime、尺寸、bytes 等字段，但不能类型化表达以下 domain 级 metadata：

- `artifactKind` / `artifactVersion` / `sourceTool`
- 来源 node/artifact id 集合与 `sourceRepos` / `licenseNotes`
- 多个 generation task id 与 sha256 证据集合
- 逐项 gate result 与显式 unsupported 列表

本次**不修改共用契约文件**，避免绕过用户指定边界；registry 保持独立且不会伪装成 CanvasNodeMetadata 已支持这些字段。

## 需要整合者处理

由 Canvas owner 在下一次共用契约变更中，将 `NovelIpCanvasArtifactMetadata` 以兼容扩展方式纳入 `CanvasNodeMetadata`，或建立明确的 `metadata.domainArtifact` 命名空间。整合时必须继续复用：

- `ReferenceImageRole` / `referenceRole` 的唯一 owner：`src/lib/image-types.ts`
- Canvas 状态与持久化：`src/app/api/agent/sessions/[id]/canvas-state/route.ts`、`src/lib/canvas/project-store.ts`
- 生成任务与计费：`src/app/api/generation-jobs/route.ts`、`src/lib/generation-core/command-service.ts`
- 产物校验与 sha256：`src/lib/generation-core/artifact-service.ts`

整合完成前，工具仍可作为 agent harness 的声明式 skill contract 使用；需要写入 Canvas 的 domain metadata 应返回 handoff，而不得静默丢失或另建 metadata store。
