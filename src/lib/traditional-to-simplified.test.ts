import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toSimplified } from "./traditional-to-simplified.ts";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

// 繁→簡實測對照（用 code point 寫，避免測試檔案本身的編碼被工具鏈損壞）。
// 查詢圖像任務狀態（輪詢不消耗限流）
const TRAD_SAMPLE = "\u67e5\u8a62\u5716\u50cf\u4efb\u52d9\u72c0\u614b";
const SIMP_SAMPLE = "\u67e5\u8be2\u56fe\u50cf\u4efb\u52a1\u72b6\u6001";

test("toSimplified converts docs-facing API copy to simplified Chinese", () => {
  assert.equal(toSimplified(TRAD_SAMPLE), SIMP_SAMPLE);
  assert.equal(toSimplified("\u7372\u53d6\u5716\u50cf\u7d50\u679c"), "\u83b7\u53d6\u56fe\u50cf\u7ed3\u679c");
});

test("toSimplified leaves ascii and code tokens untouched", () => {
  assert.equal(toSimplified("Idempotency-Key " + "\u8acb\u6c42\u982d"), "Idempotency-Key " + "\u8bf7\u6c42\u5934");
  assert.equal(toSimplified("POST /v1/images/generations 回 202"), "POST /v1/images/generations 回 202");
});

test("toSimplified covers every traditional character the openapi spec renders in docs", () => {
  // 對照來源：spec 中出現、且表內非繁簡同形（trad !== simp）的字，轉換後必須變成簡體。
  const spec = read("src/app/api/v1/openapi.json/route.ts");
  const tableSource = read("src/lib/traditional-to-simplified.ts");
  const pairs = [...tableSource.matchAll(/"\\u([0-9a-f]{4})":\s*"\\u([0-9a-f]{4})"/g)].map((m) => [
    Number.parseInt(m[1], 16),
    Number.parseInt(m[2], 16),
  ]);

  for (const [trad, simp] of pairs) {
    if (trad === simp) continue; // 繁簡同形字原樣保留
    const ch = String.fromCodePoint(trad);
    if (spec.includes(ch)) {
      assert.equal(
        toSimplified(ch),
        String.fromCodePoint(simp),
        `spec 中的繁體字 U+${trad.toString(16)} 應轉成 U+${simp.toString(16)}`,
      );
    }
  }
});