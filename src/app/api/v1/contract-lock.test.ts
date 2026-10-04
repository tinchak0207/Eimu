import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * B 端对外契约锁死测试（中控手术 P1/P2 护栏，域 H）。
 *
 * 原则：对外错误码「承诺永不变」；Idempotency-Key 重放必须回同一 job（不重复扣费）；
 * submit_unknown 一等公民；refund 对称；cost_coins 仅在有真实数字时出现。
 * 契约明细见 surgery/b-contract-table.md（每项标注出处）。
 *
 * 锁法分两层：
 * - runtime：import 稳定叶子模块（task-response / job-repository / request-trace /
 *   biz-rate-limit-response-headers），DB 边界用 mock SQL（零真实网络、零真实消费）。
 *   刻意不 import 路由文件本身——其 import 树拉进正在手术的 billing-ledger /
 *   command-service，路由接线以 source-scan 锁（沿 route.test.ts 既有惯例）。
 * - source-scan：正则锁路由源码中的错误信封、错误码、幂等接线、quota 数学。
 */

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉注释后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ─────────────────────────────────────────── runtime imports（稳定叶子模块）

import {
  generationTaskResponse,
  resolveTaskCostCoins,
  taskStatus,
} from "../../../lib/generation-core/task-response.ts";
import {
  createGenerationJob,
  IdempotencyConflictError,
} from "../../../lib/generation-core/job-repository.ts";
import type { GenerationSql } from "../../../lib/generation-core/database.ts";
import type { CreateGenerationJobInput, GenerationJob } from "../../../lib/generation-core/types.ts";
import { addRateLimitHeaders } from "../../../lib/biz-rate-limit-response-headers.ts";
import { getOrCreateTraceId, withTraceId } from "../../../lib/request-trace.ts";

// ─────────────────────────────────────────── fixtures

type JobStatus = GenerationJob["status"];

function jobFixture(status: JobStatus, overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const succeeded = status === "succeeded";
  return {
    id: "job-contract-1",
    tenantId: "biz:key-1",
    apiKeyId: "key-1",
    billingUserId: 1001,
    source: "biz",
    idempotencyKey: "agg-run-001",
    requestHash: "hash",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "v1.ciphertext",
    workflow: { prompt: "a premium skincare bottle" },
    responseFormat: "url",
    callbackUrl: null,
    status,
    requestedCount: 1,
    completedCount: succeeded ? 1 : 0,
    retryOfTaskId: null,
    primaryResultId: succeeded ? "artifact-1" : null,
    attemptCount: succeeded ? 1 : 0,
    billingAmount: 485,
    deadlineAt: now,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: status === "failed" ? "overloaded" : null,
    failureDetail:
      status === "failed" ? "capacity_exhausted: All suppliers are busy." : null,
    result: succeeded
      ? {
          created: 1,
          artifacts: [
            {
              id: "artifact-1",
              outputIndex: 0,
              url: "https://blob.example/output.png",
              mimeType: "image/png",
              sha256: "a",
              width: 1024,
              height: 1024,
              endpointLabel: "adobe2api",
            },
          ],
        }
      : null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

/** openapi GenerationTask 必填 13 栏（openapi.json/route.ts GenerationTask.required）。 */
const TASK_REQUIRED_FIELDS = [
  "object",
  "id",
  "task_id",
  "status",
  "created",
  "model",
  "requested_count",
  "completed_count",
  "primary_result_id",
  "result_ids",
  "retry_of_task_id",
  "task_url",
  "request_config",
] as const;

// ─────────────────────────────────────────── mock：生成控制面 DB（内存版）

/**
 * createGenerationJob 的 SQL 边界 mock。按 job-repository.ts 的 INSERT 列序还原行，
 * 并模拟生产的唯一约束：ON CONFLICT (tenant_id, idempotency_key)
 * WHERE idempotency_key IS NOT NULL DO NOTHING。零真实数据库、零网络。
 */
type Row = Record<string, unknown>;

interface FakeTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json(value: unknown): unknown;
}

interface FakeDb {
  sql: GenerationSql;
  /** tenant::idempotency_key → 行（唯一约束的另一面就是这张表的 key）。 */
  jobs: Map<string, Row>;
  /** 全部 billing_operation 写入（验证重放不重复扣费）。 */
  billingOperations: Array<{ jobId: unknown; operation: unknown; amount: unknown; status: unknown }>;
}

function createFakeGenerationDb(): FakeDb {
  const jobs = new Map<string, Row>();
  const billingOperations: FakeDb["billingOperations"] = [];
  let nullKeyCounter = 0;

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const text = strings.join(" ");

    if (text.includes("INSERT INTO generation_job")) {
      // 列序 = job-repository.ts INSERT INTO generation_job 的栏序。
      const [
        id, tenantId, , , source, idempotencyKey, requestHash, kind, routingClass, modelId,
        size, ratio, resolution, quality, promptCiphertext, workflowJson, responseFormat,
        callbackUrl, retryOfTaskId, requestedCount, billingAmount, deadlineAt,
        batchId, batchIndex,
      ] = values;
      const key =
        idempotencyKey === null || idempotencyKey === undefined
          ? `${String(tenantId)}::#nullable-${nullKeyCounter++}`
          : `${String(tenantId)}::${String(idempotencyKey)}`;
      if (jobs.has(key)) return Promise.resolve([]);
      const now = new Date();
      const row: Row = {
        id,
        tenant_id: tenantId,
        api_key_id: null,
        billing_user_id: null,
        source,
        idempotency_key: idempotencyKey ?? null,
        request_hash: requestHash,
        kind,
        routing_class: routingClass,
        model_id: modelId,
        size: size ?? null,
        ratio: ratio ?? null,
        resolution: resolution ?? null,
        quality: quality ?? null,
        prompt_ciphertext: promptCiphertext,
        workflow_json: workflowJson ?? {},
        response_format: responseFormat ?? "b64_json",
        callback_url: callbackUrl ?? null,
        retry_of_job_id: retryOfTaskId ?? null,
        primary_artifact_id: null,
        batch_id: batchId ?? null,
        batch_index: batchIndex ?? null,
        status: billingAmount === 0 ? "queued" : "pending_billing",
        requested_count: requestedCount,
        completed_count: 0,
        attempt_count: 0,
        billing_amount: billingAmount,
        deadline_at: deadlineAt,
        available_at: now,
        lease_owner: null,
        lease_expires_at: null,
        failure_class: null,
        failure_detail: null,
        result_json: null,
        created_at: now,
        started_at: null,
        finished_at: null,
        updated_at: now,
      };
      jobs.set(key, row);
      return Promise.resolve([row]);
    }

    if (text.includes("INSERT INTO billing_operation")) {
      // VALUES：${uuid}, ${jobId}, 'reserve'（SQL 字面量）, ${amount}, ${status}, ${ref}, ${appliedAt}
      billingOperations.push({ jobId: values[1], operation: "reserve", amount: values[2], status: values[3] });
      return Promise.resolve([]);
    }

    if (text.includes("UPDATE generation_job")) {
      // 0 额提交的即时激活：SET status = 'queued' ... WHERE id = ${input.id} RETURNING *
      for (const row of jobs.values()) {
        if (row.id === values[0]) {
          row.status = "queued";
          row.updated_at = new Date();
          return Promise.resolve([row]);
        }
      }
      return Promise.resolve([]);
    }

    if (text.includes("SELECT * FROM generation_job") && text.includes("idempotency_key")) {
      // 幂等重放查询：WHERE tenant_id = ${...} AND idempotency_key = ${...}
      const row = jobs.get(`${String(values[0])}::${String(values[1])}`);
      return Promise.resolve(row ? [row] : []);
    }

    return Promise.resolve([]);
  }) as FakeTx;

  tx.json = (value: unknown) => value;

  return {
    sql: { begin: <T,>(fn: (tx: FakeTx) => Promise<T>) => fn(tx) } as unknown as GenerationSql,
    jobs,
    billingOperations,
  };
}

function commandInput(overrides: Partial<CreateGenerationJobInput> = {}): CreateGenerationJobInput {
  return {
    id: "job-first",
    tenantId: "biz:key-1",
    apiKeyId: "key-1",
    billingUserId: 1001,
    source: "biz",
    idempotencyKey: "agg-run-20260828-001",
    requestHash: "hash-A",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    quality: "fast",
    promptCiphertext: "v1.ciphertext",
    workflow: {},
    responseFormat: "url",
    callbackUrl: null,
    requestedCount: 2,
    billingAmount: 970,
    deadlineAt: new Date("2026-08-28T00:15:00.000Z"),
    ...overrides,
  };
}

// ═══════════════════════════════════════════ 错误信封（铁律 ①）

const GENERATIONS = "src/app/api/v1/images/generations/route.ts";
const VIDEOS = "src/app/api/v1/videos/generations/route.ts";
const TTS = "src/app/api/v1/tts/generations/route.ts";
const IMAGE_STATUS = "src/app/api/v1/images/[id]/route.ts";
const VIDEO_STATUS = "src/app/api/v1/videos/[id]/route.ts";
const TTS_STATUS = "src/app/api/v1/tts/[id]/route.ts";
const IMAGE_RESULT = "src/app/api/v1/images/[id]/result/route.ts";
const VIDEO_RESULT = "src/app/api/v1/videos/[id]/result/route.ts";
const MODEL_STATUS = "src/app/api/v1/model-status/route.ts";
const OPENAPI = "src/app/api/v1/openapi.json/route.ts";

const BIZ_ROUTES = [
  GENERATIONS,
  VIDEOS,
  TTS,
  IMAGE_STATUS,
  VIDEO_STATUS,
  TTS_STATUS,
  IMAGE_RESULT,
  VIDEO_RESULT,
  MODEL_STATUS,
];

test("铁律①：每个对外路由的错误体都是 {error:{message,type,code,param:null,trace_id}}，并同步 X-Request-Id", () => {
  for (const relPath of BIZ_ROUTES) {
    const source = code(relPath);
    assert.match(source, /param:\s*null/, `${relPath} 错误体必须带 param:null`);
    assert.match(source, /trace_id:\s*traceId/, `${relPath} 错误体必须带 trace_id`);
    assert.match(source, /withTraceId\(/, `${relPath} 必须把 trace_id 写进 X-Request-Id 头`);
  }
});

test("铁律①：错误 type 六枚举是稳定承诺，openapi 原文锁死", () => {
  const openapi = read(OPENAPI);
  for (const type of [
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "insufficient_balance",
    "api_error",
  ]) {
    assert.ok(openapi.includes(`"${type}"`), `openapi ErrorBody type 枚举缺少 ${type}`);
  }
});

test("铁律①：稳定错误码清单（承诺永不变）——每个码都还在 openapi 清单里", () => {
  const openapi = read(OPENAPI);
  const stableCodes = [
    "invalid_json",
    "missing_prompt",
    "prompt_too_long",
    "missing_model",
    "model_not_found",
    "model_not_permitted",
    "unsupported_size",
    "invalid_n",
    "no_endpoints",
    "insufficient_balance",
    "upstream_failed",
    "control_plane_unavailable",
    "idempotency_key_reused",
    "task_not_found",
    "result_not_ready",
    "missing_image",
    "missing_data",
    "image_too_large",
    "method_not_allowed",
    "invalid_request_body",
    "missing_requests",
    "empty_requests",
    "batch_too_large",
    "invalid_max_in_flight",
    "invalid_item",
    "invalid_kind",
    "invalid_control_nets",
    "submission_failed",
    "batch_not_found",
  ];
  for (const codeName of stableCodes) {
    assert.ok(openapi.includes(codeName), `openapi 稳定错误码清单缺少 ${codeName}——对外承诺不得缩水`);
  }
});

test("铁律①：各端点实际抛出的错误码与路由一一对应（摘除一个即爆红）", () => {
  const expected: Array<[string, string[]]> = [
    [GENERATIONS, ["invalid_json", "missing_prompt", "prompt_too_long", "missing_model", "model_not_found", "model_not_permitted", "unsupported_size", "invalid_n", "invalid_control_nets", "idempotency_key_reused", "control_plane_unavailable", "no_endpoints", "insufficient_balance", "upstream_failed", "method_not_allowed"]],
    [VIDEOS, ["invalid_json", "missing_prompt", "prompt_too_long", "missing_model", "model_not_found", "model_not_permitted", "invalid_n", "idempotency_key_reused", "control_plane_unavailable", "method_not_allowed"]],
    [TTS, ["invalid_json", "missing_input", "input_too_long", "idempotency_key_reused", "submit_failed"]],
    [IMAGE_STATUS, ["task_not_found"]],
    [VIDEO_STATUS, ["task_not_found"]],
    [TTS_STATUS, ["task_not_found"]],
    [IMAGE_RESULT, ["task_not_found", "result_not_ready"]],
    [VIDEO_RESULT, ["task_not_found", "result_not_ready"]],
  ];
  for (const [relPath, codes] of expected) {
    const source = code(relPath);
    for (const codeName of codes) {
      assert.ok(source.includes(`"${codeName}"`), `${relPath} 缺少错误码 ${codeName}`);
    }
  }
});

test("铁律①：认证错误码四件套（store 权威，路由原样透传）", () => {
  const store = code("src/lib/biz-api-key-store.ts");
  for (const [codeName, status] of [
    ["missing_api_key", "401"],
    ["invalid_api_key", "401"],
    ["api_key_disabled", "403"],
    ["rate_limit_exceeded", "429"],
  ] as const) {
    assert.ok(store.includes(`"${codeName}"`), `biz-api-key-store 缺少认证错误码 ${codeName}`);
    assert.ok(store.includes(`status: ${status}`), `${codeName} 应映射 HTTP ${status}`);
  }
});

test("铁律①runtime：X-Request-Id 回顾客户端合法 trace id，否则新生成", () => {
  const echoed = getOrCreateTraceId({ headers: new Headers({ "x-request-id": "agg-trace-1234567890" }) });
  assert.equal(echoed, "agg-trace-1234567890");
  const fresh = getOrCreateTraceId({ headers: new Headers() });
  assert.match(fresh, /^[A-Za-z0-9._-]{8,128}$/);
  assert.notEqual(fresh, getOrCreateTraceId({ headers: new Headers() }), "无入站 id 时每次应生成新 id");
  const traced = withTraceId(new Response("{}", { status: 404 }), "agg-trace-9876543210");
  assert.equal(traced.headers.get("X-Request-Id"), "agg-trace-9876543210");
});

// ═══════════════════════════════════════════ Idempotency-Key 幂等（铁律 ②）

test("铁律②runtime：同键同内容重放必须回同一 job id，且不重复写 reserve（不重复扣费）", async () => {
  const db = createFakeGenerationDb();
  const first = await createGenerationJob(commandInput(), db.sql);
  assert.equal(first.created, true);
  assert.equal(first.job.id, "job-first");

  // 重放进程会带一个新的 uuid（command.jobId 未传时由 randomUUID 生成）——仍必须命中同一 job。
  const replay = await createGenerationJob(commandInput({ id: "job-replayed-uuid" }), db.sql);
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, first.job.id, "幂等重放必须回同一 job id");

  assert.equal(db.jobs.size, 1, "重放不得新增 generation_job 行");
  assert.equal(db.billingOperations.length, 1, "重放不得重复写 billing_operation reserve");
  assert.equal(db.billingOperations[0].operation, "reserve");
});

test("铁律②runtime：同键不同内容必须拒绝（IdempotencyConflictError 携既有 job id → 路由 409）", async () => {
  const db = createFakeGenerationDb();
  await createGenerationJob(commandInput(), db.sql);
  let caught: unknown;
  try {
    await createGenerationJob(commandInput({ id: "job-other", requestHash: "hash-B" }), db.sql);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof IdempotencyConflictError, "同键异内容必须抛 IdempotencyConflictError");
  assert.equal((caught as IdempotencyConflictError).jobId, "job-first", "错误必须携带既有 job id");
  assert.equal(db.jobs.size, 1, "冲突重放不得新增行");
});

test("铁律②runtime：0 额提交即激活为 queued，重放同样回同一 job 且不重复记帐", async () => {
  const db = createFakeGenerationDb();
  const first = await createGenerationJob(commandInput({ billingAmount: 0 }), db.sql);
  assert.equal(first.created, true);
  assert.equal(first.job.status, "queued");
  const replay = await createGenerationJob(commandInput({ billingAmount: 0, id: "job-replay-0" }), db.sql);
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(db.jobs.size, 1);
  assert.equal(db.billingOperations.length, 1);
  assert.equal(db.billingOperations[0].status, "applied");
});

test("铁律②runtime：无 Idempotency-Key 的提交永不误触幂等冲突（部分唯一索引语义）", async () => {
  const db = createFakeGenerationDb();
  const a = await createGenerationJob(commandInput({ id: "job-a", idempotencyKey: null }), db.sql);
  const b = await createGenerationJob(commandInput({ id: "job-b", idempotencyKey: null }), db.sql);
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(db.jobs.size, 2);
});

test("铁律②runtime：跨 tenant 同名 Idempotency-Key 不冲突（tenant 隔离）", async () => {
  const db = createFakeGenerationDb();
  await createGenerationJob(commandInput({ tenantId: "biz:key-1" }), db.sql);
  const other = await createGenerationJob(commandInput({ tenantId: "biz:key-2", id: "job-key2" }), db.sql);
  assert.equal(other.created, true, "另一把密钥的同名 key 必须正常建单");
  assert.equal(db.jobs.size, 2);
});

test("铁律②source：三个 generations 路由读 Idempotency-Key 头、冲突回 409 idempotency_key_reused、202 体与 Location 同源同一 job", () => {
  for (const [relPath, _resource] of [
    [GENERATIONS, "images"],
    [VIDEOS, "videos"],
    [TTS, "tts"],
  ] as const) {
    const source = code(relPath);
    assert.match(
      source,
      /idempotencyKey:\s*req\.headers\.get\("idempotency-key"\)/,
      `${relPath} 必须把 Idempotency-Key 头原样交给提交命令`,
    );
    assert.match(source, /IdempotencyConflictError/, `${relPath} 必须识别幂等冲突`);
    assert.match(source, /409/, `${relPath} 幂等冲突必须回 409`);
    assert.match(source, /"idempotency_key_reused"/, `${relPath} 幂等冲突必须回稳定码 idempotency_key_reused`);
    assert.match(source, /submitGenerationCommand\(/, `${relPath} 必须经统一提交命令`);
  }
  // 202 的 id 与 Location 都取 submitted.job.id —— 重放回同一 job 的承诺在响应层成立。
  assert.match(code(GENERATIONS), /"Location":\s*`\/v1\/images\/\$\{submitted\.job\.id\}`/);
  assert.match(code(VIDEOS), /"Location":\s*`\/v1\/videos\/\$\{submitted\.job\.id\}`/);
  // 幂等键归一：空白键视同无键。
  assert.match(
    code("src/lib/generation-core/command-service.ts"),
    /idempotencyKey:\s*command\.idempotencyKey\?\.trim\(\)\s*\|\|\s*null/,
    "空白 Idempotency-Key 必须归一成 null",
  );
});

// ═══════════════════════════════════════════ GenerationTask 栏位集与 cost_coins（铁律 ③）

test("铁律③runtime：非终结任务的栏位集精确等于 openapi 必填 13 栏（多余栏位=契约漂移）", () => {
  for (const status of ["queued", "running", "unknown"] as const) {
    const response = generationTaskResponse(jobFixture(status));
    assert.deepEqual(
      Object.keys(response).sort(),
      [...TASK_REQUIRED_FIELDS].sort(),
      `${status} 任务栏位集必须恰为必填 13 栏`,
    );
    assert.equal("result_url" in response, false, `${status} 不得带 result_url`);
    assert.equal("data" in response, false, `${status} 不得带 data`);
    assert.equal("cost_coins" in response, false, `${status} 不得带 cost_coins`);
    assert.equal("error" in response, false, `${status} 不得带 error`);
  }
});

test("铁律③runtime：succeeded 响应追加 result_url + data；cost_coins 仅在有真实数字时出现", () => {
  const withCost = generationTaskResponse(jobFixture("succeeded"), { costCoins: 0.00097 });
  assert.equal(withCost.cost_coins, 0.00097);
  assert.equal(withCost.result_url, "/v1/images/job-contract-1/result");
  assert.equal(withCost.data?.[0]?.url, "https://blob.example/output.png");

  const withoutCost = generationTaskResponse(jobFixture("succeeded"));
  assert.equal("cost_coins" in withoutCost, false, "查无真实数字时 cost_coins 栏位必须整个省略");

  const nullCost = generationTaskResponse(jobFixture("succeeded"), { costCoins: null });
  assert.equal("cost_coins" in nullCost, false, "costCoins=null（查无/DB 未配置）必须省略栏位");

  const queuedWithCost = generationTaskResponse(jobFixture("queued"), { costCoins: 5 });
  assert.equal("cost_coins" in queuedWithCost, false, "非 succeeded 恒不带 cost_coins");
});

test("铁律③runtime：failed 任务带 error{code,message}，失败不携成功栏位", () => {
  const response = generationTaskResponse(jobFixture("failed"));
  assert.equal(response.status, "failed");
  assert.deepEqual(response.error, {
    code: "overloaded",
    reason: "capacity_exhausted",
    message: "All suppliers are busy.",
  });
  assert.equal("result_url" in response, false);
  assert.equal("cost_coins" in response, false);
});

test("铁律③runtime：task_url 按 kind 分派资源路径（轮询键永不变）", () => {
  assert.equal(generationTaskResponse(jobFixture("queued")).task_url, "/v1/images/job-contract-1");
  assert.equal(
    generationTaskResponse(jobFixture("queued", { kind: "video_generate" })).task_url,
    "/v1/videos/job-contract-1",
  );
  assert.equal(generationTaskResponse(jobFixture("queued", { kind: "tts" })).task_url, "/v1/tts/job-contract-1");
});

test("铁律③runtime：request_config 恒带 model+n，prompt 截断至 500 字符（openapi RequestConfig）", () => {
  const response = generationTaskResponse(jobFixture("queued"));
  assert.equal(response.request_config.model, "gpt-image-2");
  assert.equal(response.request_config.n, 1);
  assert.ok(
    (response.request_config.prompt as string).length <= 500,
    "request_config.prompt 不得超过 500 字符",
  );
});

test("铁律③source：三个状态路由只对 succeeded 查真实花费，404 码与轮询头不得动", () => {
  for (const relPath of [IMAGE_STATUS, VIDEO_STATUS, TTS_STATUS]) {
    const source = code(relPath);
    assert.match(
      source,
      /taskStatus\(job\)\s*===\s*"succeeded"\s*\?\s*await resolveTaskCostCoins\(job\.id\)\s*:\s*null/,
      `${relPath} 必须只在 succeeded 时查 cost_coins`,
    );
    assert.match(source, /"Cache-Control":\s*"no-store"/, `${relPath} 轮询必须 no-store`);
    assert.match(source, /"task_not_found"/, `${relPath} 必须回稳定码 task_not_found`);
    assert.match(
      source,
      /getGenerationJobForTenant\(id,\s*`biz:\$\{auth\.key\.id\}`\)/,
      `${relPath} 必须 tenant 隔离（只查自己名下 job）`,
    );
  }
});

test("铁律③source：cost_coins 数学只认 commit+applied，amount/500000 换算币", () => {
  const source = code("src/lib/generation-core/task-response.ts");
  assert.match(source, /operation\s*=\s*'commit'/, "只认 commit 行");
  assert.match(source, /status\s*=\s*'applied'/, "只认 applied 行");
  assert.match(source, /Number\(rows\[0\]\.amount\)\s*\/\s*500000/, "换算必须走 amount/500000（QUOTA_PER_COIN 同源）");
  assert.match(source, /return null;/, "查无/失败必须回 null（栏位省略）");
});

test("铁律③runtime：DB 未配置时 resolveTaskCostCoins 回 null → cost_coins 省略（零真实连接）", async () => {
  const savedUrl = process.env.GENERATION_DATABASE_URL;
  const savedDbUrl = process.env.DATABASE_URL;
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(await resolveTaskCostCoins("job-contract-1"), null);
  } finally {
    if (savedUrl !== undefined) process.env.GENERATION_DATABASE_URL = savedUrl;
    if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
  }
});

// ═══════════════════════════════════════════ submit_unknown 一等公民（铁律 ⑤）

test("铁律⑤runtime：submit_unknown / billing_unknown 对外是 unknown——不判死、不带 error、可继续轮询", () => {
  for (const status of ["submit_unknown", "billing_unknown"] as const) {
    assert.equal(taskStatus(jobFixture(status)), "unknown", `${status} 对外必须是 unknown`);
    const response = generationTaskResponse(jobFixture(status));
    assert.equal(response.status, "unknown");
    assert.equal("error" in response, false, `${status} 不得伪装成失败`);
    assert.equal(response.task_url, "/v1/images/job-contract-1", `${status} 客户端必须能继续轮询`);
  }
  // 内部租约/计费态不得泄漏为对外状态。
  assert.equal(taskStatus(jobFixture("pending_billing")), "queued");
  assert.equal(taskStatus(jobFixture("leased")), "running");
  assert.equal(taskStatus(jobFixture("refunded")), "refunded");
  assert.equal(taskStatus(jobFixture("cancelled")), "cancelled");
});

test("铁律⑤source：unknown 在 openapi TaskStatus 枚举与批量计数中都是正式成员", () => {
  const openapi = read(OPENAPI);
  assert.match(
    openapi,
    /TaskStatus:\s*\{\s*type:\s*"string",\s*enum:\s*\[\s*"queued",\s*"running",\s*"succeeded",\s*"failed",\s*"cancelled",\s*"refunded",\s*"unknown"/,
    "TaskStatus 七值枚举（含 unknown）不得缩水",
  );
  assert.match(openapi, /billing_unknown \/ submit_unknown/, "批量计数 unknown 的语义描述必须覆盖两个内部态");
});

test("铁律⑤source：submit_unknown / billing_unknown 在活跃队列集里（不会从查询面消失）", () => {
  const source = code("src/lib/generation-core/status-query.ts");
  const list = /QUEUE_STATUSES\s*:\s*readonly GenerationJobStatus\[\]\s*=\s*\[([\s\S]*?)\];/.exec(source);
  assert.ok(list, "应能定位 QUEUE_STATUSES");
  for (const active of ["pending_billing", "billing_unknown", "queued", "leased", "submitting", "running", "submit_unknown"]) {
    assert.ok(list[1].includes(`"${active}"`), `活跃集必须包含 ${active}`);
  }
  for (const terminal of ["succeeded", "failed", "cancelled", "refunded"]) {
    assert.ok(!list[1].includes(`"${terminal}"`), `终结状态 ${terminal} 不应出现在活跃集`);
  }
});

// ═══════════════════════════════════════════ quota / 计费对称（铁律 ④）

test("铁律④source：余额不足必须 402 insufficient_balance（type 与 code 同码），预留先于生成", () => {
  // 权威出口 = 配额预检闸（quota-precheck）的统一契约常数：status 402、type/code 同码、文案逐字。
  const gate = code("src/lib/generation-core/quota-precheck.ts");
  assert.match(gate, /INSUFFICIENT_BALANCE_ERROR\s*=\s*\{/, "402 统一契约必须是单一常数（唯一真源）");
  assert.match(gate, /status:\s*402\b/, "余额不足必须回 402");
  const occurrences = gate.split('"insufficient_balance"').length - 1;
  assert.ok(occurrences >= 2, "type 与 code 都必须是 insufficient_balance");
  assert.match(
    gate,
    /message:\s*"余额不足，本次未扣费。充值：https:\/\/eimu\.dev\/pricing"/,
    "402 文案必须逐字（暴君 2026-09-28 裁决）",
  );

  // 路由接线：预留先于生成；legacy 余额不足出口引用同一份常数，不得另写文案。
  const source = code(GENERATIONS);
  assert.match(source, /reserveImageQuota\(apiKey\.userId/, "必须先预留配额");
  assert.match(source, /INSUFFICIENT_BALANCE_ERROR/, "legacy 余额不足出口必须引用统一契约常数");
});

test("铁律④source：未出图张数全退，退款在 after() 不阻塞响应", () => {
  const source = code(GENERATIONS);
  assert.match(source, /unusedQuota\s*=\s*coinsPerImage\s*\*\s*QUOTA_PER_COIN\s*\*\s*\(rawN\s*-\s*delivered\)/);
  assert.match(source, /after\(\s*\(\)\s*=>\s*\n?\s*refundImageQuota/);
});

test("铁律④source：控制面退费对称——退 billingAmount 减已 commit 差额，全退才标 refunded", () => {
  const source = code("src/lib/generation-core/billing-ledger.ts");
  assert.match(source, /Math\.max\(0,\s*job\.billingAmount\s*-\s*committed\)/, "退费 = billingAmount - committed");
  assert.match(
    source,
    /full:\s*amount\s*===\s*input\.job\.billingAmount/,
    "全额退费语义必须保留（对外 refunded vs failed 的分界）",
  );
});

test("铁律④source：批量 quota 帐面四栏必填，billed 只有 succeeded 为 true", () => {
  const openapi = read(OPENAPI);
  const block = openapi.slice(openapi.indexOf("BatchBillingSummary:"), openapi.indexOf("BatchItemView:"));
  for (const field of ["reserved_total", "charged_total", "refunded_total", "pending_total"]) {
    assert.ok(block.includes(field), `批量 billing 摘要缺少 ${field}`);
  }
  const service = code("src/lib/generation-core/batch-service.ts");
  assert.match(service, /billed:\s*state\s*===\s*"succeeded"/, "billed 必须只在 succeeded 为 true");
});

test("铁律④source：手术配额预检闸（quota-precheck）拒单只准用既有契约码，不得发明新码", () => {
  const source = code("src/lib/generation-core/quota-precheck.ts");
  // 拒单面 = 402 insufficient_balance（统一契约）或 503 control_plane_unavailable（成员 fail-closed，行为不变）。
  assert.match(source, /status:\s*402\s*\|\s*503/, "闸门拒单状态码必须是既有 402/503");
  assert.match(
    source,
    /type:\s*"insufficient_balance"\s*\|\s*"api_error"/,
    "闸门拒单 type 必须落在既有枚举内",
  );
  assert.match(
    source,
    /code:\s*"insufficient_balance"\s*\|\s*"control_plane_unavailable"/,
    "闸门不得发明新的对外错误码",
  );
  assert.match(source, /余额不足，本次未扣费。充值：https:\/\/eimu\.dev\/pricing/, "402 文案必须逐字");
  // 路由接线：gate 的 status/type/code 原样进 errorResponse，不得改写。
  const route = code(GENERATIONS);
  assert.match(route, /enforceQuotaGate\(/, "durable 提交必须经配额预检闸");
  assert.match(
    route,
    /errorResponse\(gate\.status,\s*gate\.message,\s*gate\.type,\s*gate\.code,\s*traceId\)/,
    "闸门拒单必须原样透传既有契约码",
  );
});

// ═══════════════════════════════════════════ 响应头契约（runtime）

test("响应头：三个 x-ratelimit-* 头名与 consumed 语义（轮询不消耗）", () => {
  type KeyParam = Parameters<typeof addRateLimitHeaders>[1];
  const consumed = addRateLimitHeaders(new Response(null, { status: 202 }), { rpm: 60 } as unknown as KeyParam, {
    consumed: true,
  });
  assert.equal(consumed.headers.get("x-ratelimit-limit-requests"), "60");
  assert.equal(consumed.headers.get("x-ratelimit-remaining-requests"), "59");
  assert.ok(consumed.headers.get("x-ratelimit-reset-requests"));

  const polled = addRateLimitHeaders(new Response(null, { status: 200 }), { rpm: 60 } as unknown as KeyParam, {
    consumed: false,
  });
  assert.equal(polled.headers.get("x-ratelimit-remaining-requests"), "60", "轮询不消耗额度，remaining=limit");
});

test("响应头：认证方式只认 Authorization Bearer，不依赖自定义请求头", () => {
  for (const relPath of BIZ_ROUTES) {
    const source = code(relPath);
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${relPath} 必须从 Authorization 取令牌`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得依赖 x-user-id`);
  }
});

// ═══════════════════════════════════════════ 结果端点与 openapi 任务 schema

test("结果端点：image_generation.result / video_generation.result 形状与 409 result_not_ready", () => {
  const image = code(IMAGE_RESULT);
  assert.match(image, /object:\s*"image_generation\.result"/);
  assert.match(image, /task_id:\s*job\.id/);
  assert.match(image, /"result_not_ready"/, "非 succeeded 必须 409 result_not_ready");
  assert.match(image, /format.*===\s*"redirect"/, "?format=redirect 向后兼容必须保留");

  const video = code(VIDEO_RESULT);
  assert.match(video, /object:\s*"video_generation\.result"/);
  assert.match(video, /video_url/);
  assert.match(video, /"result_not_ready"/);
});

test("openapi GenerationTask 必填栏与实现一致（栏位集漂移当场爆红）", () => {
  const openapi = read(OPENAPI);
  const taskBlock = openapi.slice(openapi.indexOf("GenerationTask:"), openapi.indexOf("ImageResult:"));
  for (const field of TASK_REQUIRED_FIELDS) {
    assert.ok(taskBlock.includes(`"${field}"`), `openapi GenerationTask 必填栏缺少 ${field}`);
  }
});
