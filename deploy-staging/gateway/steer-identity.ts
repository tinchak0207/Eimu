// steer-identity.ts —— REQ-D2b（steer 持久命令身份＋uncertain 態＋tombstone）的純核心。
//
// 為什麼單獨一個檔（與 steer-core.ts 同因）：本檔是「steer 身份與生命週期狀態機」的
// 唯一語義權威，必須能在 node --test / tsx 下直跑——網關的 persistence.ts 一 import
// 就載 bun:sqlite，tsx 載不動。本檔只 import node:crypto（無網關依賴、無 I/O）。
//
// ── 要解的病害（waoowaoo ARL-02 同構）──
// 「模型收到兩次，而產品 View 只顯示一次」：前端重試／斷線重發／網關重啟後，同一條
// 指引可以被投遞兩次。F-D2 的記憶體去重（pendingSteers，上限 3）在重啟後即失，TTL
// 只是把「排隊中」誠實收口，防不住重複投遞。因此：
//   1. **投遞之前**先落地命令身份（steer_id + 凍結 payload_hash + turn/session 標識）；
//   2. 投遞後未獲確認（或進程中斷於投遞與確認之間）＝ uncertain，**永不自動重發**；
//   3. 終態記 tombstone，**不隨 clear/重啟刪除**，同 id 重放一律拒絕（可辨識錯誤碼）。
//
// ── 與 TTL 的語義分工（不懂這條就會寫出雙頭馬車）──
//   * TTL（steer-core.STEER_QUEUE_TTL_MS）：**UI 兜底**。它管的是「徽章不能永停排隊中」，
//     在網關活著時把逾時條目落 failed，在前端把收不到終態的條目自行收口。它是**時間**上的
//     誠實，不知道同一條指引有沒有被送第二次。
//   * 身份 / tombstone（本檔）：**防重複投遞的正解**。它管的是「同一個 steer_id 一輩子
//     只能被投遞一次」，跨重啟有效，與時間無關。
//   兩者並存、互不取代：TTL 給使用者看得懂的時間語義，身份層給系統不可繞過的冪等保證。
//
// ── 狀態機（7 個持久態，其中 6 個會上屏）──
//   queued ──dispatch──▶ dispatched ──confirm──▶ applied（隊列腿，下一回合生效）
//      │                     │                 └▶ injected（question 斷點腿，本回合內生效）
//      │                     ├──reject/fail──▶ failed
//      │                     └──restart 未確認──▶ uncertain
//      └──user stop / 入隊被拒──▶ aborted / failed
//   dispatched 是**內部在途態**（不上屏：UI 此刻仍是「排隊中」，因為還沒被確認）；
//   其餘五個終態（applied/injected/failed/uncertain/aborted）凍結，不可再被任何幀改寫。
//   uncertain 特別要緊：它不是「失敗」，是「不知道」——遲到的 applied 幀不得把它改寫成
//   已生效（那正是「模型收到兩次而 View 顯示一次」的鏡像假話）。

import { createHash } from "node:crypto"

// ─────────────────────────── 狀態值域與流轉表

/** 持久態值域（`dispatched` 只活在網關內部，不上屏）。 */
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

/** 終態（凍結）：到了這裡不再接受任何流轉——包含 uncertain 不得被遲到幀改寫。 */
export const STEER_TERMINAL_STATES = ["applied", "injected", "failed", "uncertain", "aborted"] as const
export type SteerTerminalState = (typeof STEER_TERMINAL_STATES)[number]

/**
 * 合法流轉表（唯一權威）。終態 → 終態一律非法（F-D2 的終態凍結契約在持久層的等價物）。
 * dispatched → uncertain 是重啟恢復的專用邊（見 recoverSteerSession）。
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
 * 持久態 → 上屏狀態。dispatched 刻意映回 queued：投遞已發出但**尚未確認**，此時對使用者
 * 說「已生效」是假話、「未生效」也是假話，唯一誠實的說法是「還在排隊」；確認到達才翻
 * applied/injected，確認不到（重啟）才翻 uncertain。
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

// ─────────────────────────── payload 凍結

export interface SteerPayloadInput {
  steerId: string
  sessionId: string
  /** 上游會話標識（opencode session id）：身份不止於本站 session。 */
  opencodeSessionId?: string
  /** 關聯回合（turnGen）：同一 session 的哪一輪。 */
  turnGen?: number
  /** 已歸一化的指引正文（steer-core.normalizeSteerText 的產物）。 */
  content: string
}

/**
 * 凍結用的正則形態：鍵序固定、只含身分相關欄位，**不含時間**——時間進哈希會讓同一條
 * 指令在重試時算出不同 hash（重放識別失效）。呼叫端必須先歸一化正文。
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

/** payload hash（sha256 hex）：投遞前凍結，重放時逐字比對——同 id 不同內容＝拒絕。 */
export function freezeSteerPayload(input: SteerPayloadInput): FrozenSteerPayload {
  const canonical = canonicalSteerPayload(input)
  return { canonical, payloadHash: createHash("sha256").update(canonical, "utf8").digest("hex") }
}

// ─────────────────────────── 命令記錄（持久層的 row 形狀）

export interface SteerCommand {
  steerId: string
  sessionId: string
  /** 擁有者 key（與 sessions.owner_key 同源），重啟後可歸屬到人。 */
  ownerKey: string
  /** 同文去重時第二個 id（別名）：別名的重放同樣必須被拒（tombstone 覆蓋全 id）。 */
  aliasIds: string[]
  payloadHash: string
  /** 凍結的 canonical payload（稽核／重放比對用，原文不外洩給第三方）。 */
  payload: string
  state: SteerCommandState
  /** 命令建立時刻（投遞前）。 */
  at: number
  /** 投遞發出時刻（≠ 確認時刻）。 */
  dispatchedAt?: number
  /** 終態落地時刻。 */
  settledAt?: number
  /** 終態原因（queue_expired / delivery_failed / restart_unconfirmed …）。 */
  reason?: string
}

/** 持久層縫（依賴反轉）：生產＝persistence.ts 的 SQLite 實作，測試＝同一介面的替身。 */
export interface SteerLedgerStore {
  read(steerId: string): SteerCommand | null
  readBySession(sessionId: string): SteerCommand[]
  write(command: SteerCommand): void
}

// ─────────────────────────── 受理判定（重放拒絕）

/** 可辨識的拒絕碼（前端據此區分「改走正常送出」與「拒絕重複投遞」）。 */
export type SteerRejectCode =
  | "steer_replay_settled"
  | "steer_replay_in_flight"
  | "steer_payload_mismatch"
  /** 既有記錄屬於別的 session＝id 被盜用／碰撞，同樣不得靜默接受。 */
  | "steer_id_conflict"

export type SteerBeginOutcome =
  | { kind: "accepted"; command: SteerCommand; created: boolean }
  | { kind: "rejected"; code: SteerRejectCode; httpStatus: number; command: SteerCommand }

/**
 * 受理判定（純函數，I/O 由 createSteerLedger 做）。四種拒絕，全部**可辨識**、絕不靜默接受：
 *   * 同 id 屬別 session → `steer_id_conflict`（HTTP 409）：身份被盜用／碰撞。
 *   * 既有記錄已終態＝tombstone 命中 → `steer_replay_settled`（HTTP 409）：
 *     這條指引已經有結論了，重放只能造出第二次投遞。**終態判定排在 payload 比對之前**——
 *     已經結案的東西不會再被投遞，此刻再比 payload 只會把「已有結論」誤報成
 *     「內容不同」（實錘：重啟後 turnGen 由 DB 恢復為 0，同一條指引的正常重放會被
 *     誤判成 payload_mismatch；語義上也不該如此——沒人會被投遞，談不上改寫）。
 *   * 既有記錄仍在途（queued/dispatched）且 payload 不同 → `steer_payload_mismatch`（HTTP 409）：
 *     同一個身份帶著不同內容＝有人在改寫一條**還會被投遞**的指令，必須擋。
 *   * 既有記錄仍在途且 payload 相同 → `steer_replay_in_flight`（HTTP 409）：
 *     它還活著，重放就是「pending 自動重發」——正是要禁止的事。
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

/** 重放拒絕的上屏狀態：既有記錄當前的上屏狀態（誠實回報它現在到底怎樣了）。 */
export function steerReplayWireStatus(command: SteerCommand): ReturnType<typeof steerWireStatus> {
  return steerWireStatus(command.state)
}

// ─────────────────────────── ledger（身份層唯一入口）

export type SteerSettleOutcome =
  | { kind: "settled"; command: SteerCommand }
  | { kind: "refused"; reason: "unknown" | "terminal" | "illegal_transition"; command: SteerCommand }

export interface SteerLedger {
  /** 投遞前的身份落地（**冪等**）：同 id 重放走 planSteerBegin 拒絕，不覆寫既有記錄。 */
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
  /** queued → dispatched（投遞已發出、尚未確認）。 */
  markDispatched(steerId: string, now: number): SteerSettleOutcome
  /** 終態落地（applied/injected/failed/uncertain/aborted）：終態凍結，二次呼叫 refused。 */
  settle(steerId: string, state: SteerTerminalState, now: number, reason?: string): SteerSettleOutcome
  /** 記別名 id（同文去重命中的第二個 id）：別名重放同樣被 tombstone 覆蓋。 */
  addAlias(steerId: string, aliasId: string): void
  get(steerId: string): SteerCommand | null
  listBySession(sessionId: string): SteerCommand[]
  /**
   * 重啟恢復：把該 session 所有未終結的命令落 uncertain（**永不自動重發**），
   * 回傳被翻轉的命令（呼叫端負責上報誠實狀態）。
   *   已 dispatched（投遞後未確認）→ reason "restart_unconfirmed"
   *   仍 queued（進程中斷於投遞前）→ reason "restart_never_dispatched"
   * 兩者都是 uncertain：網關不知道上游到底收沒收到，說 failed 也是假話。
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
        // 型別上已排除，執行期防呆：非終態不得經 settle 落地（在途態只走 markDispatched）。
        const cur = store.read(steerId) ?? missing(steerId)
        return { kind: "refused", reason: "illegal_transition", command: cur }
      }
      return transition(store, steerId, state, now, reason)
    },

    addAlias(steerId, aliasId) {
      const cur = store.read(steerId)
      if (!cur || !aliasId || aliasId === steerId) return
      if (cur.aliasIds.includes(aliasId)) return
      // 終態也要記：別名徽章可能晚到，重放仍必須被 tombstone 擋住。
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
 * 流轉的唯一落地點：合法邊 → 寫回並回 settled；終態再改 → refused（凍結）；
 * 未知 id → refused（不憑空造記錄）。
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
  // 同態重入＝冪等成功（不寫盤）：注入腿落回排隊腿時會再標一次 dispatched（該條已被
  // 標記過），此處不得當成非法流轉而錯誤上報。
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
