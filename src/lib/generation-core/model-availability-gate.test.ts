import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationSql } from "./database.ts";
import {
  __resetModelBreakerStateForTests,
  checkModelAvailability,
  GenerationModelUnavailableError,
  MODEL_BREAKER_DISABLED_ENV,
  MODEL_BREAKER_HALF_OPEN_INTERVAL_MS,
  readUnavailableModels,
  type ModelGateDecision,
  type ModelOutcomeRow,
} from "./model-availability-gate.ts";
import { submitGenerationCommand } from "./command-service.ts";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const MIN = 60_000;

function row(
  modelId: string,
  status: string,
  minutesAgo: number,
  overrides: Partial<ModelOutcomeRow> = {},
): ModelOutcomeRow {
  const createdAt = new Date(NOW - minutesAgo * MIN);
  return {
    model_id: modelId,
    kind: "image_generate",
    status,
    failure_class: status === "succeeded" ? null : "deadline_exceeded",
    created_at: createdAt,
    finished_at: status === "queued" ? null : new Date(createdAt.getTime() + 3 * MIN),
    updated_at: createdAt,
    ...overrides,
  };
}

function fakeSql(rows: ModelOutcomeRow[] | Error, unsupplied: string[] = []) {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ? ");
    queries.push(text);
    if (rows instanceof Error) throw rows;
    if (text.includes("supplier_capability")) return unsupplied.map((public_model_id) => ({ public_model_id }));
    return rows;
  }) as unknown as GenerationSql;
  return { sql, queries };
}

function failures(modelId: string, count: number, startMinutesAgo: number, overrides: Partial<ModelOutcomeRow> = {}) {
  return Array.from({ length: count }, (_, index) => row(modelId, "failed", startMinutesAgo + index * 10, overrides));
}

const now = () => NOW;

test("0/5 真實失敗 → unavailable；拒單訊息誠實且推薦同介質成功率最高的模型", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    // 死模型：最後一次建單 5 分鐘前，半開窗口未到。
    ...failures("gemini-3.1-flash-image", 5, 5),
    // 同介質替代：gpt-image-2 3/4，pixai-tsubaki2 2/2（成功率更高）。
    row("gpt-image-2", "succeeded", 20),
    row("gpt-image-2", "succeeded", 30),
    row("gpt-image-2", "succeeded", 40),
    row("gpt-image-2", "failed", 50),
    row("pixai-tsubaki2", "succeeded", 60),
    row("pixai-tsubaki2", "succeeded", 70),
    // 不同介質的高成功率模型不得被推薦給圖像模型。
    row("seedream-video", "succeeded", 80, { kind: "video_generate" }),
  ];
  const { sql } = fakeSql(rows);

  const unavailable = await readUnavailableModels(sql, { now, env: {} });
  assert.deepEqual([...unavailable.keys()], ["gemini-3.1-flash-image"]);

  const decision = await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.alternatives.map((alt) => alt.modelId), ["pixai-tsubaki2", "gpt-image-2"]);
  assert.match(decision.message, /暂不可用/);
  assert.match(decision.message, /最近 5 单真实生成仅 0 单成功/);
  assert.match(decision.message, /未扣费/);
  assert.match(decision.message, /pixai-tsubaki2（近期成功率 100%）/);
  assert.doesNotMatch(decision.message, /seedream-video/);

  // 健康模型照常放行。
  assert.deepEqual(await checkModelAvailability("gpt-image-2", { sql, now, env: {} }), { allowed: true, probe: false });
});

test("user_input / cancelled 失敗不計入樣本：5 單用戶側失敗不熔斷", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    ...failures("gpt-image-2", 3, 5, { failure_class: "user_input" }),
    ...failures("gpt-image-2", 2, 40, { status: "refunded", failure_class: "user_input" }),
    ...failures("gpt-image-2", 2, 60, { status: "cancelled", failure_class: "cancelled" }),
    // 兩單真實失敗 < 5 樣本門檻。
    ...failures("gpt-image-2", 2, 100),
  ];
  const { sql } = fakeSql(rows);
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
  assert.deepEqual(await checkModelAvailability("gpt-image-2", { sql, now, env: {} }), { allowed: true, probe: false });
});

test("樣本 ≥10 且成功率 <20% → unavailable；恰 20% 不熔斷", async () => {
  __resetModelBreakerStateForTests();
  // 1/10：最近 9 單全失敗、最早一單成功。
  const low = [...failures("seedance-2.0", 9, 5, { kind: "video_generate" }), row("seedance-2.0", "succeeded", 200, { kind: "video_generate" })];
  // 2/10：同樣最近一單失敗，成功在更早。
  const edge = [
    ...failures("seedance-2.0-fast", 8, 5, { kind: "video_generate" }),
    row("seedance-2.0-fast", "succeeded", 200, { kind: "video_generate" }),
    row("seedance-2.0-fast", "succeeded", 210, { kind: "video_generate" }),
  ];
  const { sql } = fakeSql([...low, ...edge]);
  const unavailable = await readUnavailableModels(sql, { now, env: {} });
  assert.equal(unavailable.has("seedance-2.0"), true);
  assert.equal(unavailable.has("seedance-2.0-fast"), false);
});

test("72h 窗口外的失敗不計入", async () => {
  __resetModelBreakerStateForTests();
  const { sql } = fakeSql(failures("gemini-3.1-flash-image", 6, 73 * 60));
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
});

test("半開：超過間隔放行恰 1 單試探，緊接的下一單仍被拒", async () => {
  __resetModelBreakerStateForTests();
  // 最後一次建單在 31 分鐘前 → 半開窗口已到。
  const { sql } = fakeSql(failures("gemini-3.1-flash-image", 5, 31));
  const first = await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} });
  assert.deepEqual(first, { allowed: true, probe: true });

  const second = await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} });
  assert.equal(second.allowed, false);
  if (!second.allowed) {
    assert.equal(second.retryAfterSeconds, MODEL_BREAKER_HALF_OPEN_INTERVAL_MS / 1000);
  }

  // 再過一個間隔 → 再放行 1 單。
  const later = () => NOW + MODEL_BREAKER_HALF_OPEN_INTERVAL_MS;
  __resetModelBreakerStateForTests();
  const { sql: laterSql } = fakeSql(failures("gemini-3.1-flash-image", 5, 31));
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql: laterSql, now: later, env: {} }), {
    allowed: true,
    probe: true,
  });
});

test("試探單成功即恢復：最近一個計入終態成功 → available", async () => {
  __resetModelBreakerStateForTests();
  const rows = [row("gemini-3.1-flash-image", "succeeded", 2), ...failures("gemini-3.1-flash-image", 19, 40)];
  const { sql } = fakeSql(rows);
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} }), {
    allowed: true,
    probe: false,
  });
});

test("fail-open：DB 讀取失敗不攔任何模型；回滾開關關閉整個閘", async () => {
  __resetModelBreakerStateForTests();
  const { sql } = fakeSql(new Error("db down"));
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} }), {
    allowed: true,
    probe: false,
  });

  __resetModelBreakerStateForTests();
  const { sql: deadSql, queries } = fakeSql(failures("gemini-3.1-flash-image", 5, 5));
  const env = { [MODEL_BREAKER_DISABLED_ENV]: "1" } as NodeJS.ProcessEnv;
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql: deadSql, now, env }), {
    allowed: true,
    probe: false,
  });
  assert.equal((await readUnavailableModels(deadSql, { now, env })).size, 0);
  assert.equal(queries.length, 0, "停用時不讀 DB");
});

test("提交 fail-fast：被判死的模型在建單與預扣費之前拒單，零 SQL 寫入、零計費調用", async () => {
  process.env.GENERATION_PROMPT_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const blocked: ModelGateDecision = {
    allowed: false,
    modelId: "gemini-3.1-flash-image",
    message: "模型 gemini-3.1-flash-image 暂不可用：……本次未提交、未扣费。",
    alternatives: [{ modelId: "gpt-image-2", successRate: 0.91, samples: 20 }],
    retryAfterSeconds: 600,
  };
  const { sql, queries } = fakeSql([]);
  let billingCalls = 0;
  const billingAdapter = new Proxy({}, {
    get() {
      billingCalls += 1;
      throw new Error("billing adapter must not be touched");
    },
  }) as never;

  const command = {
    tenantId: "web:1",
    billingUserId: 1,
    source: "web" as const,
    kind: "image_generate" as const,
    modelId: "gemini-3.1-flash-image",
    prompt: "a cat",
    billingAmount: 500_000,
  };

  await assert.rejects(
    submitGenerationCommand(command, { sql, billingAdapter, availabilityGate: async () => blocked }),
    (error: unknown) => {
      assert.ok(error instanceof GenerationModelUnavailableError);
      assert.equal(error.message, blocked.message);
      assert.deepEqual(error.alternatives.map((alt) => alt.modelId), ["gpt-image-2"]);
      return true;
    },
  );
  assert.equal(queries.length, 0, "無冪等鍵時拒單不得觸碰 DB（不建 job、不 reserve）");
  assert.equal(billingCalls, 0);

  // 帶冪等鍵但原 job 不存在：只允許一次只讀冪等查詢，仍拒單。
  await assert.rejects(
    submitGenerationCommand({ ...command, idempotencyKey: "k-1" }, { sql, billingAdapter, availabilityGate: async () => blocked }),
    GenerationModelUnavailableError,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0], /SELECT id FROM generation_job/);
  assert.doesNotMatch(queries[0], /INSERT|UPDATE|billing_operation/i);
  assert.equal(billingCalls, 0);
});

test("供給面斷供（帳號全 disabled）→ 立即不可用、不放試探、列表標出；替代不含斷供模型（INC-VIDEO-0927b）", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    // 斷供模型在窗口內沒有任何終態樣本（排隊中的單不算）——舊閘會判 closed 放行。
    row("seedance-2.5-480p", "queued", 5, { kind: "video_generate" }),
    row("minimax-h3", "succeeded", 90, { kind: "video_generate" }),
    row("veo-good", "succeeded", 30, { kind: "video_generate" }),
  ];
  const { sql } = fakeSql(rows, ["seedance-2.5-480p", "minimax-h3"]);
  const decision = await checkModelAvailability("seedance-2.5-480p", { sql, now: () => NOW + 60 * MIN, env: {} });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.match(decision.message, /供应商账户暂不可用/);
  assert.match(decision.message, /未扣费/);

  // 即使過了半開間隔也不放試探：斷供時試探不可能成功。
  __resetModelBreakerStateForTests();
  const later = await checkModelAvailability("seedance-2.5-480p", { sql, now: () => NOW + 24 * 60 * MIN, env: {} });
  assert.equal(later.allowed, false);

  __resetModelBreakerStateForTests();
  const listed = await readUnavailableModels(sql, { now, env: {} });
  assert.ok(listed.has("seedance-2.5-480p"));
  assert.ok(listed.has("minimax-h3"), "有歷史成功但現已斷供，同樣下架");
  assert.equal(listed.has("veo-good"), false);

  __resetModelBreakerStateForTests();
  const minimax = await checkModelAvailability("minimax-h3", { sql, now, env: {} });
  assert.equal(minimax.allowed, false);
  if (!minimax.allowed) {
    assert.deepEqual(minimax.alternatives.map((a) => a.modelId), ["veo-good"], "替代只推有供給且有成功證據的模型");
  }
});
