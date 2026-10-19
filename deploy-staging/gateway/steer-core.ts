// steer-core.ts —— steer（回合中引导）队列代数的纯核心。
//
// 为什么要单独一个零 import 的档：本档是 REQ-D2 的唯一语义权威（入队顺序／
// 去重／上限／停止优先／批次文本组装），必须能在 node --test 下直跑——网关其他
// 模组（sessions-core → persistence）import 期就会载入 bun:sqlite，tsx 环境载不动。
//
// 语义契约（与 PRD REQ-D2 对齐）：
//   1. steer = 回合执行中追加的指引，在**当前回合内**生效；不终止当前回合。
//   2. 停止永远优先于 steer：**用户**中止回合 → 队列全数丢弃（不是投递）。
//      内部断路器（空转止损）中止≠用户停止：它只是换一种方式续跑同一轮，
//      用户的指引不因此失效 → 队列保留，等下一次收尾照常投递（见 abortIsUserStop）。
//   3. 物理上拿不到回合中注入管道时（无 question 断点）→ 诚实排队，下一回合生效，
//      UI 必须看得到「排队中／已生效」的状态差，不得假装已生效。
//   4. 同一回合可连发，顺序保留（FIFO）；上限与去重策略在此定义。
//   5. 每条排队 steer 带 deadline：投递端与前端共用同一个 TTL（STEER_QUEUE_TTL_MS）。
//      逾时＝不投递、落 failed 终态——网关重启后 pendingSteers 是 volatile 的，
//      前端不能永远挂著「排队中」（见 steer-gw.ts flushPendingSteers 注释）。

/** 同一回合内可挂在队列里的 steer 条数上限（超限诚实拒绝，不静默丢）。 */
export const STEER_MAX_QUEUE = 3;

/** 单条 steer 的长度上限（字元）。回合中引导是「追加一句话」，不是第二篇需求书。 */
export const STEER_MAX_CHARS = 2000;

/**
 * 一条排队 steer 的存活上限（epoch ms，30 分钟）。超过这个时间还没被投递＝这条指引
 * 已经不可能在「同一轮工作的语境」里生效，诚实落 failed 而不是永远排队中。
 * 前端镜像常数 AGENT_STEER_QUEUE_TTL_MS（src/lib/agent-chat-types.ts）必须逐字等值。
 *
 * ── 与命令身份（REQ-D2b / steer-identity.ts）的语义分工，勿混用 ──
 *   * TTL＝**UI 兜底**：让「排队中」徽章有时间上的收口（网关活著时落 queue_expired、
 *     前端收不到终态时自行翻 failed）。它不知道同一条指引有没有被送过第二次。
 *   * 身份/tombstone＝**防重复投递的正解**：同一 steer_id 一辈子只能投递一次，跨重启
 *     有效、与时间无关（见 steer-identity.STEER_TERMINAL_STATES 的终态冻结）。
 *   两者并存、互不取代：TTL 回答「还要等多久」，身份层回答「这条是不是已经送过了」。
 */
export const STEER_QUEUE_TTL_MS = 30 * 60 * 1000;

/**
 * 回合为什么被中止（D2-1b 修复：停止优先只认用户停止）。
 * - user   用户按了停止 → 待投 steer 全数作废（停止优先，PRD 硬要求）
 * - system 内部断路器（空转止损）自行中止并同轮重投 → 用户没有叫停，指引不得丢
 * 缺席（undefined）一律按 user 处置（保守：宁可多作废，不可把指引投进用户已叫停的轮）。
 */
export type TurnAbortSource = "user" | "system";

/** 停止优先的唯一判据：只有「用户叫停」才丢队列。 */
export function abortIsUserStop(turnAborted: boolean | undefined, source: TurnAbortSource | undefined): boolean {
  return turnAborted === true && source !== "system";
}

/**
 * 受理闸（D2-1a）：回合不在跑、或回合被**用户**中止（abort→idle 窗口），一律不受理 steer。
 * abort 与 idle 帧之间那一小段窗口特别重要——此刻 pendingQuestions 可能还在，若放行就会
 * 把用户的引导语当「答覆」POST 进一个已经中止的回合，并回 applied_in_turn:true（假话）。
 * 这两种情形诚实回 409，让前端走正常送出。
 *
 * D-6（2026-09-23）修掉的假话：中止闸原本只看 turnAborted，**不分来源**。而内部空转断路器
 * （triggerIdleStepBreaker）中止时同样设 turnAborted=true——它只是换一种方式续跑同一轮
 * （语义裁定见 abortIsUserStop），排队中的指引是被刻意保留的。于是那一小段窗口里对用户回的
 * 却是「本轮已中止，引导不会再生效」，讯息是假的；前端又据 409 落回普通送出（steer 模式下
 * 就是打断本轮），正好违背用户选的「不打断」语义。
 * 现在闸门直接复用停止优先的唯一判据 abortIsUserStop：**只有用户停止才拒**，系统中止窗口
 * 照常受理并走诚实的排队腿（注入腿另按同一个判据挡，见 steer-gw 的 injectEligible）。
 * 判别栏用字串 kind（strict:false 下布林字面量不收窄，见 SteerEnqueueOutcome 注释）。
 */
export type SteerGate =
  | { kind: "accept" }
  | { kind: "reject"; reason: "no_active_turn" | "turn_aborted" };

export function gateSteerAcceptance(opts: {
  turnInFlight: boolean;
  turnAborted: boolean;
  /** 中止来源；缺席一律按 "user"（与 abortIsUserStop 同一个判据、同一个保守预设）。 */
  turnAbortSource?: TurnAbortSource;
}): SteerGate {
  if (!opts.turnInFlight) return { kind: "reject", reason: "no_active_turn" };
  if (abortIsUserStop(opts.turnAborted, opts.turnAbortSource)) return { kind: "reject", reason: "turn_aborted" };
  return { kind: "accept" };
}

/**
 * steer 的生命周期状态（帧上报 + UI 徽章共用的唯一值域）：
 * - queued    已排队，等本回合结束后投递（诚实排队形态）
 * - injected  已注入：当前回合卡在 question 断点，这条以答覆语义回灌，本回合内生效
 * - applied   已生效：队列在本回合收尾时投递成功（下一回合生效）
 * - aborted   已作废：用户在同一时间按了停止——停止优先于 steer
 * - failed    未生效：投递失败（含未接线／超过 deadline 未投递），诚实告知不假装
 * - uncertain **未确认**（REQ-D2b，2026-09-23）：投递已发出但没等到确认（进程中断于
 *             投递与确认之间／重启后恢复），**永不自动重发**。它不是 failed——「不知道」
 *             与「确知没送到」是两件事，混为一谈就是把不确定说成事实。UI 显示「未确认·未重送」。
 *
 * 值域权威仍在本档：steer-identity.ts 的持久态（多一个内部态 dispatched）映射到这里，
 * 前端 src/lib/agent-chat-types.ts 的 AGENT_STEER_STATUSES 逐字对齐（六个值）。
 */
export type SteerStatus = "queued" | "injected" | "applied" | "aborted" | "failed" | "uncertain";

/** 队列里的一条 steer。id 由前端生成（前端乐观插入的徽章要能与帧对上号）。 */
export interface PendingSteer {
  id: string;
  /** 已归一化的文本（normalizeSteerText 的产物，入队后不再变）。 */
  text: string;
  /** 入队时刻（epoch ms）。 */
  at: number;
  /** 投递截止时刻（epoch ms = at + STEER_QUEUE_TTL_MS）。逾时不投递，落 failed。 */
  deadline: number;
  /**
   * 别名 id：同一条指引被前端用不同 id 重复送达（同文去重命中）时，把第二个 id
   * 记在这里——状态帧要对两个 id 都发，否则第二个徽章永远收不到终态（假排队中）。
   */
  aliases?: string[];
}

/** 一条 steer 要上报状态的全部 id（本体 + 别名）。 */
export function steerFrameIds(steer: PendingSteer): string[] {
  return [steer.id, ...(steer.aliases ?? [])];
}

/** steer id 值域：与网关其他 id 同款的保守字符集，防注入/防日志污染。 */
const STEER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSteerId(raw: unknown): raw is string {
  return typeof raw === "string" && STEER_ID_PATTERN.test(raw);
}

// D-7（2026-09-23）：这里原本有 mintSteerId（「未带／非法 id 就网关自铸一个」）——已删除。
// 自铸＝给每个无 id 的请求一个**全新的**身份，于是「手动重送」永远是第二条独立命令，
// ARL-02 的不变量（同一条指引一生只投递一次）只在客户端稳定带同一 id 时才碰巧成立。
// 身份必须来自客户端：缺 id 一律 fail-closed 回可辨识错误（见 steer-gw 的受理端），
// 网关不再代替客户端创造身份。我方前端总会带 id（src/hooks/use-agent-chat.newSteerId），
// 故 fail-closed 对它零影响。

/**
 * 文本归一化：去首尾空白 + 内部连续空白（含换行）折成单一空格。
 * 归一化同时是去重键——同一句话打字时多按了几个空白不该被当成第二条 steer。
 */
export function normalizeSteerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 入队结果。判别栏用字串 kind 而不是布林 ok：gateway 的 tsconfig 是
 * strict:false（strictNullChecks 关闭），布林字面量会被放宽成 boolean，
 * 判别联合在该设定下不会收窄（实测 TS2339）——字串判别栏才收得动。
 */
export type SteerEnqueueOutcome =
  | { kind: "accepted"; steer: PendingSteer; position: number; deduped: boolean }
  | { kind: "rejected"; reason: "empty" | "too_long" | "queue_full" };

/**
 * 入队判定（纯函数，不改 queue）：呼叫端拿 outcome.steer 自己 append。
 * 顺序契约：position = 入队后的 1-based 位置，先到先得（FIFO）。
 * 去重契约（两道，缺一不可）：
 *   a. **同 id**（D2-4）：前端／中继重放同一条 steer（重试、断线重发）→ 命中既有条目，
 *      不新增第二颗、不改顺序（同一个逻辑 steer 只占一格）。
 *   b. 同文本：队列里已有同一句（归一化后逐字相等）→ 回既有那条（deduped=true）。
 *      呼叫端要把本次的 id 记进 aliases（见 steerFrameIds），否则新徽章收不到终态。
 */
export function enqueueSteer(
  queue: readonly PendingSteer[],
  raw: unknown,
  opts: { now: number; id: string; ttlMs?: number },
): SteerEnqueueOutcome {
  const text = normalizeSteerText(raw);
  if (!text) return { kind: "rejected", reason: "empty" };
  if (text.length > STEER_MAX_CHARS) return { kind: "rejected", reason: "too_long" };
  // ① 同 id 去重（优先于文本）：重放同一条 steer 不得长出第二颗。
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
 * 队列 → 下一回合的投递文本。顺序保留（FIFO 逐条列出）＋ 明确交代这些指引的来历
 * （模型必须知道「这是上一轮执行期间用户追加的，不是新任务」），否则它会重新开场。
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
  /** 要投递的下一回合（FIFO 保序拼批）；null = 这一轮没有要投的。 */
  batch: { text: string; ids: string[] } | null;
  /** 被丢弃的条目（停止优先／逾时）：只上报状态，不投递。
   *  aborted = 用户叫停（停止优先）；expired = 过了 deadline（诚实落 failed）。 */
  dropped: Array<{ id: string; reason: "aborted" | "expired" }>;
}

/**
 * 回合收尾时对待投队列的处置（纯决策，实际 emit/投递由 steer-gw 做）。
 * 停止优先的落点就在这里：abortIsUserStop(...) === true ⇒ 全部丢弃，一条都不投。
 * 逾时（opts.now 有给才判）⇒ 该条不投递，落 dropped reason "expired"。
 * opts.now 刻意是选填：不传＝不判逾时（既有呼叫端行为逐位不变）。
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
