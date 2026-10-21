# Image Studio P0 Durable Generation Control Plane

## Outcome and Boundary

The P0 end state is a production request path where every accepted image request
has one durable `generation_job`, one stable task ID, one supplier lease at a
time, and one persistent supplier-health decision shared by all API and worker
instances.

This document covers only the first eight P0 items:

1. Durable generation jobs and task states.
2. `Idempotency-Key` enforcement.
3. Asynchronous `202 + task_id` delivery.
4. PostgreSQL atomic supplier/account/capability leases.
5. Cross-instance failure classification and cooldowns.
6. Versioned supplier capability contracts.
7. An isolated Adobe2API pool gated by `auto_refresh` health.
8. Supply-tier routing by failure domain, cost, capacity, quality, and latency.

Billing reconciliation, distributed tenant budgets, callback outbox, SLO, canary,
and administration work may coexist in this checkout, but are not prerequisites
for declaring this eight-item P0 scope complete.

## Runtime Topology

```mermaid
flowchart LR
  Client["Web or B API client"] --> API["Next.js API instance"]
  API --> DB[("PostgreSQL")]
  DB --> Worker["generation-worker replicas"]
  Worker --> Lease["Atomic supplier/account/capability lease"]
  Lease --> Adobe["Adobe2API independent pool"]
  Lease --> Managed["Sub2API managed pool"]
  Lease --> Relay["Relay/fallback pools"]
  Worker --> Blob["Blob artifact storage"]
  Worker --> DB
  Client --> Query["GET task / result"]
  Query --> DB
```

The API process only validates, authenticates, creates/replays a task, and
reserves billing. It does not make the upstream generation request when the
control plane is enabled. `generation-worker` is the only process that obtains a
supplier lease and contacts a provider.

## External Task Contract

When `GENERATION_CONTROL_PLANE_ENABLED=true`, `POST /v1/images/generations`
returns HTTP `202` for both a new task and a same-payload idempotent replay.

```json
{
  "object": "image_generation.task",
  "id": "TASK_ID",
  "task_id": "TASK_ID",
  "status": "queued",
  "created": 0,
  "model": "gpt-image-2",
  "requested_count": 1,
  "completed_count": 0,
  "task_url": "/v1/images/TASK_ID"
}
```

Required client behavior:

- Send `Idempotency-Key` on every create request. Scope is one tenant plus one
  key. Reusing it with a byte-equivalent canonical request returns the original
  task; reusing it with a different request returns `409
  idempotency_key_reused`.
- Treat `202` as accepted work, not a finished artifact. Poll
  `GET /v1/images/TASK_ID` with the same API key.
- On `succeeded`, use `result_url`, or request
  `GET /v1/images/TASK_ID/result?format=json` for all output URLs and artifact
  hashes.
- Do not retry a task create with a new key after a timeout. Retry the original
  request with the same `Idempotency-Key`.

Internal worker states (`pending_billing`, `leased`, `submitting`, and
`submit_unknown`) are mapped to the public task states below. Clients never make
routing decisions from internal states.

| Public state | Internal states | Meaning |
| --- | --- | --- |
| `queued` | `pending_billing`, `queued` | Accepted; awaiting billing settlement or worker capacity. |
| `running` | `leased`, `submitting`, `running` | A worker owns the task or provider attempt. |
| `succeeded` | `succeeded` | Validated artifact rows and result URLs exist. |
| `failed` | `failed` | Terminal error; task contains a classified error. |
| `cancelled` | `cancelled` | Cancelled before provider submission. |
| `refunded` | `refunded` | Terminal failure whose refund was recorded. |
| `unknown` | `billing_unknown`, `submit_unknown` | No automatic replay; reconcile before taking another charge or submit action. |

Web requests use the same database job path through `POST /api/generate-images`
and poll `GET /api/generation-jobs/TASK_ID`. The frontend adapts the completed
artifact to its existing `imageUrl` result shape.

## Durable Data Invariants

Migration: `db/migrations/001_generation_control_plane.sql`.

| Table | P0 responsibility | Important invariant |
| --- | --- | --- |
| `generation_job` | Task source of truth | `(tenant_id, idempotency_key)` is unique when the key is present. |
| `generation_attempt` | Provider-attempt evidence | `(job_id, attempt_no)` is unique. |
| `supplier_lease` | In-flight capacity | One active row per job; expired rows are removed before selection. |
| `supplier` | Channel and tier state | Contains failure domain, cost, quality, health, cooldown, and capacity. |
| `supplier_account` | Credential slot state | Contains per-account cooldown and Adobe refresh health projection. |
| `supplier_capability` | Immutable contract versions | Only one current contract per supplier/model/kind. |
| `supplier_health_event` | Five-minute health window | Scheduler health is durable and shared across replicas. |
| `artifact` | Output evidence | Only MIME-checked, dimension-checked, hash-recorded outputs are completed. |

Prompt text is AES-256-GCM encrypted before insertion. Set
`GENERATION_PROMPT_ENCRYPTION_KEY` to exactly one 32-byte Base64 value or a
64-character hexadecimal value and retain it for the lifetime of all queued and
retained jobs. Rotating this key requires an explicit multi-key migration; do not
replace it during an active queue.

## Scheduler and Circuit Rules

`src/lib/generation-core/scheduler.ts` selects one candidate inside a PostgreSQL
transaction. It locks the supplier row, counts only unexpired leases, inserts the
lease, and commits. This serializes lease allocation across API worker replicas
without using an in-process `Map`.

Selection filters enforce all of these before scoring:

- Supplier, account, and capability are enabled and outside cooldown.
- Model, operation kind, ratio, and resolution match the current versioned
  capability contract.
- Supplier, account, and capability lease counts remain below their respective
  concurrency limits.
- A `firefly_only` job can only select an `adobe2api` supplier.
- Suppliers or failure domains already failed for the same output are excluded.

Score ordering is supply tier, explicit priority, health state/score, quality,
load ratio, latency EWMA, cost, then least-recent selection. Tiers are
`first_party`, `managed_pool`, `relay`, and `fallback`; the tier is an input
to routing, never a substitute for health or capability checks.

| Provider observation | Failure class | Durable effect |
| --- | --- | --- |
| `401` / `403` | `authentication` | Disable the credential account; select another failure domain. |
| `429` | `rate_limited` | Apply `Retry-After` or 60-second cooldown to both account and supplier/channel. |
| `408`, `5xx`, overload | `overloaded` | 30-second supplier cooldown and fail over. A 408 is not an Adobe scope diagnosis. |
| Empty output | `empty_result` | Five-minute capability cooldown and fail over. |
| Invalid/undecodable output | `malformed_output` | Five-minute capability cooldown and fail over. |
| Artifact fetch failure | `artifact_download` | One-minute capability cooldown and fail over. |
| Unsupported model | `model_unsupported` | Disable the current capability contract; do not fan out blindly. |

Lease expiry is deliberately conservative. A `leased` task is re-queued. A worker
that expires after entering provider submission becomes `submit_unknown`, so the
system never guesses whether a provider side effect already happened.

## Capability Contract Rules

`tools/seed-generation-suppliers.ts` snapshots currently configured channels
into `supplier_capability` rows. A contract contains:

`public model x operation kind x aspect ratios x resolutions x edit support x
video support x supplier model mapping`.

Changing any capability field creates the next `contract_version` and marks the
previous version non-current. Do not edit a current contract in place. A request
is rejected into a durable `failed/model_unsupported` task if there is no current
contract matching its model, operation, ratio, and resolution.

Before enabling a new model or resolution:

1. Update the source catalog and seed path.
2. Run `npm run generation:seed` against the production database.
3. Review the resulting current contract rows.
4. Run one real artifact-producing acceptance task.
5. Only then expose the variant in `/v1/models` or the UI.

## Adobe2API Isolation and Health Gate

Adobe2API is seeded as its own `first_party` supplier and has no shared account
or cooldown state with Sub2API or relay suppliers. Image Studio reads only the
sanitized Adobe health response; it does not import browser credentials, cookies,
or tokens.

Every worker refreshes this projection before scheduling. An Adobe account is
eligible only when all of the following are true:

- `token_source` is exactly `auto_refresh`.
- `refresh_status` is `healthy`.
- `credential_expires_at` is more than two minutes in the future.
- Health was observed within the previous two minutes.
- Five-minute success rate is at least the account contract threshold, default
  `0.80`.

The Adobe health endpoint must return sanitized fields equivalent to:

```json
{
  "token_source": "auto_refresh",
  "refresh_status": "healthy",
  "expires_at": "2030-01-01T00:00:00Z",
  "success_rate_5m": 1
}
```

Do not make an open browser tab, a Chrome-memory scan, or a static session token
a scheduling condition. A health failure degrades the Adobe account and lets the
scheduler use an independent eligible supplier.

## Deployment Sequence

Deployment directory convention: `/opt/imagesite`; application source used by
the compose file: `/opt/imagesite/app`. Confirm these paths on the VPS before
running commands.

1. Provision a managed PostgreSQL database reachable from the API and worker
   network. Backups, point-in-time recovery, and a connection limit suitable for
   `API replicas * GENERATION_DATABASE_POOL_SIZE + worker replicas * pool size`
   are required.
2. In `/opt/imagesite/app/.env.production`, set these values through the normal
   secret store. Do not place real values in Git.

   ```dotenv
   GENERATION_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
   GENERATION_CONTROL_PLANE_ENABLED=false
   GENERATION_PROMPT_ENCRYPTION_KEY=BASE64_OR_64_HEX_CHAR_32_BYTE_KEY
   GENERATION_DATABASE_POOL_SIZE=5
   GENERATION_SUPPLIER_CONCURRENCY=4
   GENERATION_ACCOUNT_CONCURRENCY=2
   GENERATION_CAPABILITY_CONCURRENCY=2
   GENERATION_JOB_LEASE_MS=120000
   GENERATION_SUPPLIER_LEASE_MS=120000
   GENERATION_WORKER_POLL_MS=1000
   GENERATION_SUPPLIER_TIMEOUT_MS=100000
   ADOBE2API_HEALTH_PATH=/health
   ```

3. Build the current application image, then run schema migration and seed with
   the same environment as production.

   ```bash
   cd /opt/imagesite/app
   npm ci
   npm run generation:migrate
   npm run generation:seed
   ```

4. Inspect the seeded rows. Adobe must begin degraded until a sanitized health
   projection proves `auto_refresh`; this is expected.

   ```sql
   SELECT id, label, supply_tier, health_status, failure_domain
   FROM supplier
   ORDER BY supply_tier, priority;

   SELECT supplier_id, public_model_id, kind, contract_version, is_current,
          ratios, resolutions, enabled
   FROM supplier_capability
   ORDER BY supplier_id, public_model_id, kind, contract_version;
   ```

5. Start one worker before enabling the API cutover. In the VPS compose directory:

   ```bash
   cd /opt/imagesite
   docker compose up -d --build generation-worker
   docker compose logs --tail=100 generation-worker
   ```

6. Confirm a worker has completed its Adobe health refresh, then set
   `GENERATION_CONTROL_PLANE_ENABLED=true` in the deployed application secret
   file and roll both API and worker containers.

   ```bash
   cd /opt/imagesite
   docker compose up -d --build nextjs generation-worker
   docker compose ps
   ```

7. Preserve the previous application image and set the flag back to `false` to
   return only the HTTP route to legacy synchronous delivery. Do not delete the
   database, jobs, leases, or artifacts as part of rollback; they are evidence
   needed for reconciliation.

## P0 Acceptance Evidence

The following must be performed against production-like PostgreSQL and real
configured channels before claiming production readiness. `/v1/models`, a 200
health response, a UI state, or an empty provider response is not evidence.

| Test | Procedure | Required proof |
| --- | --- | --- |
| Task creation | Submit one B API request with a new key. | HTTP 202, one `generation_job`, one reserve operation, one final valid Blob artifact. |
| Idempotency | Send 20 concurrent same-body requests with the same tenant/key. | One task ID, one job row, one reserve row, one provider attempt per requested output. |
| Idempotency conflict | Reuse the key with changed prompt/size/model. | HTTP 409, no new job, no second reserve or provider attempt. |
| Worker lease | Run two worker replicas with a supplier/account/capability limit of one. | At no timestamp does `supplier_lease` exceed one active row for any scoped dimension. |
| 429 breaker | Make a controlled supplier return 429 plus `Retry-After`. Restart a worker. | Persisted supplier and account cooldown remains; no request reaches that supplier before expiry. |
| Auth breaker | Make one credential return 401 or 403. | That `supplier_account` becomes `disabled`; an independent supplier can complete the task. |
| Overload failover | Make one provider return 408 and another return a valid image. | First attempt is `overloaded`; task succeeds through the other failure domain; no Adobe scope misclassification. |
| Artifact gate | Return empty data, invalid bytes, and an unreachable output URL in separate controlled runs. | No `succeeded` task is produced without MIME, decode, dimensions, SHA-256, and a durable artifact row. |
| Adobe gate | Publish health data with non-`auto_refresh`, stale observation, bad refresh, expiry under two minutes, and success rate under threshold. | Each case excludes Adobe from `supplier_lease`; a healthy auto-refresh account is selected only after its projection passes. |
| Tier routing | Give eligible suppliers distinct tier, cost, quality, capacity, and latency values. | Lease selection reflects configured tier plus health/load/cost/quality rules, not static priority alone. |

Useful observation queries:

```sql
SELECT id, tenant_id, model_id, status, attempt_count, completed_count,
       failure_class, created_at, finished_at
FROM generation_job
ORDER BY created_at DESC
LIMIT 50;

SELECT job_id, attempt_no, supplier_id, status, provider_http_status,
       failure_class, submitted_at, finished_at
FROM generation_attempt
ORDER BY submitted_at DESC
LIMIT 100;

SELECT supplier_id, supplier_account_id, supplier_capability_id, job_id,
       worker_id, expires_at
FROM supplier_lease
WHERE expires_at > now()
ORDER BY expires_at;

SELECT account.id, supplier.label, account.token_source, account.refresh_status,
       account.credential_expires_at, account.success_rate_5m,
       account.health_observed_at, account.health_status
FROM supplier_account account
JOIN supplier ON supplier.id = account.supplier_id
WHERE supplier.adapter_type = 'adobe2api';
```

## Ownership and File Map

| Concern | Files |
| --- | --- |
| Schema/migration | `db/migrations/001_generation_control_plane.sql`, `tools/migrate-generation-db.ts` |
| Job create/idempotency | `src/lib/generation-core/command-service.ts`, `job-repository.ts`, `crypto.ts` |
| Task HTTP API | `src/app/api/v1/images/generations/route.ts`, `src/app/api/v1/images/[id]/route.ts`, `src/app/api/v1/images/[id]/result/route.ts` |
| Web task bridge | `src/app/api/generate-images/route.ts`, `src/app/api/generation-jobs/[id]/route.ts`, `src/hooks/use-image-generation.ts` |
| Scheduler/breakers | `src/lib/generation-core/scheduler.ts`, `failure-classifier.ts` |
| Supplier adapters | `src/lib/generation-core/supplier-adapter.ts`, `tools/seed-generation-suppliers.ts` |
| Adobe health | `src/lib/generation-core/adobe-health.ts` |
| Worker and artifacts | `src/lib/generation-core/worker-service.ts`, `artifact-service.ts`, `worker/generation-worker.ts` |
| Container runtime | `deploy/vps/Dockerfile`, `deploy/vps/docker-compose.yml`, `deploy/vps/.env.production.example` |

