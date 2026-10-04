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

test("0/5 真实失败 → unavailable；拒单讯息诚实且推荐同介质成功率最高的模型", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    // 死模型：最后一次建单 5 分钟前，半开窗口未到。
    ...failures("gemini-3.1-flash-image", 5, 5),
    // 同介质替代：gpt-image-2 3/4，pixai-tsubaki2 2/2（成功率更高）。
    row("gpt-image-2", "succeeded", 20),
    row("gpt-image-2", "succeeded", 30),
    row("gpt-image-2", "succeeded", 40),
    row("gpt-image-2", "failed", 50),
    row("pixai-tsubaki2", "succeeded", 60),
    row("pixai-tsubaki2", "succeeded", 70),
    // 不同介质的高成功率模型不得被推荐给图像模型。
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

test("user_input / cancelled 失败不计入样本：5 单用户侧失败不熔断", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    ...failures("gpt-image-2", 3, 5, { failure_class: "user_input" }),
    ...failures("gpt-image-2", 2, 40, { status: "refunded", failure_class: "user_input" }),
    ...failures("gpt-image-2", 2, 60, { status: "cancelled", failure_class: "cancelled" }),
    // 两单真实失败 < 5 样本门槛。
    ...failures("gpt-image-2", 2, 100),
  ];
  const { sql } = fakeSql(rows);
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
  assert.deepEqual(await checkModelAvailability("gpt-image-2", { sql, now, env: {} }), { allowed: true, probe: false });
});

test("样本 ≥10 且成功率 <20% → unavailable；恰 20% 不熔断", async () => {
  __resetModelBreakerStateForTests();
  // 1/10：最近 9 单全失败、最早一单成功。
  const low = [...failures("seedance-2.0", 9, 5, { kind: "video_generate" }), row("seedance-2.0", "succeeded", 200, { kind: "video_generate" })];
  // 2/10：同样最近一单失败，成功在更早。
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

test("72h 窗口外的失败不计入", async () => {
  __resetModelBreakerStateForTests();
  const { sql } = fakeSql(failures("gemini-3.1-flash-image", 6, 73 * 60));
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
});

test("半开：超过间隔放行恰 1 单试探，紧接的下一单仍被拒", async () => {
  __resetModelBreakerStateForTests();
  // 最后一次建单在 31 分钟前 → 半开窗口已到。
  const { sql } = fakeSql(failures("gemini-3.1-flash-image", 5, 31));
  const first = await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} });
  assert.deepEqual(first, { allowed: true, probe: true });

  const second = await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} });
  assert.equal(second.allowed, false);
  if (!second.allowed) {
    assert.equal(second.retryAfterSeconds, MODEL_BREAKER_HALF_OPEN_INTERVAL_MS / 1000);
  }

  // 再过一个间隔 → 再放行 1 单。
  const later = () => NOW + MODEL_BREAKER_HALF_OPEN_INTERVAL_MS;
  __resetModelBreakerStateForTests();
  const { sql: laterSql } = fakeSql(failures("gemini-3.1-flash-image", 5, 31));
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql: laterSql, now: later, env: {} }), {
    allowed: true,
    probe: true,
  });
});

test("试探单成功即恢复：最近一个计入终态成功 → available", async () => {
  __resetModelBreakerStateForTests();
  const rows = [row("gemini-3.1-flash-image", "succeeded", 2), ...failures("gemini-3.1-flash-image", 19, 40)];
  const { sql } = fakeSql(rows);
  assert.equal((await readUnavailableModels(sql, { now, env: {} })).size, 0);
  assert.deepEqual(await checkModelAvailability("gemini-3.1-flash-image", { sql, now, env: {} }), {
    allowed: true,
    probe: false,
  });
});

test("fail-open：DB 读取失败不拦任何模型；回滚开关关闭整个闸", async () => {
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
  assert.equal(queries.length, 0, "停用时不读 DB");
});

test("提交 fail-fast：被判死的模型在建单与预扣费之前拒单，零 SQL 写入、零计费调用", async () => {
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
  assert.equal(queries.length, 0, "无幂等键时拒单不得触碰 DB（不建 job、不 reserve）");
  assert.equal(billingCalls, 0);

  // 带幂等键但原 job 不存在：只允许一次只读幂等查询，仍拒单。
  await assert.rejects(
    submitGenerationCommand({ ...command, idempotencyKey: "k-1" }, { sql, billingAdapter, availabilityGate: async () => blocked }),
    GenerationModelUnavailableError,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0], /SELECT id FROM generation_job/);
  assert.doesNotMatch(queries[0], /INSERT|UPDATE|billing_operation/i);
  assert.equal(billingCalls, 0);
});

test("供给面断供（帐号全 disabled）→ 立即不可用、不放试探、列表标出；替代不含断供模型（INC-VIDEO-0927b）", async () => {
  __resetModelBreakerStateForTests();
  const rows = [
    // 断供模型在窗口内没有任何终态样本（排队中的单不算）——旧闸会判 closed 放行。
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

  // 即使过了半开间隔也不放试探：断供时试探不可能成功。
  __resetModelBreakerStateForTests();
  const later = await checkModelAvailability("seedance-2.5-480p", { sql, now: () => NOW + 24 * 60 * MIN, env: {} });
  assert.equal(later.allowed, false);

  __resetModelBreakerStateForTests();
  const listed = await readUnavailableModels(sql, { now, env: {} });
  assert.ok(listed.has("seedance-2.5-480p"));
  assert.ok(listed.has("minimax-h3"), "有历史成功但现已断供，同样下架");
  assert.equal(listed.has("veo-good"), false);

  __resetModelBreakerStateForTests();
  const minimax = await checkModelAvailability("minimax-h3", { sql, now, env: {} });
  assert.equal(minimax.allowed, false);
  if (!minimax.allowed) {
    assert.deepEqual(minimax.alternatives.map((a) => a.modelId), ["veo-good"], "替代只推有供给且有成功证据的模型");
  }
});
