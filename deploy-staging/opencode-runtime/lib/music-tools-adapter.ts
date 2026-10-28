/**
 * music_gen 工具 opencode 形状机械包装器（Wave1 收尾接线片，2026-09-08）。
 *
 * 形状轮子 = lib/blender-tools-adapter.ts 的 wrapBlenderTool（逐行同构，白名单
 * diff 仅：名称/导入源/context.sessionId 透传三处——MusicToolDef 契约多一个
 * sessionId 栏，opencode execute context 的 sessionID 原样塞进去，音频才能
 * 经 gateway /agent/v1/sessions/<id>/uploads 落盘拼公网 URL）。
 * 行为真源 = lib/music-tools-impl.ts（staging/music-tools/music_tools.ts 落位稿，
 * 描述符形状 MusicToolDef，描述符 → schema 映射纯机械翻译零二次维护面）。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { musicGenTool, type MusicToolDef, type MusicToolContext } from "./music-tools-impl"
import { gatewayRequest, confirmSpend, platformFetch, randomUUID } from "./client"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import path from "node:path"

const musicCalls = new Map<string, Promise<any>>()
const deliveryDir = () => path.join(process.env.WORKSPACE_ROOT || process.cwd(), ".opencode-state/production/music-delivery")
export async function flushMusicDeliveries(): Promise<void> {
  for (const name of await readdir(deliveryDir()).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const file = path.join(deliveryDir(), name)
    try {
      const body = JSON.parse(await readFile(file, "utf8"))
      await gatewayRequest("/internal/music-operation", body)
      await unlink(file)
    } catch { /* The durable result remains available for the next pickup. */ }
  }
}

/** Wrap the actual music tool entry, before tag resolution or any other await. */
export function runMusicOperation(args: Record<string, unknown>, context: any, execute: (guarded: any) => Promise<any>): Promise<any> {
  if (args.probe === true || args.probe === "true") return execute(context)
  const originalAbort = context.abort as AbortSignal | undefined
  if (typeof context.sessionID !== "string" || typeof context.callID !== "string" || !context.callID)
    return Promise.resolve({ title: "音乐未提交", output: JSON.stringify({ ok: false, code: "music_operation_identity_missing", message: "缺少可信工具callID，不能安全提交或重放音乐生成" }) })
  const operation = context.callID
  const invocation = randomUUID()
  const startedMono = process.hrtime.bigint().toString()
  const id = `${context.sessionID}:${operation}`
  const existing = musicCalls.get(id)
  if (existing) return existing
  const fail = (code: string, message: string) => ({ title: "音乐未提交", output: JSON.stringify({ ok: false, code, message }) })
  const run = async () => {
    let admitted = false
    try {
      if (originalAbort?.aborted) return fail("generation_work_cancelled", "原工作已中止，未提交新的音乐生成")
      const identity = { session_id: context.sessionID, operation, invocation }
      const capture = await gatewayRequest("/internal/music-operation", { ...identity, phase: "capture", started_mono: startedMono }, originalAbort)
      if (capture.operation.result) return capture.operation.result
      await flushMusicDeliveries()
      const catalog = await platformFetch("/models", { method: "GET" }, context.sessionID, originalAbort)
      if (!catalog.ok) return fail("music_price_unknown", "音乐目录价暂不可读，未生成")
      const prices: any = await catalog.json()
      const amount = prices.x_coins_per_music ?? prices.data?.find((model: any) => model.id === "music-1")?.x_coins_per_music
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return fail("music_price_unknown", "缺少权威音乐目录单价，未生成")
      const approved = await confirmSpend({ sessionID: context.sessionID, request_id: `music:${context.sessionID}:${operation}`, amount_coins: amount, model: "music-1", description: `音乐生成 ${amount} 币` }, originalAbort)
      if (!approved) return fail("music_spend_not_authorized", "该笔音乐费用未获批准，未生成")
      const beforeSubmit = async () => {
        // The original signal and captured operation never inherit a later work epoch.
        if (originalAbort?.aborted) throw Object.assign(new Error("原工作已中止，未提交新的音乐生成"), { code: "generation_work_cancelled" })
        try { await gatewayRequest("/internal/music-operation", { ...identity, phase: "check" }, originalAbort) }
        catch (error) { throw Object.assign(error as Error, { code: "music_admission_rejected" }) }
        admitted = true
      }
      const result = await execute({ ...context, beforeSubmit, operationId: `music:${context.sessionID}:${operation}` })
      if (admitted) {
        // Persist before network delivery; model cancellation cannot discard this result.
        const body = { ...identity, phase: "complete", result }
        await mkdir(deliveryDir(), { recursive: true, mode: 0o700 })
        const file = path.join(deliveryDir(), `${createHash("sha256").update(id).digest("hex")}.json`)
        const temporary = `${file}.${invocation}.tmp`
        await writeFile(temporary, JSON.stringify(body), { mode: 0o600 })
        await rename(temporary, file)
        try { await gatewayRequest("/internal/music-operation", body); await unlink(file) } catch { /* Retain the actual result for recovery. */ }
      }
      return result
    } catch (error: any) {
      return fail(error.code || "music_admission_failed", error.message || "音乐提交状态不可确认，保留原调用，不重生成")
    }
  }
  const promise = run().finally(() => musicCalls.delete(id))
  musicCalls.set(id, promise)
  return promise
}

export function wrapMusicTool(def: MusicToolDef) {
  return tool({
    description: def.description,
    args: Object.fromEntries(
      Object.entries(def.args).map(([name, spec]) => {
        let s: ReturnType<typeof tool.schema.string>
        if (spec.type === "string") {
          s = ("enum" in spec && spec.enum ? tool.schema.enum([...spec.enum]) : tool.schema.string()) as never
        } else if (spec.type === "number") {
          s = tool.schema.number() as never
        } else {
          s = tool.schema.boolean() as never
        }
        if (!spec.required) s = s.optional() as never
        return [name, s.describe(spec.description)]
      }),
    ),
    async execute(args: Record<string, unknown>, context: MusicToolContext) {
      return def.execute(args, { ...context, sessionId: context.sessionID })
    },
  })
}

export { musicGenTool }
