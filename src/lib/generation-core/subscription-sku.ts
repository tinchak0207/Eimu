// REQ-D3 订阅 SKU：**纯函式层**（无 I/O、无 DB、无上游呼叫）。
//
// 本档是「池 / 期次 / 过期 / 出资归还」四件事的单一权威。写入器在 subscription.ts，
// 帐本 schema 在 account-ledger.ts，本档只做算术与判定，故可在任何地方被独立断言。
//
// 借来的机制不变量（waoowaoo BA-15/16，机制借用、代码禁抄）：
//   ① 双池：永久池（充值／开帐基线）与订阅池（期末过期）分离；
//      可用余额 = 永久池 + 未过期订阅池。
//   ② 按原出资归还：退款回它原本的池，不跨池搬。
//   ③ (订阅 id, 期次序号) 发放幂等；下一期替换而非累加（预设，见 RENEWAL_MODE）。
//   ④ 过期只在读取时 lazy 判定——本档的 computePoolBalances(entries, nowMs) 就是那个
//      判定点：不改写任何历史、不依赖定时任务，任何时刻任何进程算出的答案都一样。
//
// ─────────────────────────────────────────────── 参数化旋钮（项目负责人一句话可翻转）
// 全档所有「暂用预设」都集中在下面这个区块：改常数值即可翻转语义，不动其他代码。
// 回报中列出的翻转点＝本区块的行号。

/** 帐本池：'permanent' 永久池（充值／开帐基线）｜'subscription' 订阅池（期末过期）。 */
export const LEDGER_POOLS = ["permanent", "subscription"] as const;
export type LedgerPool = (typeof LEDGER_POOLS)[number];

/** 默认池（没有标 pool 的帐本行一律视为永久池——020 既有列与所有旧呼叫端的语义）。 */
export const LEDGER_POOL_DEFAULT: LedgerPool = "permanent";

export function isLedgerPool(value: unknown): value is LedgerPool {
  return typeof value === "string" && (LEDGER_POOLS as readonly string[]).includes(value);
}

/**
 * 【预设 1】续期语义。
 *   'replace'    到期未用完＝按期替换：新期额度取代旧期余额，不累积（**当前预设**）
 *   'accumulate' 累积：新期额度＋旧期未用完余额，旧期余额仍按旧期到期时刻失效
 * 只影响「续期发放时是否要把旧期未用完余额作废（expire 帐本行）」。
 * 反向只需把本常数改成 "accumulate"，其余零改动。
 */
export const SUBSCRIPTION_RENEWAL_MODE: "replace" | "accumulate" = "replace";

/**
 * 【预设 2】订阅的兑现通道。
 *   'redemption' 沿用兑换码通道：订阅＝一张带 SKU 标记的兑换码，用户在 new-api 端兑换，
 *                我方由「上游兑换记录」回读入帐（与 E1a 充值入帐同一条可观测真相）（**当前预设**）
 *   'direct'     直落通道（未实作）：我方直接写库入帐，不经兑换码
 * 这不是「要不要有订阅」，而是「兑现事实从哪里读回来」。切 'direct' 需另派一刀。
 */
export const SUBSCRIPTION_FULFILLMENT_CHANNEL: "redemption" | "direct" = "redemption";

/**
 * 扣费时的扣款池次序（先扣哪个池）。
 * 预设先扣订阅池再扣永久池：订阅余额会过期，永久余额不会——先用会过期的钱。
 */
export const CONSUMPTION_POOL_ORDER: LedgerPool[] = ["subscription", "permanent"];

/**
 * 退款在多条出资腿之间的分摊次序。
 *   'lifo' 先退最后出资的那条腿（**当前预设**）｜'fifo' 按出资次序退
 */
export const REFUND_ALLOCATION_ORDER: "lifo" | "fifo" = "lifo";

/**
 * 退款回到「已过期」的原订阅期时怎么办。
 *   true  照 ② 按原出资归还：回原期（原到期时刻）——该期已过期 ⇒ 这笔退款同样不可用（**当前预设**）
 *   false 改挂当前未过期期（无当前期则仍回原期）
 * true 是「不跨池、不搬期」的忠实实作；false 对用户更宽，但语义上已不是「按原出资归还」。
 */
export const SUBSCRIPTION_REFUND_EXPIRED_TO_ORIGINAL_TERM = true;

/** 兑换码 name 的订阅标记前缀与分隔符（name 是我方在建码时自己写进去的那个栏位）。 */
export const SUBSCRIPTION_CODE_NAME_PREFIX = "SUB-";
export const SUBSCRIPTION_CODE_NAME_SEPARATOR = "@";

/**
 * SKU 注册表：只定义**期长**与显示名。每期额度不在此表——额度由用户实际购买的兑换码
 * 金额决定（不让代码发明定价；定价权威在 pricing/兑换码本身）。
 */
export const SUBSCRIPTION_SKUS: Record<string, { label: string; termSeconds: number }> = {
  "pro-monthly": { label: "专业月费", termSeconds: 30 * 24 * 60 * 60 },
  "pro-yearly": { label: "专业年费", termSeconds: 365 * 24 * 60 * 60 },
};

/**
 * 标记认得、但 SKU 不在注册表时的兜底期长（30 天）。
 * 为什么要兜底而不是失败：**充值必兑现**（项目负责人 09-20 铁律）——码是真的、钱是真的，
 * 认不出 SKU 只该影响「期长取默认＋留审计讯息」，不该让用户拿不到额度。
 */
export const SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS = 30 * 24 * 60 * 60;

export function subscriptionSkuTermSeconds(sku: string): number {
  const known = SUBSCRIPTION_SKUS[sku]?.termSeconds;
  return Number.isFinite(known) && (known as number) > 0 ? (known as number) : SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS;
}

export function isKnownSubscriptionSku(sku: string): boolean {
  return Boolean(SUBSCRIPTION_SKUS[sku]);
}

// ─────────────────────────────────────────────── 兑换码标记（SKU 载体）

export interface SubscriptionCodeMarker {
  /** SKU 识别。 */
  sku: string;
  /** 我方自己的业务参照（订单号等），只作审计。 */
  ref: string;
}

/**
 * 现场事实（决定「SKU 标记放哪里」）：
 *   new-api 兑换码有三个栏位：`key`（码本体）／`name`（名）／`quota`（额度）。
 *   ・`key`：API 建码路径由 new-api 生成（32 hex，我方拿不到控制权）；
 *     直写库路径（见记忆 new-api-redemption-code-create-recipe）由我方生成，但两种路径
 *     的 key 都是**不透明随机串**，塞标记＝改码格式（脆弱、且对用户可见）。
 *   ・`name`：**两条路径都由我方写入**（mPay 走 `MP<orderId>`；人工码走 `eimu1500` 这种名），
 *     且可由 `/api/redemption/` 只读列出（gateway-admin.listGatewayRedemptions）。
 * 结论：SKU 标记放 **name**（`SUB-<sku>@<ref>`），码本体一字不动。故此路径不需映射表。
 * 若日后上游改成我方无法控制 name，fallback 方案＝码→SKU 映射表（见回报）。
 */
export const SUBSCRIPTION_CODE_NAME_PATTERN = /^SUB-([a-z0-9][a-z0-9-]{1,31})@([A-Za-z0-9._:-]{1,64})$/;

/** 产生订阅兑换码的 name（建码端唯一入口，避免各处自拼字串）。 */
export function subscriptionCodeName(sku: string, ref: string): string {
  return `${SUBSCRIPTION_CODE_NAME_PREFIX}${sku}${SUBSCRIPTION_CODE_NAME_SEPARATOR}${ref}`;
}

/**
 * 认出订阅码：只有**严格符合**标记格式才算订阅（不回退宽松匹配）。
 * 回 null ＝ 不是订阅码 ⇒ 走 E1a 的永久充值入帐（既有行为一字不变）。
 */
export function parseSubscriptionCodeMarker(name: string | null | undefined): SubscriptionCodeMarker | null {
  if (typeof name !== "string") return null;
  const matched = SUBSCRIPTION_CODE_NAME_PATTERN.exec(name.trim());
  if (!matched) return null;
  return { sku: matched[1], ref: matched[2] };
}

// ─────────────────────────────────────────────── 期次（时间窗与幂等键）

/** 期次序号从 1 起算（第 1 期＝开通那一期）。 */
export const SUBSCRIPTION_FIRST_TERM_INDEX = 1;

/** 期次在帐本上的身份：'sub:<订阅 id>:term:<期次序号>'。 */
export function subscriptionTermRef(subscriptionId: string, termIndex: number): string {
  return `sub:${subscriptionId}:term:${termIndex}`;
}

/** 从 term_ref 反解期次序号（帐本是唯一权威，期次一律由帐本行推导）。 */
export function termIndexFromRef(termRef: string | null | undefined): number | null {
  if (typeof termRef !== "string") return null;
  const matched = /^sub:.+:term:(\d+)$/.exec(termRef);
  if (!matched) return null;
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) && parsed >= SUBSCRIPTION_FIRST_TERM_INDEX ? parsed : null;
}

export function subscriptionIdFor(billingUserId: number, sku: string): string {
  return `sub-${billingUserId}-${sku}`;
}

/** 一期 = 连续的 [start, end)：本期到期时刻 = 发放时刻 + 期长。 */
export function subscriptionTermWindow(
  grantedAtMs: number,
  termSeconds: number,
): { startMs: number; endMs: number; expiresAt: string } {
  const seconds = Number.isFinite(termSeconds) && termSeconds > 0 ? Math.round(termSeconds) : SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS;
  const endMs = grantedAtMs + seconds * 1000;
  return { startMs: grantedAtMs, endMs, expiresAt: new Date(endMs).toISOString() };
}

// ─────────────────────────────────────────────── 池余额（lazy 过期判定点）

/** 池余额计算只需要帐本的这几个栏位（让纯函式不依赖 DB 行型别）。 */
export interface PoolLedgerRow {
  amount: number;
  pool?: LedgerPool | null;
  termRef?: string | null;
  expiresAt?: string | null;
}

export interface SubscriptionTermBalance {
  termRef: string;
  quota: number;
  /** 该期到期时刻（ISO）；null＝没有到期资讯的行（异常，见 undatedRows）。 */
  expiresAt: string | null;
  expired: boolean;
}

export interface PoolBalances {
  /** 永久池 Σ（充值、开帐基线、转移、永久池的消费与退款）。 */
  permanentQuota: number;
  /** 未过期订阅池 Σ（不变量 ① 的订阅池部分）。 */
  subscriptionQuota: number;
  /** 已过期订阅池 Σ（**不计入可用**，但如实回报——过期的钱看得见）。 */
  expiredSubscriptionQuota: number;
  /** 可用余额 = permanentQuota + subscriptionQuota（不变量 ①）。 */
  availableQuota: number;
  /** 帐面净额 Σ 全部（含已过期订阅池）——与 E1a 的 computeAccountBalance 同一口径。 */
  bookQuota: number;
  /** 各期余额（未过期的在前，按到期时刻升序＝先到期先扣）。 */
  terms: SubscriptionTermBalance[];
  /** 订阅池里没有到期时刻的行数（不该存在；出现＝写入端 bug，计入可用并回报）。 */
  undatedSubscriptionRows: number;
}

export function poolOf(row: Pick<PoolLedgerRow, "pool">): LedgerPool {
  return isLedgerPool(row.pool) ? row.pool : LEDGER_POOL_DEFAULT;
}

function expiresAtMs(row: PoolLedgerRow): number | null {
  if (typeof row.expiresAt !== "string" || !row.expiresAt.trim()) return null;
  const ms = Date.parse(row.expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * **lazy 过期判定**（不变量 ④）：以「当下时刻」把帐本行分成可用／已过期两堆。
 * 纯函式 ⇒ 同一份记录集＋同一个 nowMs 在任何进程、任何时刻都算出同一个答案；
 * 不需要任何定时任务先把余额改掉（cron 只可能是加速器，不可能是正确性前提）。
 *
 * 到期边界：`expires_at <= now` 即过期（到期那一刻起不可用）。
 * 缺到期时刻的订阅行：计入可用（不让缺栏位变成「静默没收用户的钱」）并回报行数。
 */
export function computePoolBalances(rows: PoolLedgerRow[], nowMs: number): PoolBalances {
  let permanentQuota = 0;
  let subscriptionQuota = 0;
  let expiredSubscriptionQuota = 0;
  let undatedSubscriptionRows = 0;
  const byTerm = new Map<string, SubscriptionTermBalance>();

  for (const row of rows) {
    const amount = Number.isFinite(row.amount) ? row.amount : 0;
    if (poolOf(row) !== "subscription") {
      permanentQuota += amount;
      continue;
    }
    const ms = expiresAtMs(row);
    if (ms === null) undatedSubscriptionRows += 1; // 具体归属在下面按 term 统计
    const expired = ms !== null && ms <= nowMs;
    if (expired) expiredSubscriptionQuota += amount;
    else subscriptionQuota += amount;

    const termRef = typeof row.termRef === "string" && row.termRef.trim() ? row.termRef : "(no-term)";
    const term = byTerm.get(termRef) ?? { termRef, quota: 0, expiresAt: row.expiresAt ?? null, expired };
    term.quota += amount;
    if (term.expiresAt === null && row.expiresAt) term.expiresAt = row.expiresAt;
    term.expired = expired;
    byTerm.set(termRef, term);
  }

  const terms = [...byTerm.values()].sort((a, b) => {
    const left = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
    const right = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
    return left - right || a.termRef.localeCompare(b.termRef);
  });

  return {
    permanentQuota,
    subscriptionQuota,
    expiredSubscriptionQuota,
    availableQuota: permanentQuota + subscriptionQuota,
    bookQuota: permanentQuota + subscriptionQuota + expiredSubscriptionQuota,
    terms,
    undatedSubscriptionRows,
  };
}

/** 可用余额的单一读法（给 /v1/quota 与预检共用，不许各自再算一份）。 */
export function availableQuotaOf(rows: PoolLedgerRow[], nowMs: number): number {
  return computePoolBalances(rows, nowMs).availableQuota;
}

// ─────────────────────────────────────────────── 出资腿（扣款先扣谁、退款回谁）

export interface PoolLeg {
  pool: LedgerPool;
  termRef: string | null;
  expiresAt: string | null;
  /** 正数＝该腿的金额（quota）。 */
  amountQuota: number;
}

/**
 * 把一笔消费拆成出资腿（不变量 ①＋② 的源头）：按 CONSUMPTION_POOL_ORDER 逐池取钱，
 * 订阅池内按「先到期先扣」。**不截断**：可用不足时，剩下的全记在最后一个池（永久池）
 * ——帐本必须如实记下真实发生的事（余额可为负），不足与否是预检/402 的职责，不是帐本的。
 */
export function planConsumptionLegs(amountQuota: number, balances: PoolBalances): PoolLeg[] {
  const amount = Math.abs(Math.round(amountQuota));
  if (!Number.isFinite(amount) || amount === 0) return [];
  const legs: PoolLeg[] = [];
  let remaining = amount;

  for (const pool of CONSUMPTION_POOL_ORDER) {
    if (remaining <= 0) break;
    if (pool === "subscription") {
      for (const term of balances.terms) {
        if (remaining <= 0) break;
        if (term.expired) continue;
        if (!(term.quota > 0)) continue;
        const take = Math.min(remaining, term.quota);
        legs.push({ pool, termRef: term.termRef === "(no-term)" ? null : term.termRef, expiresAt: term.expiresAt, amountQuota: take });
        remaining -= take;
      }
      // 无到期资讯的订阅行（异常）：不指定期次，只记池——不让它变成扣款黑洞。
      if (remaining > 0 && balances.undatedSubscriptionRows > 0) break;
      continue;
    }
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, balances.permanentQuota));
    if (take > 0) {
      legs.push({ pool, termRef: null, expiresAt: null, amountQuota: take });
      remaining -= take;
    }
  }

  if (remaining > 0) {
    // 可用不足：超出部分记在最后一个池（预设＝永久池）。余额可为负是真实状态。
    const lastPool = CONSUMPTION_POOL_ORDER[CONSUMPTION_POOL_ORDER.length - 1] ?? LEDGER_POOL_DEFAULT;
    const tail = legs.find((leg) => leg.pool === lastPool && leg.termRef === null);
    if (tail) tail.amountQuota += remaining;
    else legs.push({ pool: lastPool, termRef: null, expiresAt: null, amountQuota: remaining });
  }
  return legs;
}

/** 已入帐的消费腿（退款分摊的输入）。 */
export interface ConsumedPoolLeg {
  pool: LedgerPool;
  termRef?: string | null;
  expiresAt?: string | null;
  /** 该腿消耗掉的量（正数）。 */
  consumedQuota: number;
}

/**
 * 退款分摊（不变量 ② 按原出资归还）：把退款额按 REFUND_ALLOCATION_ORDER 摊回各出资腿，
 * **不跨池**——订阅消耗退订阅池、永久消耗退永久池；多腿时一腿一笔帐。
 *
 * 退回已过期期的处理见 SUBSCRIPTION_REFUND_EXPIRED_TO_ORIGINAL_TERM
 * （预设 true：原期原到期时刻，该笔退款同样不可用——不假装它还有价值）。
 */
export function planRefundLegs(
  refundQuota: number,
  consumed: ConsumedPoolLeg[],
  opts: { nowMs?: number; currentTerm?: { termRef: string; expiresAt: string } } = {},
): PoolLeg[] {
  const amount = Math.abs(Math.round(refundQuota));
  if (!Number.isFinite(amount) || amount === 0 || consumed.length === 0) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const ordered = REFUND_ALLOCATION_ORDER === "lifo" ? [...consumed].reverse() : [...consumed];
  const legs: PoolLeg[] = [];
  let remaining = amount;

  for (const leg of ordered) {
    if (remaining <= 0) break;
    const available = Math.max(0, Math.round(leg.consumedQuota));
    if (available === 0) continue;
    const take = Math.min(remaining, available);
    remaining -= take;
    legs.push(refundLegFor(leg, take, nowMs, opts.currentTerm));
  }

  if (remaining > 0) {
    // 退款额大于已记录的消耗（不该发生；上游补偿/人工退款会走到这里）：
    // 记在最后一条出资腿的池——仍然不跨池搬；同池同期就并进该腿（不多开一条帐本行）。
    const last = ordered[ordered.length - 1];
    const extra = refundLegFor(last, remaining, nowMs, opts.currentTerm);
    const sameLeg = legs.find(
      (leg) => leg.pool === extra.pool && leg.termRef === extra.termRef && leg.expiresAt === extra.expiresAt,
    );
    if (sameLeg) sameLeg.amountQuota += extra.amountQuota;
    else legs.push(extra);
  }
  return legs;
}

function refundLegFor(
  leg: ConsumedPoolLeg,
  amountQuota: number,
  nowMs: number,
  currentTerm?: { termRef: string; expiresAt: string },
): PoolLeg {
  const pool = isLedgerPool(leg.pool) ? leg.pool : LEDGER_POOL_DEFAULT;
  const termRef = leg.termRef ?? null;
  const expiresAt = leg.expiresAt ?? null;
  if (pool !== "subscription") return { pool, termRef: null, expiresAt: null, amountQuota };
  const expired = expiresAt !== null && Date.parse(expiresAt) <= nowMs;
  if (expired && !SUBSCRIPTION_REFUND_EXPIRED_TO_ORIGINAL_TERM && currentTerm) {
    return { pool, termRef: currentTerm.termRef, expiresAt: currentTerm.expiresAt, amountQuota };
  }
  return { pool, termRef, expiresAt, amountQuota };
}

// ─────────────────────────────────────────────── 续期替换（不变量 ③）

/**
 * 续期时该作废多少旧期余额（不变量 ③「下一期替换而非累加」）。
 * 回 0 ＝ 无需作废（累积语义、旧期已清零、或没有旧期）。
 */
export function replacedQuotaForRenewal(
  previousTermQuota: number,
  mode: "replace" | "accumulate" = SUBSCRIPTION_RENEWAL_MODE,
): number {
  if (mode !== "replace") return 0;
  const remaining = Math.round(previousTermQuota);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

export function renewalModeOf(): "replace" | "accumulate" {
  return SUBSCRIPTION_RENEWAL_MODE;
}
