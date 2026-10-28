// 补丁回执：序列化 ≤1024 字节（UTF-8）。超限按固定优先级截断并填 more。
// 截断顺序（先丢价值低的）：changed → stale → warnings → rejected.msg 缩短 → rejected 条数 → drift 条数。
// drift 与 rejected 是最后才动的（它们是「出事了」的信号）；more 里的计数 = 总数 - 实际展示数。
import { LIMITS } from "./constants.ts"
import type { NodeId, PatchErrorCode, PatchReceipt } from "./types.ts"

const CAPS = { rejected: 5, changed: 12, stale: 12, drift: 8, warnings: 3, msgChars: 120 } as const

export interface ReceiptInput {
  ok: boolean
  version: number
  applied: number
  rejected: { i: number; code: PatchErrorCode; node?: NodeId; msg: string }[]
  changed: { node: NodeId; fields: string[] }[]
  stale: NodeId[]
  drift: NodeId[]
  warnings: string[]
}

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length
}

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join("") + "…"
}

export function buildPatchReceipt(input: ReceiptInput): PatchReceipt {
  let msgChars: number = CAPS.msgChars
  let nRejected: number = Math.min(input.rejected.length, CAPS.rejected)
  let nChanged: number = Math.min(input.changed.length, CAPS.changed)
  let nStale: number = Math.min(input.stale.length, CAPS.stale)
  let nDrift: number = Math.min(input.drift.length, CAPS.drift)
  let nWarn: number = Math.min(input.warnings.length, CAPS.warnings)

  const assemble = (): PatchReceipt => {
    const receipt: PatchReceipt = {
      ok: input.ok,
      version: input.version,
      applied: input.applied,
      rejected: input.rejected.slice(0, nRejected).map((r) => {
        const o: PatchReceipt["rejected"][number] = { i: r.i, code: r.code, msg: clip(r.msg, msgChars) }
        if (r.node) o.node = r.node
        return o
      }),
      changed: input.changed.slice(0, nChanged).map((c) => ({ node: c.node, fields: c.fields.slice(0, 4) })),
      stale: input.stale.slice(0, nStale),
      drift: input.drift.slice(0, nDrift),
      warnings: input.warnings.slice(0, nWarn).map((w) => clip(w, 80)),
    }
    const more: NonNullable<PatchReceipt["more"]> = {}
    if (input.rejected.length > nRejected) more.rejected = input.rejected.length - nRejected
    if (input.changed.length > nChanged) more.changed = input.changed.length - nChanged
    if (input.stale.length > nStale) more.stale = input.stale.length - nStale
    if (input.drift.length > nDrift) more.drift = input.drift.length - nDrift
    if (Object.keys(more).length) receipt.more = more
    return receipt
  }

  const fits = (r: PatchReceipt): boolean => utf8Bytes(r) <= LIMITS.PATCH_RECEIPT_BYTES
  let receipt = assemble()
  // 每一步只要还超限就继续降级；步骤顺序 = 截断优先级。
  const steps: (() => boolean)[] = [
    () => (nChanged > 0 ? ((nChanged = Math.max(0, nChanged - 2)), true) : false),
    () => (nStale > 0 ? ((nStale = Math.max(0, nStale - 2)), true) : false),
    () => (nWarn > 0 ? ((nWarn -= 1), true) : false),
    () => (msgChars > 20 ? ((msgChars = Math.max(20, Math.floor(msgChars / 2))), true) : false),
    () => (nRejected > 1 ? ((nRejected -= 1), true) : false),
    () => (nDrift > 1 ? ((nDrift -= 1), true) : false),
    () => (msgChars > 0 ? ((msgChars = 0), true) : false),
    () => (nRejected > 0 ? ((nRejected -= 1), true) : false),
    () => (nDrift > 0 ? ((nDrift -= 1), true) : false),
  ]
  for (const step of steps) {
    while (!fits(receipt) && step()) receipt = assemble()
    if (fits(receipt)) break
  }
  return receipt
}
