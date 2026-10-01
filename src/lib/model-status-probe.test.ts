import assert from "node:assert/strict";
import test from "node:test";
import { probeModelStatus, type ProbeEndpointInput } from "./model-status-probe.js";

// seedance-2.0：xiaoyxiao（第一順位）＋ gway（備用）兩條渠道都掛。
const env = {
  XIAOYXIAO_ENABLED: "true",
  XIAOYXIAO_BASE_URL: "https://xiaoyxiao.test/v1",
  XIAOYXIAO_API_KEY: "k-x",
  GWAY_ENABLED: "true",
  GWAY_BASE_URL: "https://gway.test/v1",
  GWAY_API_KEY: "k-g",
};

test("主渠道 403、備用渠道通 → available（2026-10-02 xiaoyxiao 封 VPS IP 事故）", async () => {
  const probed: string[] = [];
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async (endpoint: ProbeEndpointInput) => {
      probed.push(endpoint.baseURL);
      return endpoint.baseURL.includes("xiaoyxiao")
        ? { ok: false, status: 403, ms: 5, note: "上游返回 HTTP 403" }
        : { ok: true, status: 200, ms: 7 };
    },
  });
  assert.equal(entry.availability, "available");
  assert.equal(entry.latency_ms, 7);
  assert.match(entry.note ?? "", /备用渠道/);
  assert.deepEqual(probed, ["https://xiaoyxiao.test/v1", "https://gway.test/v1"]);
});

test("主渠道通 → 不再探備用", async () => {
  const probed: string[] = [];
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async (endpoint: ProbeEndpointInput) => {
      probed.push(endpoint.baseURL);
      return { ok: true, status: 200, ms: 3 };
    },
  });
  assert.equal(entry.availability, "available");
  assert.equal(entry.note, undefined);
  assert.equal(probed.length, 1);
});

test("全部渠道都不通 → unavailable，note 列出每條渠道死因", async () => {
  const entry = await probeModelStatus("seedance-2.0", {
    env,
    probeFn: async () => ({ ok: false, status: 403, ms: 5, note: "上游返回 HTTP 403" }),
  });
  assert.equal(entry.availability, "unavailable");
  assert.match(entry.note ?? "", /全部 2 个渠道不可达/);
});
