/**
 * FG-02/03：封闭 operation registry —— 自动重放（retry / 换道 / 重送）的唯一裁决来源。
 *
 * 病灶（2026-09-23 waoowaoo 机制 digest 第 4 条）：本仓库的自动重放决策过去由
 * **产品级错误分类**驱动（`worker-service.ts` 的 `if (!failure.retryable ||
 * !failure.switchSupplier)`）。那等于让「我们怎么解释这个错」决定「要不要再花一次
 * 上游与用户的钱」，而分类是关键字词表猜出来的：词表漏一个字，一条渠道就会在
 * 退避循环里被重放烧光预算（实录 adobe2api「temporarily unavailable」31 次）。
 *
 * 本档立三条不变量：
 *
 *  FG-02 封闭性：重放许可只由本 registry 的**已宣告**政策裁决。
 *         未宣告的动作 = `unregistered_operation`，默认**拒绝**重放。
 *  FG-03 呼叫方无权：呼叫方**不得**自带 retry 次数／预算。重放预算
 *         （`maxReplayAttempts`）唯一来源是这里；`planReplay` 只读
 *         `operation` 与 `nextAttemptNo`，结构上收不下任何失败分类或预算参数。
 *
 * 明确**不**在本档裁决的东西（避免偷换产品语义）：
 *  - 隔离／冷却／停用（supplier / account / capability health）：那是保护动作，
 *    不是重放；仍由 failure-classifier 的隔离维度与 scheduler 的既有租约/冷却闸决定。
 *    健康巡检／充值扫描是**节奏驱动的观察回圈**（下一次 30s／10min 到点就跑），
 *    不是「失败动作的重放」，本档不为它们宣告政策（宣告了也只是假契约）。
 *  - 产品分类（FailureClass）与人话：只允许出现在 `failure-record.ts` 的
 *    `explanation` 栏位与展示层，永不进入本档的裁决输入。
 *
 * FG-b（2026-09-23）接线：`billing.reserve` / `billing.commit` / `billing.refund`
 * 的重放**预算**由本档决定，裁决落点在 `billing-ledger.ts` 的 claim 与
 * `billing-projection.ts` 的扣款失败分支（见 `planBillingAttemptReplay`）。
 * 本档只决定「还能重试几次」，**不改**金额、状态机、幂等键或帐本行语义。
 */
import type { NativeFailureNode } from "./failure-record";
import type { GenerationKind } from "./types";

/**
 * 裁决落点：哪个执行器查这条政策。
 * `none` = 目前没有自动重放路径（宣告仅为封闭性记录；未来新增重放路径时必须改这里）。
 */
export type ReplayAdjudicator =
  | "generation-worker"
  | "callback-outbox"
  | "provider-reconciliation"
  | "billing-ledger"
  | "billing-projection"
  | "none";

/**
 * **原生**硬停（hard stop）：由上游原始 HTTP 状态／错误码判定「同一个请求再送一次
 * 也不可能成功」。这是 registry 政策的一部分（宣告式，集中在这里），输入是
 * `FailureRecord.native`（FG-01 逐字保留的原生栏位），**不是**产品分类。
 *
 * 为什么需要它：若重放许可完全只看动作键，一个被上游以 400/422 判死的确定性请求
 * 会被重放到预算上限（20 次），每次都在烧上游与用户的钱。用原生 4xx 语义挡掉，
 * 既不放产品分类进来裁决，也不让确定性失败变成 20 次无效呼叫。
 */
export interface NativeReplayHardStop {
  /** 原生 HTTP 状态原文（数字）。 */
  readonly status?: number;
  readonly reason: string;
}

/**
 * 生成动作的原生硬停集：402/400/422 = 确定性失败（重试无意义），451 = 法律/合规拒绝。
 *
 * 刻意**不**含 401/403/404/408/429/5xx：
 *  - 401/403：凭证问题，换账号/渠道有效（既有语义就是换道）。
 *  - 404：渠道不认这个模型名 —— 正是最该换道的情况。
 *  - 408/429/5xx：暂时性，本来就该重放。
 *
 * 402 例外来自**暴君裁定（2026-08-29 事故，见 failure-classifier 同一条注释）**：
 * 上游欠费/额度不足的重试无意义，改为 fail-fast —— 立刻诚实失败＋退款，不要静默空转。
 * 该裁定不得被静默覆写；如需改判（例如允许 402 换渠道）由暴君点名，不在刀内自行改。
 * 渠道自身额度耗尽的离线隔离仍由 account health 维度负责（本档不裁决保护动作）。
 */
export const NATIVE_GENERATION_HARD_STOPS: readonly NativeReplayHardStop[] = Object.freeze([
  { status: 402, reason: "402 = 上游额度/余额不足（含中文欠费文案）：重试同一动作无意义。暴君 2026-08-29 裁定 fail-fast（立刻失败＋退款），不得在刀内改判。" },
  { status: 400, reason: "上游以 400 拒绝了这个请求本身（提示词/尺寸/参考图不被接受），同请求换渠道重送不可能成功。" },
  { status: 422, reason: "上游以 422 拒绝了这个请求本身（语义不可处理），同请求换渠道重送不可能成功。" },
  { status: 451, reason: "上游以 451 因法律/合规原因拒绝，任何渠道都不会接受同一个请求。" },
]);

export interface ReplayPolicy {
  /** 动作键。未列于 registry 的键一律走 default-deny 政策。 */
  readonly key: string;
  /** 是否允许自动重放。false = 任何自动重放请求都被拒。 */
  readonly allowAutoReplay: boolean;
  /** 重放预算（本 registry 独有；呼叫方无权覆写）。 */
  readonly maxReplayAttempts: number;
  /** 裁决在谁身上执行。 */
  readonly adjudicator: ReplayAdjudicator;
  /** 这条政策是否已接到真实裁决路径（false = 仅宣告，尚未接线，属已知缺口）。 */
  readonly enforced: boolean;
  /** 原生硬停集（见 NativeReplayHardStop）。未宣告 = 无原生硬停。 */
  readonly hardStops?: readonly NativeReplayHardStop[];
  /** 为什么允许／禁止。 */
  readonly reason: string;
}

/**
 * 封闭 registry。新增可重放动作 = 在这里加一条（并在裁决落点查它）；
 * 没加 = 禁止重放。`as const satisfies` 让漏栏位在编译期就爆。
 */
export const REPLAY_REGISTRY = {
  "generation.image_generate": {
    key: "generation.image_generate",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "同步图像生成：单次渠道失败不代表模型不可用，换渠道重放是既有交付语义。同一输出位置的渠道/失败域排除链（attemptedSupplierRoutingForOutput）防同渠道空转，预算 20 远松于单 job 的 deadline 上限。",
  },
  "generation.image_edit": {
    key: "generation.image_edit",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "图像编辑与生成同管道（image_edit 走同一 supplier_adapter 路径），重放语义一致；已提交上游任务时另有对帐冻结兜底。",
  },
  "generation.video_generate": {
    key: "generation.video_generate",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "视频生成：异步上游，已提交但有 provider task id 的失败走对帐冻结（不重放、不退款），只有未提交成功的失败才允许换渠道重放。",
  },
  "generation.tts": {
    key: "generation.tts",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "TTS 生成：与图像同为同步适配器路径，失败换渠道重放。",
  },
  "generation.avatar": {
    key: "generation.avatar",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "数字人（异步视频族）与 video_generate 同构，重放语义一致。",
  },
  "generation.lipsync": {
    key: "generation.lipsync",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "对口型（异步视频族）与 video_generate 同构，重放语义一致。",
  },
  "callback.deliver": {
    key: "callback.deliver",
    allowAutoReplay: true,
    maxReplayAttempts: 8,
    adjudicator: "callback-outbox",
    enforced: true,
    reason: "把结果投递到用户 callback URL：投递失败不改变已落库的产物，属可重放的 at-least-once 通知；预算 8 次与既有生产值一致，超限进 dead_letter（不静默丢）。",
  },
  "provider.reconcile_poll": {
    key: "provider.reconcile_poll",
    allowAutoReplay: true,
    maxReplayAttempts: 128,
    adjudicator: "provider-reconciliation",
    enforced: true,
    reason: "向异步上游只读查真相（poll）：查询失败不是任务失败，必须重放。主要预算是 24h 对帐窗口（60s 起指数退避到 15min 上限，窗口内最多约 99 次）；128 是防御性天花板，正常不会先于窗口绑定。",
  },
  "billing.reserve": {
    key: "billing.reserve",
    allowAutoReplay: true,
    maxReplayAttempts: 64,
    adjudicator: "billing-ledger",
    enforced: true,
    reason: "预授权（reserve）：claim 内 attempt_count +1 后即问本政策「第 N 次准不准」，超预算不执行外部扣款、op 冻结为 unknown（reserve 的保守终结：扣款状态不明 → 由既有 zombie reclaim 全额退款给用户，金额不变）。预算 64 与 5min 上限退避相配（约 5 小时的连续失败），远早于 6h zombie 门槛。裁决输入只有 attempt_count 这个 DB 序号，呼叫方无权带预算。",
  },
  "billing.commit": {
    key: "billing.commit",
    allowAutoReplay: true,
    maxReplayAttempts: 1,
    adjudicator: "billing-projection",
    enforced: true,
    reason: "结算扣款（闸门路径 projection 的 adjustGatewayUserQuotaExact）：上游对 quota 调整**没有幂等契约**，重放同一笔扣款可能双扣 → 只准第 1 次，第 2 次起一律拒。billing_operation 的 INSERT 幂等重跑（reconcile 每 30s）不是重放付费动作，故不占预算额度。",
  },
  "billing.refund": {
    key: "billing.refund",
    allowAutoReplay: true,
    maxReplayAttempts: 64,
    adjudicator: "billing-ledger",
    enforced: true,
    reason: "退款（refund）必须可重放（否则用户钱卡死），但重放同样只能由本政策给预算：claim 内 attempt_count +1 后查「第 N 次准不准」。超预算即不再执行外部 credit、op 终结为 failed（未落地的退款不得假装 unknown——failed 才会出现在 probe 的 refund_failed 滞留名单，人工以 reconcileBillingOperationManually 接手，该入口会把预算归零以免自动预算否决人工决定）。",
  },
  "agent.steer_deliver": {
    key: "agent.steer_deliver",
    allowAutoReplay: false,
    maxReplayAttempts: 0,
    adjudicator: "none",
    enforced: false,
    reason: "回合中引导（steer）投递：重送会在同一回合重复施加引导意图、改写对话状态，副作用不可幂等 → 禁止自动重放。目前代码亦无自动重送路径（本条是禁则的封闭宣告，未接线）。",
  },
} as const satisfies Record<string, ReplayPolicy>;

export type RegisteredReplayOperation = keyof typeof REPLAY_REGISTRY;

/** 未宣告动作的默认政策：禁止重放，预算 0。 */
export const DEFAULT_DENY_REPLAY_POLICY: ReplayPolicy = Object.freeze({
  key: "*",
  allowAutoReplay: false,
  maxReplayAttempts: 0,
  adjudicator: "none",
  enforced: true,
  reason: "未宣告的动作默认禁止自动重放（FG-02 封闭性）。要允许重放，先在 REPLAY_REGISTRY 宣告。",
});

/**
 * 只读查政策。未宣告 → 默认禁止（永不回 undefined）。
 * 走 hasOwnProperty 而不是裸 `registry[key]`：后者会让 `"constructor"`／
 * `"toString"`／`"__proto__"` 这种键捡到 Object.prototype 上的成员，
 * 对外来的动作键就是一个「未宣告却拿到政策」的洞。
 */
export function resolveReplayPolicy(operation: string): ReplayPolicy {
  if (!isRegisteredReplayOperation(operation)) return DEFAULT_DENY_REPLAY_POLICY;
  return REPLAY_REGISTRY[operation] as ReplayPolicy;
}

export function isRegisteredReplayOperation(operation: string): operation is RegisteredReplayOperation {
  return Object.prototype.hasOwnProperty.call(REPLAY_REGISTRY, operation);
}

export type ReplayDenialReason =
  | "unregistered_operation"
  | "auto_replay_disabled"
  | "invalid_attempt_ordinal"
  | "native_hard_stop"
  | "attempt_budget_exhausted";

export interface ReplayPlanInput {
  /** 动作键（registry 键）。 */
  operation: string;
  /**
   * 即将执行的那次尝试的序号（1 起）。**不是**呼叫方自订的预算——
   * 是否允许由 registry 的 maxReplayAttempts 决定。
   */
  nextAttemptNo?: number;
  /**
   * 上游原生失败节点（`FailureRecord.native`）。只读 `status` 这类原生栏位来判
   * 原生硬停；产品分类、category、retryable 一律不在此列。
   */
  nativeFailure?: NativeFailureNode | null;
}

export interface ReplayPlan {
  operation: string;
  allowed: boolean;
  policy: ReplayPolicy;
  nextAttemptNo: number;
  maxReplayAttempts: number;
  denialReason: ReplayDenialReason | null;
  /** 命中的原生硬停（denialReason = "native_hard_stop" 时有值）。 */
  hardStop: NativeReplayHardStop | null;
}

function nativeStatusOf(native: NativeFailureNode | null | undefined): number | null {
  if (!native) return null;
  const status = native.status;
  if (typeof status === "number") return status;
  if (typeof status === "string") {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 命中的原生硬停（纯函数；无硬停回 null）。 */
export function matchNativeHardStop(
  policy: ReplayPolicy,
  native: NativeFailureNode | null | undefined,
): NativeReplayHardStop | null {
  const stops = policy.hardStops ?? [];
  if (!stops.length) return null;
  const status = nativeStatusOf(native);
  if (status === null) return null;
  return stops.find((stop) => stop.status === status) ?? null;
}

/**
 * 重放裁决。输入只有三个：动作键、即将执行的尝试序号、上游原生失败节点。
 *
 * 产品错误码／category／retryable／呼叫方自带的重试次数在**型别上**就传不进来；
 * 额外塞进来的属性在执行期被忽略（本函数只读上面三个栏位）。
 * 未宣告的动作 → 拒绝（FG-02 默认禁）。
 */
export function planReplay(input: ReplayPlanInput): ReplayPlan {
  const operation = String(input.operation ?? "");
  // 尝试序号必须是 ≥1 的有限数：NaN／undefined／0 一律 fail closed（拒绝重放），
  // 否则「序号算不出来」就会被当成第 1 次，预算永远绑不住 = 无限重放。
  const rawOrdinal = input.nextAttemptNo;
  const ordinalValid = typeof rawOrdinal === "number" && Number.isFinite(rawOrdinal) && rawOrdinal >= 1;
  const nextAttemptNo = ordinalValid ? Math.floor(rawOrdinal as number) : 0;
  const policy = resolveReplayPolicy(operation);
  const base = {
    operation,
    policy,
    nextAttemptNo,
    maxReplayAttempts: policy.maxReplayAttempts,
    hardStop: null as NativeReplayHardStop | null,
  };

  if (!isRegisteredReplayOperation(operation)) {
    return { ...base, allowed: false, denialReason: "unregistered_operation" };
  }
  if (!policy.allowAutoReplay) {
    return { ...base, allowed: false, denialReason: "auto_replay_disabled" };
  }
  if (!ordinalValid) {
    return { ...base, allowed: false, denialReason: "invalid_attempt_ordinal" };
  }
  const hardStop = matchNativeHardStop(policy, input.nativeFailure);
  if (hardStop) {
    return { ...base, allowed: false, denialReason: "native_hard_stop", hardStop };
  }
  if (nextAttemptNo > policy.maxReplayAttempts) {
    return { ...base, allowed: false, denialReason: "attempt_budget_exhausted" };
  }
  return { ...base, allowed: true, denialReason: null };
}

/** 生成任务 kind → registry 动作键。新增 kind 时这里必须一起加（否则默认禁重放）。 */
export function replayOperationForJobKind(kind: GenerationKind): string {
  switch (kind) {
    case "image_generate":
      return "generation.image_generate";
    case "image_edit":
      return "generation.image_edit";
    case "video_generate":
      return "generation.video_generate";
    case "tts":
      return "generation.tts";
    case "avatar":
      return "generation.avatar";
    case "lipsync":
      return "generation.lipsync";
    default:
      return `generation.${String(kind)}`;
  }
}

/**
 * worker 的换道重放裁决（真实调用路径用这个，不是直接查常数）。
 * 只看 registry + **刚失败那次尝试的序号** + 上游原生失败节点；产品分类不参与。
 * 下一次尝试的序号 = lastAttemptNo + 1（由本函数算，呼叫方不得自行指定预算）。
 */
export function planGenerationAttemptReplay(input: {
  kind: GenerationKind;
  /** 刚失败那次 attempt 的序号（generation_job.attempt_count 或 attempt.attempt_no）。 */
  lastAttemptNo?: number | null;
  /** 本次失败的上游原生节点（FailureRecord.native），用于原生硬停判定。 */
  nativeFailure?: NativeFailureNode | null;
}): ReplayPlan {
  const last = Number.isFinite(input.lastAttemptNo) && (input.lastAttemptNo as number) > 0
    ? Math.floor(input.lastAttemptNo as number)
    : 0;
  return planReplay({
    operation: replayOperationForJobKind(input.kind),
    nextAttemptNo: last + 1,
    nativeFailure: input.nativeFailure ?? null,
  });
}

/** 已接线的计费动作键：`billing-ledger` 的 claim 与 `billing-projection` 的扣款点查这三条。 */
export type BillingReplayOperation = "billing.reserve" | "billing.commit" | "billing.refund";

const BILLING_REPLAY_OPERATIONS: ReadonlySet<string> = new Set<string>([
  "billing.reserve",
  "billing.commit",
  "billing.refund",
]);

/**
 * 计费动作的重放裁决（FG-b 接线，真实调用路径用这个，不是直接查常数）。
 *
 * 序号语义（FG 教训：这类裁决最容易差一格）：`billing-ledger` 的 claim 在 UPDATE 内
 * 把 `attempt_count` +1，故 **claim 后 RETURNING 的 attempt_count 就是「这次尝试」的序号**；
 * 要问「下一次还准不准」就传 attempt_count + 1。呼叫方的预算参数（maxAttempts/retryCount
 * 等）在型别上传不进来，执行期夹带也被忽略（本函数只读 operation 与 nextAttemptNo）。
 *
 * 只认 billing.* 三键：拿这个函数裁决别族（误传 `generation.*`）一律 default-deny，
 * 免得计费的重放预算被生成族政策借走。
 *
 * 计费政策**不**宣告原生硬停：确定性 4xx 已由 `classifyBillingFailure` 判为 rejected
 * （终结不重放），本函数只负责「自动重放还剩几次」。
 */
export function planBillingAttemptReplay(input: {
  operation: BillingReplayOperation | string;
  /** 即将执行的那次尝试的序号（1 起；见上方序号语义）。 */
  nextAttemptNo?: number | null;
}): ReplayPlan {
  const operation = String(input.operation ?? "");
  if (!BILLING_REPLAY_OPERATIONS.has(operation)) {
    // 非计费动作键 → 对本裁决而言等于未宣告，fail closed（不借用别族政策）。
    return {
      operation,
      allowed: false,
      policy: DEFAULT_DENY_REPLAY_POLICY,
      nextAttemptNo: 0,
      maxReplayAttempts: 0,
      denialReason: "unregistered_operation",
      hardStop: null,
    };
  }
  // null → undefined：planReplay 的序号验证只认 number，null 会走 invalid_attempt_ordinal
  // （fail closed），与「序号算不出来就不放行」同一条规则。
  return planReplay({ operation, nextAttemptNo: input.nextAttemptNo ?? undefined });
}

/**
 * 预算耗尽时的统一话术（写进 `billing_operation.last_error` 与事件），
 * 让人工对帐一眼看出「不是上游坏了，是自动重放预算用完了」。
 */
export function billingReplayDenialDetail(operation: string, plan: ReplayPlan): string {
  return `Automatic replay denied by operation registry (${operation}: ${plan.denialReason ?? "unknown"}, attempt ${plan.nextAttemptNo}/${plan.maxReplayAttempts}); manual reconciliation required.`;
}
