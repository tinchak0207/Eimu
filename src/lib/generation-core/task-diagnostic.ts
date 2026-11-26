// 给用户（和客服）看的脱敏诊断：同一任务发生过什么、钱怎么走的，不含提示词／密钥／上游原文／内部 id。
// 客服只需要用户给一个工单号（任务 id）；运营侧用同一个 id 查 /api/probe/jobs/<id>/timeline 的完整链路。

import { taskOutcome, type TaskOutcome } from "./task-outcome";
import type { JobTimeline } from "./job-events";
import type { GenerationJob } from "./types";

const STEP_LABEL: Record<string, string> = {
  job_created: "已收到订单",
  billing_reserved: "已预留费用",
  billing_committed: "费用已结算",
  billing_refunded: "费用已退回",
  billing_retry_scheduled: "结算稍后重试",
  billing_unknown: "费用状态核对中",
  billing_refund_failed: "退款遇到问题，已转人工",
  job_failed: "订单失败",
  job_cancelled: "订单已取消",
  job_requeued: "重新排队",
  zombie_requeued: "处理中断，已自动重新排队",
  zombie_reclaimed: "处理中断，已终止",
  stranded_refund_retried: "退款重试中",
  billing_manually_reconciled: "人工核对完成",
  attempt_submitted: "已提交给生成服务",
  attempt_succeeded: "生成服务返回成功",
  attempt_failed: "生成服务返回失败",
  reconcile_frozen: "结果未知，正在核对（不会重复扣费）",
  reconcile_polled: "核对中",
  reconcile_delivered: "核对确认成功，已入库",
  reconcile_failed: "核对确认失败，已退款",
  reconcile_exhausted: "核对超时，已转人工处理",
};

export interface TaskDiagnostic {
  supportRef: string;
  outcome: TaskOutcome;
  /** 费用是否已退回／仍在核对。 */
  money: "settled" | "refunded" | "checking" | "unknown";
  steps: { at: string | null; text: string }[];
  /** 可直接粘贴进客服的预填文字（只含工单号与结论，不含提示词）。 */
  supportText: string;
}

function labelOf(entryLabel: string): string | null {
  const head = entryLabel.split(":")[0] ?? entryLabel;
  if (head === "job_current") return null;
  return STEP_LABEL[head] ?? null;
}

export function buildTaskDiagnostic(job: Pick<GenerationJob, "id" | "status" | "failureDetail">, timeline: JobTimeline | null): TaskDiagnostic {
  const outcome = taskOutcome(job);
  const entries = timeline?.timeline ?? [];
  const steps: TaskDiagnostic["steps"] = [];
  for (const entry of entries) {
    const text = labelOf(entry.label);
    if (!text) continue;
    if (steps.length > 0 && steps[steps.length - 1].text === text) continue;
    steps.push({ at: entry.at, text });
  }
  const labels = new Set(entries.map((e) => e.label.split(":")[0]));
  const money: TaskDiagnostic["money"] = labels.has("billing_refunded") || job.status === "refunded"
    ? "refunded"
    : labels.has("billing_unknown") || labels.has("reconcile_frozen") && !labels.has("reconcile_delivered") && !labels.has("reconcile_failed")
      ? "checking"
      : labels.has("billing_committed") || job.status === "succeeded"
        ? "settled"
        : "unknown";
  const moneyText = { settled: "费用已结算", refunded: "费用已退回", checking: "费用核对中", unknown: "费用状态未确定" }[money];
  return {
    supportRef: job.id,
    outcome,
    money,
    steps,
    supportText: `工单号 ${job.id}｜${outcome.headline}｜${moneyText}`,
  };
}
