// 已分类上游错误 → 展示层状态位（唯一真源＝ gateway / vendor-bridges 产出的 error.code）。
//
// 背景（2026-10-11）：music_gen 等工具的上游错误会经
// tool.result error.human_message → reducer `item.error` → 工具卡原文直甩到界面。
// human_message 兜底形态（「执行失败（上游原因：<原文>）」）可能夹带 HTTP 码、
// 上游响应体，甚至带 token 的 URL／账号名／cookie。gateway 侧
// `classifyFlowMusicFailure` 已把上游错误收敛成四个 code；vendor-bridges
// `fail()` / `classifyError` 也会产出 reference_snapshot_missing / price_unknown /
// submission_unknown / video_price_unknown 等。本档**不重做分类**，只把 code
// 映射成一句简体中文人话 + 是否可重试，客户端据此渲染状态位而不是原文／裸 code。
//
// 规则：这是**展示层**，不含任何分类逻辑。新 code 由 gateway／bridges 产出后，
// 在此补一行即可；未命中的 code 回 null，调用方用 `sanitizeDisplayError` 降级脱敏原文。

import { sanitizeUpstreamMessage, SANITIZED_MESSAGE } from "@/lib/upstream-sanitizer";

export interface ClassifiedErrorStatus {
  /** 状态位短标签，一句话钉住类别。 */
  label: string;
  /** 一句简体中文人话（可操作指引）；绝不含上游原文／URL／账号。 */
  hint: string;
  /** 用户重试是否可能奏效。 */
  retryable: boolean;
}

/** code → 状态位文案表。键取自 gateway / vendor-bridges 的 error.code 输出。 */
const CLASSIFIED_ERROR_STATUS: Record<string, ClassifiedErrorStatus> = {
  flowmusic_session_expired: {
    label: "需要重新登录",
    hint: "音乐账号登录已失效，需要重新登录后再试。",
    retryable: false,
  },
  flowmusic_resource_insufficient: {
    label: "额度或限流不足",
    hint: "上游额度或限流不足，请稍后再试。",
    retryable: true,
  },
  flowmusic_unreachable: {
    label: "上游暂时不可达",
    hint: "音乐上游暂时不可达，请稍后重试。",
    retryable: true,
  },
  flowmusic_config_disabled: {
    label: "配置被拒",
    hint: "音乐通路的配置被上游拒绝，需管理员检查后恢复。",
    retryable: false,
  },
  // vendor-bridges：参考图快照未写出可回放 URL（image_generate / image_edit / client.publicImageUrl）
  reference_snapshot_missing: {
    label: "参考图未存成",
    hint: "参考图没能存成可回放地址，未扣费/已退回。",
    retryable: true,
  },
  // vendor-bridges：缺权威报价，未提交
  price_unknown: {
    label: "缺权威报价",
    hint: "这次档位还没有权威报价，未提交也未扣费；目录恢复后可重试。",
    retryable: true,
  },
  video_price_unknown: {
    label: "缺视频报价",
    hint: "目录没有本次视频档位的权威报价，未提交也未扣费；恢复后用相同请求重试。",
    retryable: true,
  },
  // vendor-bridges：上游接受但状态不明（保留幂等键与预算）
  submission_unknown: {
    label: "提交状态不明",
    hint: "上游接受了但状态还不清楚；预算与幂等键已保留，请用同一请求重试，不要新开一单。",
    retryable: true,
  },
};

/** code → 展示状态位；未分类的 code（含 undefined）回 null＝调用方走脱敏原文。 */
export function classifiedErrorStatus(code: string | undefined): ClassifiedErrorStatus | null {
  if (!code) return null;
  return CLASSIFIED_ERROR_STATUS[code] ?? null;
}

/**
 * 未命中分类表时的展示降级：过 upstream 脱敏，避免工具卡直甩夹带内部指纹的原文。
 * 空／非字串回通用文案，不把空白失败框留给用户。
 */
export function sanitizeDisplayError(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return SANITIZED_MESSAGE;
  return sanitizeUpstreamMessage(raw) ?? SANITIZED_MESSAGE;
}
