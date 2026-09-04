import assert from "node:assert/strict";
import test from "node:test";

import {
  bizKeyTokenMappingEnabled,
  findBizKeyIdForNewApiToken,
  findNewApiTokenIdForBizKey,
  upsertBizKeyTokenMapping,
} from "./biz-key-token-mapping.ts";
import type { GenerationSql } from "./database.ts";

type Row = Record<string, unknown>;

/** 手術前半成品驗證的環境前提：控制面 DB + 開關都在 env，不在代碼。 */
const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function mockSql(rows: Row[] = []) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" | "));
    void values;
    return rows;
  }) as unknown as GenerationSql;
  return { sql: tagged, queries };
}

test("control-plane DB disabled means the mapping layer degrades to null/false without touching sql", async () => {
  await withEnv({ GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined }, async () => {
    assert.equal(bizKeyTokenMappingEnabled(), false);
    // 回歸針：sql 缺省時不得在參數缺省值裡求值 getGenerationSql（會在未配置時拋錯）。
    await assert.doesNotReject(findNewApiTokenIdForBizKey("key-1"));
    assert.equal(await findNewApiTokenIdForBizKey("key-1"), null);
    assert.equal(await findBizKeyIdForNewApiToken(30), null);
    assert.equal(await upsertBizKeyTokenMapping({ bizKeyId: "key-1", tokenId: 30 }), false);
  });
});

test("forward mapping resolves the new-api token id for a biz key", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { sql, queries } = mockSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "sk-ab…" }]);
    assert.equal(await findNewApiTokenIdForBizKey("key-1", sql), 42);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes("FROM biz_key_newapi_token"));
    assert.ok(queries[0].includes("WHERE biz_key_id"));
  });
});

test("missing mapping row resolves to null (precheck fail-closed upstream)", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { sql } = mockSql([]);
    assert.equal(await findNewApiTokenIdForBizKey("key-without-mapping", sql), null);
  });
});

test("reverse mapping resolves the biz key id for a token id (ledger projection direction)", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { sql, queries } = mockSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "sk-ab…" }]);
    assert.equal(await findBizKeyIdForNewApiToken(42, sql), "key-1");
    assert.ok(queries[0].includes("WHERE token_id"));
  });
});

test("upsert binds one token to one biz key with preview only (no plaintext)", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const captured: { query: string; values: unknown[] }[] = [];
    const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ query: strings.join(" | "), values });
      return [];
    }) as unknown as GenerationSql;
    const applied = await upsertBizKeyTokenMapping(
      { bizKeyId: "key-1", tokenId: 42, tokenKeyPreview: "sk-ab…" },
      tagged,
    );
    assert.equal(applied, true);
    assert.equal(captured.length, 1);
    assert.ok(captured[0].query.includes("INSERT INTO biz_key_newapi_token"));
    assert.ok(captured[0].query.includes("ON CONFLICT (biz_key_id)"));
    assert.deepEqual(captured[0].values, ["key-1", 42, "sk-ab…"]);
  });
});
