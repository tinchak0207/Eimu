import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decryptAdminPools, encryptAdminPools } from "./admin-pool-store.ts";
import type { AdminPool } from "./admin-pools.ts";

test("persisted pool configuration is encrypted and authenticated", () => {
  const original = process.env.ADMIN_POOL_ENCRYPTION_KEY;
  process.env.ADMIN_POOL_ENCRYPTION_KEY = "test-encryption-key";
  const pools: AdminPool[] = [{
    id: "pool-1",
    kind: "sub2api",
    name: "主号池",
    baseURL: "https://pool.example.com/v1",
    apiKey: "sk-never-plain-text",
    enabled: true,
    priority: 10,
    createdAt: 1,
    updatedAt: 1,
  }];

  try {
    const encrypted = encryptAdminPools(pools);
    assert.equal(encrypted.includes("sk-never-plain-text"), false);
    assert.deepEqual(decryptAdminPools(encrypted), pools);
    const tampered = encrypted.replace(/"data":"(.)([^\"]*)"/, (_match, first, rest) => `"data":"${first === "A" ? "B" : "A"}${rest}"`);
    assert.throws(() => decryptAdminPools(tampered));
  } finally {
    if (original === undefined) delete process.env.ADMIN_POOL_ENCRYPTION_KEY;
    else process.env.ADMIN_POOL_ENCRYPTION_KEY = original;
  }
});

test("pool storage reads the latest immutable blob version", () => {
  const source = readFileSync("src/lib/admin-pool-store.ts", "utf8");
  assert.match(source, /list\(\{ prefix: STORE_PREFIX/);
  assert.match(source, /get\(latest\.url, \{ access: "public" \}\)/);
  assert.match(source, /Date\.now\(\)/);
  assert.doesNotMatch(source, /allowOverwrite:\s*true/);
});
