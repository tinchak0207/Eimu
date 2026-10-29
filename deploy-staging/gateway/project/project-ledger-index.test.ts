import { expect, test } from "bun:test"
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProjectLedgerOperations } from "./project-ledger-index.ts"

test("UTF8原话跨调用写入半字符仍保留逐字账本证据", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "ledger-index-")), "ledger")
  const line = Buffer.from(JSON.stringify({ project_id: "p", idem_key: "op", event: "submitted", evidence: "中文原话" }) + "\n")
  const cut = line.indexOf(Buffer.from("中")) + 1
  await writeFile(file, line.subarray(0, cut))
  expect(await readProjectLedgerOperations(file, "p")).toEqual([])
  await appendFile(file, line.subarray(cut))
  expect((await readProjectLedgerOperations(file, "p"))[0].submitted?.evidence).toBe("中文原话")
  await rm(file)
  await expect(readProjectLedgerOperations(file, "p")).rejects.toThrow("ledger_unavailable")
})

test("IO故障不伪装成没有历史；新账本明确不存在才为空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-unavailable-"))
  expect(await readProjectLedgerOperations(join(dir, "new"), "p")).toEqual([])
  await expect(readProjectLedgerOperations(dir, "p")).rejects.toThrow()
  await writeFile(join(dir, "bad"), "{not-json}\n")
  await expect(readProjectLedgerOperations(join(dir, "bad"), "p")).rejects.toThrow("ledger_unavailable")
})

test("旧voice完成行漏idem_key仍归原操作，不漏掉实扣历史",async()=>{
  const file=join(await mkdtemp(join(tmpdir(),"ledger-old-voice-")),"ledger")
  const signature="a".repeat(64)
  await writeFile(file,JSON.stringify({project_id:"voice-film",node_id:"voice1",signature,take:0,attempt:0,model:"tts-zh",event:"completed",cost_coins:0.02,artifact_sha256:"b".repeat(64)})+"\n")
  const operations=await readProjectLedgerOperations(file,"voice-film")
  expect(operations).toHaveLength(1)
  expect(operations[0].key).toBe(`pg:voice-film:${"a".repeat(40)}:t0:a0`)
  expect(operations[0].completed?.cost_coins).toBe(0.02)
  expect(operations[0].completed?.idem_key_source).toBe("legacy_voice_original_identity")
})
