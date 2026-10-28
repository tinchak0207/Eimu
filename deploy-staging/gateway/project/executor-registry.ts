// S6：节点执行器注册表（设计文档 §3.5 的执行器列 + §10 S6「执行器用 fake 注入测试」）。
//
// 调度器只认这张表：`getExecutor(type)` 取不到执行器 = 该节点不能跑（不猜、不回退）。
// 真实执行器由 S7/S8a/S8b/S8c 各自导出、由接线方（S11z）在网关启动时注册；本片不 import 任何
// 执行器文件（那几片与本片并行写），测试用 fake 注册。
//
// deps 是执行器可选的附加依赖（例如需要注入评分表/子代理派发端口的执行器）；调度器不读它，
// 只随条目保存，供接线方按需取用（listExecutors 会带出来）。
import type { NodeExecutor, NodeType } from "./types"

export interface RegisteredExecutor {
  executor: NodeExecutor
  deps?: unknown
}

const REGISTRY = new Map<NodeType, RegisteredExecutor>()

/** 注册（同 type 覆盖：接线方最后注册的为准；测试可反复注册 fake）。 */
export function registerExecutor(exec: NodeExecutor, deps?: unknown): RegisteredExecutor {
  if (!exec || typeof exec.type !== "string" || !exec.type) throw new Error("registerExecutor：执行器必须有 type")
  if (!Number.isInteger(exec.specVersion) || exec.specVersion < 0) throw new Error(`registerExecutor：${exec.type} 的 specVersion 必须是非负整数`)
  if (typeof exec.estimate !== "function" || typeof exec.run !== "function") throw new Error(`registerExecutor：${exec.type} 必须有 estimate()/run()`)
  const entry: RegisteredExecutor = { executor: exec, ...(deps !== undefined ? { deps } : {}) }
  REGISTRY.set(exec.type, entry)
  return entry
}

export function getExecutor(type: NodeType): NodeExecutor | null {
  return REGISTRY.get(type)?.executor ?? null
}

export function getExecutorEntry(type: NodeType): RegisteredExecutor | null {
  return REGISTRY.get(type) ?? null
}

export function listExecutors(): { type: NodeType; specVersion: number; deps?: unknown }[] {
  return [...REGISTRY.entries()]
    .map(([type, e]) => ({ type, specVersion: e.executor.specVersion, ...(e.deps !== undefined ? { deps: e.deps } : {}) }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
}

/** 仅供测试：清空注册表（每个测试文件用 fake 起底，避免跨用例串味）。 */
export function clearExecutors(): void {
  REGISTRY.clear()
}
