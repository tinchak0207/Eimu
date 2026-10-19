// 音乐生成按次扣费（控制面执行）——镜像既有轮子 `src/lib/mapay-credit.ts` 的
// 「先占位、再动不幂等的上游、最后记帐本」范式。
//
// ── 为什么需要这一条 ────────────────────────────────────────────────────────
// 音乐走的是 harness 的 `music_gen`（FlowMusic2API / Lyria / YuE2），**从不经过
// 平台**，所以平台侧原本没有任何扣费点（记忆 `2026-10-10-music-has-no-price-authority`）。
// harness 现在按 `POST /v1/music/charges`（biz key 鉴权）申报一次生成，平台对
// 该 key 绑定的 new-api user 执行扣费。金额唯一来源＝`src/lib/music-pricing.ts`。
//
// ── 为什么自建 claim 表，而不是 billing_operation ──────────────────────────
// 既有计费列 `billing_operation` 的 `job_id` 是 `NOT NULL REFERENCES generation_job(id)`，
// 而音乐的 `generation_job.kind` CHECK 里没有（也不该谎报成 tts/video）——新增 kind
// 需要改 DB 迁移（本刀范围只到 src/，见回报）。本工程的既有答案是
// `mapay_credit`：**「上游 new-api 调额本身不幂等，必须在动上游之前先占位」**
// （operation-registry 的 `billing.commit` 政策同一条理由：上游没有幂等契约，
// 重放同一笔扣款可能双扣）。本档逐条照抄那个占位范式（表名/栏位按音乐语义改）。
//
// ── 顺序（与 account-ledger 铁律一致：先基线 → 动上游 → 记增量）──────────────
//   ① 占位 `music_charge`（PK = chargeId）——同 ref 重放不双扣；占位存在即不再动上游。
//   ② 种基线 ensureAccountBaselines（基线不可得＝不动上游，避免上游变动无法归属）
//   ③ 上游 users.quota −N（reserveImageQuota；内核执法点/供货水位）
//   ④ 我方帐本 account_ledger 记一笔 consumption（余额权威；幂等键
//      `music-charge:<chargeId>:debit`）。记帐失败只记日志（对帐报告负责，不挡钱路）。
//
// ── 与帐本/对帐的接缝（为什么 operation_id 留 NULL，job_id 放 chargeId）────────
// account-reconciliation 的 `orphan_ledger_entry` 规则（account-reconciliation.ts:233-250）
// 会把「带 operation_id 却在上游找不到对应 billing_operation applied 事件」的帐本行
// 判成漂移。音乐没有 billing_operation，若拿 operationId 承载 chargeId，**每一笔音乐
// 扣费都会产生一条假告警并可能把差额推进 unknown**。故本档：operationId 留 NULL，
// 以 `job_id = chargeId` 满足帐本铁律 3（消费列须带 operation_id **或** job_id）与
// 可追溯性；帐本余额层与上游 users.quota 同步下降，两层仍逐位对齐（difference=0）。
//
// 部署拓扑：本档只在控制面执行（直连控制面 Postgres + 上游管理凭证）。站点副本没有
// 控制面 DB ⇒ 扣费端点回 503（不静默放行一笔没记帐的扣费）。

import {
  ImageBillingGatewayError,
  ImageBillingRevertedError,
  reserveImageQuota,
} from "@/lib/image-billing";
import { classifyBillingFailure } from "@/lib/generation-core/billing-ledger";
import {
  ensureAccountBaselinesWithStatus,
  ledgerRef,
  postLedgerEntries,
} from "@/lib/generation-core/account-ledger";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────────────────────── 常量与身份

/**
 * 占位身份（PK）。**按 biz key 隔离**：ref 由客户端提供，两个 key 偶然撞同一个 ref
 * 不得互相顶掉对方的扣费（同一 key 内同 ref = 同一次生成尝试，重放不双扣）。
 */
export function musicChargeId(keyId: string, ref: string): string {
  return `music:${keyId}:${ref}`;
}

/** 占位表状态机。 */
export type MusicChargeStage = "pending" | "applied" | "failed" | "unknown";

export interface MusicChargeRecord {
  chargeId: string;
  billingUserId: number;
  amountQuota: number;
  status: MusicChargeStage;
}

export interface MusicChargeInput {
  chargeId: string;
  billingUserId: number;
  amountQuota: number;
  /** 帐本 source_ref（指回真实外部事实：`music:<keyId>:<ref>`）。 */
  sourceRef: string;
}

/**
 * 对外结果词表（路由据此映射 HTTP 状态码，唯一决策表）：
 *   charged          本次扣费成功
 *   already_charged  同 ref 之前已扣费（重放，幂等）—— 不得再扣
 *   in_flight        已占位、结果未定（pending/unknown）或并发—— 不得再动上游，防双扣
 *   insufficient     余额不足（→ 402）
 *   reverted         上游扣款已回滚、净额为零（→ 409，可安全重试同 ref）
 *   upstream_error   上游网关确定性拒绝（→ 上游状态码 ?? 502）
 *   unavailable      控制面帐本/基线不可用，本次未扣费（→ 503，可重试）
 */
export type MusicChargeOutcome =
  | "charged"
  | "already_charged"
  | "in_flight"
  | "insufficient"
  | "reverted"
  | "upstream_error"
  | "unavailable";

export interface MusicChargeResult {
  outcome: MusicChargeOutcome;
  message?: string;
  /** 上游原生 HTTP 状态（upstream_error 时可能带）。 */
  upstreamStatus?: number;
  /** 上游 Retry-After（若有）。 */
  retryAfter?: string | null;
}

// ─────────────────────────────────────────── 储存介面

export interface MusicChargeStore {
  /**
   * 占位：新插 pending（已存在则不动）。**唯一例外**：已存在且上次状态为 `failed`
   * （确定性未扣上游——4xx 拒绝/回滚净零/基线不可得）时重占为 pending，让「同 ref
   * 重试」在「上次真的没扣到钱」时能再扣一次。回 true = 本次可以动上游。
   */
  claim(input: Pick<MusicChargeInput, "chargeId" | "billingUserId" | "amountQuota">): Promise<boolean>;
  get(chargeId: string): Promise<MusicChargeRecord | null>;
  mark(chargeId: string, status: Exclude<MusicChargeStage, "pending">, detail?: string): Promise<void>;
}

export interface MusicChargeDeps {
  store: MusicChargeStore;
  ensureBaseline(userId: number): Promise<{ ready: boolean; blocked: boolean; reason?: string }>;
  /** 上游扣款（内核执法点）：reserveImageQuota(userId, quota)。 */
  reserveUpstream(userId: number, amountQuota: number): Promise<void>;
  recordLedger(input: {
    billingUserId: number;
    amountQuota: number;
    chargeId: string;
    sourceRef: string;
  }): Promise<{ posted: boolean; reason?: string }>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 已占位记录 → 结果词（重放路径；占位表是唯一幂等键）。
 * applied = 已扣过（dedup）；pending/unknown = 结果未定（不得再动上游）。
 */
function outcomeOfExisting(record: MusicChargeRecord | null): MusicChargeResult {
  if (record && record.status === "applied") return { outcome: "already_charged" };
  return {
    outcome: "in_flight",
    message: record
      ? `该 ref 已占位（${record.status}），结果未定，不得重复扣费。`
      : "该 ref 扣费占位状态不明。",
  };
}

// ─────────────────────────────────────────── 编排（永不 throw）

/**
 * 跑一次音乐扣费（永不 throw；上游/储存层异常在内部收敛成结果词）。
 * 幂等键 = chargeId：同一 ref 重放只扣一次。
 */
export async function runMusicChargeOnce(
  deps: MusicChargeDeps,
  input: MusicChargeInput,
): Promise<MusicChargeResult> {
  const amountQuota = Math.round(input.amountQuota);
  // 金额非正数 = 无从计费（定价真源应恒为正；这里是防呆 fail-closed，不放行一笔无凭据扣费）。
  if (!Number.isFinite(amountQuota) || amountQuota <= 0) {
    return { outcome: "unavailable", message: "音乐单价非正数，拒绝扣费。" };
  }

  // ① 占位：同 ref 已扣过/结果未定 → 不再动上游。
  const claimed = await deps.store.claim({
    chargeId: input.chargeId,
    billingUserId: input.billingUserId,
    amountQuota,
  });
  if (!claimed) return outcomeOfExisting(await deps.store.get(input.chargeId).catch(() => null));

  // ② 种基线（基线不可得＝不动上游，见 account-ledger 顺序铁律）。
  let baseline: { ready: boolean; blocked: boolean; reason?: string };
  try {
    baseline = await deps.ensureBaseline(input.billingUserId);
  } catch (error) {
    baseline = { ready: false, blocked: true, reason: reasonOf(error) };
  }
  if (baseline.blocked || !baseline.ready) {
    // 未动上游 ⇒ 标 failed（同 ref 重试可重占），如实回报不可用，不静默放行。
    await deps.store
      .mark(input.chargeId, "failed", `帐本/基线不可得：${baseline.reason ?? ""}`.slice(0, 500))
      .catch(() => {});
    return { outcome: "unavailable", message: "计费帐本暂不可用，本次未扣费。" };
  }

  // ③ 上游扣费。
  try {
    await deps.reserveUpstream(input.billingUserId, amountQuota);
  } catch (error) {
    const detail = reasonOf(error).slice(0, 500);
    const disposition = classifyBillingFailure(error);
    const status = error instanceof ImageBillingGatewayError ? error.status : undefined;
    // 顺序有讲究：
    //   ① unknown（超时/5xx/网络）先判——扣款状态不明，绝不让任何字串匹配把它误判成
    //      「未扣」，冻结为 unknown、永不自动重放（上游无幂等契约）。
    if (disposition === "unknown") {
      await deps.store.mark(input.chargeId, "unknown", detail).catch(() => {});
      console.error(`[music-charge] charge=${input.chargeId} user=${input.billingUserId} 扣费结果不明：${detail}`);
      return { outcome: "in_flight", message: `扣费结果不明，已冻结待人工核对：${detail}` };
    }
    //   ② 其余（rejected / retry）都是**确定性未扣**：标 failed，可安全重试同 ref。
    await deps.store.mark(input.chargeId, "failed", detail).catch(() => {});
    //   ③ 余额不足优先于「已回滚」（与图片 route 同一判据：402 或文案含「余额不足」）——
    //     回滚净零若因余额不足而起，对客户就是 402，不是 409。
    const insufficient = status === 402 || /余额不足/.test(detail);
    if (insufficient) return { outcome: "insufficient", message: detail };
    //   ④ 回滚净零（ImageBillingRevertedError；或 429 无 HTTP 状态）→ 409，可重试同 ref。
    if (error instanceof ImageBillingRevertedError || (disposition === "retry" && !status)) {
      return { outcome: "reverted", message: detail };
    }
    console.error(`[music-charge] charge=${input.chargeId} user=${input.billingUserId} 上游拒绝扣费：${detail}`);
    return {
      outcome: "upstream_error",
      message: detail,
      upstreamStatus: status,
      retryAfter: error instanceof ImageBillingGatewayError ? error.retryAfter : null,
    };
  }

  // ④ 已扣费：标 applied，再记帐本行（记帐不挡钱路，差额由对帐报告负责）。
  await deps.store.mark(input.chargeId, "applied").catch((error) => {
    console.error(`[music-charge] charge=${input.chargeId} 已扣费但未能标 applied：${reasonOf(error)}`);
  });
  if (baseline.ready) {
    const ledger = await deps
      .recordLedger({
        billingUserId: input.billingUserId,
        amountQuota,
        chargeId: input.chargeId,
        sourceRef: input.sourceRef,
      })
      .catch((error) => ({ posted: false, reason: reasonOf(error) }));
    if (!ledger.posted) {
      console.error(`[music-charge] charge=${input.chargeId} 已扣费但帐本行未落地（${ledger.reason ?? "重放"}）——由对帐报告负责`);
    }
  }
  return { outcome: "charged" };
}

// ─────────────────────────────────────────── Postgres 占位表

let schemaReady: Promise<void> | null = null;

type Row = Record<string, unknown>;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations 留档同一 DDL（幂等，首用即建）——同 mapay_credit 的姿势。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS music_charge (
          charge_ref      text PRIMARY KEY,
          billing_user_id bigint NOT NULL,
          amount_quota    bigint NOT NULL CHECK (amount_quota > 0),
          status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
          detail          text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function mapRow(row: Row): MusicChargeRecord {
  return {
    chargeId: String(row.charge_ref),
    billingUserId: Number(row.billing_user_id),
    amountQuota: Number(row.amount_quota),
    status: String(row.status) as MusicChargeStage,
  };
}

export function createPostgresMusicChargeStore(sql: GenerationSql): MusicChargeStore {
  return {
    async claim({ chargeId, billingUserId, amountQuota }) {
      await ensureSchema(sql);
      // 只插不覆盖：占位一旦存在（含 pending/unknown/applied）就不再重占——重放永远只扣一次。
      const inserted = await sql<Row[]>`
        INSERT INTO music_charge (charge_ref, billing_user_id, amount_quota, status)
        VALUES (${chargeId}, ${billingUserId}, ${amountQuota}, 'pending')
        ON CONFLICT (charge_ref) DO NOTHING
        RETURNING charge_ref
      `;
      if (inserted.length > 0) return true;
      // 唯一例外：上次是 failed（确定性未扣上游）→ 重占为 pending，让同 ref 重试能再扣一次。
      const reclaimed = await sql<Row[]>`
        UPDATE music_charge
        SET status = 'pending', detail = NULL, updated_at = now()
        WHERE charge_ref = ${chargeId} AND status = 'failed'
        RETURNING charge_ref
      `;
      return reclaimed.length > 0;
    },
    async get(chargeId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT charge_ref, billing_user_id, amount_quota, status
        FROM music_charge WHERE charge_ref = ${chargeId} LIMIT 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async mark(chargeId, status, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE music_charge SET status = ${status}, detail = ${detail ?? null}, updated_at = now()
        WHERE charge_ref = ${chargeId}
      `;
    },
  };
}

export function productionMusicChargeDeps(sql: GenerationSql): MusicChargeDeps {
  return {
    store: createPostgresMusicChargeStore(sql),
    async ensureBaseline(userId) {
      const guard = await ensureAccountBaselinesWithStatus([userId], { sql });
      return { ready: guard.ready, blocked: guard.blocked, reason: guard.failures[0]?.reason };
    },
    reserveUpstream: (userId, amountQuota) => reserveImageQuota(userId, amountQuota),
    async recordLedger({ billingUserId, amountQuota, chargeId, sourceRef }) {
      const result = await postLedgerEntries(
        [
          {
            billingUserId,
            entryType: "consumption",
            // consumption 是减项：有号金额取负（account-ledger 判别表强制方向）。
            amount: -Math.abs(Math.round(amountQuota)),
            source: "music-charge",
            sourceRef,
            // 幂等键走 account-ledger 的单一权威工厂（别处不得自拼）。
            idempotencyRef: ledgerRef.musicCharge(chargeId),
            // 铁律 3：消费列须带 operation_id 或 job_id。音乐无 billing_operation，
            // 以 job_id 承载 chargeId（对帐的 orphan 规则只看 operation_id，见档头）。
            jobId: chargeId,
            operationId: null,
            metadata: { charge_id: chargeId, amount_quota_abs: Math.abs(Math.round(amountQuota)) },
          },
        ],
        { sql },
      );
      return {
        posted: result.inserted.length > 0,
        reason:
          result.errors[0] ??
          result.rejected[0]?.reason ??
          (result.duplicates.length > 0 ? "已记过（重放）" : undefined),
      };
    },
  };
}

/** 控制面入口：给定 sql 句柄跑一次扣费。 */
export async function runMusicChargeWithSql(
  sql: GenerationSql,
  input: MusicChargeInput,
): Promise<MusicChargeResult> {
  return runMusicChargeOnce(productionMusicChargeDeps(sql), input);
}

/** 取得控制面 sql（路由用）。未配置时抛错，由路由转 503。 */
export function musicChargeSql(): GenerationSql {
  return getGenerationSql();
}
