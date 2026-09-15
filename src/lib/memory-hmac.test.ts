// memory-hmac 行為測試：簽驗往復與四類拒絕路徑（契約 §3）。
// 純函數直測，不碰網絡／存儲；密鑰經 env 即時讀取，逐案設定與還原。

import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_SIGNATURE_HEADER,
  signMemoryBody,
  verifyMemorySignature,
} from "./memory-hmac";

const SECRET = "unit-test-secret-not-real";

/** 轉成純 ArrayBuffer（verify/sign 的入參形狀）。 */
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

test("header 常量為 x-memory-signature", () => {
  assert.equal(MEMORY_SIGNATURE_HEADER, "x-memory-signature");
});

test("簽驗往復：正確密鑰＋原始位元組 → true", () => {
  withSecret(SECRET, () => {
    const raw = bytes(JSON.stringify({ batch_id: "2026-09-15", docs: [] }));
    const signature = signMemoryBody(raw, SECRET);
    assert.match(signature, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyMemorySignature(raw, signature), true);
  });
});

test("空 bytes（GET 語義）也能簽驗往復", () => {
  withSecret(SECRET, () => {
    const raw = new ArrayBuffer(0);
    const signature = signMemoryBody(raw, SECRET);
    assert.equal(verifyMemorySignature(raw, signature), true);
    // 篡改任何一个位元組即不等。
    assert.equal(verifyMemorySignature(bytes("x"), signature), false);
  });
});

test("錯簽（另一密鑰簽的）→ false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    const forged = signMemoryBody(raw, "wrong-secret");
    assert.equal(verifyMemorySignature(raw, forged), false);
  });
});

test("缺簽（null／空字串）→ false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    assert.equal(verifyMemorySignature(raw, null), false);
    assert.equal(verifyMemorySignature(raw, ""), false);
  });
});

test("密鑰未配置／全空白 → 一律 false（不崩潰不放行）", () => {
  for (const secret of [undefined, "", "   "]) {
    withSecret(secret, () => {
      const raw = bytes("payload");
      // 即便簽名本身「正確」，密鑰缺失也必須拒絕。
      const signature = signMemoryBody(raw, "any");
      assert.equal(verifyMemorySignature(raw, signature), false);
      assert.equal(verifyMemorySignature(raw, null), false);
    });
  }
});

test("header 形狀不合：非 sha256= 前綴／非 hex／長度不對 → false", () => {
  withSecret(SECRET, () => {
    const raw = bytes("payload");
    const hex = signMemoryBody(raw, SECRET).slice("sha256=".length);
    assert.equal(verifyMemorySignature(raw, hex), false); // 缺前綴
    assert.equal(verifyMemorySignature(raw, `sha1=${hex}`), false); // 錯前綴
    assert.equal(verifyMemorySignature(raw, "sha256=not-hex"), false); // 非 hex
    assert.equal(verifyMemorySignature(raw, `sha256=${hex.slice(0, 63)}`), false); // 短一碼
    // 前綴大小寫容忍（parseSignatureHeader toLowerCase），值仍對 → true。
    assert.equal(verifyMemorySignature(raw, `SHA256=${hex}`), true);
  });
});
