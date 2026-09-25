// steer-core.ts —— steer（回合中引導）隊列代數的純核心。
//
// 為什麼要單獨一個零 import 的檔：本檔是 REQ-D2 的唯一語義權威（入隊順序／
// 去重／上限／停止優先／批次文本組裝），必須能在 node --test 下直跑——網關其他
// 模組（sessions-core → persistence）import 期就會載入 bun:sqlite，tsx 環境載不動。
//
// 語義契約（與 PRD REQ-D2 對齊）：
//   1. steer = 回合執行中追加的指引，在**當前回合內**生效；不終止當前回合。
//   2. 停止永遠優先於 steer：**用戶**中止回合 → 隊列全數丟棄（不是投遞）。
//      內部斷路器（空轉止損）中止≠用戶停止：它只是換一種方式續跑同一輪，
//      用戶的指引不因此失效 → 隊列保留，等下一次收尾照常投遞（見 abortIsUserStop）。
//   3. 物理上拿不到回合中注入管道時（無 question 斷點）→ 誠實排隊，下一回合生效，
//      UI 必須看得到「排隊中／已生效」的狀態差，不得假裝已生效。
//   4. 同一回合可連發，順序保留（FIFO）；上限與去重策略在此定義。
//   5. 每條排隊 steer 帶 deadline：投遞端與前端共用同一個 TTL（STEER_QUEUE_TTL_MS）。
//      逾時＝不投遞、落 failed 終態——網關重啟後 pendingSteers 是 volatile 的，
//      前端不能永遠掛著「排隊中」（見 steer-gw.ts flushPendingSteers 註釋）。

/** 同一回合內可掛在隊列裡的 steer 條數上限（超限誠實拒絕，不靜默丟）。 */
export const STEER_MAX_QUEUE = 3;

/** 單條 steer 的長度上限（字元）。回合中引導是「追加一句話」，不是第二篇需求書。 */
export const STEER_MAX_CHARS = 2000;

/**
 * 一條排隊 steer 的存活上限（epoch ms，30 分鐘）。超過這個時間還沒被投遞＝這條指引
 * 已經不可能在「同一輪工作的語境」裡生效，誠實落 failed 而不是永遠排隊中。
 * 前端鏡像常數 AGENT_STEER_QUEUE_TTL_MS（src/lib/agent-chat-types.ts）必須逐字等值。
 *
 * ── 與命令身份（REQ-D2b / steer-identity.ts）的語義分工，勿混用 ──
 *   * TTL＝**UI 兜底**：讓「排隊中」徽章有時間上的收口（網關活著時落 queue_expired、
 *     前端收不到終態時自行翻 failed）。它不知道同一條指引有沒有被送過第二次。
 *   * 身份/tombstone＝**防重複投遞的正解**：同一 steer_id 一輩子只能投遞一次，跨重啟
 *     有效、與時間無關（見 steer-identity.STEER_TERMINAL_STATES 的終態凍結）。
 *   兩者並存、互不取代：TTL 回答「還要等多久」，身份層回答「這條是不是已經送過了」。
 */
export const STEER_QUEUE_TTL_MS = 30 * 60 * 1000;

/**
 * 回合為什麼被中止（D2-1b 修復：停止優先只認用戶停止）。
 * - user   用戶按了停止 → 待投 steer 全數作廢（停止優先，PRD 硬要求）
 * - system 內部斷路器（空轉止損）自行中止並同輪重投 → 用戶沒有叫停，指引不得丟
 * 缺席（undefined）一律按 user 處置（保守：寧可多作廢，不可把指引投進用戶已叫停的輪）。
 */
export type TurnAbortSource = "user" | "system";

/** 停止優先的唯一判據：只有「用戶叫停」才丟隊列。 */
export function abortIsUserStop(turnAborted: boolean | undefined, source: TurnAbortSource | undefined): boolean {
  return turnAborted === true && source !== "system";
}

/**
 * 受理閘（D2-1a）：回合不在跑、或回合被**用戶**中止（abort→idle 窗口），一律不受理 steer。
 * abort 與 idle 幀之間那一小段窗口特別重要——此刻 pendingQuestions 可能還在，若放行就會
 * 把用戶的引導語當「答覆」POST 進一個已經中止的回合，並回 applied_in_turn:true（假話）。
 * 這兩種情形誠實回 409，讓前端走正常送出。
 *
 * D-6（2026-09-23）修掉的假話：中止閘原本只看 turnAborted，**不分來源**。而內部空轉斷路器
 * （triggerIdleStepBreaker）中止時同樣設 turnAborted=true——它只是換一種方式續跑同一輪
 * （語義裁定見 abortIsUserStop），排隊中的指引是被刻意保留的。於是那一小段窗口裡對用戶回的
 * 卻是「本轮已中止，引导不会再生效」，訊息是假的；前端又據 409 落回普通送出（steer 模式下
 * 就是打斷本輪），正好違背用戶選的「不打断」語義。
 * 現在閘門直接複用停止優先的唯一判據 abortIsUserStop：**只有用戶停止才拒**，系統中止窗口
 * 照常受理並走誠實的排隊腿（注入腿另按同一個判據擋，見 steer-gw 的 injectEligible）。
 * 判別欄用字串 kind（strict:false 下布林字面量不收窄，見 SteerEnqueueOutcome 註釋）。
 */
export type SteerGate =
  | { kind: "accept" }
  | { kind: "reject"; reason: "no_active_turn" | "turn_aborted" };

export function gateSteerAcceptance(opts: {
  turnInFlight: boolean;
  turnAborted: boolean;
  /** 中止來源；缺席一律按 "user"（與 abortIsUserStop 同一個判據、同一個保守預設）。 */
  turnAbortSource?: TurnAbortSource;
}): SteerGate {
  if (!opts.turnInFlight) return { kind: "reject", reason: "no_active_turn" };
  if (abortIsUserStop(opts.turnAborted, opts.turnAbortSource)) return { kind: "reject", reason: "turn_aborted" };
  return { kind: "accept" };
}

/**
 * steer 的生命週期狀態（幀上報 + UI 徽章共用的唯一值域）：
 * - queued    已排隊，等本回合結束後投遞（誠實排隊形態）
 * - injected  已注入：當前回合卡在 question 斷點，這條以答覆語義回灌，本回合內生效
 * - applied   已生效：隊列在本回合收尾時投遞成功（下一回合生效）
 * - aborted   已作廢：用戶在同一時間按了停止——停止優先於 steer
 * - failed    未生效：投遞失敗（含未接線／超過 deadline 未投遞），誠實告知不假裝
 * - uncertain **未確認**（REQ-D2b，2026-09-23）：投遞已發出但沒等到確認（進程中斷於
 *             投遞與確認之間／重啟後恢復），**永不自動重發**。它不是 failed——「不知道」
 *             與「確知沒送到」是兩件事，混為一談就是把不確定說成事實。UI 顯示「未確認·未重送」。
 *
 * 值域權威仍在本檔：steer-identity.ts 的持久態（多一個內部態 dispatched）映射到這裡，
 * 前端 src/lib/agent-chat-types.ts 的 AGENT_STEER_STATUSES 逐字對齊（六個值）。
 */
export type SteerStatus = "queued" | "injected" | "applied" | "aborted" | "failed" | "uncertain";

/** 隊列裡的一條 steer。id 由前端生成（前端樂觀插入的徽章要能與幀對上號）。 */
export interface PendingSteer {
  id: string;
  /** 已歸一化的文本（normalizeSteerText 的產物，入隊後不再變）。 */
  text: string;
  /** 入隊時刻（epoch ms）。 */
  at: number;
  /** 投遞截止時刻（epoch ms = at + STEER_QUEUE_TTL_MS）。逾時不投遞，落 failed。 */
  deadline: number;
  /**
   * 別名 id：同一條指引被前端用不同 id 重複送達（同文去重命中）時，把第二個 id
   * 記在這裡——狀態幀要對兩個 id 都發，否則第二個徽章永遠收不到終態（假排隊中）。
   */
  aliases?: string[];
}

/** 一條 steer 要上報狀態的全部 id（本體 + 別名）。 */
export function steerFrameIds(steer: PendingSteer): string[] {
  return [steer.id, ...(steer.aliases ?? [])];
}

/** steer id 值域：與網關其他 id 同款的保守字符集，防注入/防日誌污染。 */
const STEER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSteerId(raw: unknown): raw is string {
  return typeof raw === "string" && STEER_ID_PATTERN.test(raw);
}

// D-7（2026-09-23）：這裡原本有 mintSteerId（「未帶／非法 id 就網關自鑄一個」）——已刪除。
// 自鑄＝給每個無 id 的請求一個**全新的**身份，於是「手動重送」永遠是第二條獨立命令，
// ARL-02 的不變量（同一條指引一生只投遞一次）只在客戶端穩定帶同一 id 時才碰巧成立。
// 身份必須來自客戶端：缺 id 一律 fail-closed 回可辨識錯誤（見 steer-gw 的受理端），
// 網關不再代替客戶端創造身份。我方前端總會帶 id（src/hooks/use-agent-chat.newSteerId），
// 故 fail-closed 對它零影響。

/**
 * 文本歸一化：去首尾空白 + 內部連續空白（含換行）折成單一空格。
 * 歸一化同時是去重鍵——同一句話打字時多按了幾個空白不該被當成第二條 steer。
 */
export function normalizeSteerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 入隊結果。判別欄用字串 kind 而不是布林 ok：gateway 的 tsconfig 是
 * strict:false（strictNullChecks 關閉），布林字面量會被放寬成 boolean，
 * 判別聯合在該設定下不會收窄（實測 TS2339）——字串判別欄才收得動。
 */
export type SteerEnqueueOutcome =
  | { kind: "accepted"; steer: PendingSteer; position: number; deduped: boolean }
  | { kind: "rejected"; reason: "empty" | "too_long" | "queue_full" };

/**
 * 入隊判定（純函數，不改 queue）：呼叫端拿 outcome.steer 自己 append。
 * 順序契約：position = 入隊後的 1-based 位置，先到先得（FIFO）。
 * 去重契約（兩道，缺一不可）：
 *   a. **同 id**（D2-4）：前端／中繼重放同一條 steer（重試、斷線重發）→ 命中既有條目，
 *      不新增第二顆、不改順序（同一個邏輯 steer 只佔一格）。
 *   b. 同文本：隊列裡已有同一句（歸一化後逐字相等）→ 回既有那條（deduped=true）。
 *      呼叫端要把本次的 id 記進 aliases（見 steerFrameIds），否則新徽章收不到終態。
 */
export function enqueueSteer(
  queue: readonly PendingSteer[],
  raw: unknown,
  opts: { now: number; id: string; ttlMs?: number },
): SteerEnqueueOutcome {
  const text = normalizeSteerText(raw);
  if (!text) return { kind: "rejected", reason: "empty" };
  if (text.length > STEER_MAX_CHARS) return { kind: "rejected", reason: "too_long" };
  // ① 同 id 去重（優先於文本）：重放同一條 steer 不得長出第二顆。
  const existingById = queue.findIndex((s) => s.id === opts.id || (s.aliases ?? []).includes(opts.id));
  if (existingById >= 0) {
    return { kind: "accepted", steer: queue[existingById], position: existingById + 1, deduped: true };
  }
  // ② 同文本去重。
  const existingAt = queue.findIndex((s) => s.text === text);
  if (existingAt >= 0) {
    return { kind: "accepted", steer: queue[existingAt], position: existingAt + 1, deduped: true };
  }
  if (queue.length >= STEER_MAX_QUEUE) return { kind: "rejected", reason: "queue_full" };
  const ttl = opts.ttlMs ?? STEER_QUEUE_TTL_MS;
  const steer: PendingSteer = { id: opts.id, text, at: opts.now, deadline: opts.now + ttl };
  return { kind: "accepted", steer, position: queue.length + 1, deduped: false };
}

/**
 * 隊列 → 下一回合的投遞文本。順序保留（FIFO 逐條列出）＋ 明確交代這些指引的來歷
 * （模型必須知道「這是上一輪執行期間用戶追加的，不是新任務」），否則它會重新開場。
 */
export function steerBatchText(queue: readonly PendingSteer[]): string {
  if (queue.length === 0) return "";
  const head =
    "【回合中追加指引】以下是你在上一轮执行期间用户追加的指引，按顺序执行；不要重新开场、不要重做已完成的步骤。";
  if (queue.length === 1) return `${head}\n${queue[0].text}`;
  const lines = queue.map((s, i) => `${i + 1}. ${s.text}`);
  return `${head}\n${lines.join("\n")}`;
}

export interface SteerFlushPlan {
  /** 要投遞的下一回合（FIFO 保序拼批）；null = 這一輪沒有要投的。 */
  batch: { text: string; ids: string[] } | null;
  /** 被丟棄的條目（停止優先／逾時）：只上報狀態，不投遞。
   *  aborted = 用戶叫停（停止優先）；expired = 過了 deadline（誠實落 failed）。 */
  dropped: Array<{ id: string; reason: "aborted" | "expired" }>;
}

/**
 * 回合收尾時對待投隊列的處置（純決策，實際 emit/投遞由 steer-gw 做）。
 * 停止優先的落點就在這裡：abortIsUserStop(...) === true ⇒ 全部丟棄，一條都不投。
 * 逾時（opts.now 有給才判）⇒ 該條不投遞，落 dropped reason "expired"。
 * opts.now 刻意是選填：不傳＝不判逾時（既有呼叫端行為逐位不變）。
 */
export function planSteerFlush(
  queue: readonly PendingSteer[],
  opts: { turnAborted: boolean; now?: number; ttlMs?: number },
): SteerFlushPlan {
  if (queue.length === 0) return { batch: null, dropped: [] };
  if (opts.turnAborted) {
    return { batch: null, dropped: queue.map((s) => ({ id: s.id, reason: "aborted" as const })) };
  }
  const now = opts.now;
  const expired: Array<{ id: string; reason: "expired" }> = [];
  const live: PendingSteer[] = [];
  for (const s of queue) {
    const deadline = s.deadline ?? s.at + (opts.ttlMs ?? STEER_QUEUE_TTL_MS);
    if (typeof now === "number" && now >= deadline) expired.push({ id: s.id, reason: "expired" });
    else live.push(s);
  }
  if (live.length === 0) return { batch: null, dropped: expired };
  return {
    batch: { text: steerBatchText(live), ids: live.map((s) => s.id) },
    dropped: expired,
  };
}
