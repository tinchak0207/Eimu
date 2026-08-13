export type WorkstationMobilePanel = "create" | "settings" | "canvas" | "output";
export type WorkstationTaskStage = "prepare" | "queued" | "running" | "succeeded" | "failed";

export function mobilePanelForTaskStage(stage: WorkstationTaskStage): WorkstationMobilePanel {
  if (stage === "succeeded") return "canvas";
  if (stage === "queued" || stage === "running" || stage === "failed") return "output";
  return "create";
}

export function workstationTaskStage(input: {
  status?: string;
  submitting?: boolean;
  hasResult?: boolean;
}): WorkstationTaskStage {
  if (input.status === "failed" || input.status === "cancelled" || input.status === "refunded" || input.status === "unknown") return "failed";
  if (input.status === "succeeded" && input.hasResult) return "succeeded";
  if (input.status === "running") return "running";
  if (input.status === "queued" || input.submitting) return "queued";
  if (input.hasResult) return "succeeded";
  return "prepare";
}
