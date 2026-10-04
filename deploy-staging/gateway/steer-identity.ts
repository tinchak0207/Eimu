// steer-identity.ts —— REQ-D2b（steer 持久命令身份＋uncertain 态＋tombstone）的纯核心。
//
// 为什么单独一个档（与 steer-core.ts 同因）：本档是「steer 身份与生命周期状态机」的
// 唯一语义权威，必须能在 node --test / tsx 下直跑——网关的 persistence.ts 一 import
// 就载 bun:sqlite，tsx 载不动。本档只 import node:crypto（无网关依赖、无 I/O）。
//
// ── 要解的病害（waoowaoo ARL-02 同构）──
// 「模型收到两次，而产品 View 只显示一次」：前端重试／断线重发／网关重启后，同一条
// 指引可以被投递两次。F-D2 的记忆体去重（pendingSteers，上限 3）在重启后即失，TTL
// 只是把「排队中」诚实收口，防不住重复投递。因此：
//   1. **投递之前**先落地命令身份（steer_id + 冻结 payload_hash + turn/session 标识）；
//   2. 投递后未获确认（或进程中断于投递与确认之间）＝ uncertain，**永不自动重发**；
//   3. 终态记 tombstone，**不随 clear/重启删除**，同 id 重放一律拒绝（可辨识错误码）。
//
// ── 与 TTL 的语义分工（不懂这条就会写出双头马车）──
//   * TTL（steer-core.STEER_QUEUE_TTL_MS）：**UI 兜底**。它管的是「徽章不能永停排队中」，
//     在网关活著时把逾时条目落 failed，在前端把收不到终态的条目自行收口。它是**时间**上的
//     诚实，不知道同一条指引有没有被送第二次。
//   * 身份 / tombstone（本档）：**防重复投递的正解**。它管的是「同一个 steer_id 一辈子
//     只能被投递一次」，跨重启有效，与时间无关。
//   两者并存、互不取代：TTL 给使用者看得懂的时间语义，身份层给系统不可绕过的幂等保证。
//
// ── 状态机（7 个持久态，其中 6 个会上屏）──
//   queued ──dispatch──▶ dispatched ──confirm──▶ applied（队列腿，下一回合生效）
//      │                     │                 └▶ injected（question 断点腿，本回合内生效）
//      │                     ├──reject/fail──▶ failed
//      │                     └──restart 未确认──▶ uncertain
//      └──user stop / 入队被拒──▶ aborted / failed
//   dispatched 是**内部在途态**（不上屏：UI 此刻仍是「排队中」，因为还没被确认）；
//   其余五个终态（applied/injected/failed/uncertain/aborted）冻结，不可再被任何帧改写。
//   uncertain 特别要紧：它不是「失败」，是「不知道」——迟到的 applied 帧不得把它改写成
//   已生效（那正是「模型收到两次而 View 显示一次」的镜像假话）。

import { createHash } from "node:crypto"

// ─────────────────────────── 状态值域与流转表

/** 持久态值域（`dispatched` 只活在网关内部，不上屏）。 */
export const STEER_COMMAND_STATES = [
  "queued",
  "dispatched",
  "applied",
  "injected",
  "failed",
  "uncertain",
  "aborted",
] as const
export type SteerCommandState = (typeof STEER_COMMAND_STATES)[number]

/** 终态（冻结）：到了这里不再接受任何流转——包含 uncertain 不得被迟到帧改写。 */
export const STEER_TERMINAL_STATES = ["applied", "injected", "failed", "uncertain", "aborted"] as const
export type SteerTerminalState = (typeof STEER_TERMINAL_STATES)[number]

/**
 * 合法流转表（唯一权威）。终态 → 终态一律非法（F-D2 的终态冻结契约在持久层的等价物）。
 * dispatched → uncertain 是重启恢复的专用边（见 recoverSteerSession）。
 */
export const STEER_STATE_TRANSITIONS: Record<SteerCommandState, readonly SteerCommandState[]> = {
  queued: ["dispatched", "failed", "aborted", "uncertain"],
  dispatched: ["applied", "injected", "failed", "uncertain", "aborted"],
  applied: [],
  injected: [],
  failed: [],
  uncertain: [],
  aborted: [],
}

export function isSteerCommandState(v: unknown): v is SteerCommandState {
  return typeof v === "string" && (STEER_COMMAND_STATES as readonly string[]).includes(v)
}

export function isSteerTerminalState(v: unknown): v is SteerTerminalState {
  return typeof v === "string" && (STEER_TERMINAL_STATES as readonly string[]).includes(v)
}

export function isLegalSteerTransition(from: SteerCommandState, to: SteerCommandState): boolean {
  return (STEER_STATE_TRANSITIONS[from] as readonly string[]).includes(to)
}

/**
 * 持久态 → 上屏状态。dispatched 刻意映回 queued：投递已发出但**尚未确认**，此时对使用者
 * 说「已生效」是假话、「未生效」也是假话，唯一诚实的说法是「还在排队」；确认到达才翻
 * applied/injected，确认不到（重启）才翻 uncertain。
 */
export function steerWireStatus(state: SteerCommandState): "queued" | "applied" | "injected" | "failed" | "uncertain" | "aborted" {
  switch (state) {
    case "queued":
    case "dispatched":
      return "queued"
    case "applied":
      return "applied"
    case "injected":
      return "injected"
    case "failed":
      return "failed"
    case "uncertain":
      return "uncertain"
    case "aborted":
      return "aborted"
  }
}

// ─────────────────────────── payload 冻结

export interface SteerPayloadInput {
  steerId: string
  sessionId: string
  /** 上游会话标识（opencode session id）：身份不止于本站 session。 */
  opencodeSessionId?: string
  /** 关联回合（turnGen）：同一 session 的哪一轮。 */
  turnGen?: number
  /** 已归一化的指引正文（steer-core.normalizeSteerText 的产物）。 */
  content: string
}

/**
 * 冻结用的正则形态：键序固定、只含身分相关栏位，**不含时间**——时间进哈希会让同一条
 * 指令在重试时算出不同 hash（重放识别失效）。呼叫端必须先归一化正文。
 */
export function canonicalSteerPayload(input: SteerPayloadInput): string {
  return JSON.stringify({
    content: input.content,
    session_id: input.sessionId,
    opencode_session_id: input.opencodeSessionId ?? "",
    turn_gen: input.turnGen ?? 0,
  })
}

export interface FrozenSteerPayload {
  canonical: string
  payloadHash: string
}

/** payload hash（sha256 hex）：投递前冻结，重放时逐字比对——同 id 不同内容＝拒绝。 */
export function freezeSteerPayload(input: SteerPayloadInput): FrozenSteerPayload {
  const canonical = canonicalSteerPayload(input)
  return { canonical, payloadHash: createHash("sha256").update(canonical, "utf8").digest("hex") }
}

// ─────────────────────────── 命令记录（持久层的 row 形状）

export interface SteerCommand {
  steerId: string
  sessionId: string
  /** 拥有者 key（与 sessions.owner_key 同源），重启后可归属到人。 */
  ownerKey: string
  /** 同文去重时第二个 id（别名）：别名的重放同样必须被拒（tombstone 覆盖全 id）。 */
  aliasIds: string[]
  payloadHash: string
  /** 冻结的 canonical payload（稽核／重放比对用，原文不外泄给第三方）。 */
  payload: string
  state: SteerCommandState
  /** 命令建立时刻（投递前）。 */
  at: number
  /** 投递发出时刻（≠ 确认时刻）。 */
  dispatchedAt?: number
  /** 终态落地时刻。 */
  settledAt?: number
  /** 终态原因（queue_expired / delivery_failed / restart_unconfirmed …）。 */
  reason?: string
}

/** 持久层缝（依赖反转）：生产＝persistence.ts 的 SQLite 实作，测试＝同一介面的替身。 */
export interface SteerLedgerStore {
  read(steerId: string): SteerCommand | null
  readBySession(sessionId: string): SteerCommand[]
  write(command: SteerCommand): void
}

// ─────────────────────────── 受理判定（重放拒绝）

/** 可辨识的拒绝码（前端据此区分「改走正常送出」与「拒绝重复投递」）。 */
export type SteerRejectCode =
  | "steer_replay_settled"
  | "steer_replay_in_flight"
  | "steer_payload_mismatch"
  /** 既有记录属于别的 session＝id 被盗用／碰撞，同样不得静默接受。 */
  | "steer_id_conflict"

export type SteerBeginOutcome =
  | { kind: "accepted"; command: SteerCommand; created: boolean }
  | { kind: "rejected"; code: SteerRejectCode; httpStatus: number; command: SteerCommand }

/**
 * 受理判定（纯函数，I/O 由 createSteerLedger 做）。四种拒绝，全部**可辨识**、绝不静默接受：
 *   * 同 id 属别 session → `steer_id_conflict`（HTTP 409）：身份被盗用／碰撞。
 *   * 既有记录已终态＝tombstone 命中 → `steer_replay_settled`（HTTP 409）：
 *     这条指引已经有结论了，重放只能造出第二次投递。**终态判定排在 payload 比对之前**——
 *     已经结案的东西不会再被投递，此刻再比 payload 只会把「已有结论」误报成
 *     「内容不同」（实锤：重启后 turnGen 由 DB 恢复为 0，同一条指引的正常重放会被
 *     误判成 payload_mismatch；语义上也不该如此——没人会被投递，谈不上改写）。
 *   * 既有记录仍在途（queued/dispatched）且 payload 不同 → `steer_payload_mismatch`（HTTP 409）：
 *     同一个身份带著不同内容＝有人在改写一条**还会被投递**的指令，必须挡。
 *   * 既有记录仍在途且 payload 相同 → `steer_replay_in_flight`（HTTP 409）：
 *     它还活著，重放就是「pending 自动重发」——正是要禁止的事。
 */
export function planSteerBegin(
  existing: SteerCommand | null,
  incoming: { steerId: string; sessionId: string; payloadHash: string },
): SteerBeginOutcome | null {
  if (!existing) return null
  if (existing.sessionId !== incoming.sessionId) {
    return { kind: "rejected", code: "steer_id_conflict", httpStatus: 409, command: existing }
  }
  if (isSteerTerminalState(existing.state)) {
    return { kind: "rejected", code: "steer_replay_settled", httpStatus: 409, command: existing }
  }
  if (existing.payloadHash !== incoming.payloadHash) {
    return { kind: "rejected", code: "steer_payload_mismatch", httpStatus: 409, command: existing }
  }
  return { kind: "rejected", code: "steer_replay_in_flight", httpStatus: 409, command: existing }
}

/** 重放拒绝的上屏状态：既有记录当前的上屏状态（诚实回报它现在到底怎样了）。 */
export function steerReplayWireStatus(command: SteerCommand): ReturnType<typeof steerWireStatus> {
  return steerWireStatus(command.state)
}

// ─────────────────────────── ledger（身份层唯一入口）

export type SteerSettleOutcome =
  | { kind: "settled"; command: SteerCommand }
  | { kind: "refused"; reason: "unknown" | "terminal" | "illegal_transition"; command: SteerCommand }

export interface SteerLedger {
  /** 投递前的身份落地（**幂等**）：同 id 重放走 planSteerBegin 拒绝，不覆写既有记录。 */
  begin(input: {
    steerId: string
    sessionId: string
    ownerKey: string
    content: string
    opencodeSessionId?: string
    turnGen?: number
    now: number
    aliases?: string[]
  }): SteerBeginOutcome
  /** queued → dispatched（投递已发出、尚未确认）。 */
  markDispatched(steerId: string, now: number): SteerSettleOutcome
  /** 终态落地（applied/injected/failed/uncertain/aborted）：终态冻结，二次呼叫 refused。 */
  settle(steerId: string, state: SteerTerminalState, now: number, reason?: string): SteerSettleOutcome
  /** 记别名 id（同文去重命中的第二个 id）：别名重放同样被 tombstone 覆盖。 */
  addAlias(steerId: string, aliasId: string): void
  get(steerId: string): SteerCommand | null
  listBySession(sessionId: string): SteerCommand[]
  /**
   * 重启恢复：把该 session 所有未终结的命令落 uncertain（**永不自动重发**），
   * 回传被翻转的命令（呼叫端负责上报诚实状态）。
   *   已 dispatched（投递后未确认）→ reason "restart_unconfirmed"
   *   仍 queued（进程中断于投递前）→ reason "restart_never_dispatched"
   * 两者都是 uncertain：网关不知道上游到底收没收到，说 failed 也是假话。
   */
  recoverSession(sessionId: string, now: number): SteerCommand[]
}

export function createSteerLedger(store: SteerLedgerStore): SteerLedger {
  const ledger: SteerLedger = {
    begin(input) {
      const frozen = freezeSteerPayload({
        steerId: input.steerId,
        sessionId: input.sessionId,
        ...(input.opencodeSessionId !== undefined ? { opencodeSessionId: input.opencodeSessionId } : {}),
        ...(input.turnGen !== undefined ? { turnGen: input.turnGen } : {}),
        content: input.content,
      })
      const existing = store.read(input.steerId)
      const replay = planSteerBegin(existing, {
        steerId: input.steerId,
        sessionId: input.sessionId,
        payloadHash: frozen.payloadHash,
      })
      if (replay) return replay
      const command: SteerCommand = {
        steerId: input.steerId,
        sessionId: input.sessionId,
        ownerKey: input.ownerKey,
        aliasIds: [...(input.aliases ?? [])],
        payloadHash: frozen.payloadHash,
        payload: frozen.canonical,
        state: "queued",
        at: input.now,
      }
      store.write(command)
      return { kind: "accepted", command, created: true }
    },

    markDispatched(steerId, now) {
      return transition(store, steerId, "dispatched", now)
    },

    settle(steerId, state, now, reason) {
      if (!isSteerTerminalState(state)) {
        // 型别上已排除，执行期防呆：非终态不得经 settle 落地（在途态只走 markDispatched）。
        const cur = store.read(steerId) ?? missing(steerId)
        return { kind: "refused", reason: "illegal_transition", command: cur }
      }
      return transition(store, steerId, state, now, reason)
    },

    addAlias(steerId, aliasId) {
      const cur = store.read(steerId)
      if (!cur || !aliasId || aliasId === steerId) return
      if (cur.aliasIds.includes(aliasId)) return
      // 终态也要记：别名徽章可能晚到，重放仍必须被 tombstone 挡住。
      store.write({ ...cur, aliasIds: [...cur.aliasIds, aliasId] })
    },

    get: (steerId) => store.read(steerId),

    listBySession: (sessionId) => store.readBySession(sessionId),

    recoverSession(sessionId, now) {
      const flipped: SteerCommand[] = []
      for (const cmd of store.readBySession(sessionId)) {
        if (isSteerTerminalState(cmd.state)) continue
        const reason = cmd.state === "dispatched" ? "restart_unconfirmed" : "restart_never_dispatched"
        const next: SteerCommand = { ...cmd, state: "uncertain", settledAt: now, reason }
        store.write(next)
        flipped.push(next)
      }
      return flipped
    },
  }
  return ledger
}

function missing(steerId: string): SteerCommand {
  return { steerId, sessionId: "", ownerKey: "", aliasIds: [], payloadHash: "", payload: "", state: "queued", at: 0 }
}

/**
 * 流转的唯一落地点：合法边 → 写回并回 settled；终态再改 → refused（冻结）；
 * 未知 id → refused（不凭空造记录）。
 */
function transition(
  store: SteerLedgerStore,
  steerId: string,
  to: SteerCommandState,
  now: number,
  reason?: string,
): SteerSettleOutcome {
  const cur = store.read(steerId)
  if (!cur) return { kind: "refused", reason: "unknown", command: missing(steerId) }
  if (isSteerTerminalState(cur.state)) return { kind: "refused", reason: "terminal", command: cur }
  // 同态重入＝幂等成功（不写盘）：注入腿落回排队腿时会再标一次 dispatched（该条已被
  // 标记过），此处不得当成非法流转而错误上报。
  if (cur.state === to) return { kind: "settled", command: cur }
  if (!isLegalSteerTransition(cur.state, to)) return { kind: "refused", reason: "illegal_transition", command: cur }
  const next: SteerCommand = {
    ...cur,
    state: to,
    ...(to === "dispatched" ? { dispatchedAt: now } : {}),
    ...(isSteerTerminalState(to) ? { settledAt: now } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
  store.write(next)
  return { kind: "settled", command: next }
}
