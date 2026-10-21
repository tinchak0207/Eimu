# Image Studio x GPT2Image-Pro B-end Fusion Handoff

## 0. Decision

Keep the current Image Studio frontend and its user-facing creation workflow. Replace the synchronous, per-instance supply path behind it with a durable generation control plane. Borrow GPT2Image-Pro's scheduler concepts, not its complete implementation and not its Adobe browser-session stack.

The measurable end state is: a client request creates exactly one traceable generation job, is charged at most once, never exceeds the selected supplier capacity, and ultimately has a durable result or a classified terminal failure even if a Vercel instance or worker restarts.

## 1. Source Read Findings

### GPT2Image-Pro, commit `aab2be9`

1. `apps/web/src/features/image-generation/operations.ts:1140` is the top-level generation operation. It resolves plan capability, decides Web-first versus Firefly-only, resolves a backend, calculates model and backend multipliers, records generation state, then executes under a queue.
2. `apps/web/src/features/image-backend-pool/service.ts` contains the useful supplier-control primitives:
   - `selectPoolMember`: priority, health bucket, recency, sticky bindings, model/interface filtering, and capacity selection.
   - `acquirePoolMemberInflightLease`: database transaction, expiry pruning, capacity count, then lease insert. This is the crucial cross-instance concurrency guard.
   - `classifyFailure` and `reportImageBackendResult`: separate user input errors, invalid credentials, quota exhaustion, provider rate limits, overload, network issues, and unsupported model errors; persist status/cooldown and health EWMA.
   - `resolveImageBackendPoolConfig`: returns the selected backend together with a lease that must later be released.
3. `apps/web/src/features/image-generation/adobe-direct.ts` is a complete internal Adobe path: valid cached token first, cookie refresh when needed, per-Adobe-backend token rotation, account status mutation, and best-effort credit observation.
4. `packages/shared/src/adobe/firefly-direct/client.ts` owns Adobe-specific semantics: source upload, submit, poll, output download, response normalization, and typed errors. It is an adapter, not a generic OpenAI proxy.
5. `apps/web/src/features/external-api/handlers/image-generations.ts` provides `async`, task query, callback URL validation, streaming, batch controls, and OpenAI-shaped responses.
6. Important limitation: `apps/web/src/features/image-generation/queue.ts` and `apps/web/src/features/external-api/async-image-tasks.ts` use process-local maps. Their global queue, async task table, and callback completion path are not durable across restart or multi-instance execution. Do not transplant these as the B-end job system.

### Image Studio, commit `65b722c` plus current uncommitted user work

1. `src/hooks/use-image-generation.ts` and `src/components/ImagePlayground.tsx` implement the current frontend creation contract. They expect `/api/generate-images` to return a completed image and should remain intact in phase one.
2. `src/app/api/generate-images/route.ts` is a capable C-end synchronous adapter. It accepts reference images, uses `/images/edits` for ordinary compatible upstreams, maps Adobe reference-image calls to `/chat/completions`, writes a final image to Blob before returning where possible, and records history after response.
3. `src/lib/generation-model-catalog.ts` is the correct public model/ratio/resolution contract. It maps an Image Studio model selection to an Adobe2API model identifier. Keep this as the single model capability source.
4. `src/lib/channel-registry.ts` correctly gives production, admin, and probes one static queue definition, but its circuit breaker is `endpointFailures: Map`, threshold two and cooldown sixty seconds. It is per Vercel instance.
5. `src/lib/admin-pools.ts` and `src/lib/admin-pool-store.ts` only model a static relay endpoint with priority and supported models. They do not model capacity, provider credential health, leases, cost, or account-level state. Pool configuration is Blob-backed and cached per instance.
6. `src/app/api/v1/images/generations/route.ts` is an OpenAI-compatible B-end endpoint, but it executes synchronously. For `n > 1` it generates serially, reserves all quota first, and uses `after()` for refunds. It exposes no idempotency key, async job, task query, callback, edit endpoint, or durable customer request record.
7. `src/lib/biz-image-pipeline.ts` retries endpoints synchronously under a 240-second request budget with a 100-second attempt ceiling. It shares the local circuit breaker but has no lease, no provider-specific error class, and no recovery state after process termination.
8. `src/lib/biz-api-key-store.ts` stores key records in Blob and rate windows in a process-local map. This is adequate for administrative keys and soft abuse throttling, not contractual B-end RPM/concurrency enforcement.
9. The current Adobe2API route is the supply anchor. It has independently verified `auto_refresh` operation and real Firefly image/video artifacts. Keep Adobe session lifecycle inside Adobe2API; do not add a second browser-cookie exporter or direct Firefly credential store to Image Studio.

## 2. What To Borrow, What To Preserve, What To Reject

| Area | Decision | Exact rationale |
| --- | --- | --- |
| Current frontend, professional workspace, references, history UX | Preserve | The frontend already has a creation-first interaction model and reference-image workflow. Backend migration must preserve its response shape during phase one. |
| `generation-model-catalog.ts` and Adobe2API mapping | Preserve | It prevents an admin/UI/production model capability split and already validates ratio/resolution before upstream submission. |
| GPT2 `selectPoolMember`, lease, health bucket, cooldown taxonomy | Borrow as concepts and reimplement | These solve the current cross-instance capacity and endpoint-health gap. Do not copy database code into a different repository unchanged. |
| GPT2 direct Firefly client/cookie exporter/transport fingerprint | Reject for Image Studio | It duplicates the current verified Adobe2API supply path and creates two divergent Adobe session systems. |
| GPT2 `force_firefly` intent and dedicated supplier lane | Borrow | A request explicitly sold as Firefly must not silently drift to a non-Adobe provider. |
| GPT2 async task API and callback public shape | Borrow, but make durable | Its process-local `Map` and fire-and-forget execution are insufficient. Use a persistent job table, outbox, and worker. |
| Current per-instance breaker and B-end RPM window | Replace | Both become incorrect as Vercel/worker count grows. |
| Current routing telemetry | Preserve and feed from durable attempts | The admin honesty principle is right. Replace Blob-only event truth with job-attempt records, then derive the same UI summaries. |

## 3. Target Topology

```text
Browser / B-end client
  -> Next.js API on Vercel
     -> Generation Command Service (Postgres transaction)
        -> generation_job + charge_operation + outbox_event
     -> return current synchronous compatibility response or task id

Durable Worker (separate long-running service)
  -> claim queued job with SKIP LOCKED / lease
  -> select supplier capability + acquire supplier lease
  -> Adobe2API / Sub2API / SenseNova / relay adapter
  -> persist attempt, artifact, settlement, callback outbox
  -> release supplier lease

Postgres = source of truth
Redis = optional low-latency rate limiting and wake-up only; never the only job truth
Object storage = generated artifacts, reference inputs, hashes, dimensions, retention metadata
```

Vercel remains the frontend/API edge. A separate worker is mandatory because Adobe/video work and fault recovery must not depend on an HTTP function surviving for 240-600 seconds. Place the worker with the existing service estate or on managed compute; Postgres must be managed or backed up independently of the worker host.

## 4. New Core Domain Model

Create these durable records. Naming can vary, state semantics cannot.

### `generation_job`

- `id`, `tenant_id`, `api_key_id`, `source` (`web`, `biz`), `idempotency_key`, `request_hash`
- `kind` (`image_generate`, `image_edit`, `video_generate`), `model_id`, `size`, `ratio`, `resolution`, `quality`, `prompt_ciphertext`, `workflow_json`
- `status` (`queued`, `leased`, `submitting`, `running`, `succeeded`, `failed`, `cancelled`, `submit_unknown`)
- `requested_count`, `completed_count`, `deadline_at`, `created_at`, `started_at`, `finished_at`
- unique `(tenant_id, idempotency_key)` where the key is present.

### `generation_attempt`

- `id`, `job_id`, `attempt_no`, `supplier_id`, `credential_slot_id`, `supplier_model_id`
- `status`, `provider_request_id`, `provider_task_id`, `provider_http_status`, `failure_class`, `failure_detail`, `retry_after_at`
- `submitted_at`, `first_output_at`, `finished_at`, `latency_ms`, `cost_observed`.

### `supplier` and `supplier_capability`

- Supplier is a route such as `adobe2api`, `sub2api`, `sensenova`, or a managed relay.
- Capability is explicit `(supplier, public_model_id, kind, ratio, resolution, edit_support, concurrency_limit, priority, cost, enabled)`.
- Credentials remain owned by the supplier service. For Adobe2API, Image Studio stores its health/capacity projection, never Adobe cookies/tokens.

### `supplier_lease`

- `supplier_id`, optional `credential_slot_id`, `job_id`, `expires_at`.
- Acquire inside a database transaction after pruning expired rows and checking active count against `concurrency_limit`.
- Worker heartbeats extend the lease; completion, cancellation, and watchdog release it.

### `billing_operation`

- `job_id`, `operation` (`reserve`, `commit`, `release`, `refund`), `amount`, `status`, `external_reference`, `idempotency_ref`.
- unique `(job_id, operation, sequence)`.
- It wraps current New API quota calls so a worker restart never creates a second charge or an untracked refund.

### `artifact` and `callback_delivery`

- Artifact stores object key, SHA-256, MIME type, width, height, source attempt, retention expiry, and public/signed delivery URL policy.
- Callback delivery stores payload hash, HMAC key version, status, delivery count, next attempt time, response code, and dead-letter state.

## 5. Scheduler Rules

1. Resolve model capability before a job is accepted. Never infer supported models from a channel name in the worker path.
2. Select only enabled suppliers capable of the exact requested model/kind/ratio/resolution/edit operation.
3. Score candidates by: static priority, tenant entitlement, hard cooldown, remaining capacity, health penalty, recent latency, cost, then least-recently-used tie-break.
4. Lease before upstream submission. A full supplier is skipped or queued; no optimistic parallel submission against a single account/relay.
5. Persist every failure before considering the next supplier. Error class controls action:
   - user input/content/model unsupported: terminal, no supplier switch;
   - auth/credential invalid: disable or quarantine the credential slot;
   - quota exhausted: cooldown until known reset or operator action;
   - 429: honour `Retry-After`, then persistent cooldown;
   - 408/5xx/network: retryable with bounded supplier and global budgets;
   - malformed/undecodable artifact: supplier failure, never a delivered success.
6. A Firefly-only job may select only Adobe2API capabilities. A generic job may use Adobe2API as an explicit fallback according to the configured capability matrix.
7. Retry must preserve a per-job excluded supplier/credential set. It may not retry a known failing slot until a new cooldown epoch.
8. `submit_unknown` is a first-class state. After process failure between submit and persistence, query a known provider task ID or reconcile the attempt; do not blindly submit a second paid generation.

## 6. API Compatibility Plan

### Preserve immediately

- `/api/generate-images` keeps request fields and completed response fields: `image`, `imageUrl`, `endpointLabel`.
- The existing frontend continues to submit through `use-image-generation.ts`; phase one adds no workspace layout change.
- `/v1/models` remains OpenAI-shaped and filters models by API key entitlement.

### Add

- `POST /v1/images/generations` accepts `Idempotency-Key`, `async: true`, and `callback_url`.
- `GET /v1/images/{job_id}` returns durable `queued/running/succeeded/failed` state and result URLs.
- `POST /v1/images/edits` accepts reference input using the same durable job flow.
- `POST /v1/jobs/{job_id}/cancel` is best effort and only succeeds before provider submission or where provider cancellation exists.
- Callback payloads are HMAC signed. Validate HTTPS/public destination at creation and revalidate DNS/IP at delivery.

### Migration behavior

- B-end clients that send `async: true` receive `202` and a task object.
- Existing B-end synchronous calls remain supported by waiting on the durable job for a bounded compatibility window. If unfinished, return a documented task response only under an opt-in version/header first; do not silently break OpenAI SDK clients.
- The web route submits a job then waits/polls internally until its current UX timeout. Later, the hook can poll `GET /api/generation-jobs/{id}` without changing the workspace structure.

## 7. File-Level Construction Map

### Keep, adapt only at call boundaries

- `src/components/ImagePlayground.tsx`
- `src/components/pro-workstation/InvokeInspiredWorkstation.tsx`
- `src/hooks/use-image-generation.ts`
- `src/lib/generation-model-catalog.ts`
- `src/lib/generation-workflow.ts`
- `src/lib/server-history-store.ts` as a read/history projection after durable job success
- `src/lib/routing-telemetry.ts` as a compatibility read model until the admin UI reads job attempts directly

### Replace as active execution paths

- `src/app/api/generate-images/route.ts`: thin compatibility command handler; remove direct retry loop after worker is live.
- `src/app/api/v1/images/generations/route.ts`: create/read job, not direct `generateBizImage` execution.
- `src/lib/biz-image-pipeline.ts`: retire after replacing it with the worker attempt executor.
- `src/lib/channel-registry.ts`: keep static model/admin projection, remove it as the live circuit breaker and scheduler authority.
- `src/lib/admin-pools.ts` and `src/lib/admin-pool-store.ts`: migrate configuration into supplier/capability tables; preserve current admin UI via an adapter endpoint during migration.
- `src/lib/biz-api-key-store.ts`: migrate hashes, entitlements, RPM, concurrency, and budget policy into Postgres; use Redis only for token-bucket acceleration.

### Add

- `src/lib/generation-core/command-service.ts`
- `src/lib/generation-core/job-repository.ts`
- `src/lib/generation-core/scheduler.ts`
- `src/lib/generation-core/supplier-adapter.ts`
- `src/lib/generation-core/billing-ledger.ts`
- `src/lib/generation-core/artifact-service.ts`
- `src/lib/generation-core/callback-outbox.ts`
- `src/app/api/generation-jobs/[id]/route.ts`
- `worker/` service with claim, execution, reconciliation, lease watchdog, callback delivery, and canary loops.

Do not move Adobe cookie/token logic into these modules. The Adobe2API adapter receives a sanitized request and records provider task/health data only.

## 8. Migration Sequence

### Phase A: Control plane without UI change

1. Add Postgres schema, migration tooling, job repository, and supplier/capability seed imported from the current model catalog and channel configuration.
2. Add worker and job lease. Implement a single adapter for Adobe2API text-to-image first.
3. Route only an internal canary API key through the worker. Compare actual output dimensions, artifact decoding, first-hop endpoint label, billing state, and job trace.
4. Add idempotency and billing operation records before enabling retries.

### Phase B: B-end durable contract

1. Add async/task/callback APIs behind opt-in flags.
2. Move B-end request execution from `biz-image-pipeline.ts` to jobs.
3. Migrate API key lookup, distributed RPM/concurrency, and usage ledger.
4. Enable a second supplier capability and demonstrate persistent cooldown/failover across two worker instances.

### Phase C: Web route convergence

1. Make `/api/generate-images` submit a job and long-poll it without changing the present UI response contract.
2. Add job status polling to the hook only when a response outlives the compatibility window.
3. Move history/provenance to durable job/artifact records; keep existing gallery rendering.
4. Retire direct execution loops only after web, B-end, references, and refunds use the same worker path.

## 9. Required Tests and Release Gates

1. Send 20 concurrent identical `Idempotency-Key` requests: one `generation_job`, one reserve operation, one provider submission, identical task response.
2. Kill the worker at each transition: before lease, after lease, after provider submit, after provider success, before artifact write, before commit, before callback. The job reaches one terminal truthful state with no duplicate charge.
3. Set Adobe2API capability concurrency to four; submit fifty jobs from two worker instances; observed in-flight count never exceeds four.
4. Return 429 with `Retry-After`; a restarted worker still observes the persisted cooldown and does not immediately reuse that supplier.
5. Return 408/5xx; next eligible capability is tried within the job budget. Return invalid prompt/model; no second supplier is tried.
6. Simulate a malformed image and an expired signed result URL; artifact validation fails, job is not marked succeeded, and billing follows the configured refund state.
7. Disable a supplier in admin; all worker instances stop selecting it after the configuration version advances. Restore an older version and verify rollback audit.
8. Run daily real canaries for every sellable `(model, ratio, resolution)` combination. Store decoded artifact metadata and first-hop provider evidence.
9. Run Playwright visual regression for normal and professional web modes. Frontend structure, reference upload, history, and completed-result behavior remain unchanged.
10. Show an operator view for success rate, P50/P95, queue age, job retries, supplier cooldowns, active leases, refunds, and Adobe2API `auto_refresh` health.

## 10. Explicit Non-Goals For This Workstream

- Do not redesign the Image Studio homepage, normal mode, professional workstation, prompt library, or gallery.
- Do not port GPT2Image-Pro's browser cookie exporter or direct Adobe transport.
- Do not claim a supplier/model is live from a model list, a health endpoint, or HTTP 200 alone.
- Do not place durable job state, strict rate limits, lease truth, or money state in Vercel module memory, `after()`, or a Blob list/read/write cycle.

## 11. Definition Of Done

The fusion is complete when both web and B-end requests traverse the same durable job and supplier scheduler, Adobe2API remains an independently auto-refreshed provider, a retry after an API timeout returns the same job rather than another billed generation, and production canaries prove decoded output for every advertised capability.
