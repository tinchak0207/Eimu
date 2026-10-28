// E4：丢掉内存里的 store 再打开同一目录，brief 原文、done、产物路径还在。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SANDBOX = mkdtempSync(join(tmpdir(), "s2-restart-"))
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")

const { ensureProject } = await import("./store.ts")
const jobStore = await import("../job-store.ts")
if (typeof jobStore.reopenSessionsDbForTest === "function") jobStore.reopenSessionsDbForTest()

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("网关重启后工程还在", () => {
  test("丢掉内存 store 再 ensureProject：brief 原文、done、output 路径还在", async () => {
    const sid = "ses_e4_drop"
    const text = "第 3 镜重拍，杯子换成玻璃杯"
    const outPath = join(SANDBOX, "e4-shot3.png")
    writeFileSync(outPath, Buffer.from("glass"))
    {
      const { store } = await ensureProject(sid)
      await store.update((g) => {
        g.brief.push({ id: "b1", at: "2026-10-28T00:00:00.000Z", messageId: "m1", text })
        g.nodes.shot3 = {
          id: "shot3", type: "keyframe", intent: "", params: { prompt: "p" }, inputs: {}, refs: [],
          pinned: null, status: "done", signature: null, lastRun: null, outputs: [{
            port: "out", artifactId: "art_e4shot3", sha256: "ab".repeat(32), path: outPath,
            mime: "image/png", bytes: 5, origin: "generated",
          }], rev: 1,
        }
        g.order.push("shot3")
      })
    }
    const { store, created } = await ensureProject(sid)
    expect(created).toBe(false)
    const g = await store.read()
    expect(g.nodes.shot3.id).toBe("shot3")
    expect(g.brief.map((b) => b.text)).toEqual([text])
    expect(g.nodes.shot3.status).toBe("done")
    expect(g.nodes.shot3.outputs[0]?.path).toBe(outPath)
  })
})
