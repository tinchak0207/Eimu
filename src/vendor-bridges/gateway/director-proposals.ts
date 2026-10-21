import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nanoid } from "nanoid"
import type { DirectorCameraMove, DirectorPlan } from "../../lib/director-engine/types"
import { fallbackPlans } from "../../lib/director-engine/planning-core"
import { planDuration } from "../../lib/director-engine/playback"
import { PROPOSAL_TTL_MS } from "./director-types"
import { DirectorNotFoundError, DirectorValidationError } from "./director-types"
import { assertSessionId, clone, loadCurrent, sessionDir, withSessionLock } from "./director-store"
import { makeDefaultPlan, parseShotCountFromInstruction, resizePlanShotCount, str } from "./director-ops"
import { applyDirectorOps } from "./director-state"
import type { ApplyDirectorOpsResult } from "./director-state"

// ── proposals 暂存（kunpeng directorTools.ts L26/812-815 同款：Map + 30 分 TTL） ──
//
// 2026-09-04 持久化（复测实锤病灶：agent-gateway 重启清零内存 Map → 用户手里提案卡全部过期，
// R3 部署窗口恰逢提案在途，apply 必 EXPIRED）：内存 Map 保留为热路径，新增落盘
// `<sid>/proposals.json`（与 current.json/versions/log.jsonl 同目录同 fs 范式）：
// - create：生成后在既有 withSessionLock(sid) 内合并写盘；写盘失败降级纯内存 + console.error，不阻塞提案。
// - apply：内存 miss → 惰性按 sid 读盘（进程启动无全量预载）；TTL 仍按 createdAt 校验，过期即删盘上条目。
// - 死锁纪律：proposals.json 的所有变更（create 合并写、apply 消费删、过期删）都收敛在
//   withSessionLock(sid) 域内串行；apply 的删盘发生在 applyDirectorOps（自持锁）返回之后，
//   两段锁顺序不嵌套。纯读（loadCurrent/读 proposals.json）不取锁。

const pendingProposals = new Map<string, { plans: DirectorPlan[]; createdAt: number }>()

function pruneProposals(): void {
  for (const [id, proposal] of pendingProposals) {
    if (Date.now() - proposal.createdAt > PROPOSAL_TTL_MS) pendingProposals.delete(id)
  }
}

function proposalsPath(sid: string): string {
  return path.join(sessionDir(sid), "proposals.json")
}

type StoredProposal = { plans: DirectorPlan[]; createdAt: number }

/** 盘上条目防呆：结构异常（非物件 plans / createdAt 非数）视同损坏 */
function isUsableProposal(p: unknown): p is StoredProposal {
  const c = p as StoredProposal | null
  return !!c && typeof c === "object" && typeof c.createdAt === "number" && Array.isArray(c.plans) && c.plans.length > 0
}

/** 读盘上 proposals；任何异常（缺档/损坏）收敛为空表——内存路径必须不被辅助持久化拖死 */
async function readProposalsFile(sid: string): Promise<Record<string, StoredProposal>> {
  try {
    const parsed = JSON.parse(await readFile(proposalsPath(sid), "utf-8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map = parsed as Record<string, StoredProposal>
      for (const [pid, p] of Object.entries(map)) if (!isUsableProposal(p)) delete map[pid]
      return map
    }
    return {}
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      console.error(`[director] proposals.json 不可读（sid=${sid}），按空处理:`, e)
    }
    return {}
  }
}

/** 合并新提案进盘上档案并清掉过期条目；调用方必须已持有 withSessionLock(sid)。 */
async function mergeProposalsOntoDisk(sid: string, entries: Array<{ id: string; proposal: StoredProposal }>): Promise<void> {
  const stored = await readProposalsFile(sid)
  const now = Date.now()
  for (const [pid, p] of Object.entries(stored)) {
    if (now - p.createdAt > PROPOSAL_TTL_MS) delete stored[pid]
  }
  for (const { id, proposal } of entries) stored[id] = proposal
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(proposalsPath(sid), JSON.stringify(stored), "utf-8")
}

/** 删盘上单条（不存在则 no-op，不无故建档）；调用方必须已持有 withSessionLock(sid)。 */
async function dropProposalFromDisk(sid: string, id: string): Promise<void> {
  const stored = await readProposalsFile(sid)
  if (!(id in stored)) return
  delete stored[id]
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(proposalsPath(sid), JSON.stringify(stored), "utf-8")
}

/** applyDirectorOps 之外调用的删盘包装：自取会话锁 + 失败仅记日志（不反噬已成功的 apply）。 */
async function dropProposalWithLock(sid: string, id: string): Promise<void> {
  try {
    await withSessionLock(sid, () => dropProposalFromDisk(sid, id))
  } catch (e) {
    console.error(`[director] proposal 盘上删除失败（sid=${sid}, id=${id}）:`, e)
  }
}

/** 测试钩子：模拟 gateway 重启（仅清内存 Map，盘上保留），验证 apply 走盘载入路径。 */
export function __clearPendingProposalsForTest(): void {
  pendingProposals.clear()
}
/** spec §3 POST /proposals 出参（每案带 requires_user_confirmation: true） */
export interface DirectorProposalSummary {
  proposal_id: string
  requires_user_confirmation: true
  name: string
  summary: string
  duration_sec: number
  shots: Array<{ name: string; duration_sec: number; camera_move: DirectorCameraMove; actions: number }>
}

/**
 * spec §3 POST /proposals：planning-core 轮子（fallbackPlans 内部含 inferPromptActionsByShot
 * + ensurePlanActions + buildPlans 链，见片1 白名单④）对 instruction 生成 2-3 案；
 * 暂存 30 分 TTL。无已初始化工程 → DirectorNotInitializedError（守卫同 requireDirector）。
 */
export async function createDirectorProposals(
  sid: string,
  instruction: string,
  /** R3-④：可选目标镜头数（1-12）；未传时从 instruction 解析「N 个镜头/N 镜」 */
  shotCount?: number,
): Promise<{ ok: true; proposal_ids: string[]; plans: DirectorProposalSummary[] }> {
  assertSessionId(sid)
  const trimmed = str(instruction, "instruction")
  // R3-④：显式 shot_count 优先并严格校验；未传走正则解析；都无 → null 维持模板默认
  let targetCount: number | null = null
  if (shotCount !== undefined && shotCount !== null) {
    if (!Number.isInteger(shotCount) || shotCount < 1 || shotCount > 12) {
      throw new DirectorValidationError("shot_count 必须是 1-12 的整数")
    }
    targetCount = shotCount
  } else {
    targetCount = parseShotCountFromInstruction(trimmed)
  }
  return withSessionLock(sid, async () => {
    let doc = await loadCurrent(sid)
    if (!doc || doc.plans.length === 0) {
      // 空工程：用默认方案当 base 生成候选（wheel open() 播种语义）；apply_proposal 的
      // replacePlans 是 seedable op，确认后会真正落盘。已有 elements/origin 时保留。
      const elements = doc?.elements ?? []
      const aspect = doc?.aspect ?? "16:9"
      doc = {
        session_id: sid,
        revision: doc?.revision ?? 0,
        version: 2,
        elements,
        groups: doc?.groups ?? [],
        plans: [makeDefaultPlan(elements, aspect, "稳定叙事")],
        activePlanId: null,
        activeShotId: null,
        aspect,
        origin: doc?.origin ?? { kind: "free", title: "" },
        exports: doc?.exports ?? [],
        currentTimeSec: 0,
        playing: false,
        undoStack: doc?.undoStack ?? [],
        redoStack: doc?.redoStack ?? [],
        updated_at: new Date(0).toISOString(),
      }
    }
    const base = doc.plans.find((p) => p.id === doc.activePlanId) ?? doc.plans[0]
    // R3-④：生成链凑数——先按目标数预调 base（≤8：planning-core adaptBaseForMotion 硬上限 8，
    // 让运镜交替与动作推理按目标镜头数自然分布），生成后再兜底 resize
    // （覆盖 >8 循环、prompt「镜头N」节区数量与目标不一致、bare base 默认 4 镜等路径）。
    const genBase = targetCount ? resizePlanShotCount(clone(base), Math.min(targetCount, 8)) : base
    let plans = fallbackPlans(clone(genBase), clone(doc.elements), trimmed)
    if (targetCount) plans = plans.map((plan) => resizePlanShotCount(plan, targetCount))
    pruneProposals()
    const ids: string[] = []
    const summaries: DirectorProposalSummary[] = []
    const diskEntries: Array<{ id: string; proposal: StoredProposal }> = []
    for (const plan of plans.slice(0, 3)) {
      const id = `director-proposal-${nanoid(8)}`
      const proposal: StoredProposal = { plans: [plan], createdAt: Date.now() }
      pendingProposals.set(id, proposal)
      diskEntries.push({ id, proposal })
      ids.push(id)
      summaries.push({
        proposal_id: id,
        requires_user_confirmation: true,
        name: plan.name,
        summary: plan.summary,
        duration_sec: Math.round(planDuration(plan) * 1000) / 1000,
        shots: plan.shots.map((shot) => ({ name: shot.name, duration_sec: shot.durationSec, camera_move: shot.cameraMove, actions: shot.actions.length })),
      })
    }
    // 2026-09-04 持久化：本处已在 withSessionLock(sid) 内，直接合并写盘；失败降级纯内存（旧行为）不阻塞提案。
    try {
      await mergeProposalsOntoDisk(sid, diskEntries)
    } catch (e) {
      console.error(`[director] proposals 落盘失败（sid=${sid}，降级纯内存）:`, e)
    }
    return { ok: true, proposal_ids: ids, plans: summaries }
  })
}

/**
 * spec §3 POST /apply_proposal：无暂存记录 → DirectorNotFoundError（守卫照搬 kunpeng
 * applyProposalTool「候选方案不存在或已过期，请重新生成」）；成功 → replacePlans + emit。
 * 2026-09-04 持久化：内存 miss → 惰性读 `<sid>/proposals.json`（重启后仍可批准在途提案）；
 * 盘上条目同样按 createdAt 校 TTL，过期即删。成功后盘上残留一并清除（内存命中时也清，幂等 no-op）。
 */
export async function applyDirectorProposal(sid: string, proposalId: string): Promise<ApplyDirectorOpsResult> {
  assertSessionId(sid)
  const id = str(proposalId, "proposal_id")
  pruneProposals()
  let proposal = pendingProposals.get(id)
  if (!proposal) {
    const disk = (await readProposalsFile(sid))[id]
    if (disk) {
      if (Date.now() - disk.createdAt > PROPOSAL_TTL_MS) {
        await dropProposalWithLock(sid, id)
      } else {
        proposal = disk
      }
    }
  }
  if (!proposal) {
    // 2026-09-03 验尸修复 R3-③（提案过期禁止静默换案）：极限评测实锤（REPORT P1-4/摩擦点 2）——
    // 用户选定方案过期后，agent 重新 propose 直接 apply 新 id，用户批准被静默替换。
    // 错误文案显式封死该路径：过期必须重新出卡请示，不许生成新 proposal 后直接套用。
    throw new DirectorNotFoundError("候选方案不存在或已过期，请重新生成；必须重新向用户出提案卡并等待用户批准，禁止生成新 proposal 后直接 apply")
  }
  pendingProposals.delete(id)
  const result = await applyDirectorOps(sid, [{ op: "replacePlans", plans: proposal.plans }], `apply ${id}`)
  await dropProposalWithLock(sid, id)
  return result
}
