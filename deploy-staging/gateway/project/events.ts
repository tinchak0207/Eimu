// events.jsonl：追加式事件流，seq 即行号（从 1 起）。设计文档 §3.4。
// 提交顺序是「先追加事件 → 再原子写 project.json」，project.json 里的 graph.seq 才是提交点；
// 崩溃后事件行数 > graph.seq 的多余行属于未提交批次，open 时按 graph.seq 截断（reconcile）。
import { appendFile, readFile, writeFile } from "node:fs/promises"
import type { Iso, ProjectEvent } from "./types.ts"

export type EventDraft = Omit<ProjectEvent, "seq" | "at">

function parseLines(text: string): ProjectEvent[] {
  const out: ProjectEvent[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as ProjectEvent)
    } catch {
      break // 崩溃留下的半行：之后的内容不可信
    }
  }
  return out
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8")
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return ""
    throw e
  }
}

export class EventLog {
  constructor(readonly file: string) {}

  /** 追加一批事件，seq 从 startSeq 起连续编号；返回带 seq/at 的完整事件。 */
  async append(drafts: EventDraft[], startSeq: number, at: Iso): Promise<ProjectEvent[]> {
    if (drafts.length === 0) return []
    const events = drafts.map((d, i): ProjectEvent => ({ seq: startSeq + i, at, ...d }))
    await appendFile(this.file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8")
    return events
  }

  /** seq > since 的事件，最多 limit 条（升序）。 */
  async read(since = 0, limit = Number.MAX_SAFE_INTEGER): Promise<ProjectEvent[]> {
    const all = parseLines(await readText(this.file))
    const out: ProjectEvent[] = []
    for (const e of all) {
      if (e.seq <= since) continue
      out.push(e)
      if (out.length >= limit) break
    }
    return out
  }

  /** 有效事件行数（遇半行即停）。 */
  async count(): Promise<number> {
    return parseLines(await readText(this.file)).length
  }

  /** 把事件文件截断到只剩 seq <= seq 的行（含丢弃半行）。 */
  async truncateToSeq(seq: number): Promise<void> {
    const kept = parseLines(await readText(this.file)).filter((e) => e.seq <= seq)
    await writeFile(this.file, kept.length ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "", "utf-8")
  }
}
