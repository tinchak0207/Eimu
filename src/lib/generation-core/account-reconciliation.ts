// REQ-E1b 跨層對帳（我方帳本 vs new-api users.quota 變動）——只讀，永不改寫任一側。
//
// 為什麼需要它：REQ-E1a 把對外餘額的權威搬回我方帳本，但 new-api 內核仍在 relay 前
// 扣 users.quota（第二個 writer，BA-07 的結構性缺口）。雙寫不消除（暴君 09-23 裁定），
// 改成「雙寫必可解釋」：本檔定期比對兩層，把差值逐筆定位到 job／operation／billing_user。
//
// 三條硬紀律：
//   1. **只讀**：本檔沒有任何 INSERT/UPDATE/DELETE（具名測試守門），不自動改寫任一側。
//   2. **歧義凍結**：差值解釋不完（殘差 ≠ 0）→ state='unknown'，如實列出「未定位差額」，
//      沿用既有的 unknown 語義（人工對帳），不猜、不自動補帳。**但「歧義」只指殘差**：
//      findings 自相抵銷使殘差為 0（孤兒帳本行與上游事件互相對沖）不是歧義——差額已逐筆
//      定位得完，如實歸 explained；帳本尚未接管（無 opening 基線且零帳本行）也不是歧義，
//      是 lazy 種帳未觸及——如實歸 unseeded，不比較、不告警，免得噪音淹沒真漂移。
//   3. **告警沿用既有通道**：console.error 的結構化行（與 [billing-reconcile] 同一條），
//      不新造通知機制；差值超過門檻（或出現未定位差額）即告警。
//
// 判別口徑（哪些 new-api 變動「應該」有帳本行）——由 E1a 的寫入器契約決定：
//   billing_operation reserve  amount > 0  → 應有 consumption 帳本行（legacy 上游扣款）
//   billing_operation reserve  amount = 0  → 無（gate 零額快車道，不動上游）
//   billing_operation commit   projection  → 應有 consumption 帳本行（投影扣款）
//   billing_operation commit   一般        → 無（只作結算憑證，錢在 reserve 已扣）
//   billing_operation refund               → 應有 refund 帳本行
//   billing_operation writeoff             → 無（平台自身損失，不動用戶餘額）
//   billing_operation release              → 無（解除預留，不動上游餘額）

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { fetchGatewayUser } from "@/lib/gateway-admin";
import {
  computeAccountBalance,
  readAccountLedger,
  type LedgerEntry,
} from "./account-ledger";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { quotaToCoins } from "./statistics-projection";

type Row = Record<string, unknown>;

/** 差值告警門檻（quota 單位）：默認 1 幣。低於門檻的零頭不叫事故，超過就是。 */
export const DEFAULT_DRIFT_ALERT_QUOTA = QUOTA_PER_COIN;
/** 每次對帳最多掃幾個身份（每個身份一次上游 GET，避免打爆 new-api）。 */
export const MAX_RECONCILE_USERS = 50;

export type BillingOperationKind = "reserve" | "commit" | "release" | "refund" | "writeoff";

/** new-api 側的變動事件（billing_operation applied 行）。 */
export interface UpstreamBalanceEvent {
  operationId: string;
  jobId: string;
  operation: BillingOperationKind;
  /** 帳本行原值（>= 0）。 */
  amountQuota: number;
  idempotencyRef: string;
  appliedAt: string;
}

export type LedgerExpectation =
  | { expected: "consumption"; amountQuota: number }
  | { expected: "refund"; amountQuota: number }
  | { expected: "none"; reason: string };

/**
 * 這筆上游帳務事件「應該」在我方帳本留下什麼（純函式，獨立於任何實作）。
 * 這是兩層判別口徑的唯一權威——新增 operation 種類必須先改這裡與其測試。
 */
export function expectedLedgerEntryForOperation(event: UpstreamBalanceEvent): LedgerExpectation {
  const amount = Math.round(event.amountQuota);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { expected: "none", reason: "金額為 0（不動上游餘額）" };
  }
  if (event.operation === "refund") return { expected: "refund", amountQuota: amount };
  if (event.operation === "reserve") {
    // gate 零額快車道的 reserve 金額必為 0，走上面的 early return；非零 reserve = legacy
    // 真扣上游，故應有 consumption 帳本行。
    return { expected: "consumption", amountQuota: amount };
  }
  if (event.operation === "commit") {
    return event.idempotencyRef.startsWith("projection:")
      ? { expected: "consumption", amountQuota: amount }
      : { expected: "none", reason: "commit 只作結算憑證（錢已在 reserve 扣）" };
  }
  if (event.operation === "writeoff") {
    return { expected: "none", reason: "writeoff 是平台自身損失，不影響用戶餘額" };
  }
  return { expected: "none", reason: "release 解除預留，不動上游餘額" };
}

export type ReconciliationFindingKind =
  | "unrecorded_upstream_change"
  | "orphan_ledger_entry"
  | "subscription_expiry"
  | "unexplained_difference"
  | "balance_unavailable";

/** 一筆可逐筆解釋／定位的差額（billing_user + job／operation／entry 三選一必填到能指認）。 */
export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  billingUserId: number;
  /** 有號：對「new-api − 我方帳本」這個差值的貢獻。 */
  quota: number;
  coins: number;
  jobId: string | null;
  operationId: string | null;
  entryId: string | null;
  detail: string;
}

/**
 * - matched：兩層逐位相等且無任何疑點。
 * - explained：差額被 findings 逐筆定位完（殘差 0，含差額本就為 0 但 findings 自相抵銷）。
 * - unseeded：帳本尚未接管（無 opening 基線且零帳本行，lazy 種帳未觸及）——不比較、不告警。
 * - unknown：殘差解釋不完，歧義凍結交人工。
 */
export type ReconciliationState = "matched" | "explained" | "unseeded" | "unknown";

export interface AccountReconciliationRow {
  billingUserId: number;
  /** 我方帳本淨額（Σ amount）。 */
  ourNetQuota: number;
  ourNetCoins: number;
  /** new-api users.quota；讀不到為 null（不以 0 代替）。 */
  newApiQuota: number | null;
  /** newApiQuota − ourNetQuota；上游讀不到或 unseeded（不比較）為 null。 */
  differenceQuota: number | null;
  differenceCoins: number | null;
  state: ReconciliationState;
  ledgerEntries: number;
  findings: ReconciliationFinding[];
  /** 解釋不完的部分（有號）。解釋完為 0。 */
  unlocatedQuota: number;
}

export interface AccountReconciliationReport {
  generatedAt: string;
  configured: boolean;
  thresholdQuota: number;
  users: AccountReconciliationRow[];
  totals: {
    users: number;
    matched: number;
    explained: number;
    unseeded: number;
    unknown: number;
    findings: number;
    unlocatedQuota: number;
  };
  alerts: string[];
  notes: string[];
}

export interface ReconcileRowInput {
  billingUserId: number;
  entries: LedgerEntry[];
  newApiQuota: number | null;
  upstreamEvents: UpstreamBalanceEvent[];
}

/**
 * 單一身份的對帳（純函式）。帳本未接管（無 opening 且零行）→ 'unseeded'（不比較）；
 * 差額能逐筆定位完（殘差 0，含抵銷歸零）→ 'explained'；有殘差 → 'unknown'（凍結人工）。
 *
 * 差值定義：difference = newApiQuota − ourNetQuota。
 * 每個 finding 的 quota 都是「它解釋了多少 difference」的有號貢獻：
 *   - 上游動了、我方帳本沒記 → 貢獻 = 該筆應記的方向（consumption 負、refund 正）
 *   - 帳本記了、上游沒有對應事件 → 反向貢獻（我方多記）
 */
export function reconcileAccountRow(input: ReconcileRowInput): AccountReconciliationRow {
  const balance = computeAccountBalance(input.entries, input.billingUserId);

  // ⓪ 帳本尚未接管：無 opening 基線（entry_type='opening'，即 lazy 種帳寫入的
  //    seed:<user>:v1 行）且零帳本行——該身份從未被任何讀/寫路徑觸及，比較毫無意義。
  //    上游有大額 quota 與 applied 事件也不是歧義，是「尚未接管」：不比較、不告警，
  //    報告裡如實列 unseeded（new-api 值仍展示，差額不計算）。
  const hasOpeningEntry = input.entries.some((entry) => entry.entryType === "opening");
  if (!hasOpeningEntry && balance.entryCount === 0) {
    return {
      billingUserId: input.billingUserId,
      ourNetQuota: 0,
      ourNetCoins: 0,
      newApiQuota: input.newApiQuota === null ? null : Math.round(input.newApiQuota),
      differenceQuota: null,
      differenceCoins: null,
      state: "unseeded",
      ledgerEntries: 0,
      findings: [],
      unlocatedQuota: 0,
    };
  }

  const findings: ReconciliationFinding[] = [];
  const entryIds = new Set(input.entries.map((entry) => entry.id));
  // **opening 基線時間截斷**：種子語義＝「以種帳當時的 users.quota 種入 opening」，基線
  // 時刻之前的上游 applied 事件已被 opening 吸收（兩層在種帳一刻逐位相等），再對它們
  // 逐筆要求帳本行必產生假 unrecorded（生產實錘：user 82 的 1026 筆事件 1022 筆在種帳前，
  // 巨額假解釋額把 6 個兩層相等身份全推進 unknown）。對帳契約從基線起算：早於 opening
  // createdAt 的事件不參與比對；無 opening 行（尚未接管或人工輸入）則不截斷。
  const openingTimes = input.entries
    .filter((entry) => entry.entryType === "opening")
    .map((entry) => entry.createdAt)
    .sort();
  const seedAt = openingTimes.length > 0 ? openingTimes[0] : null;
  const baselineEvents =
    seedAt === null
      ? input.upstreamEvents
      : input.upstreamEvents.filter((event) => event.appliedAt >= seedAt);
  const byOperationId = new Map<string, LedgerEntry>();
  for (const entry of input.entries) {
    if (entry.operationId) byOperationId.set(entry.operationId, entry);
  }
  const upstreamIds = new Set(baselineEvents.map((event) => event.operationId));

  // ① 上游動了、我方帳本沒有對應行（最常見的漂移：記帳端掉了一筆）。
  for (const event of baselineEvents) {
    const expectation = expectedLedgerEntryForOperation(event);
    if (expectation.expected === "none") continue;
    const recorded = byOperationId.get(event.operationId);
    if (recorded && recorded.entryType === expectation.expected) continue;
    const sign = expectation.expected === "consumption" ? -1 : 1;
    const quota = sign * expectation.amountQuota;
    findings.push({
      kind: "unrecorded_upstream_change",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: event.jobId,
      operationId: event.operationId,
      entryId: recorded?.id ?? null,
      detail:
        `上游 ${event.operation} 已落地 ${expectation.amountQuota} quota（job=${event.jobId}），` +
        `我方帳本缺對應 ${expectation.expected} 帳本行${recorded ? `（operation 已掛著 ${recorded.entryType} 行，類型不符）` : ""}`,
    });
  }

  // ② 我方帳本記了、上游沒有對應事件（我方多記 / 上游回滾了卻沒撤帳）。
  for (const entry of input.entries) {
    if (!entry.operationId) continue;
    // expire 行在上游本就無對應事件（口徑差，見 ③），不進孤兒判定，避免雙重解釋。
    if (entry.entryType === "expire") continue;
    if (upstreamIds.has(entry.operationId)) continue;
    // writeoff/opening/recharge/adjustment 沒有 operation_id（見 E1a 寫入器契約），不會走到這裡。
    // 貢獻 = −entry.amount：consumption 記了 −100（我方偏低）⇒ 差值 +100；refund 記了 +100 ⇒ 差值 −100。
    const quota = -entry.amount;
    findings.push({
      kind: "orphan_ledger_entry",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: entry.jobId,
      operationId: entry.operationId,
      entryId: entry.id,
      detail: `我方帳本 ${entry.entryType} 行 ${entry.id}（${entry.amount} quota）在上游找不到對應 applied 事件，需人工核對`,
    });
  }

  // ③ 訂閱池過期作廢行（E1-b D3 殘差）：續期替換按池口徑作廢舊期殘額，是我方帳本的
  //    減項；上游 users.quota 沒有「池過期」語義，永無對應事件。這是**口徑差不是漂移**——
  //    必須逐筆定位為 explained，否則每張到期訂閱都把對帳推進 unknown＋誤觸告警。
  //    貢獻 = −entry.amount（expire 為負數 ⇒ 正值），恰為這些行抬高通數的差額。
  for (const entry of input.entries) {
    if (entry.entryType !== "expire") continue;
    const quota = -entry.amount;
    findings.push({
      kind: "subscription_expiry",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: entry.jobId,
      operationId: null,
      entryId: entry.id,
      detail:
        `訂閱池過期作廢：帳本行 ${entry.id}（${entry.amount} quota，term=${entry.termRef ?? "?"}，` +
        `到期 ${entry.expiresAt ?? "?"}）按池口徑扣減，上游 users.quota 無此語義——口徑差，非漂移`,
    });
  }

  const explained = findings.reduce((sum, finding) => sum + finding.quota, 0);
  if (input.newApiQuota === null) {
    findings.push({
      kind: "balance_unavailable",
      billingUserId: input.billingUserId,
      quota: 0,
      coins: 0,
      jobId: null,
      operationId: null,
      entryId: null,
      detail: "new-api 未回該用戶額度（上游不可達或帳號被刪）——兩層無法比對，不假設相等",
    });
    return {
      billingUserId: input.billingUserId,
      ourNetQuota: balance.quota,
      ourNetCoins: balance.coins,
      newApiQuota: null,
      differenceQuota: null,
      differenceCoins: null,
      state: "unknown",
      ledgerEntries: balance.entryCount,
      findings,
      unlocatedQuota: 0,
    };
  }

  const difference = Math.round(input.newApiQuota) - balance.quota;
  const residual = difference - explained;
  const base = {
    billingUserId: input.billingUserId,
    ourNetQuota: balance.quota,
    ourNetCoins: balance.coins,
    newApiQuota: Math.round(input.newApiQuota),
    differenceQuota: difference,
    differenceCoins: quotaToCoins(difference),
    ledgerEntries: balance.entryCount,
    findings,
  };

  // 兩層相等且沒有任何疑點 = matched。
  if (difference === 0 && findings.length === 0) {
    return { ...base, state: "matched", unlocatedQuota: 0 };
  }
  // 差額被 findings 逐筆定位完（殘差 0）= explained：每一筆都能說出是哪個 job/operation
  // 造成的。**不要求 difference ≠ 0**——findings 自相抵銷（孤兒帳本行與上游事件互沖、差額
  // 恰為 0）同樣是「解釋得完」，不是歧義；拿這個前提會把它們墜進 unknown＋假告警。
  if (residual === 0) {
    return { ...base, state: "explained", unlocatedQuota: 0 };
  }

  // 殘差：差額扣掉已定位的解釋後仍有餘（典型：有人直接在 new-api 後台改額度，或上游
  // 補償/折扣）。凍結為 unknown，交人工——不猜、不自動補帳、不改寫任一側。
  findings.push({
    kind: "unexplained_difference",
    billingUserId: input.billingUserId,
    quota: residual,
    coins: quotaToCoins(residual),
    jobId: null,
    operationId: null,
    entryId: null,
    detail:
      `兩層差額 ${difference} quota（new-api − 我方帳本）扣掉已定位的 ${explained} 後仍餘 ${residual}，` +
      `找不到對應的 job／operation——人工核對 new-api 後台操作或上游補償`,
  });
  return { ...base, state: "unknown", unlocatedQuota: residual, findings };
}

// ─────────────────────────────────────────── 差值門檻與告警（沿用既有通道）

export function driftAlertQuota(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ACCOUNT_RECONCILE_ALERT_QUOTA ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_DRIFT_ALERT_QUOTA;
}

/**
 * 一列對帳結果該不該告警：差值超門檻，或出現「解釋不完」的殘差（unknown）。
 * unseeded（帳本未接管）不比較也不告警——那是尚未接管的身份，不是事故。
 * 用既有的結構化 console.error（與 [billing-reconcile] 同一條通道）——不新造告警機制。
 */
export function driftAlerts(row: AccountReconciliationRow, thresholdQuota: number): string[] {
  const alerts: string[] = [];
  if (row.state === "unseeded") return alerts;
  if (row.newApiQuota === null) {
    alerts.push(`user=${row.billingUserId} 上游額度讀不到，兩層無法比對（我方帳本 ${row.ourNetQuota} quota）`);
    return alerts;
  }
  const drift = Math.abs(row.differenceQuota ?? 0);
  if (drift === 0 && row.state === "matched") return alerts;
  if (row.state === "unknown" && row.findings.some((finding) => finding.kind === "unexplained_difference")) {
    alerts.push(`user=${row.billingUserId} 對帳出現未定位差額（我方 ${row.ourNetQuota} vs 上游 ${row.newApiQuota} quota）`);
  } else if (drift >= thresholdQuota) {
    alerts.push(
      `user=${row.billingUserId} 兩層差額 ${row.differenceQuota} quota（門檻 ${thresholdQuota}）` +
        `${row.state === "explained" ? "，已逐筆定位，仍需入帳或更正" : ""}`,
    );
  }
  return alerts;
}

// ─────────────────────────────────────────── 查詢與組裝（只讀）

function mapUpstreamEvent(row: Row): UpstreamBalanceEvent {
  return {
    operationId: String(row.operation_id),
    jobId: String(row.job_id),
    operation: String(row.operation) as BillingOperationKind,
    amountQuota: Number(row.amount ?? 0),
    idempotencyRef: String(row.idempotency_ref ?? ""),
    appliedAt: new Date(String(row.applied_at)).toISOString(),
  };
}

/** 上游側事實：該身份所有已落地的帳務事件（只讀 SELECT）。 */
export async function readUpstreamBalanceEvents(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<UpstreamBalanceEvent[]> {
  const sql = deps.sql ?? getGenerationSql();
  const rows = await sql<Row[]>`
    SELECT operation.id AS operation_id, operation.job_id AS job_id, operation.operation AS operation,
           operation.amount AS amount, operation.idempotency_ref AS idempotency_ref,
           operation.applied_at AS applied_at
    FROM billing_operation operation
    JOIN generation_job job ON job.id = operation.job_id
    WHERE job.billing_user_id = ${billingUserId}
      AND operation.status = 'applied'
      AND operation.applied_at IS NOT NULL
    ORDER BY operation.applied_at, operation.id
  `;
  return rows.map(mapUpstreamEvent);
}

/**
 * 對帳對象：近期有帳本行或帳務事件的身份（UNION 兩側，因為漂移的定義就是兩邊不齊）。
 * 截斷如實回報（truncated=true 時報表必須標明只覆蓋前 N 個身份）。
 */
export async function readReconciliationSubjects(
  input: { limit?: number; sql?: GenerationSql } = {},
): Promise<{ ids: number[]; limit: number; truncated: boolean }> {
  const sql = input.sql ?? getGenerationSql();
  const limit = Math.max(1, Math.min(input.limit ?? MAX_RECONCILE_USERS, 500));
  const rows = await sql<{ billing_user_id: string | number; total_identities: string | number }[]>`
    SELECT identity.billing_user_id AS billing_user_id, count(*) OVER () AS total_identities
    FROM (
      SELECT DISTINCT billing_user_id FROM account_ledger
      UNION
      SELECT DISTINCT job.billing_user_id AS billing_user_id
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      WHERE job.billing_user_id IS NOT NULL
    ) identity
    WHERE identity.billing_user_id IS NOT NULL
    ORDER BY identity.billing_user_id
    LIMIT ${limit}
  `;
  const ids = rows.map((row) => Number(row.billing_user_id)).filter((id) => Number.isFinite(id));
  const counted = rows.length > 0 ? Number(rows[0].total_identities) : 0;
  return { ids, limit, truncated: Number.isFinite(counted) && counted > ids.length };
}

export interface ReconcileDeps {
  sql?: GenerationSql;
  /** 上游額度讀法（默認 fetchGatewayUser，與 quota-precheck／統計同通路）。 */
  fetchUser?: (userId: number) => Promise<{ quota: number } | null>;
  readEvents?: (billingUserId: number) => Promise<UpstreamBalanceEvent[]>;
  now?: Date;
  /** 告警出口（默認 console.error，沿用既有通道）。 */
  alert?: (message: string) => void;
}

/**
 * 跨層對帳主入口（只讀）。預設對象 = 近期有帳本行或帳務事件的身份；
 * 也可指定 billingUserIds（人工排障／單一用戶核帳）。
 *
 * 永不改寫任一側：本函式只 SELECT 帳本、只 GET 上游，結果以報表與告警輸出。
 */
export async function reconcileAccountBalances(
  input: { billingUserIds?: number[]; limit?: number } = {},
  deps: ReconcileDeps = {},
): Promise<AccountReconciliationReport> {
  const threshold = driftAlertQuota();
  const generatedAt = (deps.now ?? new Date()).toISOString();
  const notes: string[] = [];
  if (!generationDatabaseConfigured() && !deps.sql) {
    return {
      generatedAt,
      configured: false,
      thresholdQuota: threshold,
      users: [],
      totals: { users: 0, matched: 0, explained: 0, unseeded: 0, unknown: 0, findings: 0, unlocatedQuota: 0 },
      alerts: [],
      notes: ["本實例沒有控制面資料庫連線（GENERATION_DATABASE_URL），跨層對帳不可用。"],
    };
  }
  const sql = deps.sql ?? getGenerationSql();
  let ids = input.billingUserIds?.filter((id) => Number.isInteger(id) && id > 0) ?? null;
  if (!ids) {
    const subjects = await readReconciliationSubjects({ limit: input.limit ?? MAX_RECONCILE_USERS, sql });
    ids = subjects.ids;
    if (subjects.truncated) {
      notes.push(`對帳身份超過單輪上限 ${subjects.limit} 個，本輪只覆蓋前 ${subjects.ids.length} 個（不是全部）。`);
    }
  }
  if (ids.length === 0) notes.push("沒有任何身份有帳本行或帳務事件——不是「對帳通過」，是還沒有可對的帳。");

  const fetchUser = deps.fetchUser ?? (async (userId: number) => {
    const user = await fetchGatewayUser(userId);
    return user && Number.isFinite(user.quota) ? { quota: Number(user.quota) } : null;
  });
  const readEvents = deps.readEvents ?? ((billingUserId: number) => readUpstreamBalanceEvents(billingUserId, { sql }));
  const alert = deps.alert ?? ((message: string) => console.error(`[account-reconcile] ${message}`));

  const users: AccountReconciliationRow[] = [];
  const alerts: string[] = [];
  for (const billingUserId of ids) {
    let newApiQuota: number | null = null;
    try {
      const user = await fetchUser(billingUserId);
      newApiQuota = user ? Number(user.quota) : null;
    } catch (error) {
      console.error(`[account-reconcile] user=${billingUserId} 上游額度讀取失敗`, error);
      newApiQuota = null;
    }
    const entries = await readAccountLedger(billingUserId, { sql });
    const upstreamEvents = await readEvents(billingUserId);
    const row = reconcileAccountRow({ billingUserId, entries, newApiQuota, upstreamEvents });
    users.push(row);
    for (const message of driftAlerts(row, threshold)) {
      alerts.push(message);
      alert(message);
    }
  }

  const totals = {
    users: users.length,
    matched: users.filter((row) => row.state === "matched").length,
    explained: users.filter((row) => row.state === "explained").length,
    unseeded: users.filter((row) => row.state === "unseeded").length,
    unknown: users.filter((row) => row.state === "unknown").length,
    findings: users.reduce((sum, row) => sum + row.findings.length, 0),
    unlocatedQuota: users.reduce(
      (sum, row) => sum + row.findings.filter((finding) => finding.kind === "unexplained_difference").reduce((part, finding) => part + finding.quota, 0),
      0,
    ),
  };
  if (totals.unknown > 0) {
    notes.push(`${totals.unknown} 個身份對帳未定（歧義凍結，人工核對；本輪不自動改寫任一側）。`);
  }
  if (totals.unseeded > 0) {
    notes.push(`${totals.unseeded} 個身份帳本尚未接管（無 opening 基線且零帳本行，lazy 種帳未觸及）——不比較、不告警。`);
  }
  return { generatedAt, configured: true, thresholdQuota: threshold, users, totals, alerts, notes };
}

/**
 * 文字報表（給人看的那一份）：每個身份一行差額 + 差額清單逐筆貼出。
 * 確定性輸出（無時鐘以外的隨機），可直接當驗收樣本。
 */
export function formatAccountReconciliationReport(report: AccountReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`# 跨層對帳報告（我方帳本 vs new-api users.quota） ${report.generatedAt}`);
  lines.push(
    `# 身份 ${report.totals.users}（matched ${report.totals.matched} / explained ${report.totals.explained} / ` +
      `unseeded ${report.totals.unseeded} / unknown ${report.totals.unknown}）門檻 ${report.thresholdQuota} quota`,
  );
  for (const row of report.users) {
    const difference =
      row.state === "unseeded" ? "不比較（帳本未接管）" : row.differenceQuota === null ? "上游不可讀" : String(row.differenceQuota);
    lines.push(
      `[${row.state}] user=${row.billingUserId} 我方帳本=${row.ourNetQuota} quota(${row.ourNetCoins} 幣) ` +
        `new-api=${row.newApiQuota === null ? "unknown" : row.newApiQuota} 差額=${difference} 帳本行=${row.ledgerEntries}`,
    );
    for (const finding of row.findings) {
      lines.push(
        `    - ${finding.kind} ${finding.quota >= 0 ? "+" : ""}${finding.quota} quota ` +
          `job=${finding.jobId ?? "-"} operation=${finding.operationId ?? "-"} entry=${finding.entryId ?? "-"} :: ${finding.detail}`,
      );
    }
  }
  for (const alert of report.alerts) lines.push(`! 告警：${alert}`);
  for (const note of report.notes) lines.push(`~ ${note}`);
  return lines.join("\n");
}
