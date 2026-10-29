// 复用已部署 runtime journal 的同一实现与 SQLite 表。不是第二份余额/风格配置。
// Gateway release 独立于 runtime，禁止相对 import 到生产不存在的兄弟源码树。
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { sharedGenerationScope } from "../generation-scope.ts"
export { sharedGenerationScope } from "../generation-scope.ts"
import type { SubmissionIdentity } from "../../opencode-runtime/lib/image-journal.ts"
import type { ProjectStore } from "./store.ts"
import type { SubmitGenerationReq, GenerationOperationReq, ExecBridgeClient } from "./types.ts"
import type { ProjectGraph } from "./types.ts"
import { readProjectLedgerOperations, type LedgerOperation } from "./project-ledger-index.ts"

type Journal = Pick<typeof import("../../opencode-runtime/lib/image-journal.ts"),
  "getSubmission" | "prepareSubmission" | "finishSubmission" | "settleSubmission" | "importVerifiedSubmission" | "acceptTaskSubmission" | "lockedProjectBudget"> & { IMAGE_JOURNAL_CONTRACT_VERSION: number }

export class GenerationJournalBlocked extends Error {
  readonly code = "generation_journal_unavailable"
}

const loaded = new Map<string, Promise<Journal>>()

/** 组合根必须提供可信目录配置；调用体不能选择模块/文件/凭证。依赖失效绝不退回直接 POST。 */
export async function loadGenerationJournal(runtimeDir?: string): Promise<Journal> {
  runtimeDir ??= process.env.EIMU_RUNTIME_DIR || join((await import("./store.ts")).workspaceDir(), ".opencode")
  let file: string
  try { file = realpathSync(join(runtimeDir, "lib/image-journal.ts")) }
  catch { throw new GenerationJournalBlocked("既有 runtime image-journal 模块不可读；未预留、未提交，需恢复运行依赖") }
  // 同一源码的数据库配置也是组合根的一部分。隔离测试/独立实例不能复用另一路径的模块级连接。
  const journalPath = process.env.EIMU_TASK_JOURNAL_PATH || "default"
  const cacheKey = file + "\0" + journalPath
  let pending = loaded.get(cacheKey)
  if (!pending) {
    pending = import(pathToFileURL(file).href + "?journal=" + encodeURIComponent(journalPath)).then((module: Journal) => {
      if (module.IMAGE_JOURNAL_CONTRACT_VERSION !== 1 || ["prepareSubmission", "getSubmission", "finishSubmission", "settleSubmission", "importVerifiedSubmission", "acceptTaskSubmission", "lockedProjectBudget"].some(name => typeof (module as any)[name] !== "function")) {
        throw new GenerationJournalBlocked("runtime image-journal 合约版本不匹配；未提交，禁止新建独立预算")
      }
      return module
    }).catch((error) => {
      loaded.delete(cacheKey)
      throw error instanceof GenerationJournalBlocked ? error : new GenerationJournalBlocked("runtime image-journal 加载失败；未提交，需恢复运行依赖")
    })
    loaded.set(cacheKey, pending)
  }
  return pending
}

export interface SharedOperation {
  identity: Omit<SubmissionIdentity, "scope">
  /** 已完成校验/实体解析/参考上传的实际载荷；不能换模型或静默掉参数。 */
  payload: Record<string, unknown>
  /** 普通图节点为 null；显式工具项目沿用原模型/参考/STYLE LOCK 冻结结构。 */
  lock: unknown | null
  cap?: number
}

/** 同一个 operation 只调用既有原子预留。图节点、tool节点和跨会话都用同一作用域。 */
export function sharedJournalOperation(journal: Journal, trustedOwnerScope: string, operation: SharedOperation) {
  const identity = { ...operation.identity, scope: sharedGenerationScope(trustedOwnerScope, operation.identity.project) }
  const row = () => journal.getSubmission(identity.scope, identity.request_id)
  return {
    identity,
    read: row,
    reserve() {
      const reserved = journal.prepareSubmission(identity, operation.payload, operation.lock, operation.cap)
      return { row: row(), submitAllowed: reserved.created }
    },
    /** task_id 与恢复收据使用既有 SQLite 同一事务，调用后才可以对外回受理。 */
    accept(taskId: string, receipt: Record<string, unknown>) {
      journal.acceptTaskSubmission(identity.scope, identity.request_id, taskId, { ...receipt, session_id: identity.session_id })
      return row()
    },
    reject() { journal.finishSubmission(identity.scope, identity.request_id, "rejected") },
    refunded() { journal.finishSubmission(identity.scope, identity.request_id, "refunded") },
    settle(actualCoins: number) { journal.settleSubmission(identity.scope, identity.request_id, actualCoins) },
    /** 未知不是拒收。保留原预留，重复入口只可读，不获得再次 POST 的许可。 */
    unknown() { journal.finishSubmission(identity.scope, identity.request_id, "submitting") },
  }
}
export type SharedJournalOperation = ReturnType<typeof sharedJournalOperation>

/** 只接受逐笔可关联的旧消耗；没有证据就阻塞，不用总额伪造新订单或归零。 */
export function assertJournalCoversLedger(journal: Journal, scope: string, projectId: string, graphSpent: number, ledgerText: string) {
  let hasSpendEvidence = false
  for (const line of ledgerText.split("\n")) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) } catch { continue }
    if (row.project_id !== projectId || !["submitted", "completed"].includes(String(row.event))) continue
    if (!(typeof row.cost_coins === "number" && row.cost_coins > 0)) continue
    hasSpendEvidence = true
    if (typeof row.idem_key !== "string" || !journal.getSubmission(scope, row.idem_key)) {
      throw new GenerationJournalBlocked(`reconciliation_required: 工程 ${projectId} 存量操作缺少同scope journal关联，先按原receipt/operation对账；未提交`)
    }
  }
  if (graphSpent > 0 && !hasSpendEvidence) throw new GenerationJournalBlocked(`reconciliation_required: 工程 ${projectId} 有历史消耗但没有逐笔ledger证据；未提交`)
}

/** 导入真实历史operation，不创建新provider请求。receipt与ledger身份/实际金额须相互支持。 */
export function reconcileJournalOperations(journal: Journal, owner: string, graph: Readonly<ProjectGraph>, operations: LedgerOperation[], receipts: Array<Record<string, any>>) {
  const scope = sharedGenerationScope(owner, graph.id)
  if (graph.budget.spentCoins > 0 && !operations.length) throw new GenerationJournalBlocked("reconciliation_required: 历史支出缺逐笔operation证据")
  for (const op of operations) {
    const prior = journal.getSubmission(scope, op.key)
    const priorMeta = prior ? JSON.parse(prior.metadata_json) : undefined
    if (priorMeta?.bridge_operation === op.key && priorMeta?.input_signature === (op.completed ?? op.submitted)?.signature && ["music", "voice"].includes(priorMeta?.media_kind)) continue
    if (prior && JSON.parse(prior.metadata_json).imported_from !== "gateway_ledger_receipt") continue
    const row = op.completed ?? op.submitted
    if (!row || !(typeof row.cost_coins === "number" && row.cost_coins > 0)) continue
    if (typeof row.signature !== "string" || typeof row.node_id !== "string" || !graph.nodes[row.node_id] || row.project_id !== graph.id || row.session_id !== graph.sessionId) {
      throw new GenerationJournalBlocked(`reconciliation_required: 操作${op.key}缺少可验证的工程/账号/节点来源`)
    }
    const receipt = receipts.find((r) => r.request_id === op.key && r.parent_gw === graph.sessionId && r.node_id === row.node_id && r.signature === row.signature && r.project === graph.id)
    if (receipt?.tool_request_id) {
      const linked = journal.getSubmission(sharedGenerationScope(owner, receipt.tool_project), receipt.tool_request_id)
      if (linked && linked.task_id === receipt.task_id && JSON.parse(linked.metadata_json).graph_signature === row.signature) continue
    }
    const identity = { scope, graph_scope: sharedGenerationScope(owner, `graph:${graph.id}`), project: graph.id, request_id: op.key, session_id: graph.sessionId, model: String(row.model ?? receipt?.model ?? ""), input_signature: row.signature, cost_coins: row.cost_coins }
    if (op.refunded && receipt && (receipt.status === "refunded" || (typeof receipt.refunded_coins === "number" && receipt.refunded_coins >= row.cost_coins))) {
      journal.importVerifiedSubmission(identity, "refunded", receipt.task_id)
    } else if (op.completed) {
      if (!receipt || receipt.status !== "succeeded" || typeof receipt.cost_coins !== "number" || receipt.cost_coins !== row.cost_coins || (row.task_id && row.task_id !== receipt.task_id)) throw new GenerationJournalBlocked(`reconciliation_required: 已完成操作${op.key}的终态/任务/实扣回执不一致`)
      journal.importVerifiedSubmission(identity, "completed", receipt.task_id)
    } else {
      // 提交未知/failed未证退款仍保留原operation预留，绝不冒充0或释放后重新付费。
      journal.importVerifiedSubmission(identity, receipt ? "accepted" : "submitting", receipt?.task_id)
    }
  }
}

/** 音乐/语音旧账按其原回执与实际产物核对，不能拿影像receipt冒充。 */
export async function reconcileNonVisualOperations(journal: Journal, owner: string, graph: Readonly<ProjectGraph>, store: ProjectStore, operations: LedgerOperation[], bridge: ExecBridgeClient) {
  const scope=sharedGenerationScope(owner,graph.id)
  for(const op of operations) {
    let row=op.completed??op.submitted
    if(!row || typeof row.node_id!=="string")continue
    const kind=graph.nodes[row.node_id]?.type
    if(kind!=="music"&&kind!=="voice")continue
    const node=graph.nodes[row.node_id]
    const recoveredOutput=kind==="music"?node.outputs.find(out=>{
      const source=out.meta?.bridgeOperation as Record<string,unknown>|undefined
      return source?.idemKey===op.key&&source.sessionId===graph.sessionId&&source.projectId===graph.id&&source.nodeId===node.id&&source.signature===row!.signature
    }):undefined
    let completed=!!op.completed
    let recoveredResult:Awaited<ReturnType<ExecBridgeClient["result"]>>|undefined
    const prior=journal.getSubmission(scope,op.key)
    if(prior){const meta=JSON.parse(prior.metadata_json);if(meta.bridge_operation===op.key&&meta.input_signature===row.signature&&meta.media_kind===kind&&(prior.state==="completed"||prior.state==="refunded"||(!completed&&!recoveredOutput)))continue}
    if(!completed&&recoveredOutput){
      recoveredResult=await bridge.result(op.key,{sessionId:graph.sessionId,projectId:graph.id,nodeId:node.id,signature:String(row.signature)})
      if(recoveredResult.state!=="done")continue // 仍未知保原预留，不以图状态冒充财务终态
      if(typeof recoveredResult.costCoins!=="number"||!Number.isFinite(recoveredResult.costCoins)||recoveredResult.costCoins<0||node.lastRun?.costCoins!==recoveredResult.costCoins||!recoveredResult.chargeRef)throw new GenerationJournalBlocked(`reconciliation_required: 恢复音乐${op.key}缺原实扣证据`)
      row={...row,cost_coins:recoveredResult.costCoins,artifact_sha256:recoveredOutput.sha256,charge_ref:recoveredResult.chargeRef}
      completed=true
    }
    if(typeof row.signature!=="string"||row.project_id!==graph.id||row.session_id!==graph.sessionId||typeof row.cost_coins!=="number"||!Number.isFinite(row.cost_coins)||row.cost_coins<0)throw new GenerationJournalBlocked(`reconciliation_required: ${kind}操作${op.key}来源不完整`)
    const identity={scope,graph_scope:sharedGenerationScope(owner,`graph:${graph.id}`),project:graph.id,request_id:op.key,session_id:graph.sessionId,model:String(row.model??""),input_signature:row.signature,cost_coins:row.cost_coins,bridge_operation:op.key,media_kind:kind as "music"|"voice"}
    if(completed){
      const sha=row.artifact_sha256
      if(typeof sha!=="string"||!/^[a-f0-9]{64}$/.test(sha)||!await store.artifacts.verify(`art_${sha.slice(0,16)}`))throw new GenerationJournalBlocked(`reconciliation_required: ${kind}操作${op.key}缺原产物指纹证据`)
      let shas=[sha]
      if(kind==="music") {
        const result=recoveredResult??await bridge.result(op.key,{sessionId:graph.sessionId,projectId:graph.id,nodeId:node.id,signature:row.signature})
        if(result.state!=="done"||result.costCoins!==row.cost_coins||!result.files?.some(f=>f.sha256===sha)||typeof row.charge_ref!=="string"||result.chargeRef!==row.charge_ref)throw new GenerationJournalBlocked(`reconciliation_required: 音乐操作${op.key}原bridge实扣/产物回执不一致`)
        shas=result.files.map(file=>file.sha256??"")
      }
      const outputs=[]
      for(const hash of shas){
        if(!/^[a-f0-9]{64}$/.test(hash)||!await store.artifacts.verify(`art_${hash.slice(0,16)}`))throw new GenerationJournalBlocked(`reconciliation_required: ${kind}原批次产物不完整`)
        const out=await store.artifacts.get(`art_${hash.slice(0,16)}`,{port:"out",origin:"generated"})
        if(!out)throw new GenerationJournalBlocked(`reconciliation_required: ${kind}原产物不可读`)
        outputs.push(out)
      }
      journal.importVerifiedSubmission(identity,"completed",op.key)
      journal.acceptTaskSubmission(scope,op.key,op.key,{outputs,kind,originalCostCoins:row.cost_coins,session_id:graph.sessionId})
    }else{
      // 未完成/未证退款仍占用原预留；只允许原bridge result恢复，不自动重做speech。
      journal.importVerifiedSubmission(identity,"submitting",op.key)
    }
  }
}

async function reconcileProductionOperations(journal: Journal, owner: string, graph: Readonly<ProjectGraph>, store: ProjectStore, bridge: ExecBridgeClient) {
  const [{LEDGER_PATH},{generationReceipts}]=await Promise.all([import("../constants-gateway.ts"),import("../job-store.ts")])
  const operations=await readProjectLedgerOperations(LEDGER_PATH,graph.id)
  await reconcileNonVisualOperations(journal,owner,graph,store,operations,bridge)
  reconcileJournalOperations(journal,owner,graph,operations,generationReceipts(graph.sessionId))
}

export function productionGenerationOperation(sessionId:string,store:ProjectStore,bridge:ExecBridgeClient) {
  return async(req:GenerationOperationReq):Promise<SharedJournalOperation>=>{
    const [{stableGenerationOwnerScope},{generationProjectAuthorization}]=await Promise.all([import("../job-delivery.ts"),import("../job-store.ts")])
    const owner=await stableGenerationOwnerScope(sessionId),graph=await store.read()
    if(!owner||req.sessionId!==sessionId||req.projectId!==graph.id||graph.nodes[req.nodeId]?.type!==req.kind)throw new GenerationJournalBlocked("generation_owner_unavailable: 音频工程归属未确认")
    const journal=await loadGenerationJournal()
    await reconcileProductionOperations(journal,owner,graph,store,bridge)
    const auth=generationProjectAuthorization(owner,graph.id)
    return sharedJournalOperation(journal,owner,{identity:{project:graph.id,request_id:req.idemKey,session_id:sessionId,model:req.model,cost_coins:req.coins,input_signature:req.signature,graph_signature:req.signature,bridge_operation:req.idemKey,media_kind:req.kind,graph_scope:sharedGenerationScope(owner,`graph:${graph.id}`),...(graph.budget.capCoins!==null?{graph_cap:graph.budget.capCoins}:{})},payload:req.payload,lock:null,...(auth?.cap_coins!==undefined?{cap:auth.cap_coins}:{})})
  }
}

/** 生产组合根。模型不能提供owner/scope/模块路径，也不能通过project标签抹掉旧账。 */
export function productionJournalOperation(sessionId: string, store: ProjectStore) {
  return async (req: SubmitGenerationReq, payload: Record<string, unknown>, coins: number): Promise<SharedJournalOperation> => {
    const [{ stableGenerationOwnerScope }, { generationProjectAuthorization, generationReceipts }] = await Promise.all([import("../job-delivery.ts"), import("../job-store.ts")])
    const owner = await stableGenerationOwnerScope(sessionId)
    if (!owner) throw new GenerationJournalBlocked("project_budget_unavailable: 服务端可信归属暂不可读")
    const graph = await store.read()
    if (req.projectId !== graph.id || req.sessionId !== sessionId) throw new GenerationJournalBlocked("会话/工程归属不符；未提交")
    const explicit = req.prepared?.identity.project
    if (explicit !== undefined && (typeof explicit !== "string" || !explicit.trim() || explicit.length > 200)) throw new GenerationJournalBlocked("invalid_project: 项目标签必须是1..200字")
    const project = req.prepared ? typeof explicit === "string" ? explicit : undefined : graph.id
    const journal = await loadGenerationJournal()
    const {createExecBridgeClient}=await import("./exec-bridge-client.ts")
    await reconcileProductionOperations(journal,owner,graph,store,createExecBridgeClient())
    const auth = project ? generationProjectAuthorization(owner, project) : undefined
    const requestedCap = req.prepared?.identity.project_budget_coins
    if (requestedCap !== undefined && (typeof requestedCap !== "number" || !Number.isFinite(requestedCap) || requestedCap < 0)) throw new GenerationJournalBlocked("invalid_project_budget")
    const caps = [auth?.cap_coins, requestedCap].filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c >= 0)
    const workflow = payload.workflow as { metadata?: Record<string, unknown> } | undefined
    const meta = workflow?.metadata ?? {}
    // 工作代/席位消息不是生成输入，不让恢复同一订单因run_id改变而变成新订单。
    const canonical = { ...payload, workflow: { metadata: Object.fromEntries(["frame", "reference_version", "style_version", "style_lock"].filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]])) } }
    return sharedJournalOperation(journal, owner, {
      identity: { request_id: String(req.prepared?.identity.request_id ?? meta.request_id), session_id: sessionId, project, model: String(payload.model), cost_coins: coins,
        input_signature: String(req.prepared?.identity.input_signature ?? req.signature), graph_signature: req.signature,
        graph_scope: sharedGenerationScope(owner, `graph:${graph.id}`), ...(graph.budget.capCoins !== null ? { graph_cap: graph.budget.capCoins } : {}),
        ...(req.prepared?.identity.reference_version ? { reference_version: String(req.prepared.identity.reference_version) } : {}),
        ...(req.prepared?.identity.style_version ? { style_version: String(req.prepared.identity.style_version) } : {}),
        budget_version: auth ? String(auth.version) : "no_extra_cap", budget_source: auth ? auth.source : "no_extra_cap" },
      payload: canonical, lock: req.prepared?.lock ?? null, ...(caps.length ? { cap: Math.min(...caps) } : {}),
    })
  }
}
