// 子代理／工具卡任务状态的单一语义表（0920 收口）。
//
// 背景：任务状态（running/pending/ok/error/failed/interrupted/stopped…）的
// 中文标签、色调、「是否算失败」曾散布在多个组件的字面比较里，酿成
// 「人工停止被判失败」的假判定事故。本表是状态 → UI 语义的唯一权威：
// 组件只查表，不再各自字面比较。
//
// 语义裁定（0920 暴君钦定）：
//   - stopped（人工停止）＝ 中性灰「已停止」，**不是失败**——取消是使用者
//     自己的决定，标红失败是欺君。
//   - interrupted（回合收尾时仍在 running 的诚实收尾）同样中性。
//   - error/failed 才算失败；running/pending 是进行中。
// 表内 label 照抄改前各组件的实际渲染值（渲染输出零变更的收口重构）。

export type AgentTaskStatus =
  | "running"
  | "pending"
  | "ok"
  | "error"
  | "failed"
  | "interrupted"
  | "stopped";

export type AgentTaskStatusTone = "success" | "failure" | "neutral" | "pending";

export interface AgentTaskStatusMeta {
  label: string;
  tone: AgentTaskStatusTone;
  /** 保守语义：未知状态一律视为失败（宁红勿漏），本表内的终态以表为准。 */
  isFailure: boolean;
}

export const AGENT_TASK_STATUS_TABLE: Record<AgentTaskStatus, AgentTaskStatusMeta> = {
  running: { label: "运行中", tone: "pending", isFailure: false },
  pending: { label: "生成中", tone: "pending", isFailure: false },
  ok: { label: "已完成", tone: "success", isFailure: false },
  error: { label: "失败", tone: "failure", isFailure: true },
  failed: { label: "失败", tone: "failure", isFailure: true },
  interrupted: { label: "已中止", tone: "neutral", isFailure: false },
  stopped: { label: "已停止", tone: "neutral", isFailure: false },
};

/**
 * 状态字符串 → 语义（查表）。未知值 fallback：label=原值、tone=neutral、
 * isFailure=true——不认识的终态宁可当失败（保守），标签诚实回显原值不假造。
 */
export function taskStatusTone(v: string): { label: string; tone: string; isFailure: boolean } {
  const hit = (AGENT_TASK_STATUS_TABLE as Record<string, AgentTaskStatusMeta | undefined>)[v];
  if (hit) return { label: hit.label, tone: hit.tone, isFailure: hit.isFailure };
  return { label: v, tone: "neutral", isFailure: true };
}
