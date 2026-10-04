// memory-hmac 行为测试：签验往复与四类拒绝路径（契约 §3）。
// 纯函数直测，不碰网络／存储；密钥经 env 即时读取，逐案设定与还原。

import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_SIGNATURE_HEADER,
  signMemoryBody,
  verifyMemorySignature,
} from "./memory-hmac";

const SECRET = "unit-test-secret-not-real";

/** 转成纯 ArrayBuffer（verify/sign 的入参形状）。 */
function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

function withSecret(secret: string | undefined, run: () => void): void {
  const previous = process.env.MEMORY_INGEST_SECRET;
  if (secret === undefined) delete process.env.MEMORY_INGEST_SECRET;
  else process.env.MEMORY_INGEST_SECRET = secret;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MEMORY_INGEST_SECRET;
    else process.env.MEMORY_INGEST_SECRET = previous;
  }
}

test("header 常量为 x-memory-signature", () => {
  assert.equal(MEMORY_SIGNATURE_HEADER, "x-memory-signature");
});

test("签验往复：正确密钥＋原始位元组 → true", () => {
  withSecret(SECRET, () => {
    const raw = bytes(JSON.stringify({ batch_id: "2026-09-15", docs: [] }));
    const signature = signMemoryBody(raw, SECRET);
    assert.match(signature, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyMemorySignature(raw, signature), true);
  });
});

test("空 bytes（GET 语义）也能签验往复", () => {
  withSecret(SECRET, () => {
    const raw = new ArrayBuffer(0);
    const signature = signMemoryBody(raw, SECRET);
    assert.equal(verifyMemorySignature(raw, signature), true);
    // 篡改任何一个位元组即不等。
    assert.equal(verifyMemorySignature(bytes("x"), signature), false);
  });
});

test("错签（另一密钥签的）→ false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    const forged = signMemoryBody(raw, "wrong-secret");
    assert.equal(verifyMemorySignature(raw, forged), false);
  });
});

test("缺签（null／空字串）→ false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    assert.equal(verifyMemorySignature(raw, null), false);
    assert.equal(verifyMemorySignature(raw, ""), false);
  });
});

test("密钥未配置／全空白 → 一律 false（不崩溃不放行）", () => {
  for (const secret of [undefined, "", "   "]) {
    withSecret(secret, () => {
      const raw = bytes("payload");
      // 即便签名本身「正确」，密钥缺失也必须拒绝。
      const signature = signMemoryBody(raw, "any");
      assert.equal(verifyMemorySignature(raw, signature), false);
      assert.equal(verifyMemorySignature(raw, null), false);
    });
  }
});

test("header 形状不合：非 sha256= 前缀／非 hex／长度不对 → false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    const hex = signMemoryBody(raw, SECRET).slice("sha256=".length);
    assert.equal(verifyMemorySignature(raw, hex), false); // 缺前缀
    assert.equal(verifyMemorySignature(raw, `sha1=${hex}`), false); // 错前缀
    assert.equal(verifyMemorySignature(raw, "sha256=not-hex"), false); // 非 hex
    assert.equal(verifyMemorySignature(raw, `sha256=${hex.slice(0, 63)}`), false); // 短一码
    // 前缀大小写容忍（parseSignatureHeader toLowerCase），值仍对 → true。
    assert.equal(verifyMemorySignature(raw, `SHA256=${hex}`), true);
  });
});
