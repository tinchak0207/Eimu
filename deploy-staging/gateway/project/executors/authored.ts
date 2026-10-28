// S7 authored 执行器（script / shotlist）：把已写好的内容物化成工程产物（文本 / JSON）。
//
// 内容来源（按优先级）：
//   1. params.text（script）/ params.rows（shotlist）——write_result 或补丁写入的定稿；
//   2. 已有 outputs——内容已落盘（例如同签名重启恢复），直接交回，不重写。
// 两者都没有 → {code:"bad_input", message:"awaiting authored content"}（S6 据此不当执行失败，不写别的状态）。
//
// 落盘口径与 patch.ts 的 write_result 逐字节一致：
//   script   → 正文原样，text/plain
//   shotlist → JSON.stringify({kind, rows})，application/json
// 物化路径：$WORKSPACE_DIR/projects/<sid>/tmp/（在工程目录内，满足 ctx.ingest 的允许根），入库后删临时文件。
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { NODE_SPECS } from "../specs.ts"
import { projectDirFor } from "../store.ts"
import type { ExecContext, ExecResult, Json, NodeExecutor, NodeType, Output, ProjectGraph, ProjectNode } from "../types.ts"

type AuthoredType = "script" | "shotlist"

const AWAITING = "awaiting authored content"

/** 要落盘的字节；absent = 该节点从未写过内容（可回退已有 outputs），empty = 写了但内容为空。 */
function authoredBody(type: AuthoredType, params: Record<string, Json>): { body: string; mime: string; ext: string } | "absent" | "empty" {
  if (type === "script") {
    if (params.text === undefined) return "absent"
    const text = typeof params.text === "string" ? params.text : ""
    return text.trim() ? { body: text, mime: "text/plain", ext: ".txt" } : "empty"
  }
  if (params.rows === undefined) return "absent"
  const rows = params.rows
  if (!Array.isArray(rows) || rows.length === 0) return "empty"
  const kind = typeof params.kind === "string" ? params.kind : null
  return { body: JSON.stringify({ kind, rows }), mime: "application/json", ext: ".json" }
}

const safeSeg = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_")

function makeAuthored(type: AuthoredType): NodeExecutor {
  return {
    type: type as NodeType,
    specVersion: NODE_SPECS[type].specVersion,
    async estimate(_node: Readonly<ProjectNode>, _project: Readonly<ProjectGraph>, _session: unknown): Promise<number | null> {
      return 0 // 作者型节点不产生外部成本
    },
    async run(ctx: ExecContext): Promise<ExecResult> {
      const content = authoredBody(type, ctx.params)
      if (typeof content === "object") {
        const dir = path.join(projectDirFor(ctx.sessionId), "tmp")
        const file = path.join(dir, `authored-${safeSeg(ctx.node.id)}-${safeSeg(String(ctx.runId))}-a${ctx.attempt}-t${ctx.take}${content.ext}`)
        let out: Output
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(file, content.body, "utf-8")
          out = await ctx.ingest({ path: file }, { port: "out", mime: content.mime, origin: "generated" })
        } catch (error) {
          return { ok: false, code: "bad_input", message: `authoring 落盘失败：${error instanceof Error ? error.message : String(error)}`, retryable: false }
        } finally {
          await rm(file, { force: true }).catch(() => undefined)
        }
        return { ok: true, outputs: [{ ...out, port: "out" }], costCoins: 0 }
      }
      if (content === "absent" && ctx.node.outputs.length > 0) {
        return { ok: true, outputs: ctx.node.outputs.map((o: Output) => ({ ...o, port: "out" })), costCoins: 0 }
      }
      return { ok: false, code: "bad_input", message: AWAITING, retryable: false }
    },
  }
}

/** script 与 shotlist 共用一个实现；type 字段按 NodeType 区分。 */
export const scriptExecutor: NodeExecutor = makeAuthored("script")
export const shotlistExecutor: NodeExecutor = makeAuthored("shotlist")
