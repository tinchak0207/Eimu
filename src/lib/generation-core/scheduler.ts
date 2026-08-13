import { randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { mapSupplierLease } from "./job-repository";
import type { ClassifiedFailure } from "./failure-classifier";
import type { GenerationJob, SupplierLease } from "./types";

type Row = Record<string, unknown>;

export async function acquireSupplierLease(input: {
  job: GenerationJob;
  workerId: string;
  outputIndex: number;
  excludedSupplierIds?: string[];
  excludedFailureDomains?: string[];
  leaseMs: number;
}, sql: GenerationSql = getGenerationSql()): Promise<SupplierLease | null> {
  return sql.begin(async (tx) => {
    await tx`DELETE FROM supplier_lease WHERE expires_at < now()`;
    const excluded = input.excludedSupplierIds ?? [];
    const excludedDomains = input.excludedFailureDomains ?? [];
    const candidates = await tx<Row[]>`
      SELECT supplier.*, capability.id AS capability_id, capability.supplier_model_id,
        capability.concurrency_limit AS capability_concurrency_limit,
        capability.contract_version, capability.health_status AS capability_health_status,
        account.id AS account_id, account.label AS account_label,
        account.credential_ref AS account_credential_ref,
        account.concurrency_limit AS account_concurrency_limit,
        account.health_status AS account_health_status, account.token_source,
        account.credential_expires_at, account.refresh_status, account.success_rate_5m,
        account.health_observed_at, account.configuration_json AS account_configuration_json,
        (SELECT count(*)::int FROM supplier_lease lease
          WHERE lease.supplier_id = supplier.id AND lease.expires_at > now()) AS active_lease_count
      FROM supplier
      JOIN supplier_capability capability ON capability.supplier_id = supplier.id
      JOIN supplier_account account ON account.supplier_id = supplier.id
      WHERE supplier.enabled
        AND supplier.health_status <> 'disabled'
        AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now())
        AND capability.enabled
        AND capability.is_current
        AND capability.health_status <> 'disabled'
        AND (capability.cooldown_until IS NULL OR capability.cooldown_until <= now())
        AND account.enabled
        AND account.health_status <> 'disabled'
        AND (account.cooldown_until IS NULL OR account.cooldown_until <= now())
        AND capability.public_model_id = ${input.job.modelId}
        AND capability.kind = ${input.job.kind}
        AND (${input.job.ratio}::text IS NULL OR cardinality(capability.ratios) = 0 OR ${input.job.ratio} = ANY(capability.ratios))
        AND (${input.job.resolution}::text IS NULL OR cardinality(capability.resolutions) = 0 OR ${input.job.resolution} = ANY(capability.resolutions))
        AND (${input.job.routingClass} <> 'firefly_only' OR supplier.adapter_type = 'adobe2api')
        AND NOT (supplier.id = ANY(${excluded}::text[]))
        AND NOT (supplier.failure_domain = ANY(${excludedDomains}::text[]))
        AND (
          supplier.adapter_type <> 'adobe2api' OR (
            account.token_source = 'auto_refresh'
            AND account.refresh_status = 'healthy'
            AND account.credential_expires_at > now() + interval '2 minutes'
            AND account.health_observed_at > now() - interval '2 minutes'
            AND account.success_rate_5m >= COALESCE((account.configuration_json->>'minimumSuccessRate5m')::float, 0.8)
          )
        )
        AND (SELECT count(*) FROM supplier_lease lease
          WHERE lease.supplier_id = supplier.id AND lease.expires_at > now()) < supplier.concurrency_limit
        AND (SELECT count(*) FROM supplier_lease lease
          WHERE lease.supplier_account_id = account.id AND lease.expires_at > now()) < account.concurrency_limit
        AND (SELECT count(*) FROM supplier_lease lease
          WHERE lease.supplier_capability_id = capability.id AND lease.expires_at > now()) < capability.concurrency_limit
      ORDER BY CASE supplier.supply_tier
          WHEN 'first_party' THEN 0 WHEN 'managed_pool' THEN 1 WHEN 'relay' THEN 2 ELSE 3 END,
        supplier.priority ASC,
        CASE supplier.health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
        supplier.health_score * supplier.quality_score * capability.health_score DESC,
        (SELECT count(*)::float FROM supplier_lease lease
          WHERE lease.supplier_id = supplier.id AND lease.expires_at > now()) / supplier.concurrency_limit ASC,
        supplier.latency_ewma_ms ASC NULLS LAST,
        (supplier.unit_cost + capability.cost_units) ASC,
        supplier.last_selected_at ASC NULLS FIRST
      FOR UPDATE OF supplier SKIP LOCKED
      LIMIT 1
    `;
    if (!candidates[0]) return null;

    const supplier = candidates[0];
    const leaseId = randomUUID();
    const expiresAt = new Date(Date.now() + input.leaseMs);
    const inserted = await tx<Row[]>`
      INSERT INTO supplier_lease (
        id, supplier_id, supplier_account_id, supplier_capability_id, model_id,
        job_id, worker_id, expires_at
      ) VALUES (
        ${leaseId}, ${String(supplier.id)}, ${String(supplier.account_id)}, ${Number(supplier.capability_id)},
        ${input.job.modelId}, ${input.job.id}, ${input.workerId}, ${expiresAt}
      )
      ON CONFLICT (job_id) DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) return null;
    await tx`
      UPDATE supplier SET last_selected_at = now(), updated_at = now() WHERE id = ${String(supplier.id)}
    `;
    return mapSupplierLease({
      ...supplier,
      lease_id: leaseId,
      job_id: input.job.id,
      worker_id: input.workerId,
      expires_at: expiresAt,
    });
  });
}

export type SupplierUnavailabilityReason =
  | "model_not_provisioned"
  | "capability_disabled"
  | "suppliers_disabled"
  | "suppliers_cooldown"
  | "accounts_unhealthy"
  | "capacity_saturated"
  | "routing_class_unmet"
  | "variant_unsupported";

export type SupplierUnavailability = {
  reason: SupplierUnavailabilityReason;
  detail: string;
};

/**
 * 解釋「為什麼沒有可用 supplier」。
 *
 * 排障記錄（2026-08-05）：生圖失敗一律回 `overloaded / No eligible supplier
 * capacity is currently available.`，而實際成因至少有六種 —— 模型從未 seed、
 * capability 被停用、supplier 全部 disabled、全在 cooldown、賬號健康門檻不過、
 * 併發位打滿。這些的處置完全不同（跑 seed / 開渠道 / 等冷卻 / 修賬號 / 擴併發），
 * 但錯誤訊息把它們壓成同一句，只能靠人肉連進 DB 查。
 *
 * 這個函數按「從最外層條件往內收」的順序逐段放寬 acquireSupplierLease 的
 * WHERE，第一個能查到行的層級就是真正的卡點。只在租約失敗後跑，不在熱路徑上。
 */
export async function diagnoseSupplierUnavailability(
  job: Pick<GenerationJob, "modelId" | "kind" | "ratio" | "resolution" | "routingClass">,
  sql: GenerationSql = getGenerationSql(),
): Promise<SupplierUnavailability> {
  const anyContract = await sql<Row[]>`
    SELECT supplier_id, is_current, enabled FROM supplier_capability
    WHERE public_model_id = ${job.modelId} AND kind = ${job.kind}
  `;
  if (!anyContract.length) {
    return {
      reason: "model_not_provisioned",
      detail: `No supplier has ever been provisioned for ${job.modelId} (${job.kind}). `
        + "Run the supplier seed against this database.",
    };
  }
  const current = anyContract.filter((row) => Boolean(row.is_current));
  if (!current.length) {
    return {
      reason: "model_not_provisioned",
      detail: `Every capability contract for ${job.modelId} (${job.kind}) has been retired. `
        + "Re-run the supplier seed so a current contract exists.",
    };
  }
  if (!current.some((row) => Boolean(row.enabled))) {
    return {
      reason: "capability_disabled",
      detail: `All capability contracts for ${job.modelId} (${job.kind}) are disabled — `
        + "usually auto-disabled after the upstream rejected the model. Re-enable after fixing the upstream.",
    };
  }

  // 變體（比例/解析度）是否被合約接受。
  const variantOk = await sql<Row[]>`
    SELECT capability.id FROM supplier_capability capability
    WHERE capability.public_model_id = ${job.modelId} AND capability.kind = ${job.kind}
      AND capability.is_current AND capability.enabled
      AND (${job.ratio}::text IS NULL OR cardinality(capability.ratios) = 0 OR ${job.ratio} = ANY(capability.ratios))
      AND (${job.resolution}::text IS NULL OR cardinality(capability.resolutions) = 0 OR ${job.resolution} = ANY(capability.resolutions))
    LIMIT 1
  `;
  if (!variantOk.length) {
    return {
      reason: "variant_unsupported",
      detail: `No capability contract for ${job.modelId} accepts ratio=${job.ratio ?? "any"} `
        + `resolution=${job.resolution ?? "any"}.`,
    };
  }

  const routable = await sql<Row[]>`
    SELECT supplier.id, supplier.enabled, supplier.health_status, supplier.cooldown_until,
      supplier.adapter_type, supplier.concurrency_limit,
      (SELECT count(*)::int FROM supplier_lease lease
        WHERE lease.supplier_id = supplier.id AND lease.expires_at > now()) AS active_leases
    FROM supplier
    JOIN supplier_capability capability ON capability.supplier_id = supplier.id
    WHERE capability.public_model_id = ${job.modelId} AND capability.kind = ${job.kind}
      AND capability.is_current AND capability.enabled
      AND (${job.ratio}::text IS NULL OR cardinality(capability.ratios) = 0 OR ${job.ratio} = ANY(capability.ratios))
      AND (${job.resolution}::text IS NULL OR cardinality(capability.resolutions) = 0 OR ${job.resolution} = ANY(capability.resolutions))
  `;
  if (job.routingClass === "firefly_only" && !routable.some((row) => row.adapter_type === "adobe2api")) {
    return {
      reason: "routing_class_unmet",
      detail: `Job requires the Adobe supplier (routing class firefly_only) but no adobe2api supplier serves ${job.modelId}.`,
    };
  }
  const enabled = routable.filter((row) => Boolean(row.enabled) && row.health_status !== "disabled");
  if (!enabled.length) {
    return {
      reason: "suppliers_disabled",
      detail: `Every supplier that serves ${job.modelId} is disabled: `
        + `${routable.map((row) => String(row.id)).join(", ") || "none"}. Enable one in /admin, or seed the correct channel.`,
    };
  }
  const notCooling = enabled.filter((row) => !row.cooldown_until || new Date(String(row.cooldown_until)) <= new Date());
  if (!notCooling.length) {
    const soonest = enabled
      .map((row) => new Date(String(row.cooldown_until)).getTime())
      .sort((left, right) => left - right)[0];
    return {
      reason: "suppliers_cooldown",
      detail: `Every supplier for ${job.modelId} is in cooldown after recent failures; `
        + `the earliest resumes at ${new Date(soonest).toISOString()}.`,
    };
  }

  const withHealthyAccount = await sql<Row[]>`
    SELECT supplier.id FROM supplier
    JOIN supplier_capability capability ON capability.supplier_id = supplier.id
    JOIN supplier_account account ON account.supplier_id = supplier.id
    WHERE capability.public_model_id = ${job.modelId} AND capability.kind = ${job.kind}
      AND capability.is_current AND capability.enabled
      AND supplier.enabled AND supplier.health_status <> 'disabled'
      AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now())
      AND account.enabled AND account.health_status <> 'disabled'
      AND (account.cooldown_until IS NULL OR account.cooldown_until <= now())
      AND (
        supplier.adapter_type <> 'adobe2api' OR (
          account.token_source = 'auto_refresh'
          AND account.refresh_status = 'healthy'
          AND account.credential_expires_at > now() + interval '2 minutes'
          AND account.health_observed_at > now() - interval '2 minutes'
          AND account.success_rate_5m >= COALESCE((account.configuration_json->>'minimumSuccessRate5m')::float, 0.8)
        )
      )
    LIMIT 1
  `;
  if (!withHealthyAccount.length) {
    return {
      reason: "accounts_unhealthy",
      detail: `Suppliers for ${job.modelId} are enabled but none has a usable account `
        + "(disabled, cooling down, or failing the Adobe token-freshness / success-rate gate).",
    };
  }

  return {
    reason: "capacity_saturated",
    detail: `All suppliers for ${job.modelId} are healthy but their concurrency limits are full `
      + `(${notCooling.map((row) => `${String(row.id)} ${Number(row.active_leases)}/${Number(row.concurrency_limit)}`).join(", ")}). `
      + "The job stays queued and will retry.",
  };
}

export async function heartbeatSupplierLease(
  leaseId: string,
  workerId: string,
  leaseMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE supplier_lease
    SET expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval, updated_at = now()
    WHERE id = ${leaseId} AND worker_id = ${workerId}
    RETURNING id
  `;
  return Boolean(rows[0]);
}

export async function releaseSupplierLease(
  leaseId: string,
  workerId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  await sql`DELETE FROM supplier_lease WHERE id = ${leaseId} AND worker_id = ${workerId}`;
}

export async function reportSupplierSuccess(
  supplier: { supplierId: string; accountId: string; capabilityId: number },
  latencyMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO supplier_health_event (supplier_id, supplier_account_id, supplier_capability_id, outcome)
      VALUES (${supplier.supplierId}, ${supplier.accountId}, ${supplier.capabilityId}, 'success')
    `;
    await tx`
      UPDATE supplier
      SET health_status = 'healthy', cooldown_until = NULL,
          health_score = LEAST(1, health_score * 0.8 + 0.2),
          latency_ewma_ms = CASE WHEN latency_ewma_ms IS NULL THEN ${latencyMs}
            ELSE latency_ewma_ms * 0.8 + ${latencyMs} * 0.2 END,
          success_count = success_count + 1, last_success_at = now(), updated_at = now()
      WHERE id = ${supplier.supplierId}
    `;
    await tx`
      UPDATE supplier_capability
      SET health_status = 'healthy', cooldown_until = NULL, health_score = LEAST(1, health_score * 0.8 + 0.2),
          success_count = success_count + 1, updated_at = now()
      WHERE id = ${supplier.capabilityId}
    `;
    await tx`
      UPDATE supplier_account account
      SET health_status = 'healthy', cooldown_until = NULL,
          attempts_5m = health.attempts, successes_5m = health.successes,
          success_rate_5m = CASE WHEN health.attempts = 0 THEN 1 ELSE health.successes::float / health.attempts END,
          health_observed_at = now(), updated_at = now()
      FROM (
        SELECT count(*)::int AS attempts, count(*) FILTER (WHERE outcome = 'success')::int AS successes
        FROM supplier_health_event
        WHERE supplier_account_id = ${supplier.accountId} AND observed_at >= now() - interval '5 minutes'
      ) health
      WHERE account.id = ${supplier.accountId}
    `;
  });
}

export async function reportSupplierFailure(
  supplier: { supplierId: string; accountId: string; capabilityId: number },
  failure: ClassifiedFailure,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  await sql.begin(async (tx) => {
    const accountFailure = failure.failureClass === "authentication" || failure.failureClass === "quota_exhausted" || failure.failureClass === "rate_limited";
    const capabilityFailure = failure.failureClass === "model_unsupported" || failure.failureClass === "malformed_output" || failure.failureClass === "empty_result" || failure.failureClass === "artifact_download";
    // 429 is normally enforced at the channel/project boundary rather than the
    // individual credential. Persist the cooldown on both levels so another
    // worker or account cannot immediately resume the same upstream traffic.
    const supplierCooldown = failure.failureClass === "rate_limited"
      ? failure.cooldownUntil
      : accountFailure
        ? null
        : failure.cooldownUntil;
    const supplierStatus = supplierCooldown ? "cooldown" : "degraded";
    await tx`
      INSERT INTO supplier_health_event (supplier_id, supplier_account_id, supplier_capability_id, outcome)
      VALUES (${supplier.supplierId}, ${supplier.accountId}, ${supplier.capabilityId}, 'failure')
    `;
    await tx`
      UPDATE supplier
      SET health_status = ${supplierStatus}, cooldown_until = ${supplierCooldown},
          health_score = GREATEST(0, health_score * 0.7), failure_count = failure_count + 1,
          last_failure_at = now(), updated_at = now()
      WHERE id = ${supplier.supplierId}
    `;
    if (accountFailure) {
      await tx`
        UPDATE supplier_account
        SET health_status = ${failure.quarantineSupplier ? "disabled" : "cooldown"},
            cooldown_until = ${failure.cooldownUntil}, updated_at = now()
        WHERE id = ${supplier.accountId}
      `;
    }
    if (capabilityFailure) {
      await tx`
        UPDATE supplier_capability
        SET enabled = CASE WHEN ${failure.failureClass} = 'model_unsupported' THEN false ELSE enabled END,
            health_status = CASE WHEN ${failure.failureClass} = 'model_unsupported' THEN 'disabled' ELSE 'cooldown' END,
            cooldown_until = ${failure.cooldownUntil}, health_score = GREATEST(0, health_score * 0.7),
            failure_count = failure_count + 1, updated_at = now()
        WHERE id = ${supplier.capabilityId}
      `;
    }
    await tx`
      UPDATE supplier_account account
      SET attempts_5m = health.attempts, successes_5m = health.successes,
          success_rate_5m = CASE WHEN health.attempts = 0 THEN 1 ELSE health.successes::float / health.attempts END,
          health_observed_at = now(), updated_at = now()
      FROM (
        SELECT count(*)::int AS attempts, count(*) FILTER (WHERE outcome = 'success')::int AS successes
        FROM supplier_health_event
        WHERE supplier_account_id = ${supplier.accountId} AND observed_at >= now() - interval '5 minutes'
      ) health
      WHERE account.id = ${supplier.accountId}
    `;
  });
}

export async function consumeDistributedRateLimit(input: {
  apiKeyId: string;
  rpm: number;
  now?: Date;
}, sql: GenerationSql = getGenerationSql()): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = input.now ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const rows = await sql<{ request_count: number }[]>`
    INSERT INTO api_rate_limit_window (api_key_id, window_start, request_count)
    VALUES (${input.apiKeyId}, ${windowStart}, 1)
    ON CONFLICT (api_key_id, window_start) DO UPDATE
      SET request_count = api_rate_limit_window.request_count + 1, updated_at = now()
    RETURNING request_count
  `;
  const count = Number(rows[0]?.request_count ?? input.rpm + 1);
  return {
    allowed: count <= input.rpm,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000)),
  };
}
