import assert from "node:assert/strict";
import test from "node:test";

import { GENERATION_MODEL_CATALOG } from "./generation-model-catalog";
import { REGISTRY_CHANNELS } from "./supplier-channels.config";
import {
  MODEL_ROUTES,
  NEWAPI_ROUTE_LABEL,
  NEWAPI_SUPERSEDED_LABELS,
  modelsRoutedTo,
  routeSupplierId,
} from "./model-routes.config";
import { effectiveRoute, normalizeRouteInput, type ModelRouteOverrideRow } from "./generation-core/model-routing";
import { appendLabelToRoutes } from "../../tools/add-supplier-channel";

// 控面直连渠道全集：registry 条目 + 旧硬编码仍直连的 adobe2api + new-api 那一步。
const DIRECT_LABELS = new Set([...REGISTRY_CHANNELS.map((channel) => channel.label), "adobe2api", NEWAPI_ROUTE_LABEL]);

test("MODEL_ROUTES：每个模型都在 catalog 里（打错 id＝那条路由永远用不到）", () => {
  const missing = Object.keys(MODEL_ROUTES).filter((modelId) => !GENERATION_MODEL_CATALOG[modelId]);
  assert.deepEqual(missing, []);
});

test("MODEL_ROUTES：每一步都是已知渠道，且不含已并入 new-api 的旧 label", () => {
  for (const [modelId, route] of Object.entries(MODEL_ROUTES)) {
    assert.equal(new Set(route).size, route.length, `${modelId} 路由有重复渠道`);
    for (const label of route) {
      assert.ok(!NEWAPI_SUPERSEDED_LABELS.has(label), `${modelId} → ${label} 已并入 new-api，应写 "${NEWAPI_ROUTE_LABEL}"`);
      assert.ok(DIRECT_LABELS.has(label), `${modelId} → ${label} 不是已知渠道`);
    }
  }
});

test("MODEL_ROUTES：registry 直连步骤必须有对应 claim（否则 seed 不会产出 capability，那一步选不中）", () => {
  for (const [modelId, route] of Object.entries(MODEL_ROUTES)) {
    for (const label of route) {
      const registry = REGISTRY_CHANNELS.find((channel) => channel.label === label);
      if (!registry) continue;
      assert.ok(registry.claims.some((claim) => claim.modelId === modelId), `${label} 没有认领 ${modelId}`);
    }
  }
});

test("生产校准：gpt-image-2 系顺序＝yyds > adobe2api > newapi（2026-10-03 改：yyds 1K/2K/4K 统一 0.016 元/次为最低价）", () => {
  assert.deepEqual([...MODEL_ROUTES["gpt-image-2"]], ["yyds", "adobe2api", "newapi"]);
  assert.deepEqual([...MODEL_ROUTES["gpt-image-2.5-flare"]], ["yyds", "adobe2api", "newapi"]);
  assert.deepEqual([...MODEL_ROUTES["gpt-image-2.5-sunburst"]], ["yyds", "adobe2api", "newapi"]);
  assert.ok(modelsRoutedTo(NEWAPI_ROUTE_LABEL).includes("pixai-tsubaki2"));
  assert.equal(routeSupplierId("newapi"), "env:newapi");
});

test("effectiveRoute：有覆写用覆写、无覆写用程式码预设，supplierIds 与 labels 同序", () => {
  const overrides = new Map<string, ModelRouteOverrideRow>([
    ["gpt-image-2", { modelId: "gpt-image-2", route: ["yyds", "adobe2api"], note: null, updatedBy: "admin", updatedAt: "2026-10-01T00:00:00.000Z" }],
  ]);
  const overridden = effectiveRoute("gpt-image-2", overrides);
  assert.equal(overridden.source, "override");
  assert.deepEqual(overridden.supplierIds, ["env:yyds", "env:adobe2api"]);

  const fallback = effectiveRoute("seedance-2.0", overrides);
  assert.equal(fallback.source, "config");
  assert.deepEqual(fallback.labels, ["xiaoyxiao", "gway"]);

  assert.deepEqual(effectiveRoute("no-such-model", overrides).supplierIds, []);
});

test("normalizeRouteInput：拒收非阵列、非法 label、重复渠道", () => {
  assert.deepEqual(normalizeRouteInput([" yyds ", "adobe2api"]), ["yyds", "adobe2api"]);
  assert.throws(() => normalizeRouteInput("yyds"));
  assert.throws(() => normalizeRouteInput(["yyds", "yyds"]));
  assert.throws(() => normalizeRouteInput(["env:yyds"]));
  assert.throws(() => normalizeRouteInput([""]));
});

test("appendLabelToRoutes：既有模型追加到队尾、已存在不重复、新模型补一行", () => {
  const source = [
    "export const MODEL_ROUTES: Record<string, readonly string[]> = {",
    '  "gpt-image-2": ["adobe2api", "newapi"],',
    '  "flux-2": ["adobe2api"],',
    "};",
    "",
    "export function modelRoute() {}",
  ].join("\n");
  const next = appendLabelToRoutes(source, "acme", ["gpt-image-2", "flux-2", "brand-new"]);
  assert.match(next, /"gpt-image-2": \["adobe2api", "newapi", "acme"\],/);
  assert.match(next, /"flux-2": \["adobe2api", "acme"\],/);
  assert.match(next, /"brand-new": \["acme"\],\n\};/);
  assert.equal(appendLabelToRoutes(next, "acme", ["gpt-image-2"]), next);
});
