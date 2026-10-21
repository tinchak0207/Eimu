import { randomUUID } from "node:crypto";
import { LEDGER_POOL_DEFAULT, isLedgerPool } from "../subscription-sku";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "../database";
import { validateLedgerEntryDraft } from "./schema";
import type { LedgerEntry, LedgerEntryDraft, LedgerEntryType, PostLedgerResult } from "./types";

// ─────────────────────────────────────────── 写入层

export type Row = Record<string, unknown>;

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

/** 帐本储存层可用吗（C 端 Vercel 没有控制面库 ⇒ 走降级，不炸）。 */
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
 * 记一批帐（append-only + 幂等）。多笔时包在一个事务里——转移的两条腿要嘛都记、
 * 要嘛都不记（单腿落地 = 我方帐本自己制造不对称）。
 *
 * 永不 throw：本地契约拒收与 SQL 失败都只是回报值（记帐不挡钱路，第 3 条纪律）。
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
      console.error(`[account-ledger] 拒收帐本行 ref=${String(draft?.idempotencyRef)}：${reason}`);
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
    console.error(`[account-ledger] 记帐失败（不挡钱路，差额由对帐报告负责）：${reason}`);
  }
  return result;
}

// ─────────────────────────────────────────── 读取层

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
