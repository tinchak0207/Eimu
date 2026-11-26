/** 子检查回传：status 是等价 HTTP 状态；0 = 网关侧超时/不可判定（调用方按网络失败处理）。 */
export interface PrecheckChild {
  status: number
  body: unknown | null
}
