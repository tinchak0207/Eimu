import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_PNG_HEADER_SIZE,
  WORKFLOW_PNG_MAGIC,
  WORKFLOW_PNG_VERSION,
  embedWorkflowIntoPng,
  extractWorkflowFromPng,
} from "./workflow-png";

// 1x1 透明 PNG（67 bytes，含 IEND chunk），十六進位已知良好的最小合法樣本。
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function minimalPng(): Uint8Array {
  return new Uint8Array(Buffer.from(MINIMAL_PNG_BASE64, "base64"));
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

test("embed keeps the original PNG bytes intact and appends a valid trailing block", () => {
  const png = minimalPng();
  const workflow = JSON.stringify({ prompt: "product poster", copies: 2 });
  const embedded = embedWorkflowIntoPng(png, workflow);

  // 前綴必須逐位元組等於原始 PNG：開圖功能不受影響（IEND 與 CRC 都在前綴內）。
  assert.equal(embedded.length, png.length + WORKFLOW_PNG_HEADER_SIZE + new TextEncoder().encode(workflow).length);
  assert.deepEqual(Array.from(embedded.subarray(0, png.length)), Array.from(png));

  // 尾端 13 位元組 = magic + version + length
  const tail = embedded.subarray(embedded.length - WORKFLOW_PNG_HEADER_SIZE);
  const magic = String.fromCharCode(...Array.from(tail.subarray(0, 8)));
  assert.equal(magic, WORKFLOW_PNG_MAGIC);
  assert.equal(tail[8], WORKFLOW_PNG_VERSION);
  const length =
    ((tail[9] << 24) >>> 0) + (tail[10] << 16) + (tail[11] << 8) + tail[12];
  assert.equal(length, new TextEncoder().encode(workflow).length);
});

test("roundtrip embed -> extract returns the exact workflow JSON", () => {
  const png = minimalPng();
  const workflow = JSON.stringify({
    schemaVersion: 2,
    prompt: "  product poster  ",
    negativePrompt: "bad text",
    imageSize: "1536x1024",
    copies: 3,
    modelId: "gpt-image-2",
  });
  const embedded = embedWorkflowIntoPng(png, workflow);
  assert.equal(extractWorkflowFromPng(embedded), workflow);
});

test("roundtrip preserves unicode without mangling", () => {
  const png = minimalPng();
  const workflow = JSON.stringify({ prompt: "產品海報，柔和光影，中文文案可直接閱讀" });
  const embedded = embedWorkflowIntoPng(png, workflow);
  assert.equal(extractWorkflowFromPng(embedded), workflow);
});

test("plain image and garbage buffers return null", () => {
  assert.equal(extractWorkflowFromPng(minimalPng()), null);
  assert.equal(extractWorkflowFromPng(randomBytes(1024)), null);
  assert.equal(extractWorkflowFromPng(new Uint8Array(0)), null);
  assert.equal(extractWorkflowFromPng(new Uint8Array(512).fill(0x00)), null);
});

test("corrupted trailing block returns null", () => {
  const png = minimalPng();
  const workflow = JSON.stringify({ prompt: "x" });
  const embedded = embedWorkflowIntoPng(png, workflow);

  // 把 magic 換掉一個位元組 → 視為一般 PNG，回 null
  const badMagic = Uint8Array.from(embedded);
  badMagic[badMagic.length - WORKFLOW_PNG_HEADER_SIZE] =
    badMagic[badMagic.length - WORKFLOW_PNG_HEADER_SIZE] === 0x57 ? 0x00 : 0x58;
  assert.equal(extractWorkflowFromPng(badMagic), null);

  // 版本位元組不符 → 回 null
  const badVersion = Uint8Array.from(embedded);
  badVersion[badVersion.length - 5] = 99;
  assert.equal(extractWorkflowFromPng(badVersion), null);

  // payload 不是合法 JSON → 回 null
  const nonJson = Uint8Array.from(embedded);
  const payloadStart = nonJson.length - WORKFLOW_PNG_HEADER_SIZE - "{\"prompt\": \"x\"}".length;
  for (let index = 0; index < 5; index += 1) nonJson[payloadStart + index] = 0x41;
  assert.equal(extractWorkflowFromPng(nonJson), null);
});

test("non-PNG bytes that happen to carry the magic still return null", () => {
  const fake = Uint8Array.from(randomBytes(512));
  // 自己拼一個有 magic 但沒有 PNG 簽名的資料
  const suffix = new TextEncoder().encode(WORKFLOW_PNG_MAGIC);
  const withMagic = new Uint8Array(fake.length + suffix.length + 5);
  withMagic.set(fake, 0);
  withMagic.set(suffix, fake.length);
  withMagic[fake.length + 8] = WORKFLOW_PNG_VERSION;
  withMagic[fake.length + 9] = 0;
  withMagic[fake.length + 10] = 0;
  withMagic[fake.length + 11] = 0;
  withMagic[fake.length + 12] = 1;
  assert.equal(extractWorkflowFromPng(withMagic), null);
});