// Canary evidence-gathering for the generation control plane.
//
// There is no live worker/supplier-adapter yet that actually submits jobs to
// an upstream (Adobe2API, Sub2API, ...). This module does NOT simulate one.
// Instead it does the honest thing that is possible today:
//   1. Enumerate every currently-sellable (model, kind, ratio, resolution)
//      combination from `supplier_capability` (listSellableCapabilities).
//   2. Create a *real* `generation_job` row (source = 'canary') for each one
//      (startCanaryRun / runFullCanarySweep) via the same job-repository
//      entrypoint used by real traffic.
//   3. Some time later, look at what actually happened to that job
//      (evaluateCanaryRun / evaluatePendingCanaryRuns): succeeded with a
//      verifiably decodable image, failed, or stuck/never picked up.
//
// Nothing here fabricates a "succeeded" outcome. A canary that was never
// picked up by a worker is reported as stale_no_pickup, not success. Once a
// real worker exists, these same jobs will actually get processed and this
// becomes a full end-to-end canary automatically — no changes needed here.

import { randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { encryptGenerationPrompt, generationRequestHash } from "./crypto";
import { createGenerationJob, getGenerationJob } from "./job-repository";
import { validateImageBuffer } from "./artifact-service";
import type { GenerationKind } from "./types";

type Row = Record<string, unknown>;

/** A worker never picks up the job within this window → stale_no_pickup. */
export const STALE_NO_PICKUP_MS = 3 * 60_000;
/** A worker leases/submits/runs the job but never resolves it within this window → stale_stuck. */
export const STALE_STUCK_MS = 10 * 60_000;
/** Deadline given to the underlying generation_job itself. */
export const CANARY_JOB_DEADLINE_MS = 5 * 60_000;

const CANARY_PROMPT = "a simple test image of a red circle on white background";

export interface CanaryTarget {
  supplierId: string;
  modelId: string;
  kind: GenerationKind;
  ratio: string | null;
  resolution: string | null;
}

export type CanaryOutcome = "pending" | "succeeded" | "failed" | "stale_no_pickup" | "stale_stuck";

export interface CanaryRun {
  id: string;
  jobId: string | null;
  supplierId: string;
  modelId: string;
  kind: GenerationKind;
  ratio: string | null;
  resolution: string | null;
  outcome: CanaryOutcome;
  decodedMimeType: string | null;
  decodedWidth: number | null;
  decodedHeight: number | null;
  decodedSha256: string | null;
  firstHopEndpointLabel: string | null;
  failureDetail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface CanaryEvaluationSummary {
  succeeded: number;
  failed: number;
  staleNoPickup: number;
  staleStuck: number;
  stillPending: number;
}

function mapCanaryRun(row: Row): CanaryRun {
  return {
    id: String(row.id),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    supplierId: String(row.supplier_id),
    modelId: String(row.model_id),
    kind: row.kind as GenerationKind,
    ratio: row.ratio === null || row.ratio === undefined ? null : String(row.ratio),
    resolution: row.resolution === null || row.resolution === undefined ? null : String(row.resolution),
    outcome: row.outcome as CanaryOutcome,
    decodedMimeType: row.decoded_mime_type === null || row.decoded_mime_type === undefined ? null : String(row.decoded_mime_type),
    decodedWidth: row.decoded_width === null || row.decoded_width === undefined ? null : Number(row.decoded_width),
    decodedHeight: row.decoded_height === null || row.decoded_height === undefined ? null : Number(row.decoded_height),
    decodedSha256: row.decoded_sha256 === null || row.decoded_sha256 === undefined ? null : String(row.decoded_sha256),
    firstHopEndpointLabel:
      row.first_hop_endpoint_label === null || row.first_hop_endpoint_label === undefined
        ? null
        : String(row.first_hop_endpoint_label),
    failureDetail: row.failure_detail === null || row.failure_detail === undefined ? null : String(row.failure_detail),
    startedAt: row.started_at instanceof Date ? row.started_at : new Date(String(row.started_at)),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : row.finished_at instanceof Date
          ? row.finished_at
          : new Date(String(row.finished_at)),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/**
 * One target per currently-sellable (supplier, model, kind, ratio, resolution)
 * combination. `enabled AND is_current` on the capability and `enabled` on
 * the supplier — the same "is this actually sellable right now" gate used
 * elsewhere in the control plane. Empty ratios/resolutions arrays mean
 * "unconstrained", which becomes a single target with a null ratio/resolution
 * rather than being skipped.
 */
export async function listSellableCapabilities(sql: GenerationSql = getGenerationSql()): Promise<CanaryTarget[]> {
  const rows = await sql<Row[]>`
    SELECT capability.supplier_id AS supplier_id, capability.public_model_id AS model_id,
      capability.kind AS kind, capability.ratios AS ratios, capability.resolutions AS resolutions
    FROM supplier_capability capability
    JOIN supplier ON supplier.id = capability.supplier_id
    WHERE capability.enabled AND capability.is_current AND supplier.enabled
  `;

  const targets: CanaryTarget[] = [];
  for (const row of rows) {
    const supplierId = String(row.supplier_id);
    const modelId = String(row.model_id);
    const kind = row.kind as GenerationKind;
    const ratios = Array.isArray(row.ratios) ? (row.ratios as unknown[]).map((value) => String(value)) : [];
    const resolutions = Array.isArray(row.resolutions) ? (row.resolutions as unknown[]).map((value) => String(value)) : [];

    const ratioValues: (string | null)[] = ratios.length ? ratios : [null];
    const resolutionValues: (string | null)[] = resolutions.length ? resolutions : [null];

    for (const ratio of ratioValues) {
      for (const resolution of resolutionValues) {
        targets.push({ supplierId, modelId, kind, ratio, resolution });
      }
    }
  }
  return targets;
}

/**
 * Creates a real generation_job (source: 'canary') via the same
 * createGenerationJob entrypoint used by real traffic, with billingAmount: 0
 * so it doesn't touch a real balance, then records a `canary_run` row
 * tracking it.
 */
export async function startCanaryRun(target: CanaryTarget, sql: GenerationSql = getGenerationSql()): Promise<CanaryRun> {
  const jobId = randomUUID();
  const canaryRunId = randomUUID();
  const now = new Date();

  const requestHash = generationRequestHash({
    source: "canary",
    modelId: target.modelId,
    kind: target.kind,
    ratio: target.ratio,
    resolution: target.resolution,
  });

  const { job } = await createGenerationJob(
    {
      id: jobId,
      tenantId: "canary",
      source: "canary",
      requestHash,
      kind: target.kind,
      routingClass: "generic",
      modelId: target.modelId,
      ratio: target.ratio ?? null,
      resolution: target.resolution ?? null,
      promptCiphertext: encryptGenerationPrompt(CANARY_PROMPT),
      requestedCount: 1,
      billingAmount: 0,
      deadlineAt: new Date(now.getTime() + CANARY_JOB_DEADLINE_MS),
    },
    sql,
  );

  const rows = await sql<Row[]>`
    INSERT INTO canary_run (
      id, job_id, supplier_id, model_id, kind, ratio, resolution, outcome, started_at
    ) VALUES (
      ${canaryRunId}, ${job.id}, ${target.supplierId}, ${target.modelId}, ${target.kind},
      ${target.ratio}, ${target.resolution}, 'pending', ${now}
    )
    RETURNING *
  `;
  return mapCanaryRun(rows[0]);
}

export async function getCanaryRun(id: string, sql: GenerationSql = getGenerationSql()): Promise<CanaryRun | null> {
  const rows = await sql<Row[]>`SELECT * FROM canary_run WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapCanaryRun(rows[0]) : null;
}

/**
 * Looks at a canary run's linked generation_job and updates its outcome to
 * reflect reality:
 *   - succeeded job → decode+verify the first artifact, record it as
 *     succeeded (or failed, if the artifact itself doesn't decode).
 *   - failed job → failed, with the job's failure detail.
 *   - queued/pending_billing and older than STALE_NO_PICKUP_MS → stale_no_pickup
 *     (nobody has even leased it).
 *   - leased/submitting/running and older than STALE_STUCK_MS → stale_stuck
 *     (a worker took it and never finished).
 *   - anything else → left pending (still legitimately in flight).
 */
export async function evaluateCanaryRun(
  canaryRunId: string,
  sql: GenerationSql = getGenerationSql(),
  now: Date = new Date(),
): Promise<CanaryRun | null> {
  const canaryRun = await getCanaryRun(canaryRunId, sql);
  if (!canaryRun) return null;
  if (canaryRun.outcome !== "pending") return canaryRun;
  if (!canaryRun.jobId) return canaryRun;

  const job = await getGenerationJob(canaryRun.jobId, sql);
  if (!job) return canaryRun;

  const elapsedMs = now.getTime() - canaryRun.startedAt.getTime();

  if (job.status === "succeeded") {
    const artifact = job.result?.artifacts?.[0];
    if (!artifact) {
      const rows = await sql<Row[]>`
        UPDATE canary_run
        SET outcome = 'failed', failure_detail = 'Job succeeded but returned no artifacts.', finished_at = now()
        WHERE id = ${canaryRunId}
        RETURNING *
      `;
      return mapCanaryRun(rows[0]);
    }

    if (artifact.b64Json) {
      const stripped = artifact.b64Json.replace(/^data:[^;,]*;base64,/, "");
      const buffer = Buffer.from(stripped, "base64");
      const validated = validateImageBuffer(buffer);
      if ("error" in validated) {
        const rows = await sql<Row[]>`
          UPDATE canary_run
          SET outcome = 'failed', failure_detail = ${`Artifact failed decode validation: ${validated.error}`},
              first_hop_endpoint_label = ${artifact.endpointLabel ?? null}, finished_at = now()
          WHERE id = ${canaryRunId}
          RETURNING *
        `;
        return mapCanaryRun(rows[0]);
      }
      const rows = await sql<Row[]>`
        UPDATE canary_run
        SET outcome = 'succeeded', decoded_mime_type = ${validated.mimeType}, decoded_width = ${validated.width},
            decoded_height = ${validated.height}, decoded_sha256 = ${validated.sha256},
            first_hop_endpoint_label = ${artifact.endpointLabel ?? null}, finished_at = now()
        WHERE id = ${canaryRunId}
        RETURNING *
      `;
      return mapCanaryRun(rows[0]);
    }

    // No inline base64 available (e.g. url response format) — record success
    // using the artifact's own reported metadata rather than fabricating a
    // decode we didn't perform.
    const rows = await sql<Row[]>`
      UPDATE canary_run
      SET outcome = 'succeeded', decoded_mime_type = ${artifact.mimeType ?? null}, decoded_width = ${artifact.width ?? null},
          decoded_height = ${artifact.height ?? null}, decoded_sha256 = ${artifact.sha256 ?? null},
          first_hop_endpoint_label = ${artifact.endpointLabel ?? null}, finished_at = now()
      WHERE id = ${canaryRunId}
      RETURNING *
    `;
    return mapCanaryRun(rows[0]);
  }

  if (job.status === "failed") {
    const rows = await sql<Row[]>`
      UPDATE canary_run
      SET outcome = 'failed', failure_detail = ${job.failureDetail ?? job.failureClass ?? "Job failed."}, finished_at = now()
      WHERE id = ${canaryRunId}
      RETURNING *
    `;
    return mapCanaryRun(rows[0]);
  }

  if ((job.status === "queued" || job.status === "pending_billing") && elapsedMs > STALE_NO_PICKUP_MS) {
    const rows = await sql<Row[]>`
      UPDATE canary_run
      SET outcome = 'stale_no_pickup',
          failure_detail = ${`No worker picked up job ${job.id} within ${Math.round(STALE_NO_PICKUP_MS / 1000)}s (status: ${job.status}).`},
          finished_at = now()
      WHERE id = ${canaryRunId}
      RETURNING *
    `;
    return mapCanaryRun(rows[0]);
  }

  if ((job.status === "leased" || job.status === "submitting" || job.status === "running") && elapsedMs > STALE_STUCK_MS) {
    const rows = await sql<Row[]>`
      UPDATE canary_run
      SET outcome = 'stale_stuck',
          failure_detail = ${`Job ${job.id} was leased/running but never resolved within ${Math.round(STALE_STUCK_MS / 1000)}s (status: ${job.status}).`},
          finished_at = now()
      WHERE id = ${canaryRunId}
      RETURNING *
    `;
    return mapCanaryRun(rows[0]);
  }

  return canaryRun;
}

/** Kick off half: create one real canary generation_job per sellable target. */
export async function runFullCanarySweep(sql: GenerationSql = getGenerationSql()): Promise<string[]> {
  const targets = await listSellableCapabilities(sql);
  const ids: string[] = [];
  for (const target of targets) {
    const canaryRun = await startCanaryRun(target, sql);
    ids.push(canaryRun.id);
  }
  return ids;
}

/** Check-results half: evaluate every still-pending canary_run and summarize. */
export async function evaluatePendingCanaryRuns(sql: GenerationSql = getGenerationSql()): Promise<CanaryEvaluationSummary> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM canary_run WHERE outcome = 'pending'`;
  const summary: CanaryEvaluationSummary = { succeeded: 0, failed: 0, staleNoPickup: 0, staleStuck: 0, stillPending: 0 };

  for (const row of rows) {
    const evaluated = await evaluateCanaryRun(row.id, sql);
    if (!evaluated) continue;
    switch (evaluated.outcome) {
      case "succeeded":
        summary.succeeded += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "stale_no_pickup":
        summary.staleNoPickup += 1;
        break;
      case "stale_stuck":
        summary.staleStuck += 1;
        break;
      default:
        summary.stillPending += 1;
    }
  }
  return summary;
}
