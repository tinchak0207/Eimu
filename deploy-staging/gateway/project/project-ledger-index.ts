// 原ledger的只读增量索引：缓存operation身份与原始回执行，不另算/保存余额。
import { open, stat } from "node:fs/promises"
export interface LedgerOperation { key: string; submitted?: Record<string, unknown>; completed?: Record<string, unknown>; refunded?: Record<string, unknown>; failed?: Record<string, unknown> }
type Index = { inode: number; offset: number; tail: string; decoder: TextDecoder; projects: Map<string, Map<string, LedgerOperation>>; pending?: Promise<void> }
const indexes = new Map<string, Index>()

export async function readProjectLedgerOperations(file: string, projectId: string): Promise<LedgerOperation[]> {
  let info
  try { info = await stat(file) } catch (error: any) {
    if (error.code === "ENOENT" && !indexes.has(file)) return []
    throw new Error(`ledger_unavailable: 无法读取权威账本状态(${error.code ?? "io"})，不能当作没有历史`)
  }
  let index = indexes.get(file)
  if (!index || index.inode !== info.ino || index.offset > info.size) {
    index = { inode: info.ino, offset: 0, tail: "", decoder: new TextDecoder("utf-8", { fatal: true }), projects: new Map() }
    indexes.set(file, index)
  }
  if (index.pending) await index.pending
  const current = index
  current.pending = (async () => {
    const handle = await open(file, "r")
    try {
      // UTF-8跨chunk保留到下一个完整换行；不在eventloop上同步读/解析整个账本。
      const decoder = current.decoder
      while (current.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(65536, info.size - current.offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, current.offset)
        if (!bytesRead) throw new Error("ledger_unavailable: 账本读取提前终止，历史状态未知")
        current.offset += bytesRead
        const text = current.tail + decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
        const lines = text.split("\n")
        current.tail = lines.pop() ?? ""
        for (const line of lines) {
          let row: Record<string, unknown>
          try { row = JSON.parse(line) } catch { throw new Error("ledger_unavailable: 权威账本含损坏完整行，不能忽略历史") }
          if (typeof row.project_id !== "string" || !["submitted", "completed", "refunded", "failed"].includes(String(row.event))) continue
          const projectId=row.project_id
          if(typeof row.idem_key!=="string") {
            // 旧voice写completed时漏带idem_key，但实际操作的确定性身份没有变。
            // 只复用其原helper和账本实际字段；不能把无法证明身份的付费行当不存在。
            if(row.model==="tts-zh"&&typeof row.signature==="string"&&typeof row.take==="number"&&Number.isInteger(row.take)&&typeof row.attempt==="number"&&Number.isInteger(row.attempt)) {
              const {idempotencyKeyOf}=await import("./submit-generation.ts")
              row={...row,idem_key:idempotencyKeyOf({projectId:row.project_id,signature:row.signature,take:row.take,attempt:row.attempt}),idem_key_source:"legacy_voice_original_identity"}
            } else if(typeof row.cost_coins==="number"&&row.cost_coins>0) throw new Error("ledger_unavailable: 付费历史行缺稳定operation身份")
            else continue
          }
          const key=String(row.idem_key)
          let project = current.projects.get(projectId)
          if (!project) current.projects.set(projectId, project = new Map())
          const operation = project.get(key) ?? { key }
          operation[row.event as "submitted" | "completed" | "refunded" | "failed"] = row
          project.set(key, operation)
        }
      }
    } finally { await handle.close() }
  })()
  try { await current.pending } catch (error) { indexes.delete(file); throw error } finally { current.pending = undefined }
  return [...(current.projects.get(projectId)?.values() ?? [])]
}
