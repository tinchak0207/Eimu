/**
 * FG-02/03：封閉 operation registry —— 自動重放（retry / 換道 / 重送）的唯一裁決來源。
 *
 * 病灶（2026-09-23 waoowaoo 機制 digest 第 4 條）：本倉庫的自動重放決策過去由
 * **產品級錯誤分類**驅動（`worker-service.ts` 的 `if (!failure.retryable ||
 * !failure.switchSupplier)`）。那等於讓「我們怎麼解釋這個錯」決定「要不要再花一次
 * 上游與用戶的錢」，而分類是關鍵字詞表猜出來的：詞表漏一個字，一條渠道就會在
 * 退避循環裡被重放燒光預算（實錄 adobe2api「temporarily unavailable」31 次）。
 *
 * 本檔立三條不變量：
 *
 *  FG-02 封閉性：重放許可只由本 registry 的**已宣告**政策裁決。
 *         未宣告的動作 = `unregistered_operation`，默認**拒絕**重放。
 *  FG-03 呼叫方無權：呼叫方**不得**自帶 retry 次數／預算。重放預算
 *         （`maxReplayAttempts`）唯一來源是這裡；`planReplay` 只讀
 *         `operation` 與 `nextAttemptNo`，結構上收不下任何失敗分類或預算參數。
 *
 * 明確**不**在本檔裁決的東西（避免偷換產品語義）：
 *  - 隔離／冷卻／停用（supplier / account / capability health）：那是保護動作，
 *    不是重放；仍由 failure-classifier 的隔離維度與 scheduler 的既有租約/冷卻閘決定。
 *    健康巡檢／充值掃描是**節奏驅動的觀察迴圈**（下一次 30s／10min 到點就跑），
 *    不是「失敗動作的重放」，本檔不為它們宣告政策（宣告了也只是假契約）。
 *  - 產品分類（FailureClass）與人話：只允許出現在 `failure-record.ts` 的
 *    `explanation` 欄位與展示層，永不進入本檔的裁決輸入。
 *
 * FG-b（2026-09-23）接線：`billing.reserve` / `billing.commit` / `billing.refund`
 * 的重放**預算**由本檔決定，裁決落點在 `billing-ledger.ts` 的 claim 與
 * `billing-projection.ts` 的扣款失敗分支（見 `planBillingAttemptReplay`）。
 * 本檔只決定「還能重試幾次」，**不改**金額、狀態機、冪等鍵或帳本行語義。
 */
import type { NativeFailureNode } from "./failure-record";
import type { GenerationKind } from "./types";

/**
 * 裁決落點：哪個執行器查這條政策。
 * `none` = 目前沒有自動重放路徑（宣告僅為封閉性記錄；未來新增重放路徑時必須改這裡）。
 */
export type ReplayAdjudicator =
  | "generation-worker"
  | "callback-outbox"
  | "provider-reconciliation"
  | "billing-ledger"
  | "billing-projection"
  | "none";

/**
 * **原生**硬停（hard stop）：由上游原始 HTTP 狀態／錯誤碼判定「同一個請求再送一次
 * 也不可能成功」。這是 registry 政策的一部分（宣告式，集中在這裡），輸入是
 * `FailureRecord.native`（FG-01 逐字保留的原生欄位），**不是**產品分類。
 *
 * 為什麼需要它：若重放許可完全只看動作鍵，一個被上游以 400/422 判死的確定性請求
 * 會被重放到預算上限（20 次），每次都在燒上游與用戶的錢。用原生 4xx 語義擋掉，
 * 既不放產品分類進來裁決，也不讓確定性失敗變成 20 次無效呼叫。
 */
export interface NativeReplayHardStop {
  /** 原生 HTTP 狀態原文（數字）。 */
  readonly status?: number;
  readonly reason: string;
}

/**
 * 生成動作的原生硬停集：402/400/422 = 確定性失敗（重試無意義），451 = 法律/合規拒絕。
 *
 * 刻意**不**含 401/403/404/408/429/5xx：
 *  - 401/403：憑證問題，換賬號/渠道有效（既有語義就是換道）。
 *  - 404：渠道不認這個模型名 —— 正是最該換道的情況。
 *  - 408/429/5xx：暫時性，本來就該重放。
 *
 * 402 例外來自**暴君裁定（2026-08-29 事故，見 failure-classifier 同一條註釋）**：
 * 上游欠費/額度不足的重試無意義，改為 fail-fast —— 立刻誠實失敗＋退款，不要靜默空轉。
 * 該裁定不得被靜默覆寫；如需改判（例如允許 402 換渠道）由暴君點名，不在刀內自行改。
 * 渠道自身額度耗盡的離線隔離仍由 account health 維度負責（本檔不裁決保護動作）。
 */
export const NATIVE_GENERATION_HARD_STOPS: readonly NativeReplayHardStop[] = Object.freeze([
  { status: 402, reason: "402 = 上游額度/餘額不足（含中文欠費文案）：重試同一動作無意義。暴君 2026-08-29 裁定 fail-fast（立刻失敗＋退款），不得在刀內改判。" },
  { status: 400, reason: "上游以 400 拒絕了這個請求本身（提示詞/尺寸/參考圖不被接受），同請求換渠道重送不可能成功。" },
  { status: 422, reason: "上游以 422 拒絕了這個請求本身（語義不可處理），同請求換渠道重送不可能成功。" },
  { status: 451, reason: "上游以 451 因法律/合規原因拒絕，任何渠道都不會接受同一個請求。" },
]);

export interface ReplayPolicy {
  /** 動作鍵。未列於 registry 的鍵一律走 default-deny 政策。 */
  readonly key: string;
  /** 是否允許自動重放。false = 任何自動重放請求都被拒。 */
  readonly allowAutoReplay: boolean;
  /** 重放預算（本 registry 獨有；呼叫方無權覆寫）。 */
  readonly maxReplayAttempts: number;
  /** 裁決在誰身上執行。 */
  readonly adjudicator: ReplayAdjudicator;
  /** 這條政策是否已接到真實裁決路徑（false = 僅宣告，尚未接線，屬已知缺口）。 */
  readonly enforced: boolean;
  /** 原生硬停集（見 NativeReplayHardStop）。未宣告 = 無原生硬停。 */
  readonly hardStops?: readonly NativeReplayHardStop[];
  /** 為什麼允許／禁止。 */
  readonly reason: string;
}

/**
 * 封閉 registry。新增可重放動作 = 在這裡加一條（並在裁決落點查它）；
 * 沒加 = 禁止重放。`as const satisfies` 讓漏欄位在編譯期就爆。
 */
export const REPLAY_REGISTRY = {
  "generation.image_generate": {
    key: "generation.image_generate",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "同步圖像生成：單次渠道失敗不代表模型不可用，換渠道重放是既有交付語義。同一輸出位置的渠道/失敗域排除鏈（attemptedSupplierRoutingForOutput）防同渠道空轉，預算 20 遠鬆於單 job 的 deadline 上限。",
  },
  "generation.image_edit": {
    key: "generation.image_edit",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "圖像編輯與生成同管道（image_edit 走同一 supplier_adapter 路徑），重放語義一致；已提交上游任務時另有對帳凍結兜底。",
  },
  "generation.video_generate": {
    key: "generation.video_generate",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "視頻生成：異步上游，已提交但有 provider task id 的失敗走對帳凍結（不重放、不退款），只有未提交成功的失敗才允許換渠道重放。",
  },
  "generation.tts": {
    key: "generation.tts",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "TTS 生成：與圖像同為同步適配器路徑，失敗換渠道重放。",
  },
  "generation.avatar": {
    key: "generation.avatar",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "數字人（異步視頻族）與 video_generate 同構，重放語義一致。",
  },
  "generation.lipsync": {
    key: "generation.lipsync",
    allowAutoReplay: true,
    maxReplayAttempts: 20,
    adjudicator: "generation-worker",
    enforced: true,
    hardStops: NATIVE_GENERATION_HARD_STOPS,
    reason: "對口型（異步視頻族）與 video_generate 同構，重放語義一致。",
  },
  "callback.deliver": {
    key: "callback.deliver",
    allowAutoReplay: true,
    maxReplayAttempts: 8,
    adjudicator: "callback-outbox",
    enforced: true,
    reason: "把結果投遞到用戶 callback URL：投遞失敗不改變已落庫的產物，屬可重放的 at-least-once 通知；預算 8 次與既有生產值一致，超限進 dead_letter（不靜默丟）。",
  },
  "provider.reconcile_poll": {
    key: "provider.reconcile_poll",
    allowAutoReplay: true,
    maxReplayAttempts: 128,
    adjudicator: "provider-reconciliation",
    enforced: true,
    reason: "向異步上游只讀查真相（poll）：查詢失敗不是任務失敗，必須重放。主要預算是 24h 對帳窗口（60s 起指數退避到 15min 上限，窗口內最多約 99 次）；128 是防禦性天花板，正常不會先於窗口綁定。",
  },
  "billing.reserve": {
    key: "billing.reserve",
    allowAutoReplay: true,
    maxReplayAttempts: 64,
    adjudicator: "billing-ledger",
    enforced: true,
    reason: "預授權（reserve）：claim 內 attempt_count +1 後即問本政策「第 N 次准不准」，超預算不執行外部扣款、op 凍結為 unknown（reserve 的保守終結：扣款狀態不明 → 由既有 zombie reclaim 全額退款給用戶，金額不變）。預算 64 與 5min 上限退避相配（約 5 小時的連續失敗），遠早於 6h zombie 門檻。裁決輸入只有 attempt_count 這個 DB 序號，呼叫方無權帶預算。",
  },
  "billing.commit": {
    key: "billing.commit",
    allowAutoReplay: true,
    maxReplayAttempts: 1,
    adjudicator: "billing-projection",
    enforced: true,
    reason: "結算扣款（閘門路徑 projection 的 adjustGatewayUserQuotaExact）：上游對 quota 調整**沒有冪等契約**，重放同一筆扣款可能雙扣 → 只准第 1 次，第 2 次起一律拒。billing_operation 的 INSERT 冪等重跑（reconcile 每 30s）不是重放付費動作，故不佔預算額度。",
  },
  "billing.refund": {
    key: "billing.refund",
    allowAutoReplay: true,
    maxReplayAttempts: 64,
    adjudicator: "billing-ledger",
    enforced: true,
    reason: "退款（refund）必須可重放（否則用戶錢卡死），但重放同樣只能由本政策給預算：claim 內 attempt_count +1 後查「第 N 次准不准」。超預算即不再執行外部 credit、op 終結為 failed（未落地的退款不得假裝 unknown——failed 才會出現在 probe 的 refund_failed 滯留名單，人工以 reconcileBillingOperationManually 接手，該入口會把預算歸零以免自動預算否決人工決定）。",
  },
  "agent.steer_deliver": {
    key: "agent.steer_deliver",
    allowAutoReplay: false,
    maxReplayAttempts: 0,
    adjudicator: "none",
    enforced: false,
    reason: "回合中引導（steer）投遞：重送會在同一回合重複施加引導意圖、改寫對話狀態，副作用不可冪等 → 禁止自動重放。目前代碼亦無自動重送路徑（本條是禁則的封閉宣告，未接線）。",
  },
} as const satisfies Record<string, ReplayPolicy>;

export type RegisteredReplayOperation = keyof typeof REPLAY_REGISTRY;

/** 未宣告動作的默認政策：禁止重放，預算 0。 */
export const DEFAULT_DENY_REPLAY_POLICY: ReplayPolicy = Object.freeze({
  key: "*",
  allowAutoReplay: false,
  maxReplayAttempts: 0,
  adjudicator: "none",
  enforced: true,
  reason: "未宣告的動作默認禁止自動重放（FG-02 封閉性）。要允許重放，先在 REPLAY_REGISTRY 宣告。",
});

/**
 * 只讀查政策。未宣告 → 默認禁止（永不回 undefined）。
 * 走 hasOwnProperty 而不是裸 `registry[key]`：後者會讓 `"constructor"`／
 * `"toString"`／`"__proto__"` 這種鍵撿到 Object.prototype 上的成員，
 * 對外來的動作鍵就是一個「未宣告卻拿到政策」的洞。
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
  /** 動作鍵（registry 鍵）。 */
  operation: string;
  /**
   * 即將執行的那次嘗試的序號（1 起）。**不是**呼叫方自訂的預算——
   * 是否允許由 registry 的 maxReplayAttempts 決定。
   */
  nextAttemptNo?: number;
  /**
   * 上游原生失敗節點（`FailureRecord.native`）。只讀 `status` 這類原生欄位來判
   * 原生硬停；產品分類、category、retryable 一律不在此列。
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
  /** 命中的原生硬停（denialReason = "native_hard_stop" 時有值）。 */
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

/** 命中的原生硬停（純函數；無硬停回 null）。 */
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
 * 重放裁決。輸入只有三個：動作鍵、即將執行的嘗試序號、上游原生失敗節點。
 *
 * 產品錯誤碼／category／retryable／呼叫方自帶的重試次數在**型別上**就傳不進來；
 * 額外塞進來的屬性在執行期被忽略（本函數只讀上面三個欄位）。
 * 未宣告的動作 → 拒絕（FG-02 默認禁）。
 */
export function planReplay(input: ReplayPlanInput): ReplayPlan {
  const operation = String(input.operation ?? "");
  // 嘗試序號必須是 ≥1 的有限數：NaN／undefined／0 一律 fail closed（拒絕重放），
  // 否則「序號算不出來」就會被當成第 1 次，預算永遠綁不住 = 無限重放。
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

/** 生成任務 kind → registry 動作鍵。新增 kind 時這裡必須一起加（否則默認禁重放）。 */
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
 * worker 的換道重放裁決（真實調用路徑用這個，不是直接查常數）。
 * 只看 registry + **剛失敗那次嘗試的序號** + 上游原生失敗節點；產品分類不參與。
 * 下一次嘗試的序號 = lastAttemptNo + 1（由本函數算，呼叫方不得自行指定預算）。
 */
export function planGenerationAttemptReplay(input: {
  kind: GenerationKind;
  /** 剛失敗那次 attempt 的序號（generation_job.attempt_count 或 attempt.attempt_no）。 */
  lastAttemptNo?: number | null;
  /** 本次失敗的上游原生節點（FailureRecord.native），用於原生硬停判定。 */
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

/** 已接線的計費動作鍵：`billing-ledger` 的 claim 與 `billing-projection` 的扣款點查這三條。 */
export type BillingReplayOperation = "billing.reserve" | "billing.commit" | "billing.refund";

const BILLING_REPLAY_OPERATIONS: ReadonlySet<string> = new Set<string>([
  "billing.reserve",
  "billing.commit",
  "billing.refund",
]);

/**
 * 計費動作的重放裁決（FG-b 接線，真實調用路徑用這個，不是直接查常數）。
 *
 * 序號語義（FG 教訓：這類裁決最容易差一格）：`billing-ledger` 的 claim 在 UPDATE 內
 * 把 `attempt_count` +1，故 **claim 後 RETURNING 的 attempt_count 就是「這次嘗試」的序號**；
 * 要問「下一次還准不准」就傳 attempt_count + 1。呼叫方的預算參數（maxAttempts/retryCount
 * 等）在型別上傳不進來，執行期夾帶也被忽略（本函數只讀 operation 與 nextAttemptNo）。
 *
 * 只認 billing.* 三鍵：拿這個函數裁決別族（誤傳 `generation.*`）一律 default-deny，
 * 免得計費的重放預算被生成族政策借走。
 *
 * 計費政策**不**宣告原生硬停：確定性 4xx 已由 `classifyBillingFailure` 判為 rejected
 * （終結不重放），本函數只負責「自動重放還剩幾次」。
 */
export function planBillingAttemptReplay(input: {
  operation: BillingReplayOperation | string;
  /** 即將執行的那次嘗試的序號（1 起；見上方序號語義）。 */
  nextAttemptNo?: number | null;
}): ReplayPlan {
  const operation = String(input.operation ?? "");
  if (!BILLING_REPLAY_OPERATIONS.has(operation)) {
    // 非計費動作鍵 → 對本裁決而言等於未宣告，fail closed（不借用別族政策）。
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
  // null → undefined：planReplay 的序號驗證只認 number，null 會走 invalid_attempt_ordinal
  // （fail closed），與「序號算不出來就不放行」同一條規則。
  return planReplay({ operation, nextAttemptNo: input.nextAttemptNo ?? undefined });
}

/**
 * 預算耗盡時的統一話術（寫進 `billing_operation.last_error` 與事件），
 * 讓人工對帳一眼看出「不是上游壞了，是自動重放預算用完了」。
 */
export function billingReplayDenialDetail(operation: string, plan: ReplayPlan): string {
  return `Automatic replay denied by operation registry (${operation}: ${plan.denialReason ?? "unknown"}, attempt ${plan.nextAttemptNo}/${plan.maxReplayAttempts}); manual reconciliation required.`;
}
