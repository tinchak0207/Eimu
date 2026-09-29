import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * B 端對外契約鎖死測試（中控手術 P1/P2 護欄，域 H）。
 *
 * 原則：對外錯誤碼「承諾永不變」；Idempotency-Key 重放必須回同一 job（不重複扣費）；
 * submit_unknown 一等公民；refund 對稱；cost_coins 僅在有真實數字時出現。
 * 契約明細見 surgery/b-contract-table.md（每項標注出處）。
 *
 * 鎖法分兩層：
 * - runtime：import 穩定葉子模塊（task-response / job-repository / request-trace /
 *   biz-rate-limit-response-headers），DB 邊界用 mock SQL（零真實網絡、零真實消費）。
 *   刻意不 import 路由文件本身——其 import 樹拉進正在手術的 billing-ledger /
 *   command-service，路由接線以 source-scan 鎖（沿 route.test.ts 既有慣例）。
 * - source-scan：正則鎖路由源碼中的錯誤信封、錯誤碼、冪等接線、quota 數學。
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

// ─────────────────────────────────────────── runtime imports（穩定葉子模塊）

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

/** openapi GenerationTask 必填 13 欄（openapi.json/route.ts GenerationTask.required）。 */
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

// ─────────────────────────────────────────── mock：生成控制面 DB（內存版）

/**
 * createGenerationJob 的 SQL 邊界 mock。按 job-repository.ts 的 INSERT 列序還原行，
 * 並模擬生產的唯一約束：ON CONFLICT (tenant_id, idempotency_key)
 * WHERE idempotency_key IS NOT NULL DO NOTHING。零真實數據庫、零網絡。
 */
type Row = Record<string, unknown>;

interface FakeTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json(value: unknown): unknown;
}

interface FakeDb {
  sql: GenerationSql;
  /** tenant::idempotency_key → 行（唯一約束的另一面就是這張表的 key）。 */
  jobs: Map<string, Row>;
  /** 全部 billing_operation 寫入（驗證重放不重複扣費）。 */
  billingOperations: Array<{ jobId: unknown; operation: unknown; amount: unknown; status: unknown }>;
}

function createFakeGenerationDb(): FakeDb {
  const jobs = new Map<string, Row>();
  const billingOperations: FakeDb["billingOperations"] = [];
  let nullKeyCounter = 0;

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const text = strings.join(" ");

    if (text.includes("INSERT INTO generation_job")) {
      // 列序 = job-repository.ts INSERT INTO generation_job 的欄序。
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
      // 0 額提交的即時激活：SET status = 'queued' ... WHERE id = ${input.id} RETURNING *
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
      // 冪等重放查詢：WHERE tenant_id = ${...} AND idempotency_key = ${...}
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

// ═══════════════════════════════════════════ 錯誤信封（鐵律 ①）

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

test("鐵律①：每個對外路由的錯誤體都是 {error:{message,type,code,param:null,trace_id}}，並同步 X-Request-Id", () => {
  for (const relPath of BIZ_ROUTES) {
    const source = code(relPath);
    assert.match(source, /param:\s*null/, `${relPath} 錯誤體必須帶 param:null`);
    assert.match(source, /trace_id:\s*traceId/, `${relPath} 錯誤體必須帶 trace_id`);
    assert.match(source, /withTraceId\(/, `${relPath} 必須把 trace_id 寫進 X-Request-Id 頭`);
  }
});

test("鐵律①：錯誤 type 六枚舉是穩定承諾，openapi 原文鎖死", () => {
  const openapi = read(OPENAPI);
  for (const type of [
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "insufficient_balance",
    "api_error",
  ]) {
    assert.ok(openapi.includes(`"${type}"`), `openapi ErrorBody type 枚舉缺少 ${type}`);
  }
});

test("鐵律①：穩定錯誤碼清單（承諾永不變）——每個碼都還在 openapi 清單裡", () => {
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
    assert.ok(openapi.includes(codeName), `openapi 穩定錯誤碼清單缺少 ${codeName}——對外承諾不得縮水`);
  }
});

test("鐵律①：各端點實際拋出的錯誤碼與路由一一對應（摘除一個即爆紅）", () => {
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
      assert.ok(source.includes(`"${codeName}"`), `${relPath} 缺少錯誤碼 ${codeName}`);
    }
  }
});

test("鐵律①：認證錯誤碼四件套（store 權威，路由原樣透傳）", () => {
  const store = code("src/lib/biz-api-key-store.ts");
  for (const [codeName, status] of [
    ["missing_api_key", "401"],
    ["invalid_api_key", "401"],
    ["api_key_disabled", "403"],
    ["rate_limit_exceeded", "429"],
  ] as const) {
    assert.ok(store.includes(`"${codeName}"`), `biz-api-key-store 缺少認證錯誤碼 ${codeName}`);
    assert.ok(store.includes(`status: ${status}`), `${codeName} 應映射 HTTP ${status}`);
  }
});

test("鐵律①runtime：X-Request-Id 回顧客戶端合法 trace id，否則新生成", () => {
  const echoed = getOrCreateTraceId({ headers: new Headers({ "x-request-id": "agg-trace-1234567890" }) });
  assert.equal(echoed, "agg-trace-1234567890");
  const fresh = getOrCreateTraceId({ headers: new Headers() });
  assert.match(fresh, /^[A-Za-z0-9._-]{8,128}$/);
  assert.notEqual(fresh, getOrCreateTraceId({ headers: new Headers() }), "無入站 id 時每次應生成新 id");
  const traced = withTraceId(new Response("{}", { status: 404 }), "agg-trace-9876543210");
  assert.equal(traced.headers.get("X-Request-Id"), "agg-trace-9876543210");
});

// ═══════════════════════════════════════════ Idempotency-Key 冪等（鐵律 ②）

test("鐵律②runtime：同鍵同內容重放必須回同一 job id，且不重複寫 reserve（不重複扣費）", async () => {
  const db = createFakeGenerationDb();
  const first = await createGenerationJob(commandInput(), db.sql);
  assert.equal(first.created, true);
  assert.equal(first.job.id, "job-first");

  // 重放進程會帶一個新的 uuid（command.jobId 未傳時由 randomUUID 生成）——仍必須命中同一 job。
  const replay = await createGenerationJob(commandInput({ id: "job-replayed-uuid" }), db.sql);
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, first.job.id, "冪等重放必須回同一 job id");

  assert.equal(db.jobs.size, 1, "重放不得新增 generation_job 行");
  assert.equal(db.billingOperations.length, 1, "重放不得重複寫 billing_operation reserve");
  assert.equal(db.billingOperations[0].operation, "reserve");
});

test("鐵律②runtime：同鍵不同內容必須拒絕（IdempotencyConflictError 攜既有 job id → 路由 409）", async () => {
  const db = createFakeGenerationDb();
  await createGenerationJob(commandInput(), db.sql);
  let caught: unknown;
  try {
    await createGenerationJob(commandInput({ id: "job-other", requestHash: "hash-B" }), db.sql);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof IdempotencyConflictError, "同鍵異內容必須拋 IdempotencyConflictError");
  assert.equal((caught as IdempotencyConflictError).jobId, "job-first", "錯誤必須攜帶既有 job id");
  assert.equal(db.jobs.size, 1, "衝突重放不得新增行");
});

test("鐵律②runtime：0 額提交即激活為 queued，重放同樣回同一 job 且不重複記帳", async () => {
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

test("鐵律②runtime：無 Idempotency-Key 的提交永不誤觸冪等衝突（部分唯一索引語義）", async () => {
  const db = createFakeGenerationDb();
  const a = await createGenerationJob(commandInput({ id: "job-a", idempotencyKey: null }), db.sql);
  const b = await createGenerationJob(commandInput({ id: "job-b", idempotencyKey: null }), db.sql);
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(db.jobs.size, 2);
});

test("鐵律②runtime：跨 tenant 同名 Idempotency-Key 不衝突（tenant 隔離）", async () => {
  const db = createFakeGenerationDb();
  await createGenerationJob(commandInput({ tenantId: "biz:key-1" }), db.sql);
  const other = await createGenerationJob(commandInput({ tenantId: "biz:key-2", id: "job-key2" }), db.sql);
  assert.equal(other.created, true, "另一把密鑰的同名 key 必須正常建單");
  assert.equal(db.jobs.size, 2);
});

test("鐵律②source：三個 generations 路由讀 Idempotency-Key 頭、衝突回 409 idempotency_key_reused、202 體與 Location 同源同一 job", () => {
  for (const [relPath, resource] of [
    [GENERATIONS, "images"],
    [VIDEOS, "videos"],
    [TTS, "tts"],
  ] as const) {
    const source = code(relPath);
    assert.match(
      source,
      /idempotencyKey:\s*req\.headers\.get\("idempotency-key"\)/,
      `${relPath} 必須把 Idempotency-Key 頭原樣交給提交命令`,
    );
    assert.match(source, /IdempotencyConflictError/, `${relPath} 必須識別冪等衝突`);
    assert.match(source, /409/, `${relPath} 冪等衝突必須回 409`);
    assert.match(source, /"idempotency_key_reused"/, `${relPath} 冪等衝突必須回穩定碼 idempotency_key_reused`);
    assert.match(source, /submitGenerationCommand\(/, `${relPath} 必須經統一提交命令`);
  }
  // 202 的 id 與 Location 都取 submitted.job.id —— 重放回同一 job 的承諾在響應層成立。
  assert.match(code(GENERATIONS), /"Location":\s*`\/v1\/images\/\$\{submitted\.job\.id\}`/);
  assert.match(code(VIDEOS), /"Location":\s*`\/v1\/videos\/\$\{submitted\.job\.id\}`/);
  // 冪等鍵歸一：空白鍵視同無鍵。
  assert.match(
    code("src/lib/generation-core/command-service.ts"),
    /idempotencyKey:\s*command\.idempotencyKey\?\.trim\(\)\s*\|\|\s*null/,
    "空白 Idempotency-Key 必須歸一成 null",
  );
});

// ═══════════════════════════════════════════ GenerationTask 欄位集與 cost_coins（鐵律 ③）

test("鐵律③runtime：非終結任務的欄位集精確等於 openapi 必填 13 欄（多餘欄位=契約漂移）", () => {
  for (const status of ["queued", "running", "unknown"] as const) {
    const response = generationTaskResponse(jobFixture(status));
    assert.deepEqual(
      Object.keys(response).sort(),
      [...TASK_REQUIRED_FIELDS].sort(),
      `${status} 任務欄位集必須恰為必填 13 欄`,
    );
    assert.equal("result_url" in response, false, `${status} 不得帶 result_url`);
    assert.equal("data" in response, false, `${status} 不得帶 data`);
    assert.equal("cost_coins" in response, false, `${status} 不得帶 cost_coins`);
    assert.equal("error" in response, false, `${status} 不得帶 error`);
  }
});

test("鐵律③runtime：succeeded 響應追加 result_url + data；cost_coins 僅在有真實數字時出現", () => {
  const withCost = generationTaskResponse(jobFixture("succeeded"), { costCoins: 0.00097 });
  assert.equal(withCost.cost_coins, 0.00097);
  assert.equal(withCost.result_url, "/v1/images/job-contract-1/result");
  assert.equal(withCost.data?.[0]?.url, "https://blob.example/output.png");

  const withoutCost = generationTaskResponse(jobFixture("succeeded"));
  assert.equal("cost_coins" in withoutCost, false, "查無真實數字時 cost_coins 欄位必須整個省略");

  const nullCost = generationTaskResponse(jobFixture("succeeded"), { costCoins: null });
  assert.equal("cost_coins" in nullCost, false, "costCoins=null（查無/DB 未配置）必須省略欄位");

  const queuedWithCost = generationTaskResponse(jobFixture("queued"), { costCoins: 5 });
  assert.equal("cost_coins" in queuedWithCost, false, "非 succeeded 恆不帶 cost_coins");
});

test("鐵律③runtime：failed 任務帶 error{code,message}，失敗不攜成功欄位", () => {
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

test("鐵律③runtime：task_url 按 kind 分派資源路徑（輪詢鍵永不變）", () => {
  assert.equal(generationTaskResponse(jobFixture("queued")).task_url, "/v1/images/job-contract-1");
  assert.equal(
    generationTaskResponse(jobFixture("queued", { kind: "video_generate" })).task_url,
    "/v1/videos/job-contract-1",
  );
  assert.equal(generationTaskResponse(jobFixture("queued", { kind: "tts" })).task_url, "/v1/tts/job-contract-1");
});

test("鐵律③runtime：request_config 恆帶 model+n，prompt 截斷至 500 字符（openapi RequestConfig）", () => {
  const response = generationTaskResponse(jobFixture("queued"));
  assert.equal(response.request_config.model, "gpt-image-2");
  assert.equal(response.request_config.n, 1);
  assert.ok(
    (response.request_config.prompt as string).length <= 500,
    "request_config.prompt 不得超過 500 字符",
  );
});

test("鐵律③source：三個狀態路由只對 succeeded 查真實花費，404 碼與輪詢頭不得動", () => {
  for (const relPath of [IMAGE_STATUS, VIDEO_STATUS, TTS_STATUS]) {
    const source = code(relPath);
    assert.match(
      source,
      /taskStatus\(job\)\s*===\s*"succeeded"\s*\?\s*await resolveTaskCostCoins\(job\.id\)\s*:\s*null/,
      `${relPath} 必須只在 succeeded 時查 cost_coins`,
    );
    assert.match(source, /"Cache-Control":\s*"no-store"/, `${relPath} 輪詢必須 no-store`);
    assert.match(source, /"task_not_found"/, `${relPath} 必須回穩定碼 task_not_found`);
    assert.match(
      source,
      /getGenerationJobForTenant\(id,\s*`biz:\$\{auth\.key\.id\}`\)/,
      `${relPath} 必須 tenant 隔離（只查自己名下 job）`,
    );
  }
});

test("鐵律③source：cost_coins 數學只認 commit+applied，amount/500000 換算幣", () => {
  const source = code("src/lib/generation-core/task-response.ts");
  assert.match(source, /operation\s*=\s*'commit'/, "只認 commit 行");
  assert.match(source, /status\s*=\s*'applied'/, "只認 applied 行");
  assert.match(source, /Number\(rows\[0\]\.amount\)\s*\/\s*500000/, "換算必須走 amount/500000（QUOTA_PER_COIN 同源）");
  assert.match(source, /return null;/, "查無/失敗必須回 null（欄位省略）");
});

test("鐵律③runtime：DB 未配置時 resolveTaskCostCoins 回 null → cost_coins 省略（零真實連接）", async () => {
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

// ═══════════════════════════════════════════ submit_unknown 一等公民（鐵律 ⑤）

test("鐵律⑤runtime：submit_unknown / billing_unknown 對外是 unknown——不判死、不帶 error、可繼續輪詢", () => {
  for (const status of ["submit_unknown", "billing_unknown"] as const) {
    assert.equal(taskStatus(jobFixture(status)), "unknown", `${status} 對外必須是 unknown`);
    const response = generationTaskResponse(jobFixture(status));
    assert.equal(response.status, "unknown");
    assert.equal("error" in response, false, `${status} 不得偽裝成失敗`);
    assert.equal(response.task_url, "/v1/images/job-contract-1", `${status} 客戶端必須能繼續輪詢`);
  }
  // 內部租約/計費態不得洩漏為對外狀態。
  assert.equal(taskStatus(jobFixture("pending_billing")), "queued");
  assert.equal(taskStatus(jobFixture("leased")), "running");
  assert.equal(taskStatus(jobFixture("refunded")), "refunded");
  assert.equal(taskStatus(jobFixture("cancelled")), "cancelled");
});

test("鐵律⑤source：unknown 在 openapi TaskStatus 枚舉與批量計數中都是正式成員", () => {
  const openapi = read(OPENAPI);
  assert.match(
    openapi,
    /TaskStatus:\s*\{\s*type:\s*"string",\s*enum:\s*\[\s*"queued",\s*"running",\s*"succeeded",\s*"failed",\s*"cancelled",\s*"refunded",\s*"unknown"/,
    "TaskStatus 七值枚舉（含 unknown）不得縮水",
  );
  assert.match(openapi, /billing_unknown \/ submit_unknown/, "批量計數 unknown 的語義描述必須覆蓋兩個內部態");
});

test("鐵律⑤source：submit_unknown / billing_unknown 在活躍隊列集裡（不會從查詢面消失）", () => {
  const source = code("src/lib/generation-core/status-query.ts");
  const list = /QUEUE_STATUSES\s*:\s*readonly GenerationJobStatus\[\]\s*=\s*\[([\s\S]*?)\];/.exec(source);
  assert.ok(list, "應能定位 QUEUE_STATUSES");
  for (const active of ["pending_billing", "billing_unknown", "queued", "leased", "submitting", "running", "submit_unknown"]) {
    assert.ok(list[1].includes(`"${active}"`), `活躍集必須包含 ${active}`);
  }
  for (const terminal of ["succeeded", "failed", "cancelled", "refunded"]) {
    assert.ok(!list[1].includes(`"${terminal}"`), `終結狀態 ${terminal} 不應出現在活躍集`);
  }
});

// ═══════════════════════════════════════════ quota / 計費對稱（鐵律 ④）

test("鐵律④source：餘額不足必須 402 insufficient_balance（type 與 code 同碼），預留先於生成", () => {
  // 權威出口 = 配額預檢閘（quota-precheck）的統一契約常數：status 402、type/code 同碼、文案逐字。
  const gate = code("src/lib/generation-core/quota-precheck.ts");
  assert.match(gate, /INSUFFICIENT_BALANCE_ERROR\s*=\s*\{/, "402 統一契約必須是單一常數（唯一真源）");
  assert.match(gate, /status:\s*402\b/, "餘額不足必須回 402");
  const occurrences = gate.split('"insufficient_balance"').length - 1;
  assert.ok(occurrences >= 2, "type 與 code 都必須是 insufficient_balance");
  assert.match(
    gate,
    /message:\s*"余额不足，本次未扣费。充值：https:\/\/eimu\.dev\/pricing"/,
    "402 文案必須逐字（暴君 2026-09-28 裁決）",
  );

  // 路由接線：預留先於生成；legacy 餘額不足出口引用同一份常數，不得另寫文案。
  const source = code(GENERATIONS);
  assert.match(source, /reserveImageQuota\(apiKey\.userId/, "必須先預留配額");
  assert.match(source, /INSUFFICIENT_BALANCE_ERROR/, "legacy 餘額不足出口必須引用統一契約常數");
});

test("鐵律④source：未出圖張數全退，退款在 after() 不阻塞響應", () => {
  const source = code(GENERATIONS);
  assert.match(source, /unusedQuota\s*=\s*coinsPerImage\s*\*\s*QUOTA_PER_COIN\s*\*\s*\(rawN\s*-\s*delivered\)/);
  assert.match(source, /after\(\s*\(\)\s*=>\s*\n?\s*refundImageQuota/);
});

test("鐵律④source：控制面退費對稱——退 billingAmount 減已 commit 差額，全退才標 refunded", () => {
  const source = code("src/lib/generation-core/billing-ledger.ts");
  assert.match(source, /Math\.max\(0,\s*job\.billingAmount\s*-\s*committed\)/, "退費 = billingAmount - committed");
  assert.match(
    source,
    /full:\s*amount\s*===\s*input\.job\.billingAmount/,
    "全額退費語義必須保留（對外 refunded vs failed 的分界）",
  );
});

test("鐵律④source：批量 quota 帳面四欄必填，billed 只有 succeeded 為 true", () => {
  const openapi = read(OPENAPI);
  const block = openapi.slice(openapi.indexOf("BatchBillingSummary:"), openapi.indexOf("BatchItemView:"));
  for (const field of ["reserved_total", "charged_total", "refunded_total", "pending_total"]) {
    assert.ok(block.includes(field), `批量 billing 摘要缺少 ${field}`);
  }
  const service = code("src/lib/generation-core/batch-service.ts");
  assert.match(service, /billed:\s*state\s*===\s*"succeeded"/, "billed 必須只在 succeeded 為 true");
});

test("鐵律④source：手術配額預檢閘（quota-precheck）拒單只准用既有契約碼，不得發明新碼", () => {
  const source = code("src/lib/generation-core/quota-precheck.ts");
  // 拒單面 = 402 insufficient_balance（統一契約）或 503 control_plane_unavailable（成員 fail-closed，行為不變）。
  assert.match(source, /status:\s*402\s*\|\s*503/, "閘門拒單狀態碼必須是既有 402/503");
  assert.match(
    source,
    /type:\s*"insufficient_balance"\s*\|\s*"api_error"/,
    "閘門拒單 type 必須落在既有枚舉內",
  );
  assert.match(
    source,
    /code:\s*"insufficient_balance"\s*\|\s*"control_plane_unavailable"/,
    "閘門不得發明新的對外錯誤碼",
  );
  assert.match(source, /余额不足，本次未扣费。充值：https:\/\/eimu\.dev\/pricing/, "402 文案必須逐字");
  // 路由接線：gate 的 status/type/code 原樣進 errorResponse，不得改寫。
  const route = code(GENERATIONS);
  assert.match(route, /enforceQuotaGate\(/, "durable 提交必須經配額預檢閘");
  assert.match(
    route,
    /errorResponse\(gate\.status,\s*gate\.message,\s*gate\.type,\s*gate\.code,\s*traceId\)/,
    "閘門拒單必須原樣透傳既有契約碼",
  );
});

// ═══════════════════════════════════════════ 響應頭契約（runtime）

test("響應頭：三個 x-ratelimit-* 頭名與 consumed 語義（輪詢不消耗）", () => {
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
  assert.equal(polled.headers.get("x-ratelimit-remaining-requests"), "60", "輪詢不消耗額度，remaining=limit");
});

test("響應頭：認證方式只認 Authorization Bearer，不依賴自定義請求頭", () => {
  for (const relPath of BIZ_ROUTES) {
    const source = code(relPath);
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${relPath} 必須從 Authorization 取令牌`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得依賴 x-user-id`);
  }
});

// ═══════════════════════════════════════════ 結果端點與 openapi 任務 schema

test("結果端點：image_generation.result / video_generation.result 形狀與 409 result_not_ready", () => {
  const image = code(IMAGE_RESULT);
  assert.match(image, /object:\s*"image_generation\.result"/);
  assert.match(image, /task_id:\s*job\.id/);
  assert.match(image, /"result_not_ready"/, "非 succeeded 必須 409 result_not_ready");
  assert.match(image, /format.*===\s*"redirect"/, "?format=redirect 向後兼容必須保留");

  const video = code(VIDEO_RESULT);
  assert.match(video, /object:\s*"video_generation\.result"/);
  assert.match(video, /video_url/);
  assert.match(video, /"result_not_ready"/);
});

test("openapi GenerationTask 必填欄與實現一致（欄位集漂移當場爆紅）", () => {
  const openapi = read(OPENAPI);
  const taskBlock = openapi.slice(openapi.indexOf("GenerationTask:"), openapi.indexOf("ImageResult:"));
  for (const field of TASK_REQUIRED_FIELDS) {
    assert.ok(taskBlock.includes(`"${field}"`), `openapi GenerationTask 必填欄缺少 ${field}`);
  }
});
