import { createHash } from "node:crypto"

/**
 * 工具面或提示词契约一变就改这里。已盖章的 run 续跑时对不上当前指纹 → 409 kernel_drift。
 * 没盖过章的旧 run 放行，避免把冻期前的会话全部打断。
 * 会话根仍是一条 gateway session；子专家并行不动（那是产线，不是融光式单根表单）。
 */
export const KERNEL_SURFACES = [
  "worker-hard-rules",
  "expert-constitution",
  "short-drama-tool-slices-v1",
  "asset-two-level-v1",
  "comfyui-pin-v1",
  "bgm-video-duration-authority-v1",
] as const

export function kernelFingerprint(input: {
  agent?: string
  modelId?: string
  surfaces?: readonly string[]
}): string {
  const body = JSON.stringify({
    agent: input.agent ?? "",
    modelId: input.modelId ?? "",
    surfaces: [...(input.surfaces ?? KERNEL_SURFACES)].sort(),
  })
  return createHash("sha256").update(body).digest("hex")
}

export function currentKernelFingerprint(agent?: string, modelId?: string): string {
  return kernelFingerprint({ agent, modelId })
}

export interface KernelResumeDecision {
  ok: boolean
  status?: number
  code?: string
  error?: string
}

/** 工具 / prompt 面变了，旧 run 不能静默续。未盖章的历史 run 不算漂移。 */
export function decideKernelResume(stored: string | undefined, current: string): KernelResumeDecision {
  if (!stored || stored === current) return { ok: true }
  return {
    ok: false,
    status: 409,
    code: "kernel_drift",
    error: "历史运行的工具与提示词指纹已变，不能在旧会话上续跑。请重新派工。",
  }
}
