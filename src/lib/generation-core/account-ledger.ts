// REQ-E1a 我方帳本（餘額權威）——「客戶可見餘額的權威歸我方帳本」（暴君 2026-09-23 裁定）。
//
// 為什麼要有本檔：waoowaoo BA-07「賬本唯一 writer」。new-api 內核在 relay 前扣
// `users.quota`，與我方帳本構成雙寫（B1 真轉移更讓兩層同時變動）；只要對外餘額直接
// 讀 new-api，我方就永遠說不清「這個數字是怎麼來的」。本檔把對外餘額的計算源搬回
// 我方帳本：`account_ledger` 是 append-only 的有號流水，餘額 = Σ amount（單一公式，
// 見 computeAccountBalance）。new-api 的 users.quota 降格為「上游供貨水位」與內核
// 執法點，只作對帳另一側（見 account-reconciliation.ts）。
//
// 加項 / 減項（完整判別表，權威在本檔）：
//   + opening      上線基線（以 new-api 當時 users.quota 種入，可為負）
//   + recharge     充值入帳（new-api 兌換碼被使用）
//   + refund       任務退款
//   + transfer_in  B1 成員收到分配
//   ± adjustment   管理員加減額度（建戶初始額度／人工補正）
//   − consumption  消費扣費（legacy reserve 的上游扣款、gate path 投影扣款）
//   − transfer_out B1 主帳劃出給成員
//   不入帳：writeoff（平台自身損失，不影響用戶 users.quota）。
//
// REQ-D3（訂閱 SKU）在原模型上加**一個維度**（不新造第二條帳務通道）：每一列可標
//   pool        'permanent'（默認）｜'subscription'
//   term_ref    'sub:<訂閱 id>:term:<期次序號>'（永久池 NULL）
//   expires_at  該期到期時刻（訂閱池必填）
// 兩個餘額口徑（單一權威在本檔 + subscription-sku.ts）：
//   book(user)      = Σ amount                                    ← 帳面淨額（對帳用，不變）
//   available(user) = 永久池 Σ + **未過期**訂閱池 Σ（讀取時 lazy 判定，不依賴 cron）
// 加減項新增一種：
//   − expire       訂閱續期替換：舊期未用完餘額在寫入時作廢（見 subscription.ts）
//
// 四條紀律：
//   1. append-only：只 INSERT。錯帳靠再 INSERT 一筆反向 adjustment 更正，不改歷史
//      （本檔沒有任何 UPDATE/DELETE account_ledger 的語句，測試具名守門）。
//   2. 冪等：每筆帳帶 `idempotency_ref`（UNIQUE）。寫入端重放同一件事 = 命中
//      ON CONFLICT DO NOTHING，不雙算。
//   2b. 順序鐵律：**先 ensureAccountBaselines() 種基線，再動上游，最後記增量**。
//      顛倒順序 = 基線已含該筆增量 + 帳本再記一次 = 雙算（見 ensureAccountBaselines 註釋）。
//   3. 不擋錢路：記帳失敗只 console.error + 回傳 false，永不讓計費/上游調整路徑失敗。
//      差額由 E1b 的對帳報告如實指出（可解釋優先於假裝同步成功）。
//      唯一例外（E1-b D-2）：**基線不成立時不得動上游**——沒有基線的上游變動無法歸屬，
//      lazy 種子之後會把它算進基線 ⇒ 同一筆增量算兩次、差額永久存在。故此種情況回
//      blocked=true，由呼叫端在動上游之前就停手（見 ensureAccountBaselinesWithStatus）。
//   4. 方向由 entry_type 決定（signed 類型只有 opening/adjustment），簽名不符的行
//      一律拒收——寧可不記，不記錯方向的帳。

import { randomUUID } from "node:crypto";

import { fetchGatewayUser, listGatewayRedemptions, type GatewayAdminUser, type GatewayRedemption } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { quotaToCoins } from "./statistics-projection";
import {
  LEDGER_POOL_DEFAULT,
  computePoolBalances,
  isLedgerPool,
  parseSubscriptionCodeMarker,
  planConsumptionLegs,
  planRefundLegs,
  poolOf,
  subscriptionTermRef,
  type ConsumedPoolLeg,
  type LedgerPool,
  type PoolBalances,
} from "./subscription-sku";

export type LedgerEntryType =
  | "opening"
  | "recharge"
  | "consumption"
  | "refund"
  | "transfer_out"
  | "transfer_in"
  | "adjustment"
  // REQ-D3：訂閱續期的「下一期替換而非累加」——把舊期未用完餘額在**寫入時**作廢。
  // 與 lazy 過期（讀取時判定）是兩件事：時間到＝不落帳；續費替換＝真的有一筆事件。
  | "expire";

export type { LedgerPool };

export type LedgerDirection = "credit" | "debit";

/**
 * 每個 entry_type 的法定方向。`signed` = 加減皆可（基線可為負；人工調整兩個方向
 * 都是合法更正）。這張表是「餘額模型」的單一權威，不得在別處另立第二份判別。
 */
export const LEDGER_ENTRY_DIRECTION: Record<LedgerEntryType, LedgerDirection | "signed"> = {
  opening: "signed",
  recharge: "credit",
  consumption: "debit",
  refund: "credit",
  transfer_in: "credit",
  transfer_out: "debit",
  adjustment: "signed",
  expire: "debit",
};

/** 會計恆等式用的方向分類：opening/adjustment 按實際符號判。 */
export function ledgerDirectionOf(entryType: LedgerEntryType, amount: number): LedgerDirection {
  const fixed = LEDGER_ENTRY_DIRECTION[entryType];
  if (fixed === "credit") return "credit";
  if (fixed === "debit") return "debit";
  return amount >= 0 ? "credit" : "debit";
}

export interface LedgerEntryDraft {
  billingUserId: number;
  entryType: LedgerEntryType;
  /** 有號金額（quota 單位）：正 = 加項，負 = 減項。 */
  amount: number;
  /** 寫入者（'billing-projection' / 'member-quota' / 'seed' / …）。 */
  source: string;
  /** 外部事實位址（'job:<id>' / 'billing-op:<id>' / 'redemption:<id>' …）。 */
  sourceRef: string;
  /** 一次性判重鍵。 */
  idempotencyRef: string;
  /** 池維度（REQ-D3）：未指定 = 永久池（020 既有列與所有舊呼叫端語義不變）。 */
  pool?: LedgerPool;
  /** 訂閱期次身份（永久池為 null/省略）；訂閱池必填。 */
  termRef?: string | null;
  /** 該期到期時刻 ISO（永久池為 null/省略）；訂閱池必填。 */
  expiresAt?: string | null;
  jobId?: string | null;
  operationId?: string | null;
  counterpartyUserId?: number | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  billingUserId: number;
  entryType: LedgerEntryType;
  amount: number;
  source: string;
  sourceRef: string;
  idempotencyRef: string;
  /**
   * 池維度（可選：020 期間落地的列與測試自建的記錄集沒有這一欄，一律按永久池讀）。
   * 判定一律走 subscription-sku 的 poolOf()，別處不得自己 `?? "permanent"`。
   */
  pool?: LedgerPool | null;
  termRef?: string | null;
  expiresAt?: string | null;
  jobId: string | null;
  operationId: string | null;
  counterpartyUserId: number | null;
  note: string | null;
  createdAt: string;
}

export interface PostLedgerResult {
  /** 真正落地的 idempotency_ref。 */
  inserted: string[];
  /** 已存在（重放/併發）而被 ON CONFLICT 跳過的。 */
  duplicates: string[];
  /** 本地契約檢查拒收（方向不符、缺來源、金額非整數等）——記帳端 bug，必須可見。 */
  rejected: { idempotencyRef: string; reason: string }[];
  /** SQL/連線層失敗（記帳端不擋錢路，只回報）。 */
  errors: string[];
}

export interface AccountBalance {
  billingUserId: number;
  /** Σ amount（quota 單位，可為負）。 */
  quota: number;
  coins: number;
  credits: number;
  debits: number;
  entryCount: number;
  /** 各類型加總（未出現的類型不列出——沒帳就是沒帳）。 */
  byType: Partial<Record<LedgerEntryType, { quota: number; entries: number }>>;
}

// ─────────────────────────────────────────── 純函式：契約檢查與餘額

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * 帳本行契約（純函式，可單獨測）：方向、來源、冪等鍵、金額。
 * 回 null = 可入帳；回字串 = 拒收原因。
 *
 * 金額 0 的唯一例外是 `opening`：0 基線是一句真話（「此刻這個身份沒有可入帳的歷史
 * 淨額」），且它定下「哪一刻之後的充值才該入帳」的時間界線。其餘類型 0 一律拒收。
 */
export function validateLedgerEntryDraft(draft: LedgerEntryDraft): string | null {
  if (!isFiniteInteger(draft.billingUserId) || draft.billingUserId <= 0) {
    return `billing_user_id 必須是正整數（收到 ${String(draft.billingUserId)}）`;
  }
  if (!isFiniteInteger(draft.amount)) {
    return `amount 必須是整數 quota（收到 ${String(draft.amount)}）`;
  }
  if (draft.amount === 0 && draft.entryType !== "opening") {
    return `amount 0 只允許出現在 opening 基線（${draft.entryType} 的 0 是空帳）`;
  }
  const direction = LEDGER_ENTRY_DIRECTION[draft.entryType];
  if (direction === undefined) return `未知的 entry_type：${String(draft.entryType)}`;
  if (direction === "credit" && draft.amount < 0) {
    return `${draft.entryType} 是加項，不得為負（收到 ${draft.amount}）`;
  }
  if (direction === "debit" && draft.amount > 0) {
    return `${draft.entryType} 是減項，不得為正（收到 ${draft.amount}）`;
  }
  if (!draft.source.trim()) return "source 必填（哪個寫入器記的帳）";
  if (!draft.sourceRef.trim()) return "source_ref 必填（這筆帳指回哪一件外部事實）";
  if (!draft.idempotencyRef.trim()) return "idempotency_ref 必填（重放不得雙算）";
  // 池維度契約（REQ-D3）：池值必須合法；訂閱池的每一列必須帶期次與到期時刻——
  // 沒有這兩個欄位，讀取端就只能靠定時任務改餘額（違反「過期只在讀取時 lazy 判定」）。
  if (draft.pool !== undefined && !isLedgerPool(draft.pool)) {
    return `未知的 pool：${String(draft.pool)}`;
  }
  const pool = draft.pool ?? LEDGER_POOL_DEFAULT;
  if (pool === "subscription") {
    if (typeof draft.termRef !== "string" || !draft.termRef.trim()) {
      return "訂閱池的帳本行必須帶 term_ref（期次身份）";
    }
    if (typeof draft.expiresAt !== "string" || !Number.isFinite(Date.parse(draft.expiresAt))) {
      return `訂閱池的帳本行必須帶可解析的 expires_at（收到 ${String(draft.expiresAt)}）`;
    }
  }
  return null;
}

/**
 * 餘額公式（唯一口徑）：Σ amount。同一份帳本記錄集在任何地方只能算出一個數字。
 * 非有限值整行跳過並回報（跳過的筆數計進 skippedRows——不當 0 加、不靜默吞）。
 */
export function computeAccountBalance(
  entries: LedgerEntry[],
  billingUserId?: number,
): AccountBalance & { skippedRows: number } {
  const rows = billingUserId === undefined ? entries : entries.filter((entry) => entry.billingUserId === billingUserId);
  let quota = 0;
  let credits = 0;
  let debits = 0;
  let skippedRows = 0;
  const byType: AccountBalance["byType"] = {};
  for (const row of rows) {
    if (!Number.isFinite(row.amount)) {
      skippedRows += 1;
      continue;
    }
    quota += row.amount;
    if (ledgerDirectionOf(row.entryType, row.amount) === "credit") credits += row.amount;
    else debits += row.amount;
    const bucket = byType[row.entryType] ?? { quota: 0, entries: 0 };
    bucket.quota += row.amount;
    bucket.entries += 1;
    byType[row.entryType] = bucket;
  }
  return {
    billingUserId: billingUserId ?? Number.NaN,
    quota,
    coins: quotaToCoins(quota),
    credits,
    debits,
    entryCount: rows.length - skippedRows,
    byType,
    skippedRows,
  };
}

/**
 * 對外餘額讀取口的回應形體（`/v1/quota` 的契約）：與 2026-08-29 事故後定下的形狀
 * **逐字相同**（success / balance_coins / currency）——本刀改的是數字的來源，不是形狀。
 * 放在這裡是為了讓「契約」有一條可被真實斷言的路徑（路由只負責包 NextResponse）。
 * 幣值換算沿用 statistics-projection 的 quotaToCoins（同一條換算式，不另立第二份）。
 */
export const QUOTA_RESPONSE_CURRENCY = "coins";

export function quotaResponseBody(quota: number): { success: true; balance_coins: number; currency: string } {
  return { success: true, balance_coins: quotaToCoins(quota), currency: QUOTA_RESPONSE_CURRENCY };
}

// ─────────────────────────────────────────── 純函式：契約檢查（冪等鍵）

/** 寫入器用的冪等鍵約定（單一權威，別處不得自拼）。 */
export const ledgerRef = {
  opening: (userId: number) => `seed:${userId}:v1`,
  consumption: (operationId: string) => `billing-op:${operationId}:debit`,
  refund: (operationId: string) => `billing-op:${operationId}:credit`,
  /** 非首條出資腿/退款腿的冪等鍵（首條永遠用上面那兩個，維持既有帳本行的鍵不變）。 */
  consumptionLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:debit:${legIndex}`,
  refundLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:credit:${legIndex}`,
  transferOut: (transferId: string) => `transfer:${transferId}:out`,
  transferIn: (transferId: string) => `transfer:${transferId}:in`,
  recharge: (redemptionId: string | number) => `redemption:${String(redemptionId)}`,
  adjustment: (sourceRef: string) => `adjustment:${sourceRef}`,
  /** REQ-D3 期次發放冪等鍵：(訂閱 id, 期次序號)（不變量 ③）。 */
  subscriptionTerm: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}`,
  /** 續期替換（把上一期未用完餘額作廢）的冪等鍵。 */
  subscriptionReplace: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}:replace`,
} as const;

// ─────────────────────────────────────────── 寫入層

type Row = Record<string, unknown>;

function mapLedgerRow(row: Row): LedgerEntry {
  return {
    id: String(row.id),
    billingUserId: Number(row.billing_user_id),
    entryType: String(row.entry_type) as LedgerEntryType,
    amount: Number(row.amount),
    source: String(row.source),
    sourceRef: String(row.source_ref),
    idempotencyRef: String(row.idempotency_ref),
    pool: isLedgerPool(row.pool) ? row.pool : LEDGER_POOL_DEFAULT,
    termRef: row.term_ref === null || row.term_ref === undefined ? null : String(row.term_ref),
    expiresAt:
      row.expires_at === null || row.expires_at === undefined ? null : new Date(String(row.expires_at)).toISOString(),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    operationId: row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id),
    counterpartyUserId:
      row.counterparty_user_id === null || row.counterparty_user_id === undefined
        ? null
        : Number(row.counterparty_user_id),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/** 帳本儲存層可用嗎（C 端 Vercel 沒有控制面庫 ⇒ 走降級，不炸）。 */
export function accountLedgerStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return generationDatabaseConfigured(env);
}

function metadataJson(draft: LedgerEntryDraft): string {
  try {
    return JSON.stringify({
      ...(draft.metadata ?? {}),
      entry_type: draft.entryType,
      source_ref: draft.sourceRef,
      pool: draft.pool ?? LEDGER_POOL_DEFAULT,
      ...(draft.termRef ? { term_ref: draft.termRef } : {}),
      ...(draft.expiresAt ? { expires_at: draft.expiresAt } : {}),
    });
  } catch {
    return JSON.stringify({ entry_type: draft.entryType, source_ref: draft.sourceRef, unserializable: true });
  }
}

async function insertLedgerRow(sql: GenerationSql, id: string, draft: LedgerEntryDraft): Promise<Row[]> {
  return sql<Row[]>`
    INSERT INTO account_ledger (
      id, billing_user_id, entry_type, amount, source, source_ref, idempotency_ref,
      job_id, operation_id, counterparty_user_id, note, metadata_json,
      pool, term_ref, expires_at
    ) VALUES (
      ${id}, ${draft.billingUserId}, ${draft.entryType}, ${draft.amount}, ${draft.source},
      ${draft.sourceRef}, ${draft.idempotencyRef}, ${draft.jobId ?? null}, ${draft.operationId ?? null},
      ${draft.counterpartyUserId ?? null}, ${draft.note ?? null}, ${metadataJson(draft)}::jsonb,
      ${draft.pool ?? LEDGER_POOL_DEFAULT}, ${draft.termRef ?? null}, ${draft.expiresAt ?? null}
    )
    ON CONFLICT (idempotency_ref) DO NOTHING
    RETURNING id, idempotency_ref
  `;
}

/**
 * 記一批帳（append-only + 冪等）。多筆時包在一個事務裡——轉移的兩條腿要嘛都記、
 * 要嘛都不記（單腿落地 = 我方帳本自己製造不對稱）。
 *
 * 永不 throw：本地契約拒收與 SQL 失敗都只是回報值（記帳不擋錢路，第 3 條紀律）。
 */
export async function postLedgerEntries(
  drafts: LedgerEntryDraft[],
  deps: { sql?: GenerationSql; newId?: () => string } = {},
): Promise<PostLedgerResult> {
  const result: PostLedgerResult = { inserted: [], duplicates: [], rejected: [], errors: [] };
  const accepted: { id: string; draft: LedgerEntryDraft }[] = [];
  for (const draft of drafts) {
    const reason = validateLedgerEntryDraft(draft);
    if (reason) {
      result.rejected.push({ idempotencyRef: draft?.idempotencyRef ?? "(missing)", reason });
      console.error(`[account-ledger] 拒收帳本行 ref=${String(draft?.idempotencyRef)}：${reason}`);
      continue;
    }
    accepted.push({ id: (deps.newId ?? randomUUID)(), draft });
  }
  if (accepted.length === 0) return result;

  const sql = deps.sql ?? getGenerationSql();
  const write = async (handle: GenerationSql): Promise<void> => {
    for (const item of accepted) {
      const rows = await insertLedgerRow(handle, item.id, item.draft);
      if (rows[0]) result.inserted.push(item.draft.idempotencyRef);
      else result.duplicates.push(item.draft.idempotencyRef);
    }
  };

  try {
    if (accepted.length > 1 && typeof sql.begin === "function") {
      await sql.begin(async (tx) => {
        await write(tx as unknown as GenerationSql);
      });
    } else {
      await write(sql);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.errors.push(reason);
    console.error(`[account-ledger] 記帳失敗（不擋錢路，差額由對帳報告負責）：${reason}`);
  }
  return result;
}

// ─────────────────────────────────────────── 讀取層

export async function readAccountLedger(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<LedgerEntry[]> {
  const sql = deps.sql ?? getGenerationSql();
  const rows = await sql<Row[]>`
    SELECT id, billing_user_id, entry_type, amount, source, source_ref, idempotency_ref,
           job_id, operation_id, counterparty_user_id, note, created_at,
           pool, term_ref, expires_at
    FROM account_ledger
    WHERE billing_user_id = ${billingUserId}
    ORDER BY created_at, id
  `;
  return rows.map(mapLedgerRow);
}

/** 對外餘額的唯一讀法：取該身份帳本 → Σ amount。 */
export async function readAccountBalance(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<AccountBalance & { skippedRows: number }> {
  const entries = await readAccountLedger(billingUserId, deps);
  return computeAccountBalance(entries, billingUserId);
}

/**
 * 池餘額的唯一讀法（REQ-D3）：取該身份帳本 → 按池分堆 + **讀取時 lazy 判定過期**。
 * 純函式在 subscription-sku.ts（computePoolBalances），本函式只負責把帳本餵進去。
 */
export async function readPoolBalances(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<PoolBalances & { entries: LedgerEntry[] }> {
  const entries = await readAccountLedger(billingUserId, deps);
  const balances = computePoolBalances(entries, deps.nowMs ?? Date.now());
  return { ...balances, entries };
}

/**
 * **可用餘額**（不變量 ①）：永久池 + 未過期訂閱池。對外讀取口與配額預檢共用這一條。
 * 回 null ＝ 讀不出來（儲存層未配置／查詢失敗）——呼叫端據此走既有降級路徑，
 * 絕不讓「讀不到」被當成 0 或當成「足夠」。
 */
export async function readAvailableQuota(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<number | null> {
  try {
    const balances = await readPoolBalances(billingUserId, deps);
    return balances.availableQuota;
  } catch (error) {
    console.error(
      `[account-ledger] 可用餘額讀取失敗 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ─────────────────────────────────────────── 基線（種子）

/**
 * 基線不可得的類別（E1-b D-2）：決定呼叫端能不能安全地動上游。
 *
 *   store_unavailable    帳本儲存層未配置（C 端降級實例，沒有帳本權威）→ 呼叫端照舊走錢路
 *   upstream_unavailable 上游 users.quota 讀不到（基線不明）→ 帳本權威實例上不得動上游
 *   ledger_unavailable   基線行落不了地（INSERT 失敗／回讀不到基線行）→ 不得動上游
 */
export type OpeningFailureKind = "store_unavailable" | "upstream_unavailable" | "ledger_unavailable";

export interface OpeningSeedResult {
  billingUserId: number;
  /** true = 本次真的種進去（第一次）；false = 已有基線（重放幂等）或基線不可得。 */
  seeded: boolean;
  /**
   * 基線值（**經回讀確認**帳本裡真的有這一行的 amount）；不可得為 null。
   *
   * 為什麼只有回讀確認過的基線才回非 null（E1-b D-2 必修）：基線 INSERT 失敗時若仍回
   * 上游讀數，呼叫端會以為「基線就緒」→ 照常動上游並記增量，但帳本裡沒有基線行；
   * 之後 lazy 種子讀到**扣款後**的 users.quota 當基線 → 同一筆消費算兩次，差額永久存在。
   */
  baselineQuota: number | null;
  reason?: string;
  /** baselineQuota === null 時的分類；null = 基線已就位（回讀確認過）。 */
  failure?: OpeningFailureKind | null;
  /** 基線行是否經**回讀確認**存在（不是「函式回了非 null」）。 */
  verified?: boolean;
}

interface OpeningDeps {
  sql?: GenerationSql;
  fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
  now?: () => Date;
}

type OpeningRead =
  | { status: "found"; amount: number }
  | { status: "absent" }
  | { status: "error"; reason: string };

/**
 * 讀基線行（唯一判據：帳本裡真的有這一行）。查詢文本與寫入端同一條冪等鍵，
 * 成功／失敗／併發三條路徑共用 ⇒ 「基線就緒」永遠是回讀的結論，不是函式回傳值的推論。
 */
async function readOpeningRow(sql: GenerationSql, billingUserId: number): Promise<OpeningRead> {
  try {
    const rows = await sql<Row[]>`
      SELECT amount FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(billingUserId)} LIMIT 1
    `;
    if (!rows[0]) return { status: "absent" };
    const amount = Number(rows[0].amount);
    if (!Number.isFinite(amount)) return { status: "error", reason: `基線行金額非有限值（${String(rows[0].amount)}）` };
    return { status: "found", amount };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 種入/確認基線：**上線基線 = new-api 當時的 users.quota**（歷史淨額已含在裡面，
 * 故本表只記基線之後的增量，不得雙算既有歷史）。
 *
 * 幂等機制：idempotency_ref = `seed:<userId>:v1` 且 UNIQUE ⇒ 同一份 new-api 基線
 * 重放兩次，第二次命中 ON CONFLICT DO NOTHING（實測見測試「重放不雙算」）。
 *
 * 呼叫時機：對外餘額第一次被讀、或任何寫入器動手前（見 ensureOpeningBeforeWrite）。
 * 「先種基線、後記增量」是防雙算的關鍵：若先記了一筆扣費再種基線，基線已經含了
 * 那筆扣費 ⇒ 兩邊都算。
 */
export async function ensureAccountOpening(
  billingUserId: number,
  deps: OpeningDeps = {},
): Promise<OpeningSeedResult> {
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "帳本儲存層未配置",
      failure: "store_unavailable",
      verified: false,
    };
  }
  const sql = deps.sql ?? getGenerationSql();

  const existing = await readOpeningRow(sql, billingUserId);
  if (existing.status === "error") {
    // 讀不到（連線/語法/權限）：既不能說基線在、也不能說不在 ⇒ 回不可得（不得猜）。
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: `基線回讀失敗：${existing.reason}`,
      failure: "ledger_unavailable",
      verified: false,
    };
  }
  if (existing.status === "found") {
    return { billingUserId, seeded: false, baselineQuota: existing.amount, reason: "已有基線（重放）", failure: null, verified: true };
  }

  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  let user: GatewayAdminUser | null;
  try {
    user = await fetchUser(billingUserId);
  } catch (error) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: `基線讀取失敗：${error instanceof Error ? error.message : String(error)}`,
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!user || !Number.isFinite(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "new-api 未回該用戶額度（基線不明）",
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!Number.isInteger(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "上游額度非整數，基線不可信",
      failure: "upstream_unavailable",
      verified: false,
    };
  }

  // 0 基線也照樣入帳（amount=0 的 opening）：它不改變任何金額，但把「基線時刻」記下來，
  // 充值同步據此判斷「這筆充值是否已含在基線裡」。
  const posted = await postLedgerEntries(
    [
      {
        billingUserId,
        entryType: "opening",
        amount: Math.round(user.quota),
        source: "seed",
        sourceRef: `new-api:users/${billingUserId}@${(deps.now ?? (() => new Date()))().toISOString()}`,
        idempotencyRef: ledgerRef.opening(billingUserId),
        note: "上線基線：以 new-api users.quota 為起點，歷史淨額已含在此",
        metadata: { baseline_source: "new-api/users.quota" },
      },
    ],
    { sql },
  );

  // 唯一判據＝回讀：INSERT 回報成功但讀不到（或 INSERT 直接失敗）都算基線未落地，
  // 一律回 null（呼叫端據此 503／不動上游），**不得**回一個上游讀數當作「基線就緒」。
  const confirmed = await readOpeningRow(sql, billingUserId);
  if (confirmed.status !== "found") {
    const reason =
      confirmed.status === "error"
        ? `基線回讀失敗：${confirmed.reason}`
        : posted.errors[0] ?? posted.rejected[0]?.reason ?? "基線未落地（回讀不到基線行）";
    console.error(`[account-ledger] 基線未落地 user=${billingUserId}（${reason}）——不得當成基線就緒`);
    return { billingUserId, seeded: false, baselineQuota: null, reason, failure: "ledger_unavailable", verified: false };
  }
  if (posted.inserted.length > 0) {
    return { billingUserId, seeded: true, baselineQuota: confirmed.amount, failure: null, verified: true };
  }
  return {
    billingUserId,
    seeded: false,
    baselineQuota: confirmed.amount,
    reason: posted.duplicates.length > 0 ? "併發種入（另一寫入者已種）" : "基線已落地（回讀確認）",
    failure: null,
    verified: true,
  };
}

/** 批量種基線（上線遷移工具用）。逐個幂等 ⇒ 整批可任意重放。 */
export async function seedAccountOpenings(
  billingUserIds: number[],
  deps: OpeningDeps = {},
): Promise<{ seeded: number[]; skipped: OpeningSeedResult[] }> {
  const seeded: number[] = [];
  const skipped: OpeningSeedResult[] = [];
  for (const userId of [...new Set(billingUserIds.filter((id) => Number.isInteger(id) && id > 0))]) {
    const result = await ensureAccountOpening(userId, deps);
    if (result.seeded) seeded.push(userId);
    else skipped.push(result);
  }
  return { seeded, skipped };
}

/**
 * 基線保證（**必須在動上游之前呼叫**，這是防雙算的關鍵順序）：
 *
 *   先種基線 →[上游扣/加]→ 再記增量
 *
 * 為什麼順序不能顛倒：基線取的是「當下 new-api users.quota」，若先動了上游再種基線，
 * 那筆增量已經被算進基線裡，帳本再把同一件事記一次 = 雙算（本刀端到端測試實錘：
 * B1 分配若不先種基線，主帳帳本會憑空少 2,000,000）。反之「先種基線、後動上游」是
 * 安全的：多種的基線是無害的（餘額仍等於上游），而缺記的增量由 E1b 對帳報告負責。
 *
 * **基線就緒的判據＝回讀確認**（不是「函式回了非 null」）：見 ensureOpeningBeforeWrite。
 * 基線不可得 → 放棄記這次增量；帳本權威實例（儲存層已配置）上**連上游都不准動**，
 * 否則就留下一筆沒有基線歸屬的上游變動，之後 lazy 種子讀到變動後的 users.quota 當基線
 * ⇒ 同一筆增量算兩次、差額永久存在（E1-b D-2 實測）。
 */
export async function ensureAccountBaselines(
  billingUserIds: number[],
  deps: LedgerWriterDeps = {},
): Promise<boolean> {
  return (await ensureAccountBaselinesWithStatus(billingUserIds, deps)).ready;
}

/** 基線閘門的完整結論（呼叫端據 `blocked` 決定能不能動上游）。 */
export interface BaselineGuardResult {
  /** 全部身份的基線都經回讀確認存在。 */
  ready: boolean;
  /**
   * **不得動上游**：帳本儲存層已配置（有帳本權威）、但基線不成立——包括
   * ①基線行落不了地（ledger_unavailable）②上游 users.quota 讀不到（upstream_unavailable）。
   * 儲存層未配置的降級實例（C 端站點副本）回 false：那裡本來就沒有帳本權威，不改變既有行為。
   */
  blocked: boolean;
  /** 不可得的身份與分類（ready=false 時非空）。 */
  failures: { billingUserId: number; failure: OpeningFailureKind; reason: string }[];
}

export async function ensureAccountBaselinesWithStatus(
  billingUserIds: number[],
  deps: LedgerWriterDeps = {},
): Promise<BaselineGuardResult> {
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    return {
      ready: false,
      blocked: false,
      failures: billingUserIds.map((billingUserId) => ({
        billingUserId,
        failure: "store_unavailable" as const,
        reason: "帳本儲存層未配置",
      })),
    };
  }
  const sql = deps.sql ?? getGenerationSql();
  return ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser);
}

async function ensureOpeningBeforeWrite(
  billingUserIds: number[],
  sql: GenerationSql,
  fetchUser?: LedgerWriterDeps["fetchUser"],
): Promise<BaselineGuardResult> {
  // 帳本權威實例＝儲存層已配置。降級實例沒有帳本可記，擋上游只會弄壞可用性。
  const authoritative = accountLedgerStoreEnabled();
  for (const userId of [...new Set(billingUserIds)]) {
    const result = await ensureAccountOpening(userId, { sql, fetchUser });
    // 判據是「回讀確認過的基線行」，不是回傳值非 null（result.verified 由 readOpeningRow 定案）。
    if (result.baselineQuota !== null && result.verified !== false) continue;
    const failure: OpeningFailureKind = result.failure ?? "ledger_unavailable";
    const blocked = authoritative && failure !== "store_unavailable";
    console.error(
      `[account-ledger] 基線不可得 user=${userId}（${failure}：${result.reason}）——本次增量不記帳` +
        `${blocked ? "，且不得動上游（基線不成立＝上游變動無法歸屬）" : ""}`,
    );
    return { ready: false, blocked, failures: [{ billingUserId: userId, failure, reason: result.reason ?? "" }] };
  }
  return { ready: true, blocked: false, failures: [] };
}

// ─────────────────────────────────────────── 寫入器（各錢路徑呼叫）

export interface PendingWriteOutcome {
  posted: boolean;
  reason?: string;
}

/**
 * 寫入器共通依賴。`fetchUser` 是基線讀法的注入點（測試與 worker 用同一條生產通路：
 * 默認 fetchGatewayUser）。基線種不進去＝放棄記這次增量（見 ensureOpeningBeforeWrite）。
 */
export interface LedgerWriterDeps {
  sql?: GenerationSql;
  fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
}

async function withOpeningGuard(
  billingUserIds: number[],
  drafts: LedgerEntryDraft[],
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  if (!accountLedgerStoreEnabled() && !deps.sql) return { posted: false, reason: "帳本儲存層未配置" };
  const sql = deps.sql ?? getGenerationSql();
  try {
    if (!(await ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser))) {
      return { posted: false, reason: "基線不可得，放棄記帳（對帳報告負責）" };
    }
    const result = await postLedgerEntries(drafts, { sql });
    if (result.errors.length > 0) return { posted: false, reason: result.errors[0] };
    if (result.rejected.length > 0) return { posted: false, reason: result.rejected[0].reason };
    return { posted: result.inserted.length > 0, reason: result.duplicates.length > 0 ? "已記過（重放）" : undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[account-ledger] 帳本寫入異常（不擋錢路）：${reason}`);
    return { posted: false, reason };
  }
}

/** 消費扣費（legacy reserve 的上游扣款、gate path 投影扣款）。amount 取正數入帳為減項。
 *
 * REQ-D3：扣款**按池拆腿**（預設先扣訂閱池、再扣永久池，見 CONSUMPTION_POOL_ORDER）。
 * 沒有任何訂閱資料時，只有一條永久池腿、冪等鍵與 020 期間逐字相同（行為零變化）。
 * 讀帳本失敗＝回退單一永久池腿：記帳永不擋錢路，池歸屬的缺口由對帳報告指出。
 */
export async function recordConsumption(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 指定扣款池（省略＝按 CONSUMPTION_POOL_ORDER 自動選）。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金額為 0，無帳可記" };
  const legs = await resolveConsumptionLegs(input.billingUserId, amount, input.pool, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "consumption" as const,
      amount: -leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.consumption(input.operationId) : ledgerRef.consumptionLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/**
 * 訂閱池的「當前期」：未過期的期中最早到期的那一期（先到期先扣）。
 * 純讀帳本；拿不到就回 null（呼叫端據此不指定期次，不製造無效的訂閱帳本行）。
 */
async function resolveConsumptionLegs(
  billingUserId: number,
  amountQuota: number,
  forcedPool: LedgerPool | undefined,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const permanentOnly = [{ pool: LEDGER_POOL_DEFAULT, termRef: null, expiresAt: null, amountQuota }];
  if (!accountLedgerStoreEnabled() && !deps.sql) return permanentOnly;
  if (forcedPool === "permanent") return permanentOnly;
  try {
    const balances = computePoolBalances(await readAccountLedger(billingUserId, deps), Date.now());
    const planned = planConsumptionLegs(amountQuota, balances);
    const legs = forcedPool === "subscription" ? planned.filter((leg) => leg.pool === "subscription") : planned;
    if (legs.length === 0) return permanentOnly;
    return legs.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 池餘額讀取失敗，本次消費記在永久池 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return permanentOnly;
  }
}

/** 退款入帳（billing_operation refund applied 對應的上游 credit）。
 *
 * REQ-D3 **按原出資歸還**：退款回到原本出資的池——訂閱消耗退訂閱池、永久消耗退永久池，
 * 不跨池搬。出資腿的事實來自帳本本身的消費行（不是重算一遍計劃，避免兩處口徑漂移）。
 */
export async function recordRefund(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 帳本沒有該 operation 的消費行時（歷史資料）的兜底池。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金額為 0，無帳可記" };
  const legs = await resolveRefundLegs(input, amount, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "refund" as const,
      amount: leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.refund(input.operationId) : ledgerRef.refundLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

async function resolveRefundLegs(
  input: { billingUserId: number; operationId: string; pool?: LedgerPool },
  amountQuota: number,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const fallback = [
    {
      pool: input.pool ?? LEDGER_POOL_DEFAULT,
      termRef: null as string | null,
      expiresAt: null as string | null,
      amountQuota,
    },
  ];
  if (!accountLedgerStoreEnabled() && !deps.sql) return fallback;
  try {
    const entries = await readAccountLedger(input.billingUserId, deps);
    const consumed: ConsumedPoolLeg[] = entries
      .filter((entry) => entry.operationId === input.operationId && entry.entryType === "consumption" && entry.amount < 0)
      .map((entry) => ({
        pool: poolOf(entry),
        termRef: entry.termRef ?? null,
        expiresAt: entry.expiresAt ?? null,
        consumedQuota: Math.abs(entry.amount),
      }));
    if (consumed.length === 0) return fallback;
    const balances = computePoolBalances(entries, Date.now());
    const current = balances.terms.find((term) => !term.expired && term.expiresAt);
    const planned = planRefundLegs(amountQuota, consumed, {
      nowMs: Date.now(),
      ...(current && current.termRef !== "(no-term)" ? { currentTerm: { termRef: current.termRef, expiresAt: current.expiresAt as string } } : {}),
    });
    if (planned.length === 0) return fallback;
    return planned.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 出資腿讀取失敗，本次退款記在兜底池 user=${input.billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

/**
 * B1 分配/回收 = 真轉移：主帳 −Δ、成員 +Δ，**兩條腿同一個事務**記帳（單腿落地
 * = 我方帳本自己製造不對稱）。amountQuota 傳正數（劃出方向），回收時呼叫端傳負數
 * 由本函式翻向：正 = 主帳→成員，負 = 成員→主帳。
 */
export async function recordTransfer(
  input: {
    teamUserId: number;
    memberUserId: number;
    amountQuota: number;
    transferId: string;
    source: string;
    memberKeyId?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "轉移金額為 0，無帳可記" };
  const outgoing = amount > 0;
  const magnitude = Math.abs(amount);
  const from = outgoing ? input.teamUserId : input.memberUserId;
  const to = outgoing ? input.memberUserId : input.teamUserId;
  const metadata = { transfer_id: input.transferId, member_key_id: input.memberKeyId ?? null };
  return withOpeningGuard(
    [from, to],
    [
      {
        billingUserId: from,
        entryType: "transfer_out",
        amount: -magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferOut(input.transferId),
        counterpartyUserId: to,
        metadata,
      },
      {
        billingUserId: to,
        entryType: "transfer_in",
        amount: magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferIn(input.transferId),
        counterpartyUserId: from,
        metadata,
      },
    ],
    deps,
  );
}

/** 充值入帳（兌換碼被使用）。 */
export async function recordRecharge(
  input: {
    billingUserId: number;
    amountQuota: number;
    redemptionId: string | number;
    redemptionKey?: string;
    redeemedAt?: string | null;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "充值金額非正數" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "recharge",
        amount,
        source: "redemption-sync",
        sourceRef: `redemption:${String(input.redemptionId)}`,
        idempotencyRef: ledgerRef.recharge(input.redemptionId),
        note: "new-api 兌換碼已使用（充值入帳）",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null },
      },
    ],
    deps,
  );
}

/**
 * REQ-D3 期次切換（訂閱池入帳，**不變量 ③**）：一次寫入「本期發放」與（可選）「上一期
 * 未用完餘額作廢」。
 *
 *   發放行：entry_type=recharge、pool='subscription'、term_ref='sub:<id>:term:<n>'，
 *           expires_at = 本期到期時刻；冪等鍵 = `subscription:<id>:term:<n>`（就是
 *           「(訂閱 id, 期次序號)」那條不變量）。
 *   替換行：entry_type=expire、amount = −舊期未用完額（寫入時作廢；replace 語義）。
 *           兩行同一批 ⇒ 同一個事務，要嘛都記、要嘛都不記（不會出現「舊額已作廢、
 *           新額卻沒發」的淨損失）。
 *
 * 重放防護兩層：①呼叫端先按 source_ref（redemption:<id>）判斷同一張碼是否已發過；
 * ②帳本 UNIQUE(idempotency_ref) 擋並發（同一期次只會落一次）。
 */
export async function recordSubscriptionTermSwitch(
  input: {
    billingUserId: number;
    subscriptionId: string;
    /** 本期期次序號（從 1 起算）。 */
    termIndex: number;
    /** 本期額度（quota）。 */
    termQuota: number;
    /** 本期到期時刻 ISO。 */
    expiresAt: string;
    /** 發放來源（'redemption:<id>'）。 */
    sourceRef: string;
    sku: string;
    grantedAt?: string | null;
    redemptionKey?: string | null;
    /** 要作廢的上一期未用完餘額（>0 才寫 expire 行；由 subscription.ts 依替換語義算出）。 */
    replaced?: { termIndex: number; termRef: string; expiresAt: string; amountQuota: number } | null;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.termQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "期次額度非正數" };
  const drafts: LedgerEntryDraft[] = [
    {
      billingUserId: input.billingUserId,
      entryType: "recharge",
      amount,
      source: "subscription-redemption",
      sourceRef: input.sourceRef,
      idempotencyRef: ledgerRef.subscriptionTerm(input.subscriptionId, input.termIndex),
      pool: "subscription",
      termRef: subscriptionTermRef(input.subscriptionId, input.termIndex),
      expiresAt: input.expiresAt,
      note: `訂閱期次發放（第 ${input.termIndex} 期）`,
      metadata: {
        subscription_id: input.subscriptionId,
        sku: input.sku,
        term_index: input.termIndex,
        granted_at: input.grantedAt ?? null,
        redemption_key: input.redemptionKey ?? null,
      },
    },
  ];
  if (input.replaced && Math.round(input.replaced.amountQuota) > 0) {
    const replaced = Math.round(input.replaced.amountQuota);
    drafts.push({
      billingUserId: input.billingUserId,
      entryType: "expire",
      amount: -replaced,
      source: "subscription-redemption",
      sourceRef: `${input.sourceRef}/replace-term-${input.replaced.termIndex}`,
      idempotencyRef: ledgerRef.subscriptionReplace(input.subscriptionId, input.replaced.termIndex),
      pool: "subscription",
      termRef: input.replaced.termRef,
      expiresAt: input.replaced.expiresAt,
      note: `續期替換：第 ${input.replaced.termIndex} 期未用完餘額作廢`,
      metadata: {
        subscription_id: input.subscriptionId,
        replaced_term_index: input.replaced.termIndex,
        replaced_quota: replaced,
        renewal_mode: "replace",
      },
    });
  }
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/** 期次身份（與 subscription-sku.ts 的 subscriptionTermRef 同一格式；此處避免循環引用）。 */
function subscriptionTermRefOf(subscriptionId: string, termIndex: number): string {
  return `sub:${subscriptionId}:term:${termIndex}`;
}

/** 管理員加減額度（建戶初始額度、人工補正）。sourceRef 必填且要能指回操作人。 */
export async function recordAdjustment(
  input: {
    billingUserId: number;
    amountQuota: number;
    sourceRef: string;
    note: string;
    source?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "調整金額為 0，無帳可記" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "adjustment",
        amount,
        source: input.source ?? "admin",
        sourceRef: input.sourceRef,
        idempotencyRef: ledgerRef.adjustment(input.sourceRef),
        note: input.note.slice(0, 500),
      },
    ],
    deps,
  );
}

// ─────────────────────────────────────────── 充值入帳（上游兌換碼 → 帳本）

export interface RechargeIngestSummary {
  scanned: number;
  charged: number;
  skippedUnused: number;
  skippedBeforeBaseline: number;
  skippedNoUser: number;
  /** REQ-D3：帶訂閱 SKU 標記的碼（由 subscription.ts 的訂閱通道入帳，本通道**不得**再記一筆）。 */
  skippedSubscription: number;
  errors: string[];
}

type RedemptionReader = (input: { pages: number; pageSize: number }) => Promise<GatewayRedemption[]>;

/**
 * 充值入帳：把 new-api「已被使用」的兌換碼同步成我方帳本的 recharge 加項。
 *
 * 為什麼讀上游而不是在發碼時記帳：mPay 回調只是**產生**兌換碼（`fulfillMapayRedemption`），
 * 真正入帳要用戶在 new-api 端兌換（`POST /api/user/topup`）。發碼即記 = 未被兌換的碼
 * 憑空變成餘額；故一律以「上游記錄顯示已使用」為唯一入帳依據（同時涵蓋人工發碼）。
 *
 * 防雙算（關鍵）：只入帳 `redeemed_time` **晚於該身份基線入帳時間**的碼——
 * 基線前發生的充值已含在 opening 裡。基線不存在 = 先種基線再同步。
 *
 * 幂等：idempotency_ref = `redemption:<id>` ⇒ 週期性重掃不會重複入帳。
 */
export async function ingestRedeemedRecharges(
  input: { pages?: number; pageSize?: number } = {},
  deps: { sql?: GenerationSql; readRedemptions?: RedemptionReader; fetchUser?: OpeningDeps["fetchUser"] } = {},
): Promise<RechargeIngestSummary> {
  const summary: RechargeIngestSummary = {
    scanned: 0,
    charged: 0,
    skippedUnused: 0,
    skippedBeforeBaseline: 0,
    skippedNoUser: 0,
    skippedSubscription: 0,
    errors: [],
  };
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    summary.errors.push("帳本儲存層未配置");
    return summary;
  }
  const sql = deps.sql ?? getGenerationSql();
  const reader: RedemptionReader = deps.readRedemptions ?? listGatewayRedemptions;

  let items: GatewayRedemption[];
  try {
    items = await reader({ pages: Math.max(1, Math.min(input.pages ?? 2, 20)), pageSize: Math.max(1, Math.min(input.pageSize ?? 100, 100)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    summary.errors.push(reason);
    console.error(`[account-ledger] 兌換碼讀取失敗：${reason}`);
    return summary;
  }

  for (const item of items) {
    summary.scanned += 1;
    const redeemedAtSec = Number(item.redeemed_time ?? 0);
    const usedUserId = Number(item.used_user_id ?? 0);
    if (!(redeemedAtSec > 0)) {
      summary.skippedUnused += 1;
      continue;
    }
    if (!(usedUserId > 0)) {
      summary.skippedNoUser += 1;
      continue;
    }
    // REQ-D3 防雙算（關鍵）：帶訂閱 SKU 標記的兌換碼**只**走訂閱通道（subscription.ts
    // 建訂閱＋發期次，記在訂閱池）。這裡若照舊記一筆 recharge，同一張碼就會同時產生
    // 「永久充值」與「訂閱發放」兩筆入帳 = 憑空多一筆錢。
    if (parseSubscriptionCodeMarker(item.name)) {
      summary.skippedSubscription += 1;
      continue;
    }
    const opening = await ensureAccountOpening(usedUserId, { sql, fetchUser: deps.fetchUser });
    if (opening.baselineQuota === null) {
      // 基線不明（上游 user 讀不到/額度非整數）⇒ 不入帳，留給對帳報告解釋。
      summary.skippedNoUser += 1;
      continue;
    }
    const openingRow = await sql<Row[]>`
      SELECT created_at FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(usedUserId)} LIMIT 1
    `;
    // 基線時刻 = 這筆充值是否已含在基線裡的分界線。基線行寫入失敗時保守取 now
    // （寧可漏記一筆舊充值讓對帳報告指出，也不把已含在基線裡的錢再加一次）。
    const openingAtMs = openingRow[0] ? new Date(String(openingRow[0].created_at)).getTime() : Date.now();
    if (redeemedAtSec * 1000 < openingAtMs) {
      summary.skippedBeforeBaseline += 1;
      continue;
    }
    const outcome = await recordRecharge(
      {
        billingUserId: usedUserId,
        amountQuota: Number(item.quota ?? 0),
        redemptionId: item.id,
        redemptionKey: item.key,
        redeemedAt: new Date(redeemedAtSec * 1000).toISOString(),
      },
      { sql },
    );
    if (outcome.posted) summary.charged += 1;
    else if (outcome.reason && !/重放/.test(outcome.reason)) summary.errors.push(`redemption ${item.id}: ${outcome.reason}`);
  }
  return summary;
}
