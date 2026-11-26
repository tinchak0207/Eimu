// 任务结局的人话投影（吸收 AID「任务异常中心」的用户侧：同一原任务，四种结局说清楚）。
//
// 病灶：任务卡只有 failed／unknown 一个红字。提交响应丢失（submit_unknown）、排队等待、
// 确定失败已退款、成功入库，对用户是四件完全不同的事——前者最危险：用户若以为「没成」重提，
// 就会重复扣费；它真正该做的是「别重提，原订单还在，我们在核对」。
//
// 本档纯函式，不碰 DB、不发上游：只把 job 状态翻成用户能行动的话，并给出可共享的工单号
// （＝任务 id，运营后台 `/api/admin/…/timeline` 与用户看到的是同一个键，沿 id 即可查原始链路）。

import type { GenerationJob } from "./types";
import { taskStatus } from "./task-response";

export type TaskOutcomeState =
  | "succeeded"
  | "waiting"
  | "unknown_upstream"
  | "failed_refunded"
  | "failed"
  | "cancelled";

export interface TaskOutcome {
  state: TaskOutcomeState;
  /** 一句话结论（用户第一眼看到的）。 */
  headline: string;
  /** 补充：现在发生了什么、用户该做什么。 */
  detail: string;
  /** 可重提吗？`unknown_upstream`／`waiting` 恒为 false——重提＝重复扣费。 */
  safeToRetry: boolean;
  /** 工单号（任务 id）：用户求助时预填，运营沿它查链路；不含 prompt／密钥。 */
  supportRef: string;
}

export function taskOutcome(job: Pick<GenerationJob, "id" | "status" | "failureDetail">): TaskOutcome {
  const supportRef = job.id;
  const status = taskStatus(job as GenerationJob);
  switch (status) {
    case "succeeded":
      return { state: "succeeded", headline: "已完成", detail: "成果已入库，可在历史里找到。", safeToRetry: false, supportRef };
    case "queued":
    case "running":
      return {
        state: "waiting",
        headline: status === "queued" ? "排队中，原订单在等待" : "生成中，请稍候",
        detail: "不用重新提交：重复提交会产生第二笔订单。关掉页面也没关系，回来会接着显示这一单。",
        safeToRetry: false,
        supportRef,
      };
    case "unknown":
      return {
        state: "unknown_upstream",
        headline: "上游是否已收到订单还在核对",
        detail: "原订单已保留，不要重新提交（会重复扣费）。核对完成后会自动入库，或自动退款；你可以稍后回来查看同一个任务。",
        safeToRetry: false,
        supportRef,
      };
    case "refunded":
      return {
        state: "failed_refunded",
        headline: "本次没有生成成功，费用已退回",
        detail: "可以放心重试，不会重复扣费。",
        safeToRetry: true,
        supportRef,
      };
    case "cancelled":
      return { state: "cancelled", headline: "已取消", detail: "未完成的部分已按规则退回。", safeToRetry: true, supportRef };
    default:
      return {
        state: "failed",
        headline: "本次生成失败",
        detail: "费用以账单为准（失败单会自动退回）。如需求助，请把下面的工单号发给我们，不用复制提示词或密钥。",
        safeToRetry: true,
        supportRef,
      };
  }
}
