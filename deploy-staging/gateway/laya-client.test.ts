import test from "node:test";
import assert from "node:assert/strict";
import { layaEnabled, layaSystemOne, layaHealth } from "./laya-client";

/**
 * 全部 mock fetch：单测不打真服务（实弹验证走 env LAYA_ENABLED=true 的手动脚本）。
 * 覆盖全部 fail-open 分支——这是本档的契约核心：判定层挂掉永不阻断主链路。
 */

type FetchArgs = [string, RequestInit?];
const realFetch = globalThis.fetch;

function mockFetch(impl: (...args: FetchArgs) => Promise<unknown>): { calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  globalThis.fetch = ((...args: FetchArgs) => {
    calls.push(args);
    return impl(...args);
  }) as typeof globalThis.fetch;
  return { calls };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

test("layaEnabled: 未设 LAYA_ENABLED → false", () => {
  withEnv({ LAYA_ENABLED: undefined, LAYA_ENDPOINT: undefined }, () => {
    assert.equal(layaEnabled(), false);
  });
});

test("layaEnabled: LAYA_ENABLED=true 但无端点 → false", () => {
  withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: undefined }, () => {
    assert.equal(layaEnabled(), false);
  });
});

test("layaEnabled: 两者皆设 → true", () => {
  withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, () => {
    assert.equal(layaEnabled(), true);
  });
});

test("layaSystemOne: 未启用 → 零动作回 null（不发出请求）", async () => {
  await withEnv({ LAYA_ENABLED: undefined, LAYA_ENDPOINT: undefined }, async () => {
    const m = mockFetch(async () => ({ ok: true, json: async () => ({}) }));
    try {
      assert.equal(await layaSystemOne({ a: 1 }, { q: { type: "noul" } }), null);
      assert.equal(m.calls.length, 0, "未配置时不应发出任何请求");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: HTTP 非 2xx → 静默 null（fail-open）", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    const m = mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    try {
      assert.equal(await layaSystemOne({ a: 1 }, { q: { type: "noul" } }), null);
      assert.equal(m.calls.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: answers 非物件（畸形）→ 静默 null", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ answers: "bad-type" }) }));
    try {
      assert.equal(await layaSystemOne({ a: 1 }, { q: { type: "noul" } }), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: answers 缺席 → 静默 null", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ model: "laya" }) }));
    try {
      assert.equal(await layaSystemOne({ a: 1 }, { q: { type: "noul" } }), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: 网路错误 → 静默 null（不 throw）", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      assert.equal(await layaSystemOne({ a: 1 }, { q: { type: "noul" } }), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: 成功 → 回传 answers（契约与 Jev 同构）", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({ answers: { jailbreak: { type: "noul", noul: 0.97 } } }),
    }));
    try {
      const out = await layaSystemOne({ prompt: "x" }, { jailbreak: { type: "noul" } });
      assert.deepEqual(out, { jailbreak: { type: "noul", noul: 0.97 } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaSystemOne: 请求带 state 与 questions 两栏", async () => {
  await withEnv({ LAYA_ENABLED: "true", LAYA_ENDPOINT: "http://127.0.0.1:8082/predict" }, async () => {
    const m = mockFetch(async () => ({ ok: true, json: async () => ({ answers: {} }) }));
    try {
      await layaSystemOne({ prompt: "hello" }, { q: { type: "noul", instructions: "?" } });
      const body = JSON.parse(String(m.calls[0][1]?.body));
      assert.deepEqual(body.state, { prompt: "hello" });
      assert.ok(body.questions.q);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("layaHealth: 未启用 → false", async () => {
  await withEnv({ LAYA_ENABLED: undefined, LAYA_ENDPOINT: undefined }, async () => {
    assert.equal(await layaHealth(), false);
  });
});
