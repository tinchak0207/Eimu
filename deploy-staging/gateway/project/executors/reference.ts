// S7 reference 执行器（materialize）：把上传/素材库文件入库成工程产物。
//
// 素材先在 ingress（上传）或素材库侧落成内容寻址产物（params.artifactId 是唯一指针）；
// 执行器的职责只是把它经 ctx.ingest 收编进 artifact-store 并交回 Output：
//   - 已有同 artifactId 的产物 → 直接复用（幂等；不重复拷/hash 大视频）；
//   - 否则从工程产物目录读出 meta（artifacts/<artifactId>.meta.json 的 file 字段），
//     以本地路径交给 ctx.ingest 重算 sha256 入库（adopt 对同内容幂等）。
// 价格 0；不调上游、不新增 env。工程目录契约见设计文档 §3.4：$WORKSPACE_DIR/projects/<sessionId>/。
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { NODE_SPECS } from "../specs.ts"
// 工程目录只认 S2 store.ts 的 projectDirFor（$WORKSPACE_DIR/projects/<sessionId>），不在这里另造一套。
import { projectDirFor } from "../store.ts"
import type { ExecContext, ExecResult, NodeExecutor, Output, ProjectGraph, ProjectNode } from "../types.ts"

const ARTIFACT_ID_RE = /^art_[0-9a-f]{16}$/

function bad(message: string): ExecResult {
  return { ok: false, code: "bad_input", message, retryable: false }
}

export const referenceExecutor: NodeExecutor = {
  type: "reference",
  specVersion: NODE_SPECS.reference.specVersion,
  async estimate(_node: Readonly<ProjectNode>, _project: Readonly<ProjectGraph>, _session: unknown): Promise<number | null> {
    return 0 // 素材入库不花钱
  },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const artifactId = typeof ctx.params.artifactId === "string" ? ctx.params.artifactId : ""
    if (!ARTIFACT_ID_RE.test(artifactId)) {
      return bad(`reference 节点 ${ctx.node.id} 缺少合法 params.artifactId（形如 art_ + 16 位小写 hex）；素材尚未登记，未入库。`)
    }
    const existing = ctx.node.outputs.find((o: Output) => o.artifactId === artifactId)
    if (existing) {
      // 产物文件还在 → 直接复用（不重复拷/hash 大视频）；文件被删则走下面的重新入库。
      const ok = await stat(existing.path).then((st) => st.isFile()).catch(() => false)
      if (ok) return { ok: true, outputs: [{ ...existing, port: "out" }], costCoins: 0 }
    }

    let dir: string
    try {
      dir = path.join(projectDirFor(ctx.sessionId), "artifacts")
    } catch (error) {
      return bad(`reference 节点 ${ctx.node.id} 的工程目录不可用：${error instanceof Error ? error.message : String(error)}；未入库。`)
    }
    const metaPath = path.join(dir, `${artifactId}.meta.json`)
    let meta: { sha256?: unknown; mime?: unknown; file?: unknown }
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8")) as typeof meta
    } catch {
      return bad(`reference 节点 ${ctx.node.id} 的素材 ${artifactId} 不在工程产物库（${metaPath} 不可读）；先由上传/素材库登记该产物，未入库。`)
    }
    if (typeof meta.file !== "string" || !meta.file || typeof meta.sha256 !== "string") {
      return bad(`reference 节点 ${ctx.node.id} 的素材元数据不完整（${metaPath}）；未入库。`)
    }
    const source = path.join(dir, meta.file)
    let out: Output
    try {
      out = await ctx.ingest({ path: source }, {
        port: "out",
        ...(typeof meta.mime === "string" && meta.mime ? { mime: meta.mime } : {}),
        origin: "user",
      })
    } catch (error) {
      return bad(`reference 节点 ${ctx.node.id} 素材入库失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 内容寻址：同一份字节必然落在同一 artifactId；不一致说明素材目录被外部改动。
    if (out.sha256 !== meta.sha256) {
      return bad(`reference 节点 ${ctx.node.id} 素材内容与登记的 sha256 不一致（重算 ${out.sha256.slice(0, 12)}…，登记 ${String(meta.sha256).slice(0, 12)}…）；未入库。`)
    }
    return { ok: true, outputs: [{ ...out, port: "out" }], costCoins: 0 }
  },
}
