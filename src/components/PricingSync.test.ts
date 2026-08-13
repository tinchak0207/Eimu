import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("PricingSync is a client-side side-effect component that returns null", () => {
  const source = read("src/components/PricingSync.tsx");
  assert.match(source, /"use client"/);
  assert.match(source, /applyModelPricingOverrides/);
  // 掛載時同步讀 localStorage 快取（24 小時內先套上覆寫，避免閃基準價）。
  assert.match(source, /model-pricing-overrides\.v1/);
  assert.match(source, /hydrateFromCache\(\)/);
  // 之後每 60 秒輪詢 + visibilitychange/focus 立即重取。
  assert.match(source, /POLL_INTERVAL_MS = 60_000/);
  assert.match(source, /addEventListener\("visibilitychange"/);
  assert.match(source, /addEventListener\("focus"/);
  // 卸載清理 interval、listener，並用 AbortController 取消在途請求。
  assert.match(source, /clearInterval/);
  assert.match(source, /removeEventListener/);
  assert.match(source, /abort\(\)/);
  // 同頁多次掛載安全：模組級 guard 避免重複 interval。
  assert.match(source, /activeSyncCount/);
  // 純副作用，不渲染節點。
  assert.match(source, /return null/);
});

test("root layout mounts PricingSync inside AuthProvider, before Navbar", () => {
  const layout = read("src/app/layout.tsx");
  const authIndex = layout.indexOf("<AuthProvider>");
  const pricingIndex = layout.indexOf("<PricingSync />");
  const navbarIndex = layout.indexOf("<Navbar />");
  assert.ok(authIndex >= 0, "layout 應包含 <AuthProvider>");
  assert.ok(pricingIndex >= 0, "layout 應引入 <PricingSync />");
  assert.ok(navbarIndex >= 0, "layout 應包含 <Navbar />");
  assert.ok(pricingIndex > authIndex, "PricingSync 應在 AuthProvider 內");
  assert.ok(pricingIndex < navbarIndex, "PricingSync 應在 Navbar 之前");
});

test("charging routes sync model pricing before computing the bill", () => {
  const cases: Array<{ file: string; marker: string }> = [
    { file: "src/app/api/generate-images/route.ts", marker: "requiredCoins" },
    { file: "src/app/api/generate-videos/route.ts", marker: "requiredCoins" },
    { file: "src/app/api/generation-jobs/route.ts", marker: "requiredCoins" },
    // v1 端點有兩處扣費：durable branch 的 billingAmount 與 legacy 的 coinsPerImage。
    { file: "src/app/api/v1/images/generations/route.ts", marker: "billingAmount" },
  ];

  for (const { file, marker } of cases) {
    const source = read(file);
    const syncIndex = source.indexOf("syncModelPricing");
    const markerIndex = source.indexOf(marker);
    assert.ok(syncIndex >= 0, `${file} 應引入並呼叫 syncModelPricing`);
    assert.ok(markerIndex >= 0, `${file} 應包含 ${marker}`);
    // 位置比對：syncModelPricing 的出現位置必須早於算價符號的首次出現。
    assert.ok(syncIndex < markerIndex, `${file} 的 syncModelPricing 應在 ${marker} 之前`);
    // 除了 import，函式體內必須真的 await 呼叫，而非只有 import 字串。
    assert.match(source, /await syncModelPricing\(\);/);
  }

  // v1 端點兩處扣費都要被同一次上游 sync 覆蓋。
  const v1 = read("src/app/api/v1/images/generations/route.ts");
  assert.ok(v1.indexOf("syncModelPricing") < v1.indexOf("coinsPerImage"), "v1 的 sync 應在 coinsPerImage 之前");
});

test("price-displaying components subscribe to pricing revisions", () => {
  const files = [
    "src/components/ImagePlayground.tsx",
    "src/components/pro-workstation/InvokeInspiredWorkstation.tsx",
    "src/components/PromptInput.tsx",
    "src/components/ModelPicker.tsx",
    "src/components/PricingClient.tsx",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /usePricingRevision/);
    assert.match(source, /usePricingRevision\(\);/);
  }
});
