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

// 控面直連渠道全集：registry 條目 + 舊硬編碼仍直連的 adobe2api + new-api 那一步。
const DIRECT_LABELS = new Set([...REGISTRY_CHANNELS.map((channel) => channel.label), "adobe2api", NEWAPI_ROUTE_LABEL]);

test("MODEL_ROUTES：每個模型都在 catalog 裡（打錯 id＝那條路由永遠用不到）", () => {
  const missing = Object.keys(MODEL_ROUTES).filter((modelId) => !GENERATION_MODEL_CATALOG[modelId]);
  assert.deepEqual(missing, []);
});

test("MODEL_ROUTES：每一步都是已知渠道，且不含已併入 new-api 的舊 label", () => {
  for (const [modelId, route] of Object.entries(MODEL_ROUTES)) {
    assert.equal(new Set(route).size, route.length, `${modelId} 路由有重複渠道`);
    for (const label of route) {
      assert.ok(!NEWAPI_SUPERSEDED_LABELS.has(label), `${modelId} → ${label} 已併入 new-api，應寫 "${NEWAPI_ROUTE_LABEL}"`);
      assert.ok(DIRECT_LABELS.has(label), `${modelId} → ${label} 不是已知渠道`);
    }
  }
});

test("MODEL_ROUTES：registry 直連步驟必須有對應 claim（否則 seed 不會產出 capability，那一步選不中）", () => {
  for (const [modelId, route] of Object.entries(MODEL_ROUTES)) {
    for (const label of route) {
      const registry = REGISTRY_CHANNELS.find((channel) => channel.label === label);
      if (!registry) continue;
      assert.ok(registry.claims.some((claim) => claim.modelId === modelId), `${label} 沒有認領 ${modelId}`);
    }
  }
});

test("生產校準：gpt-image-2 順序＝adobe2api > newapi > yyds（2026-10-01 VPS 實查的生效順序，合併 new-api 假渠道後）", () => {
  assert.deepEqual([...MODEL_ROUTES["gpt-image-2"]], ["adobe2api", "newapi", "yyds"]);
  assert.ok(modelsRoutedTo(NEWAPI_ROUTE_LABEL).includes("pixai-tsubaki2"));
  assert.equal(routeSupplierId("newapi"), "env:newapi");
});

test("effectiveRoute：有覆寫用覆寫、無覆寫用程式碼預設，supplierIds 與 labels 同序", () => {
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

test("normalizeRouteInput：拒收非陣列、非法 label、重複渠道", () => {
  assert.deepEqual(normalizeRouteInput([" yyds ", "adobe2api"]), ["yyds", "adobe2api"]);
  assert.throws(() => normalizeRouteInput("yyds"));
  assert.throws(() => normalizeRouteInput(["yyds", "yyds"]));
  assert.throws(() => normalizeRouteInput(["env:yyds"]));
  assert.throws(() => normalizeRouteInput([""]));
});

test("appendLabelToRoutes：既有模型追加到隊尾、已存在不重複、新模型補一行", () => {
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
