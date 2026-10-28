// S11z：真实执行器总注册（设计文档 §3.5 / §10 S11z）。
//
// 执行器文件由 S7/S8a/S8b/S8c 各自导出，本档只做两件事：
//   1) 汇总成 NodeType → NodeExecutor 映射（键取执行器自己的 type，不另写一份类型名清单）；
//   2) 注册进 executor-registry，并把 scheduler 的 scoreTake 端口接到 S8c 的 scoreTakeOutput。
//
// render3d 在 v1 没有实现，也未被任何配方使用：本档不注册它（不伪造空执行器），
// recipes.test.ts 显式断言“未注册且不被配方使用”。
import { registerExecutor } from "../executor-registry.ts"
import type { NodeExecutor, NodeType, Output, ProjectGraph, ProjectNode } from "../types.ts"
import { scoreTakeOutput } from "./qc"
import { referenceExecutor } from "./reference"
import { scriptExecutor, shotlistExecutor } from "./authored"
import { keyframeExecutor } from "./keyframe"
import { clipExecutor } from "./clip"
import { voiceExecutor } from "./voice"
import { musicExecutor } from "./music"
import { timelineExecutor } from "./timeline"
import { subtitleExecutor } from "./subtitle"
import { mixExecutor } from "./mix"
import { exportExecutor } from "./export"
import { qcExecutor } from "./qc"

/** 全部已实现的真实执行器（顺序无关；键 = executor.type）。 */
const ALL_EXECUTORS: readonly NodeExecutor[] = [
  referenceExecutor,
  scriptExecutor,
  shotlistExecutor,
  keyframeExecutor,
  clipExecutor,
  voiceExecutor,
  musicExecutor,
  timelineExecutor,
  subtitleExecutor,
  mixExecutor,
  exportExecutor,
  qcExecutor,
]

/** 真实执行器映射。不含 render3d：v1 没有实现，注册它等于伪造可跑能力。 */
export function defaultExecutors(): Partial<Record<NodeType, NodeExecutor>> {
  return Object.fromEntries(ALL_EXECUTORS.map((e) => [e.type, e])) as Partial<Record<NodeType, NodeExecutor>>
}

/** takes select:"qc" 的评分端口适配器（scheduler 的签名带 node/project，scoreTakeOutput 收 opts.project）。 */
export function defaultScoreTake(
  output: Output,
  _node: Readonly<ProjectNode>,
  project: Readonly<ProjectGraph>,
): Promise<Output> {
  return scoreTakeOutput(output, { project })
}

export interface InstalledDefaultExecutors {
  executors: Partial<Record<NodeType, NodeExecutor>>
  registered: NodeType[]
  /** 直接作为 runProject/executePlan 的 deps.scoreTake。 */
  scoreTake: typeof defaultScoreTake
}

/** 注册全部真实执行器（同 type 覆盖），返回已注册类型与 scoreTake 端口供网关接线。 */
export function installDefaultExecutors(): InstalledDefaultExecutors {
  const executors = defaultExecutors()
  const registered: NodeType[] = []
  for (const [type, executor] of Object.entries(executors)) {
    if (!executor) continue
    registerExecutor(executor)
    registered.push(type as NodeType)
  }
  return { executors, registered, scoreTake: defaultScoreTake }
}
