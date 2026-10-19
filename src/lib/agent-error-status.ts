// 已分类上游错误 → 展示层状态位（唯一真源＝ gateway 分类器产出的 error.code）。
//
// 背景（2026-10-11）：music_gen 等工具的上游错误会经
// tool.result error.human_message → reducer `item.error` → 工具卡原文直甩到界面。
// human_message 兜底形态（「执行失败（上游原因：<原文>）」）可能夹带 HTTP 码、
// 上游响应体，甚至带 token 的 URL／账号名／cookie。gateway 侧
// `classifyFlowMusicFailure` 已把上游错误收敛成四个 code；本档**不重做分类**，
// 只把 code 映射成一句简体中文人话 + 是否可重试，客户端据此渲染状态位而不是原文。
//
// 规则：这是**展示层**，不含任何分类逻辑。新 code 由 gateway 分类器产出后，
// 在此补一行即可；未命中的 code 回 null，调用方照旧展示既有 error 文字。

export interface ClassifiedErrorStatus {
  /** 状态位短标签，一句话钉住类别。 */
  label: string;
  /** 一句简体中文人话（可操作指引）；绝不含上游原文／URL／账号。 */
  hint: string;
  /** 用户重试是否可能奏效。 */
  retryable: boolean;
}

/** code → 状态位文案表。键取自 gateway `classifyFlowMusicFailure` 的 code 输出。 */
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
};

/** code → 展示状态位；未分类的 code（含 undefined）回 null＝照旧展示原文字。 */
export function classifiedErrorStatus(code: string | undefined): ClassifiedErrorStatus | null {
  if (!code) return null;
  return CLASSIFIED_ERROR_STATUS[code] ?? null;
}
