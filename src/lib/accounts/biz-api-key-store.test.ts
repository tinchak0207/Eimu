import test from "node:test";
import assert from "node:assert/strict";

import { generateBizApiKey, hashBizApiKey } from "./biz-api-keys.ts";
import { authenticateBizApiKey, __resetBizKeyStoreForTests } from "./biz-api-key-store.ts";

test("BIZ_API_KEY_HASHES env fallback authenticates without Blob", async () => {
  const previousHashes = process.env.BIZ_API_KEY_HASHES;
  const previousBlob = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  __resetBizKeyStoreForTests();

  try {
    const { key } = generateBizApiKey();
    process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(key)}:7:probe`;

    const auth = await authenticateBizApiKey(key, { consumeRateLimit: false });
    assert.equal(auth.ok, true);
    if (auth.ok) {
      assert.equal(auth.key.userId, 7);
      assert.equal(auth.key.enabled, true);
      assert.equal(auth.key.allowedModels.length, 0);
    }
  } finally {
    if (previousHashes === undefined) delete process.env.BIZ_API_KEY_HASHES;
    else process.env.BIZ_API_KEY_HASHES = previousHashes;
    if (previousBlob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlob;
    __resetBizKeyStoreForTests();
  }
});

test("invalid BIZ_API_KEY_HASHES entries are ignored", async () => {
  const previousHashes = process.env.BIZ_API_KEY_HASHES;
  const previousBlob = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  __resetBizKeyStoreForTests();

  try {
    const { key } = generateBizApiKey();
    process.env.BIZ_API_KEY_HASHES = "not-a-hash:1,garbage";

    const auth = await authenticateBizApiKey(key, { consumeRateLimit: false });
    assert.equal(auth.ok, false);
  } finally {
    if (previousHashes === undefined) delete process.env.BIZ_API_KEY_HASHES;
    else process.env.BIZ_API_KEY_HASHES = previousHashes;
    if (previousBlob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlob;
    __resetBizKeyStoreForTests();
  }
});
