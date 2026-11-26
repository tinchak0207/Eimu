export type ComfyVersionStatus = "imported" | "invalid" | "valid" | "test_failed" | "test_passed" | "published";

export interface ComfyWorkflowVersion {
  versionId: string;
  workflowId: string;
  status: ComfyVersionStatus;
}

export interface PinnedComfyTask {
  taskId: string;
  workflowVersionId: string;
}

export class ComfyVersionPinError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ComfyVersionPinError";
  }
}

export function markValidated(version: ComfyWorkflowVersion, passed: boolean): ComfyWorkflowVersion {
  if (version.status === "published") return version;
  return { ...version, status: passed ? "valid" : "invalid" };
}

export function markTested(version: ComfyWorkflowVersion, passed: boolean): ComfyWorkflowVersion {
  if (version.status !== "valid" && version.status !== "test_passed" && version.status !== "test_failed") {
    throw new ComfyVersionPinError("未通过校验的工作流不能试跑");
  }
  return { ...version, status: passed ? "test_passed" : "test_failed" };
}

export function publishVersion(version: ComfyWorkflowVersion): ComfyWorkflowVersion {
  if (version.status !== "test_passed" && version.status !== "published") {
    throw new ComfyVersionPinError("必须先校验通过并且试跑通过，才能发布");
  }
  return { ...version, status: "published" };
}

export function pinTask(taskId: string, version: ComfyWorkflowVersion): PinnedComfyTask {
  if (version.status !== "published") {
    throw new ComfyVersionPinError("任务只能钉已发布的 workflowVersionId");
  }
  if (!taskId || !version.versionId) throw new ComfyVersionPinError("钉版本缺少 taskId 或 versionId");
  return { taskId, workflowVersionId: version.versionId };
}

/** 进行中的任务保持原 versionId。后发布的新版本不改写它。 */
export function keepPinnedVersion(task: PinnedComfyTask, _laterPublished: ComfyWorkflowVersion): PinnedComfyTask {
  return { taskId: task.taskId, workflowVersionId: task.workflowVersionId };
}

/**
 * 没有 Comfy 字段的任务不动。带了工作流 id 却没钉已发布版本的，拒绝落库。
 */
export function requirePinnedPublishedWorkflow(workflow: unknown): void {
  if (!workflow || typeof workflow !== "object") return;
  const record = workflow as Record<string, unknown>;
  const usesComfy = record.protocol === "comfyui" || typeof record.comfyuiWorkflowId === "string";
  if (!usesComfy) return;
  if (typeof record.workflowVersionId !== "string" || record.workflowVersionId.length === 0) {
    throw new ComfyVersionPinError("ComfyUI 任务必须钉 workflowVersionId");
  }
  if (record.comfyuiVersionStatus !== "published") {
    throw new ComfyVersionPinError("ComfyUI 版本必须已发布才能钉到任务");
  }
}
