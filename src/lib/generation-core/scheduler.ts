import { randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { mapSupplierLease } from "./job-repository";
import type { ClassifiedFailure } from "./failure-classifier";
import type { GenerationJob, SupplierLease } from "./types";
import { NEWAPI_ROUTE_LABEL, routeSupplierId } from "../model-routes.config";
import { resolveModelRoute } from "./model-routing";

/**
 * B 端 `routing_hint=hub`（routingClass hub_only）原意＝只走 hub.linux.do。hublinuxdo
 * 已并入 new-api（其内部渠道之一），控面能指定的最近粒度就是 new-api 那一步。
 */
const HUB_ONLY_SUPPLIER_ID = routeSupplierId(NEWAPI_ROUTE_LABEL);

type Row = Record<string, unknown>;

export async function acquireSupplierLease(input: {
  job: GenerationJob;
  workerId: string;
  outputIndex: number;
  excludedSupplierIds?: string[];
  excludedFailureDomains?: string[];
  leaseMs: number;
}, sql: GenerationSql = getGenerationSql()): Promise<SupplierLease | null> {
  // 路由是闸门也是排序：不在该模型生效路由里的 supplier 一律不可租；顺序＝阵列顺序。
  const route = await resolveModelRoute(input.job.modelId, sql);
  if (!route.supplierIds.length) return null;
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
        AND (${input.job.routingClass} <> 'hub_only' OR supplier.id = ${HUB_ONLY_SUPPLIER_ID})
        AND supplier.id = ANY(${route.supplierIds}::text[])
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
      ORDER BY array_position(${route.supplierIds}::text[], supplier.id::text) ASC,
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
  | "model_not_routed"
  | "capability_disabled"
  | "suppliers_disabled"
  | "suppliers_cooldown"
  | "accounts_unhealthy"
  | "capacity_saturated"
  | "routing_class_unmet"
  | "variant_unsupported"
  | "supplier_excluded";

export type SupplierUnavailability = {
  reason: SupplierUnavailabilityReason;
  detail: string;
};

/**
 * 解释「为什么没有可用 supplier」。
 *
 * 排障记录（2026-08-05）：生图失败一律回 `overloaded / No eligible supplier
 * capacity is currently available.`，而实际成因至少有六种 —— 模型从未 seed、
 * capability 被停用、supplier 全部 disabled、全在 cooldown、账号健康门槛不过、
 * 并发位打满。这些的处置完全不同（跑 seed / 开渠道 / 等冷却 / 修账号 / 扩并发），
 * 但错误讯息把它们压成同一句，只能靠人肉连进 DB 查。
 *
 * 这个函数按「从最外层条件往内收」的顺序逐段放宽 acquireSupplierLease 的
 * WHERE，第一个能查到行的层级就是真正的卡点。只在租约失败后跑，不在热路径上。
 *
 * 排障记录（2026-08-29）：旧版从不考虑 acquire 时的 attempt 排除链
 * （excludedSupplierIds / excludedFailureDomains），单供应商渠道在第一次 attempt
 * 失败后必然被自己排除，诊断却谎报「healthy but their concurrency limits are
 * full」（实录 env:metaso 0/6 也敢说满）。`excluded` 参数把排除链带进来：若唯一
 * 的合格供应商都被排除，如实回报 supplier_excluded 并附最近一次上游失败原文，
 * 让 worker 快速失败而不是空转到 deadline。
 */
export async function diagnoseSupplierUnavailability(
  job: Pick<GenerationJob, "modelId" | "kind" | "ratio" | "resolution" | "routingClass">,
  sql: GenerationSql = getGenerationSql(),
  excluded?: { supplierIds: string[]; failureDomains: string[]; lastFailureDetail?: string | null },
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

  // 变体（比例/解析度）是否被合约接受。
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

  const route = await resolveModelRoute(job.modelId, sql);
  if (!route.supplierIds.length) {
    return {
      reason: "model_not_routed",
      detail: `${job.modelId} has no route (source: ${route.source}). `
        + "Add it to MODEL_ROUTES in src/lib/model-routes.config.ts or set a route in /admin.",
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
      AND supplier.id = ANY(${route.supplierIds}::text[])
  `;
  if (!routable.length) {
    return {
      reason: "model_not_routed",
      detail: `None of the routed channels for ${job.modelId} [${route.labels.join(" > ")}] (source: ${route.source}) `
        + "holds a current capability contract. Fix the route or seed the channel.",
    };
  }
  if (job.routingClass === "firefly_only" && !routable.some((row) => row.adapter_type === "adobe2api")) {
    return {
      reason: "routing_class_unmet",
      detail: `Job requires the Adobe supplier (routing class firefly_only) but no adobe2api supplier serves ${job.modelId}.`,
    };
  }
  if (job.routingClass === "hub_only" && !routable.some((row) => row.id === HUB_ONLY_SUPPLIER_ID)) {
    return {
      reason: "routing_class_unmet",
      detail: `Job requires the hub supplier (routing class hub_only → ${HUB_ONLY_SUPPLIER_ID}) but it is not on the route for ${job.modelId}.`,
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
    SELECT supplier.id, supplier.failure_domain FROM supplier
    JOIN supplier_capability capability ON capability.supplier_id = supplier.id
    JOIN supplier_account account ON account.supplier_id = supplier.id
    WHERE capability.public_model_id = ${job.modelId} AND capability.kind = ${job.kind}
      AND capability.is_current AND capability.enabled
      AND supplier.id = ANY(${route.supplierIds}::text[])
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
  `;
  if (!withHealthyAccount.length) {
    return {
      reason: "accounts_unhealthy",
      detail: `Suppliers for ${job.modelId} are enabled but none has a usable account `
        + "(disabled, cooling down, or failing the Adobe token-freshness / success-rate gate).",
    };
  }

  // 排除链检查（2026-08-29）：acquire 会排除本 job 已失败过的 supplier / failure
  // domain，这里必须用同一把尺，否则单供应商渠道永远谎报 capacity_saturated。
  // 一个 supplier 可能挂多个账号（查询按账号展开行），先按 supplier id 去重。
  const supplierDomainById = new Map<string, string | null>();
  for (const row of withHealthyAccount) {
    supplierDomainById.set(String(row.id), row.failure_domain === null ? null : String(row.failure_domain));
  }
  const excludedIds = new Set((excluded?.supplierIds ?? []).map((id) => String(id)));
  const excludedDomains = new Set((excluded?.failureDomains ?? []).map((domain) => String(domain)));
  const leaseable = [...supplierDomainById.entries()].filter(([id, failureDomain]) =>
    !excludedIds.has(id) && !(failureDomain !== null && excludedDomains.has(failureDomain)));
  if (!leaseable.length) {
    const lastFailure = excluded?.lastFailureDetail?.trim();
    return {
      reason: "supplier_excluded",
      detail: `All eligible suppliers for ${job.modelId} were excluded after earlier failed attempts on this job`
        + (lastFailure ? ` — last upstream failure: ${lastFailure}` : "")
        + ". The job cannot reuse the same supplier; it will fail fast instead of spinning.",
    };
  }

  return {
    reason: "capacity_saturated",
    detail: `No eligible supplier could be leased for ${job.modelId} `
      + `(active leases vs limits: ${notCooling.map((row) => `${String(row.id)} ${Number(row.active_leases)}/${Number(row.concurrency_limit)}`).join(", ")}). `
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
  // INC-0830-VIDEO：upstream_protocol = 「上游成功但我们解析不出输出」——我们的
  // 解析 bug，不是上游的错。不记 health event（不拉低 success_rate_5m）、不动
  // supplier/account/capability 健康状态，渠道继续接单；只留一行日志待查。
  if (failure.failureClass === "upstream_protocol") {
    console.warn(
      `[scheduler] upstream_protocol failure (no cooldown, no health penalty) supplier=${supplier.supplierId} account=${supplier.accountId}: ${failure.detail.slice(0, 300)}`,
    );
    return;
  }
  await sql.begin(async (tx) => {
    const accountFailure = failure.failureClass === "authentication" || failure.failureClass === "quota_exhausted" || failure.failureClass === "rate_limited";
    const capabilityFailure = failure.failureClass === "model_unsupported" || failure.failureClass === "malformed_output" || failure.failureClass === "empty_result" || failure.failureClass === "artifact_download" || failure.failureClass === "pricing_config";
    // 429 is normally enforced at the channel/project boundary rather than the
    // individual credential. Persist the cooldown on both levels so another
    // worker or account cannot immediately resume the same upstream traffic.
    const supplierCooldown = failure.failureClass === "rate_limited"
      ? failure.cooldownUntil
      : accountFailure
        ? null
        : failure.cooldownUntil;
    const supplierStatus = supplierCooldown ? "cooldown" : "degraded";
    // H2：pricing_config 是我方本地配置错，只冷却该 capability，不得连坐 supplier
    // （不记 health event、不动 supplier 健康/冷却/账号成功率）。
    const localConfigFailure = failure.failureClass === "pricing_config";
    if (!localConfigFailure) {
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
    }
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

/**
 * 通用 cooldown 到期自动恢复（病灶 C，2026-08-30）。
 *
 * reportSupplierFailure 把 supplier/account 设成 'cooldown' 后，只有成功路径
 * （reportSupplierSuccess）能把健康状态捡回来；一条渠道一旦长期无单，cooldown
 * 到期后永远不会被恢复，等于一冷到底（实录：cangyuansuanli 已充值仍被 cooldown/
 * disabled 挡住 4 笔 fast；adobe2api cooldown 到 09-08 全冷著）。
 *
 * 这个定时扫描把「cooldown 已到期」的 supplier/account 保守恢复成 healthy。
 * supplier 保留历史 health_score（LEAST(1, score*0.5+0.5)，不满血），避免反覆
 * 熔断后立刻满血；supplier_account 无 health_score 列，只清状态与 cooldown。
 *
 * disabled 是「隔离待人工 / 凭证（账号）吊销」语义（quarantineSupplier 设成
 * disabled），一律不自动恢复，只能靠后台人工放行 —— 恢复条件 WHERE
 * health_status = 'cooldown' 天然排除 disabled。
 */
export async function recoverExpiredCooldowns(sql: GenerationSql = getGenerationSql()): Promise<{ recovered: number }> {
  const accounts = await sql<{ id: string }[]>`
    UPDATE supplier_account
    SET health_status = 'healthy', cooldown_until = NULL, updated_at = now()
    WHERE health_status = 'cooldown'
      AND cooldown_until IS NOT NULL AND cooldown_until <= now()
    RETURNING id
  `;
  const suppliers = await sql<{ id: string }[]>`
    UPDATE supplier
    SET health_status = 'healthy', cooldown_until = NULL,
        health_score = LEAST(1, health_score * 0.5 + 0.5), updated_at = now()
    WHERE health_status = 'cooldown'
      AND cooldown_until IS NOT NULL AND cooldown_until <= now()
    RETURNING id
  `;
  return { recovered: accounts.length + suppliers.length };
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
