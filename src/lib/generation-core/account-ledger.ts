// REQ-E1a 我方帐本（余额权威）——「客户可见余额的权威归我方帐本」（暴君 2026-09-23 裁定）。
//
// 为什么要有本档：waoowaoo BA-07「账本唯一 writer」。new-api 内核在 relay 前扣
// `users.quota`，与我方帐本构成双写（B1 真转移更让两层同时变动）；只要对外余额直接
// 读 new-api，我方就永远说不清「这个数字是怎么来的」。本档把对外余额的计算源搬回
// 我方帐本：`account_ledger` 是 append-only 的有号流水，余额 = Σ amount（单一公式，
// 见 computeAccountBalance）。new-api 的 users.quota 降格为「上游供货水位」与内核
// 执法点，只作对帐另一侧（见 account-reconciliation.ts）。
//
// 加项 / 减项（完整判别表，权威在本档）：
//   + opening      上线基线（以 new-api 当时 users.quota 种入，可为负）
//   + recharge     充值入帐（new-api 兑换码被使用）
//   + refund       任务退款
//   + transfer_in  B1 成员收到分配
//   ± adjustment   管理员加减额度（建户初始额度／人工补正）
//   − consumption  消费扣费（legacy reserve 的上游扣款、gate path 投影扣款）
//   − transfer_out B1 主帐划出给成员
//   不入帐：writeoff（平台自身损失，不影响用户 users.quota）。
//
// REQ-D3（订阅 SKU）在原模型上加**一个维度**（不新造第二条帐务通道）：每一列可标
//   pool        'permanent'（默认）｜'subscription'
//   term_ref    'sub:<订阅 id>:term:<期次序号>'（永久池 NULL）
//   expires_at  该期到期时刻（订阅池必填）
// 两个余额口径（单一权威在本档 + subscription-sku.ts）：
//   book(user)      = Σ amount                                    ← 帐面净额（对帐用，不变）
//   available(user) = 永久池 Σ + **未过期**订阅池 Σ（读取时 lazy 判定，不依赖 cron）
// 加减项新增一种：
//   − expire       订阅续期替换：旧期未用完余额在写入时作废（见 subscription.ts）
//
// 四条纪律：
//   1. append-only：只 INSERT。错帐靠再 INSERT 一笔反向 adjustment 更正，不改历史
//      （本档没有任何 UPDATE/DELETE account_ledger 的语句，测试具名守门）。
//   2. 幂等：每笔帐带 `idempotency_ref`（UNIQUE）。写入端重放同一件事 = 命中
//      ON CONFLICT DO NOTHING，不双算。
//   2b. 顺序铁律：**先 ensureAccountBaselines() 种基线，再动上游，最后记增量**。
//      颠倒顺序 = 基线已含该笔增量 + 帐本再记一次 = 双算（见 ensureAccountBaselines 注释）。
//   3. 不挡钱路：记帐失败只 console.error + 回传 false，永不让计费/上游调整路径失败。
//      差额由 E1b 的对帐报告如实指出（可解释优先于假装同步成功）。
//      唯一例外（E1-b D-2）：**基线不成立时不得动上游**——没有基线的上游变动无法归属，
//      lazy 种子之后会把它算进基线 ⇒ 同一笔增量算两次、差额永久存在。故此种情况回
//      blocked=true，由呼叫端在动上游之前就停手（见 ensureAccountBaselinesWithStatus）。
//   4. 方向由 entry_type 决定（signed 类型只有 opening/adjustment），签名不符的行
//      一律拒收——宁可不记，不记错方向的帐。

export {
  LEDGER_ENTRY_DIRECTION,
  ledgerDirectionOf,
  validateLedgerEntryDraft,
  computeAccountBalance,
  QUOTA_RESPONSE_CURRENCY,
  quotaResponseBody,
  ledgerRef,
  REDEMPTION_CASH_SOURCE,
  REDEMPTION_MANUAL_SOURCE,
  REDEMPTION_BASELINE_OFFSET_SOURCE,
} from "./account-ledger/schema";
export { accountLedgerStoreEnabled, postLedgerEntries, readAccountLedger } from "./account-ledger/storage";
export { readAccountBalance, readPoolBalances, readAvailableQuota } from "./account-ledger/queries";
export {
  ensureAccountOpening,
  seedAccountOpenings,
  ensureAccountBaselines,
  ensureAccountBaselinesWithStatus,
} from "./account-ledger/opening";
export {
  recordConsumption,
  recordRefund,
  recordTransfer,
  recordRecharge,
  recordSubscriptionTermSwitch,
  recordAdjustment,
} from "./account-ledger/writes";
export { isCashBackedRedemptionName, ingestRedeemedRecharges } from "./account-ledger/recharge-ingest";
export type {
  LedgerEntryType,
  LedgerPool,
  LedgerDirection,
  LedgerEntryDraft,
  LedgerEntry,
  PostLedgerResult,
  AccountBalance,
  OpeningFailureKind,
  OpeningSeedResult,
  BaselineGuardResult,
  PendingWriteOutcome,
  LedgerWriterDeps,
  RechargeIngestSummary,
} from "./account-ledger/types";
