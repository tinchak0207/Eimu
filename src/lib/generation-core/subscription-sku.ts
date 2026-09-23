// REQ-D3 訂閱 SKU：**純函式層**（無 I/O、無 DB、無上游呼叫）。
//
// 本檔是「池 / 期次 / 過期 / 出資歸還」四件事的單一權威。寫入器在 subscription.ts，
// 帳本 schema 在 account-ledger.ts，本檔只做算術與判定，故可在任何地方被獨立斷言。
//
// 借來的機制不變量（waoowaoo BA-15/16，機制借用、代碼禁抄）：
//   ① 雙池：永久池（充值／開帳基線）與訂閱池（期末過期）分離；
//      可用餘額 = 永久池 + 未過期訂閱池。
//   ② 按原出資歸還：退款回它原本的池，不跨池搬。
//   ③ (訂閱 id, 期次序號) 發放冪等；下一期替換而非累加（預設，見 RENEWAL_MODE）。
//   ④ 過期只在讀取時 lazy 判定——本檔的 computePoolBalances(entries, nowMs) 就是那個
//      判定點：不改寫任何歷史、不依賴定時任務，任何時刻任何進程算出的答案都一樣。
//
// ─────────────────────────────────────────────── 參數化旋鈕（暴君一句話可翻轉）
// 全檔所有「暫用預設」都集中在下面這個區塊：改常數值即可翻轉語義，不動其他代碼。
// 回報中列出的翻轉點＝本區塊的行號。

/** 帳本池：'permanent' 永久池（充值／開帳基線）｜'subscription' 訂閱池（期末過期）。 */
export const LEDGER_POOLS = ["permanent", "subscription"] as const;
export type LedgerPool = (typeof LEDGER_POOLS)[number];

/** 默認池（沒有標 pool 的帳本行一律視為永久池——020 既有列與所有舊呼叫端的語義）。 */
export const LEDGER_POOL_DEFAULT: LedgerPool = "permanent";

export function isLedgerPool(value: unknown): value is LedgerPool {
  return typeof value === "string" && (LEDGER_POOLS as readonly string[]).includes(value);
}

/**
 * 【預設 1】續期語義。
 *   'replace'    到期未用完＝按期替換：新期額度取代舊期餘額，不累積（**當前預設**）
 *   'accumulate' 累積：新期額度＋舊期未用完餘額，舊期餘額仍按舊期到期時刻失效
 * 只影響「續期發放時是否要把舊期未用完餘額作廢（expire 帳本行）」。
 * 反向只需把本常數改成 "accumulate"，其餘零改動。
 */
export const SUBSCRIPTION_RENEWAL_MODE: "replace" | "accumulate" = "replace";

/**
 * 【預設 2】訂閱的兌現通道。
 *   'redemption' 沿用兌換碼通道：訂閱＝一張帶 SKU 標記的兌換碼，用戶在 new-api 端兌換，
 *                我方由「上游兌換記錄」回讀入帳（與 E1a 充值入帳同一條可觀測真相）（**當前預設**）
 *   'direct'     直落通道（未實作）：我方直接寫庫入帳，不經兌換碼
 * 這不是「要不要有訂閱」，而是「兌現事實從哪裡讀回來」。切 'direct' 需另派一刀。
 */
export const SUBSCRIPTION_FULFILLMENT_CHANNEL: "redemption" | "direct" = "redemption";

/**
 * 扣費時的扣款池次序（先扣哪個池）。
 * 預設先扣訂閱池再扣永久池：訂閱餘額會過期，永久餘額不會——先用會過期的錢。
 */
export const CONSUMPTION_POOL_ORDER: LedgerPool[] = ["subscription", "permanent"];

/**
 * 退款在多條出資腿之間的分攤次序。
 *   'lifo' 先退最後出資的那條腿（**當前預設**）｜'fifo' 按出資次序退
 */
export const REFUND_ALLOCATION_ORDER: "lifo" | "fifo" = "lifo";

/**
 * 退款回到「已過期」的原訂閱期時怎麼辦。
 *   true  照 ② 按原出資歸還：回原期（原到期時刻）——該期已過期 ⇒ 這筆退款同樣不可用（**當前預設**）
 *   false 改掛當前未過期期（無當前期則仍回原期）
 * true 是「不跨池、不搬期」的忠實實作；false 對用戶更寬，但語義上已不是「按原出資歸還」。
 */
export const SUBSCRIPTION_REFUND_EXPIRED_TO_ORIGINAL_TERM = true;

/** 兌換碼 name 的訂閱標記前綴與分隔符（name 是我方在建碼時自己寫進去的那個欄位）。 */
export const SUBSCRIPTION_CODE_NAME_PREFIX = "SUB-";
export const SUBSCRIPTION_CODE_NAME_SEPARATOR = "@";

/**
 * SKU 註冊表：只定義**期長**與顯示名。每期額度不在此表——額度由用戶實際購買的兌換碼
 * 金額決定（不讓代碼發明定價；定價權威在 pricing/兌換碼本身）。
 */
export const SUBSCRIPTION_SKUS: Record<string, { label: string; termSeconds: number }> = {
  "pro-monthly": { label: "专业月费", termSeconds: 30 * 24 * 60 * 60 },
  "pro-yearly": { label: "专业年费", termSeconds: 365 * 24 * 60 * 60 },
};

/**
 * 標記認得、但 SKU 不在註冊表時的兜底期長（30 天）。
 * 為什麼要兜底而不是失敗：**充值必兌現**（暴君 09-20 鐵律）——碼是真的、錢是真的，
 * 認不出 SKU 只該影響「期長取默認＋留審計訊息」，不該讓用戶拿不到額度。
 */
export const SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS = 30 * 24 * 60 * 60;

export function subscriptionSkuTermSeconds(sku: string): number {
  const known = SUBSCRIPTION_SKUS[sku]?.termSeconds;
  return Number.isFinite(known) && (known as number) > 0 ? (known as number) : SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS;
}

export function isKnownSubscriptionSku(sku: string): boolean {
  return Boolean(SUBSCRIPTION_SKUS[sku]);
}

// ─────────────────────────────────────────────── 兌換碼標記（SKU 載體）

export interface SubscriptionCodeMarker {
  /** SKU 識別。 */
  sku: string;
  /** 我方自己的業務參照（訂單號等），只作審計。 */
  ref: string;
}

/**
 * 現場事實（決定「SKU 標記放哪裡」）：
 *   new-api 兌換碼有三個欄位：`key`（碼本體）／`name`（名）／`quota`（額度）。
 *   ・`key`：API 建碼路徑由 new-api 生成（32 hex，我方拿不到控制權）；
 *     直寫庫路徑（見記憶 new-api-redemption-code-create-recipe）由我方生成，但兩種路徑
 *     的 key 都是**不透明隨機串**，塞標記＝改碼格式（脆弱、且對用戶可見）。
 *   ・`name`：**兩條路徑都由我方寫入**（mPay 走 `MP<orderId>`；人工碼走 `eimu1500` 這種名），
 *     且可由 `/api/redemption/` 只讀列出（gateway-admin.listGatewayRedemptions）。
 * 結論：SKU 標記放 **name**（`SUB-<sku>@<ref>`），碼本體一字不動。故此路徑不需映射表。
 * 若日後上游改成我方無法控制 name，fallback 方案＝碼→SKU 映射表（見回報）。
 */
export const SUBSCRIPTION_CODE_NAME_PATTERN = /^SUB-([a-z0-9][a-z0-9-]{1,31})@([A-Za-z0-9._:-]{1,64})$/;

/** 產生訂閱兌換碼的 name（建碼端唯一入口，避免各處自拼字串）。 */
export function subscriptionCodeName(sku: string, ref: string): string {
  return `${SUBSCRIPTION_CODE_NAME_PREFIX}${sku}${SUBSCRIPTION_CODE_NAME_SEPARATOR}${ref}`;
}

/**
 * 認出訂閱碼：只有**嚴格符合**標記格式才算訂閱（不回退寬鬆匹配）。
 * 回 null ＝ 不是訂閱碼 ⇒ 走 E1a 的永久充值入帳（既有行為一字不變）。
 */
export function parseSubscriptionCodeMarker(name: string | null | undefined): SubscriptionCodeMarker | null {
  if (typeof name !== "string") return null;
  const matched = SUBSCRIPTION_CODE_NAME_PATTERN.exec(name.trim());
  if (!matched) return null;
  return { sku: matched[1], ref: matched[2] };
}

// ─────────────────────────────────────────────── 期次（時間窗與冪等鍵）

/** 期次序號從 1 起算（第 1 期＝開通那一期）。 */
export const SUBSCRIPTION_FIRST_TERM_INDEX = 1;

/** 期次在帳本上的身份：'sub:<訂閱 id>:term:<期次序號>'。 */
export function subscriptionTermRef(subscriptionId: string, termIndex: number): string {
  return `sub:${subscriptionId}:term:${termIndex}`;
}

/** 從 term_ref 反解期次序號（帳本是唯一權威，期次一律由帳本行推導）。 */
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

/** 一期 = 連續的 [start, end)：本期到期時刻 = 發放時刻 + 期長。 */
export function subscriptionTermWindow(
  grantedAtMs: number,
  termSeconds: number,
): { startMs: number; endMs: number; expiresAt: string } {
  const seconds = Number.isFinite(termSeconds) && termSeconds > 0 ? Math.round(termSeconds) : SUBSCRIPTION_UNKNOWN_SKU_TERM_SECONDS;
  const endMs = grantedAtMs + seconds * 1000;
  return { startMs: grantedAtMs, endMs, expiresAt: new Date(endMs).toISOString() };
}

// ─────────────────────────────────────────────── 池餘額（lazy 過期判定點）

/** 池餘額計算只需要帳本的這幾個欄位（讓純函式不依賴 DB 行型別）。 */
export interface PoolLedgerRow {
  amount: number;
  pool?: LedgerPool | null;
  termRef?: string | null;
  expiresAt?: string | null;
}

export interface SubscriptionTermBalance {
  termRef: string;
  quota: number;
  /** 該期到期時刻（ISO）；null＝沒有到期資訊的行（異常，見 undatedRows）。 */
  expiresAt: string | null;
  expired: boolean;
}

export interface PoolBalances {
  /** 永久池 Σ（充值、開帳基線、轉移、永久池的消費與退款）。 */
  permanentQuota: number;
  /** 未過期訂閱池 Σ（不變量 ① 的訂閱池部分）。 */
  subscriptionQuota: number;
  /** 已過期訂閱池 Σ（**不計入可用**，但如實回報——過期的錢看得見）。 */
  expiredSubscriptionQuota: number;
  /** 可用餘額 = permanentQuota + subscriptionQuota（不變量 ①）。 */
  availableQuota: number;
  /** 帳面淨額 Σ 全部（含已過期訂閱池）——與 E1a 的 computeAccountBalance 同一口徑。 */
  bookQuota: number;
  /** 各期餘額（未過期的在前，按到期時刻升序＝先到期先扣）。 */
  terms: SubscriptionTermBalance[];
  /** 訂閱池裡沒有到期時刻的行數（不該存在；出現＝寫入端 bug，計入可用並回報）。 */
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
 * **lazy 過期判定**（不變量 ④）：以「當下時刻」把帳本行分成可用／已過期兩堆。
 * 純函式 ⇒ 同一份記錄集＋同一個 nowMs 在任何進程、任何時刻都算出同一個答案；
 * 不需要任何定時任務先把餘額改掉（cron 只可能是加速器，不可能是正確性前提）。
 *
 * 到期邊界：`expires_at <= now` 即過期（到期那一刻起不可用）。
 * 缺到期時刻的訂閱行：計入可用（不讓缺欄位變成「靜默沒收用戶的錢」）並回報行數。
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
    if (ms === null) undatedSubscriptionRows += 1; // 具體歸屬在下面按 term 統計
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

/** 可用餘額的單一讀法（給 /v1/quota 與預檢共用，不許各自再算一份）。 */
export function availableQuotaOf(rows: PoolLedgerRow[], nowMs: number): number {
  return computePoolBalances(rows, nowMs).availableQuota;
}

// ─────────────────────────────────────────────── 出資腿（扣款先扣誰、退款回誰）

export interface PoolLeg {
  pool: LedgerPool;
  termRef: string | null;
  expiresAt: string | null;
  /** 正數＝該腿的金額（quota）。 */
  amountQuota: number;
}

/**
 * 把一筆消費拆成出資腿（不變量 ①＋② 的源頭）：按 CONSUMPTION_POOL_ORDER 逐池取錢，
 * 訂閱池內按「先到期先扣」。**不截斷**：可用不足時，剩下的全記在最後一個池（永久池）
 * ——帳本必須如實記下真實發生的事（餘額可為負），不足與否是預檢/402 的職責，不是帳本的。
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
      // 無到期資訊的訂閱行（異常）：不指定期次，只記池——不讓它變成扣款黑洞。
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
    // 可用不足：超出部分記在最後一個池（預設＝永久池）。餘額可為負是真實狀態。
    const lastPool = CONSUMPTION_POOL_ORDER[CONSUMPTION_POOL_ORDER.length - 1] ?? LEDGER_POOL_DEFAULT;
    const tail = legs.find((leg) => leg.pool === lastPool && leg.termRef === null);
    if (tail) tail.amountQuota += remaining;
    else legs.push({ pool: lastPool, termRef: null, expiresAt: null, amountQuota: remaining });
  }
  return legs;
}

/** 已入帳的消費腿（退款分攤的輸入）。 */
export interface ConsumedPoolLeg {
  pool: LedgerPool;
  termRef?: string | null;
  expiresAt?: string | null;
  /** 該腿消耗掉的量（正數）。 */
  consumedQuota: number;
}

/**
 * 退款分攤（不變量 ② 按原出資歸還）：把退款額按 REFUND_ALLOCATION_ORDER 攤回各出資腿，
 * **不跨池**——訂閱消耗退訂閱池、永久消耗退永久池；多腿時一腿一筆帳。
 *
 * 退回已過期期的處理見 SUBSCRIPTION_REFUND_EXPIRED_TO_ORIGINAL_TERM
 * （預設 true：原期原到期時刻，該筆退款同樣不可用——不假裝它還有價值）。
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
    // 退款額大於已記錄的消耗（不該發生；上游補償/人工退款會走到這裡）：
    // 記在最後一條出資腿的池——仍然不跨池搬；同池同期就併進該腿（不多開一條帳本行）。
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

// ─────────────────────────────────────────────── 續期替換（不變量 ③）

/**
 * 續期時該作廢多少舊期餘額（不變量 ③「下一期替換而非累加」）。
 * 回 0 ＝ 無需作廢（累積語義、舊期已清零、或沒有舊期）。
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
