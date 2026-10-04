import assert from "node:assert/strict";
import test from "node:test";
import { probeModelStatus, type ProbeEndpointInput } from "./model-status-probe.js";

// seedance-2.0：xiaoyxiao（第一顺位）＋ gway（备用）两条渠道都挂。
const env = {
  XIAOYXIAO_ENABLED: "true",
  XIAOYXIAO_BASE_URL: "https://xiaoyxiao.test/v1",
  XIAOYXIAO_API_KEY: "k-x",
  GWAY_ENABLED: "true",
  GWAY_BASE_URL: "https://gway.test/v1",
  GWAY_API_KEY: "k-g",
};

test("主渠道 403、备用渠道通 → available（2026-10-02 xiaoyxiao 封 VPS IP 事故）", async () => {
  const probed: string[] = [];
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async (endpoint: ProbeEndpointInput) => {
      probed.push(endpoint.baseURL);
      return endpoint.baseURL.includes("xiaoyxiao")
        ? { ok: false, status: 403, ms: 5, note: "上游返回 HTTP 403" }
        : { ok: true, status: 200, ms: 7, modelIds: ["seedance-2.0-900-特惠"] };
    },
  });
  assert.equal(entry.availability, "available");
  assert.equal(entry.latency_ms, 7);
  assert.match(entry.note ?? "", /备用渠道/);
  assert.deepEqual(probed, ["https://xiaoyxiao.test/v1", "https://gway.test/v1"]);
});

test("主渠道通 → 不再探备用", async () => {
  const probed: string[] = [];
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async (endpoint: ProbeEndpointInput) => {
      probed.push(endpoint.baseURL);
      return { ok: true, status: 200, ms: 3, modelIds: ["seedance-2.0-900-特惠"] };
    },
  });
  assert.equal(entry.availability, "available");
  assert.equal(entry.note, undefined);
  assert.equal(probed.length, 1);
});

test("全部渠道都不通 → unavailable，note 列出每条渠道死因", async () => {
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async () => ({ ok: false, status: 403, ms: 5, note: "上游返回 HTTP 403" }),
  });
  assert.equal(entry.availability, "unavailable");
  assert.match(entry.note ?? "", /全部 2 个渠道不可达/);
});

test("/models 200 但清单没有上游模型名 → 不算通，继续探下一顺位（2026-10-02 hublinuxdo 零生图模型实锤）", async () => {
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async (endpoint: ProbeEndpointInput) =>
      endpoint.baseURL.includes("xiaoyxiao")
        ? { ok: true, status: 200, ms: 4, modelIds: ["glm-5.3", "deepseek-v4-flash"] }
        : { ok: true, status: 200, ms: 6, modelIds: ["seedance-2.0-900-特惠"] },
  });
  assert.equal(entry.availability, "available");
  assert.equal(entry.channel_id, "env:gway");
  assert.match(entry.note ?? "", /未列出上游模型 seedance-2\.0-900-特惠/);
});

test("所有渠道 /models 都不列该模型 → unavailable", async () => {
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async () => ({ ok: true, status: 200, ms: 4, modelIds: ["glm-5.3"] }),
  });
  assert.equal(entry.availability, "unavailable");
  assert.match(entry.note ?? "", /全部 2 个渠道不可达/);
});
