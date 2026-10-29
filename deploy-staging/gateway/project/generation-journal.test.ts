import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, statSync, mkdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadGenerationJournal, sharedJournalOperation, sharedGenerationScope, assertJournalCoversLedger, reconcileNonVisualOperations } from "./generation-journal.ts"

const root = mkdtempSync(join(tmpdir(), "shared-generation-journal-"))
const journalPath = join(root, "journal.sqlite")
process.env.WORKSPACE_DIR=join(root,"workspace")
process.env.SESSIONS_DB_PATH=join(root,"sessions.sqlite")
process.env.EIMU_TASK_JOURNAL_PATH = journalPath
const runtimeDir = fileURLToPath(new URL("../../opencode-runtime/", import.meta.url))
const journal = await loadGenerationJournal(runtimeDir)
journal.getSubmission("test-init", "none") // 原journal按首次调用建SQLite，不在import时写磁盘
const db = new Database(journalPath, { readonly: true })

test("共享journal仅受控目录2770/defaultACL，DB与WAL/SHM同组0660", () => {
  expect(statSync(root).mode & 0o7777).toBe(0o2770)
  for (const file of [journalPath, `${journalPath}-wal`, `${journalPath}-shm`]) {
    expect(statSync(file).mode & 0o777).toBe(0o660)
    expect(statSync(file).gid).toBe(statSync(root).gid)
  }
  const acl = spawnSync("getfacl", ["-cp", root], {encoding:"utf8"})
  expect(acl.status).toBe(0)
  expect(acl.stdout).toContain("default:group::rwx")
  expect(acl.stdout).toContain("default:other::---")
})
function operation(project: string, request: string, session: string, cost: number, lock: unknown = null, cap = 1) {
  return sharedJournalOperation(journal, "verified-account-1", {
    identity: { project, request_id: request, session_id: session, model: "model", cost_coins: cost },
    payload: { model: "model", prompt: request, size: "1024x1024", n: 1 }, lock, cap,
  })
}

test("真实SQLite：graph/tool同operation重复进入只预留一次、只有首次取得提交许可", () => {
  const graph = operation("film-mixed", "op1", "session-a", 0.4)
  expect(graph.reserve().submitAllowed).toBe(true)
  const toolRetry = operation("film-mixed", "op1", "session-a", 0.4)
  expect(toolRetry.reserve().submitAllowed).toBe(false)
  const scope = sharedGenerationScope("verified-account-1", "film-mixed")
  const row = db.query("SELECT count(*) AS count,sum(reservation) AS reserved FROM tool_submission WHERE scope=?").get(scope) as any
  expect(row.count).toBe(1)
  expect(row.reserved).toBe(0.4)
  graph.unknown()
  expect(toolRetry.reserve().submitAllowed).toBe(false)
  expect(toolRetry.read().state).toBe("submitting")
})

test("同账户显式project跨session同预算；混用graph普通节点与prepared工具不绕cap", () => {
  const prepared = operation("film-mixed", "op2", "session-b", 0.7, { style: "locked" })
  expect(() => prepared.reserve()).toThrow("task_budget_exceeded")
  const fits = operation("film-mixed", "op3", "session-b", 0.6, { style: "locked" })
  expect(fits.reserve().submitAllowed).toBe(true)
  const laterGraph = operation("film-mixed", "op4", "session-c", 0.1)
  expect(() => laterGraph.reserve()).toThrow("task_budget_exceeded")
})

test("普通graph不冻结用户没选的风格；prepared仍沿用原profile且不允许改锁", () => {
  const ordinary = operation("film-style", "ordinary", "session-a", 0.1)
  ordinary.reserve()
  const prepared = operation("film-style", "prepared", "session-b", 0.1, { model: "fixed", style: "ink" })
  prepared.reserve()
  const changed = operation("film-style", "changed", "session-c", 0.1, { model: "fixed", style: "photo" })
  expect(() => changed.reserve()).toThrow("project_lock_changed")
  expect(operation("film-style", "ordinary-next", "session-c", 0.1).reserve().submitAllowed).toBe(true)
})

test("受理收据同事务落盘；旧单只读恢复不会得到新POST许可", () => {
  const op = operation("film-receipt", "stable-original-id", "session-a", 0.2)
  op.reserve()
  const task = "11111111-1111-4111-8111-111111111111"
  op.accept(task, { task_id: task, kind: "image", request_id: "stable-original-id" })
  const row = op.read()
  expect(row.task_id).toBe(task)
  expect(JSON.parse(row.registration_json).task_id).toBe(task)
  expect(operation("film-receipt", "stable-original-id", "session-b", 0.2).reserve().submitAllowed).toBe(false)
})

test("运行依赖缺失具名阻塞，不产生独立预算/旧POST回退", async () => {
  await expect(loadGenerationJournal(join(root, "missing-runtime"))).rejects.toMatchObject({ code: "generation_journal_unavailable" })
})

test("同一graph跨显式project与普通节点的单行预留同时受工程cap约束", () => {
  const make = (project: string, id: string, cost: number) => sharedJournalOperation(journal, "dual-owner", {
    identity: { project, request_id: id, session_id: "dual-session", model: "m", cost_coins: cost, graph_scope: "same-graph", graph_cap: 1 },
    payload: { prompt: id }, lock: null, cap: 10,
  })
  expect(make("explicit-film", "one", 0.6).reserve().submitAllowed).toBe(true)
  expect(() => make("ordinary-graph", "two", 0.5).reserve()).toThrow("task_budget_exceeded")
  expect(make("ordinary-graph", "three", 0.4).reserve().submitAllowed).toBe(true)
  expect((db.query("SELECT count(*) AS n,sum(reservation) AS used FROM tool_submission WHERE json_extract(metadata_json,'$.graph_scope')='same-graph'").get() as any)).toEqual({n:2,used:1})
})

test("两个真实进程同时抢同一operation：SQLite事务只给一路新提交许可", async () => {
  const source = `const {prepareSubmission}=await import(${JSON.stringify(new URL("../../opencode-runtime/lib/image-journal.ts", import.meta.url).href)});const r=prepareSubmission({scope:"cross-process",request_id:"one-order",session_id:"s",model:"m",cost_coins:0.1},{prompt:"same"},null,1);process.stdout.write(JSON.stringify(r));`
  const run = () => Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, EIMU_TASK_JOURNAL_PATH: journalPath }, stdout: "pipe", stderr: "pipe" })
  const children = [run(), run()]
  const results = await Promise.all(children.map(async (child) => {
    const text = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return JSON.parse(text)
  }))
  expect(results.filter((r) => r.created === true)).toHaveLength(1)
  const row = db.query("SELECT count(*) AS count,sum(reservation) AS reserved FROM tool_submission WHERE scope='cross-process'").get() as any
  expect(row).toEqual({ count: 1, reserved: 0.1 })
})

test("存量只接受operation逐笔映射，不从总额伪造订单或把未知余额归零", () => {
  const scope = sharedGenerationScope("verified-account-1", "film-mixed")
  expect(() => assertJournalCoversLedger(journal, scope, "graph-1", 0.4, JSON.stringify({ project_id: "graph-1", event: "completed", idem_key: "op1", cost_coins: 0.4 }))).not.toThrow()
  expect(() => assertJournalCoversLedger(journal, scope, "graph-1", 0.4, JSON.stringify({ project_id: "graph-1", event: "completed", idem_key: "unmapped-order", cost_coins: 0.4 }))).toThrow("reconciliation_required")
  expect(() => assertJournalCoversLedger(journal, scope, "graph-1", 0.4, "")).toThrow("reconciliation_required")
})

test("真实recoverProject桥恢复后，同一accepted音乐订单按实际回执推进completed而非卡在预留价",async()=>{
  const {ensureProject}=await import("./store.ts")
  const {computeSignature}=await import("./signature.ts")
  const {NODE_SPECS_LITE}=await import("./specs.ts")
  const {recoverProject}=await import("./recovery.ts")
  const {store}=await ensureProject("recover-shared-music")
  await store.applyPatches({ops:[{op:"add_node",node:{id:"score",type:"music",params:{prompt:"original piano score"}}}]},{kind:"agent"})
  const graph=await store.read(),signature=await computeSignature(graph,"score",store.artifacts,NODE_SPECS_LITE)
  if(!signature.ok)throw new Error("fixture signature unknown")
  const key=`pg:${graph.id}:${signature.signature.slice(0,40)}:t0:a0`
  const owner="verified-recovery-owner"
  const operation=sharedJournalOperation(journal,owner,{identity:{project:graph.id,request_id:key,session_id:graph.sessionId,model:"music_gen",cost_coins:1,input_signature:signature.signature,bridge_operation:key,media_kind:"music"},payload:{prompt:"original piano score"},lock:null})
  expect(operation.reserve().submitAllowed).toBe(true)
  operation.accept(key,{kind:"music"})
  const dir=join(store.paths.dir,"tmp");mkdirSync(dir,{recursive:true})
  const file=join(dir,"recovered.wav"),wav=Buffer.alloc(46)
  wav.write("RIFF");wav.writeUInt32LE(38,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(2,40)
  writeFileSync(file,wav)
  const sha=createHash("sha256").update(wav).digest("hex")
  let bridgeCalls=0,resultState="done"
  const bridge:any={call:async()=>{bridgeCalls++;throw new Error("不得新生成")},result:async()=>resultState==="done"?{state:"done",files:[{path:file,mime:"audio/wav",bytes:wav.length,sha256:sha}],costCoins:0.8,chargeRef:"real-fixture-charge"}:{state:"failed"},ingested:async()=>({ok:true})}
  await store.update(g=>{g.nodes.score.status="running";g.nodes.score.inflight={idemKey:key,since:new Date().toISOString(),submitUnknown:true,sig:signature.signature} as any})
  await recoverProject(store,{session:{sessionId:graph.sessionId},execBridge:bridge,submitGeneration:async()=>{throw new Error("不得新生成")},ledger:{write:async()=>{}}})
  const recovered=await store.read()
  expect(recovered.nodes.score.status).toBe("done")
  expect(operation.read().state).toBe("accepted") // 原recover入口没有同步结算此SQLite row
  const ops=[{key,submitted:{project_id:graph.id,session_id:graph.sessionId,node_id:"score",signature:signature.signature,event:"submitted",model:"music_gen",cost_coins:1}}]
  await reconcileNonVisualOperations(journal,owner,recovered,store,ops,bridge)
  expect(operation.read().state).toBe("completed")
  expect(operation.read().reservation).toBe(0.8)
  expect(JSON.parse(operation.read().registration_json).outputs[0].sha256).toBe(sha)
  resultState="failed"
  await reconcileNonVisualOperations(journal,owner,recovered,store,ops,bridge)
  expect(operation.read().state).toBe("completed")
  expect(operation.read().reservation).toBe(0.8)
  expect(bridgeCalls).toBe(0)
})
