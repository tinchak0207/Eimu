import { fetchGatewayUser, type GatewayAdminUser } from "@/lib/gateway-admin";
import { getGenerationSql, type GenerationSql } from "../database";
import { ledgerRef } from "./schema";
import { accountLedgerStoreEnabled, postLedgerEntries, type Row } from "./storage";
import type { BaselineGuardResult, LedgerWriterDeps, OpeningDeps, OpeningFailureKind, OpeningSeedResult } from "./types";

// ─────────────────────────────────────────── 基线（种子）

type OpeningRead =
  | { status: "found"; amount: number }
  | { status: "absent" }
  | { status: "error"; reason: string };

/**
 * 读基线行（唯一判据：帐本里真的有这一行）。查询文本与写入端同一条幂等键，
 * 成功／失败／并发三条路径共用 ⇒ 「基线就绪」永远是回读的结论，不是函式回传值的推论。
 */
async function readOpeningRow(sql: GenerationSql, billingUserId: number): Promise<OpeningRead> {
  try {
    const rows = await sql<Row[]>`
      SELECT amount FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(billingUserId)} LIMIT 1
    `;
    if (!rows[0]) return { status: "absent" };
    const amount = Number(rows[0].amount);
    if (!Number.isFinite(amount)) return { status: "error", reason: `基线行金额非有限值（${String(rows[0].amount)}）` };
    return { status: "found", amount };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 种入/确认基线：**上线基线 = new-api 当时的 users.quota**（历史净额已含在里面，
 * 故本表只记基线之后的增量，不得双算既有历史）。
 *
 * 幂等机制：idempotency_ref = `seed:<userId>:v1` 且 UNIQUE ⇒ 同一份 new-api 基线
 * 重放两次，第二次命中 ON CONFLICT DO NOTHING（实测见测试「重放不双算」）。
 *
 * 呼叫时机：对外余额第一次被读、或任何写入器动手前（见 ensureOpeningBeforeWrite）。
 * 「先种基线、后记增量」是防双算的关键：若先记了一笔扣费再种基线，基线已经含了
 * 那笔扣费 ⇒ 两边都算。
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
      reason: "帐本储存层未配置",
      failure: "store_unavailable",
      verified: false,
    };
  }
  const sql = deps.sql ?? getGenerationSql();

  const existing = await readOpeningRow(sql, billingUserId);
  if (existing.status === "error") {
    // 读不到（连线/语法/权限）：既不能说基线在、也不能说不在 ⇒ 回不可得（不得猜）。
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: `基线回读失败：${existing.reason}`,
      failure: "ledger_unavailable",
      verified: false,
    };
  }
  if (existing.status === "found") {
    return { billingUserId, seeded: false, baselineQuota: existing.amount, reason: "已有基线（重放）", failure: null, verified: true };
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
      reason: `基线读取失败：${error instanceof Error ? error.message : String(error)}`,
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!user || !Number.isFinite(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "new-api 未回该用户额度（基线不明）",
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!Number.isInteger(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "上游额度非整数，基线不可信",
      failure: "upstream_unavailable",
      verified: false,
    };
  }

  // 0 基线也照样入帐（amount=0 的 opening）：它不改变任何金额，但把「基线时刻」记下来，
  // 充值同步据此判断「这笔充值是否已含在基线里」。
  const posted = await postLedgerEntries(
    [
      {
        billingUserId,
        entryType: "opening",
        amount: Math.round(user.quota),
        source: "seed",
        sourceRef: `new-api:users/${billingUserId}@${(deps.now ?? (() => new Date()))().toISOString()}`,
        idempotencyRef: ledgerRef.opening(billingUserId),
        note: "上线基线：以 new-api users.quota 为起点，历史净额已含在此",
        metadata: { baseline_source: "new-api/users.quota" },
      },
    ],
    { sql },
  );

  // 唯一判据＝回读：INSERT 回报成功但读不到（或 INSERT 直接失败）都算基线未落地，
  // 一律回 null（呼叫端据此 503／不动上游），**不得**回一个上游读数当作「基线就绪」。
  const confirmed = await readOpeningRow(sql, billingUserId);
  if (confirmed.status !== "found") {
    const reason =
      confirmed.status === "error"
        ? `基线回读失败：${confirmed.reason}`
        : posted.errors[0] ?? posted.rejected[0]?.reason ?? "基线未落地（回读不到基线行）";
    console.error(`[account-ledger] 基线未落地 user=${billingUserId}（${reason}）——不得当成基线就绪`);
    return { billingUserId, seeded: false, baselineQuota: null, reason, failure: "ledger_unavailable", verified: false };
  }
  if (posted.inserted.length > 0) {
    return { billingUserId, seeded: true, baselineQuota: confirmed.amount, failure: null, verified: true };
  }
  return {
    billingUserId,
    seeded: false,
    baselineQuota: confirmed.amount,
    reason: posted.duplicates.length > 0 ? "并发种入（另一写入者已种）" : "基线已落地（回读确认）",
    failure: null,
    verified: true,
  };
}

/** 批量种基线（上线迁移工具用）。逐个幂等 ⇒ 整批可任意重放。 */
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
 * 基线保证（**必须在动上游之前呼叫**，这是防双算的关键顺序）：
 *
 *   先种基线 →[上游扣/加]→ 再记增量
 *
 * 为什么顺序不能颠倒：基线取的是「当下 new-api users.quota」，若先动了上游再种基线，
 * 那笔增量已经被算进基线里，帐本再把同一件事记一次 = 双算（本刀端到端测试实锤：
 * B1 分配若不先种基线，主帐帐本会凭空少 2,000,000）。反之「先种基线、后动上游」是
 * 安全的：多种的基线是无害的（余额仍等于上游），而缺记的增量由 E1b 对帐报告负责。
 *
 * **基线就绪的判据＝回读确认**（不是「函式回了非 null」）：见 ensureOpeningBeforeWrite。
 * 基线不可得 → 放弃记这次增量；帐本权威实例（储存层已配置）上**连上游都不准动**，
 * 否则就留下一笔没有基线归属的上游变动，之后 lazy 种子读到变动后的 users.quota 当基线
 * ⇒ 同一笔增量算两次、差额永久存在（E1-b D-2 实测）。
 */
export async function ensureAccountBaselines(
  billingUserIds: number[],
  deps: LedgerWriterDeps = {},
): Promise<boolean> {
  return (await ensureAccountBaselinesWithStatus(billingUserIds, deps)).ready;
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
        reason: "帐本储存层未配置",
      })),
    };
  }
  const sql = deps.sql ?? getGenerationSql();
  return ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser);
}

export async function ensureOpeningBeforeWrite(
  billingUserIds: number[],
  sql: GenerationSql,
  fetchUser?: LedgerWriterDeps["fetchUser"],
): Promise<BaselineGuardResult> {
  // 帐本权威实例＝储存层已配置。降级实例没有帐本可记，挡上游只会弄坏可用性。
  const authoritative = accountLedgerStoreEnabled();
  for (const userId of [...new Set(billingUserIds)]) {
    const result = await ensureAccountOpening(userId, { sql, fetchUser });
    // 判据是「回读确认过的基线行」，不是回传值非 null（result.verified 由 readOpeningRow 定案）。
    if (result.baselineQuota !== null && result.verified !== false) continue;
    const failure: OpeningFailureKind = result.failure ?? "ledger_unavailable";
    const blocked = authoritative && failure !== "store_unavailable";
    console.error(
      `[account-ledger] 基线不可得 user=${userId}（${failure}：${result.reason}）——本次增量不记帐` +
        `${blocked ? "，且不得动上游（基线不成立＝上游变动无法归属）" : ""}`,
    );
    return { ready: false, blocked, failures: [{ billingUserId: userId, failure, reason: result.reason ?? "" }] };
  }
  return { ready: true, blocked: false, failures: [] };
}
