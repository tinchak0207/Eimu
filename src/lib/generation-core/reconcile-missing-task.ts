/** 上游最终结果已经是「任务不存在」。超时、空错误、只有状态码，都不算。 */
export function isMissingUpstreamTask(errorDetail: string): boolean {
  return /404/i.test(errorDetail) && /task not found/i.test(errorDetail)
}

/**
 * 提交之后仍然没有上游任务标识，也没有已保存的响应。
 * 有任务标识但暂时查不到，不算这一支：那种仍可能已经做成，不能猜着退。
 */
export function isUndeliveredNoHandle(input: {
  providerTaskId: unknown
  responseCiphertext: unknown
  jobStatus: unknown
}): boolean {
  const task = input.providerTaskId == null ? "" : String(input.providerTaskId).trim()
  const ciphertext = input.responseCiphertext
  const emptyBody = ciphertext == null || ciphertext === ""
  return task === "" && emptyBody && String(input.jobStatus ?? "") === "submit_unknown"
}
