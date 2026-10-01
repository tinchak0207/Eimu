// 透析面板 JSON 高亮：類別正確、拼回無損。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeJson } from "./json-tokens";

test("tokenizeJson：鍵/字串/數字/字面量分類", () => {
  const text = JSON.stringify({ model: "seedream-4", count: 2, ratio: -1.5e30, audio: false, lora: null }, null, 2);
  const tokens = tokenizeJson(text);
  const pick = (kind: string) => tokens.filter((t) => t.kind === kind).map((t) => t.text);
  assert.deepEqual(pick("key"), ['"model"', '"count"', '"ratio"', '"audio"', '"lora"']);
  assert.deepEqual(pick("string"), ['"seedream-4"']);
  assert.deepEqual(pick("number"), ["2", "-1.5e+30"]);
  assert.deepEqual(pick("literal"), ["false", "null"]);
});

test("tokenizeJson：拼回＝原文（含跳脫與陣列）", () => {
  const text = JSON.stringify({ prompt: 'a "quoted" \\ line\n2', ids: ["v1", 3], nested: { ok: true } }, null, 2);
  assert.equal(
    tokenizeJson(text)
      .map((t) => t.text)
      .join(""),
    text,
  );
});

test("tokenizeJson：字串內的數字不被拆", () => {
  const tokens = tokenizeJson('{"size": "1536x1024"}');
  assert.ok(tokens.some((t) => t.kind === "string" && t.text === '"1536x1024"'));
  assert.ok(!tokens.some((t) => t.kind === "number"));
});
