// `/api/mcp` 協議層的真實行為斷言。
//
// 這一層是純函式，所以斷言全部是「輸入 → 輸出」的行為檢查（不是源碼字串掃描）：
// 錯誤碼對映、id 回填、畸型輸入的判定、版本協商、憑證消毒與截斷。
// route 層（401、畸型 body 的實際 JSON-RPC 錯誤碼）在 `tools.test.ts` 的
// 「真 handler」段落直呼 POST 驗。

import test from "node:test";
import assert from "node:assert/strict";

import {
  JSON_RPC_ERROR_CODES,
  MAX_TOOL_TEXT_LENGTH,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpRpcError,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isJsonRpcRequest,
  isNotification,
  jsonRpcErr,
  jsonRpcOk,
  negotiateProtocolVersion,
  normalizeJsonRpcId,
  redactSecrets,
  textResult,
  truncateToolText,
} from "./protocol";

test("錯誤碼對映：五個標準碼逐個等於 JSON-RPC 2.0 的規定值", () => {
  assert.equal(JSON_RPC_ERROR_CODES.parseError, -32700);
  assert.equal(JSON_RPC_ERROR_CODES.invalidRequest, -32600);
  assert.equal(JSON_RPC_ERROR_CODES.methodNotFound, -32601);
  assert.equal(JSON_RPC_ERROR_CODES.invalidParams, -32602);
  assert.equal(JSON_RPC_ERROR_CODES.internalError, -32603);
});

test("jsonRpcOk：信封是 2.0、id 原樣、result 缺席時補空物件", () => {
  assert.deepEqual(jsonRpcOk(7, { tools: [] }), { jsonrpc: "2.0", id: 7, result: { tools: [] } });
  assert.deepEqual(jsonRpcOk("abc", undefined), { jsonrpc: "2.0", id: "abc", result: {} });
});

test("id 回填：0 與空字串不得被當成「沒有 id」而丟掉", () => {
  assert.deepEqual(jsonRpcOk(0, {}).id, 0);
  assert.deepEqual(jsonRpcOk("", {}).id, "");
  assert.deepEqual(jsonRpcErr(0, -32601, "no").id, 0);
});

test("jsonRpcErr：無 data 時不得有 data 鍵；有 data 時逐位元保留", () => {
  const plain = jsonRpcErr(1, -32602, "參數不合法");
  assert.deepEqual(plain, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "參數不合法" } });
  assert.equal("data" in plain.error!, false);

  const withData = jsonRpcErr(1, -32600, "bad", { code: "invalid_api_key" });
  assert.deepEqual(withData.error!.data, { code: "invalid_api_key" });
});

test("normalizeJsonRpcId：合法形狀原樣、非法形狀收斂成 null（對應 -32600）", () => {
  assert.equal(normalizeJsonRpcId(5), 5);
  assert.equal(normalizeJsonRpcId("x"), "x");
  assert.equal(normalizeJsonRpcId(null), null);
  assert.equal(normalizeJsonRpcId(undefined), null);
  // 物件 / 陣列 / 布林 / NaN-ish 都是非法 id → null（而不是原樣塞進回應）
  assert.equal(normalizeJsonRpcId({ id: 1 }), null);
  assert.equal(normalizeJsonRpcId([1]), null);
  assert.equal(normalizeJsonRpcId(true), null);
});

test("isJsonRpcRequest：只認 object + jsonrpc 2.0 + 非空 method", () => {
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", method: "ping" }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", id: null, method: "ping" }), true);

  assert.equal(isJsonRpcRequest(null), false);
  assert.equal(isJsonRpcRequest("tools/list"), false);
  assert.equal(isJsonRpcRequest([{ jsonrpc: "2.0", method: "ping" }]), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: "1.0", method: "ping" }), false);
  assert.equal(isJsonRpcRequest({ method: "ping" }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", method: "" }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", method: "  " }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", method: 42 }), false);
  // 非法 id 型別（物件）→ 不合法請求，早退成 -32600，不進 dispatch
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }), false);
});

test("isNotification：無 id 才是通知（id 為 0/空字串仍算請求）", () => {
  assert.equal(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" }), true);
  assert.equal(isNotification({ jsonrpc: "2.0", id: 0, method: "ping" }), false);
  assert.equal(isNotification({ jsonrpc: "2.0", id: "", method: "ping" }), false);
});

test("negotiateProtocolVersion：認識的版本回聲，不認識／非字串回我方支援版本", () => {
  for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(version), version);
  }
  assert.equal(negotiateProtocolVersion("2019-01-01"), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(""), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(20250618), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion({ v: "2025-06-18" }), MCP_PROTOCOL_VERSION);
  // 我方宣告的版本必須在支援清單內且是最新那個
  assert.equal(MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS[0]);
});

test("serverInfo 常數：name 固定 eimu，version 非空", () => {
  assert.equal(MCP_SERVER_NAME, "eimu");
  assert.match(MCP_SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});

test("textResult：成功只給 content，失敗才有 isError=true（布林而非字串）", () => {
  const ok = textResult("done");
  assert.deepEqual(ok, { content: [{ type: "text", text: "done" }] });
  assert.equal("isError" in ok, false);

  const failed = textResult("boom", true);
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].type, "text");
  assert.equal(failed.content[0].text, "boom");
});

test("redactSecrets：Bearer 與 sk-* 憑證一律換掉（B 端 key 不得外洩）", () => {
  const key = "sk-biz-0123456789abcdef0123456789abcdef";
  const dirty = `failed with Authorization: Bearer ${key} and key=${key}`;
  const clean = redactSecrets(dirty);
  assert.equal(clean.includes(key), false);
  assert.equal(clean.includes("sk-biz-0123456789"), false);
  assert.match(clean, /Bearer \[REDACTED\]/);
  assert.match(clean, /sk-\[REDACTED\]/);
  // 一般文字不得被誤殺
  assert.equal(redactSecrets("prompt: a red apple"), "prompt: a red apple");
});

test("truncateToolText：先消毒再截斷，截斷處標明原始長度", () => {
  const key = "sk-biz-0123456789abcdef0123456789abcdef";
  // 填充用空白：不可用英數，否則會被 sk-* 的消毒樣式一起吞掉（那正是本測試要隔開的坑）。
  const long = `${key}${" ".repeat(100)}`;
  const cut = truncateToolText(long, 20);
  assert.equal(cut.includes(key), false);
  assert.match(cut, /內容已截斷/);
  assert.match(cut, /共 \d+ 字元/);

  assert.equal(truncateToolText("short", 100), "short");
  assert.ok(MAX_TOOL_TEXT_LENGTH > 1_000, "上限必須足以裝下一條真實端點回應");
});

test("McpRpcError：帶得住錯誤碼與 data（給 route 轉 JSON-RPC 錯誤用）", () => {
  const error = new McpRpcError(JSON_RPC_ERROR_CODES.invalidParams, "參數不合法", { tool: "get_skill" });
  assert.equal(error.code, -32602);
  assert.equal(error.message, "參數不合法");
  assert.deepEqual(error.data, { tool: "get_skill" });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "McpRpcError");
});
