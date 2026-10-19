// /api/agent/biz/[...path] B 端密钥代理的不变量测试。
//
// 与 src/app/api/agent/route.test.ts 同一路数：读原始码字串断言安全属性，
// 挡住「某天有人顺手把一行搬走了」式的回归。重点三件事：
// 1. 必须走 B 端密钥鉴权 + 派生 key 换发（不许透传调用方的 key）；
// 2. SSE 分支必须流式透传（不缓冲、不带超时）；
// 3. 派生 key 只能出现在 Authorization 头，不进任何错误响应或 log。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/** 去掉注解后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8")
    // 先剥行注释再剥块注释：行注释里出现 "/*"（如 /agent/v1/*）时，
    // 先剥块注释会把它当成块注释开头，一路吞到下一个 */，误删真代码。
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROUTE = "src/app/api/agent/biz/[...path]/route.ts";

test("B 端代理必须走 readBearerToken + authenticateBizApiKey + 派生 key 换发", () => {
  const source = code(ROUTE);
  assert.match(source, /readBearerToken/, "必须从 Authorization 头取 Bearer 令牌");
  assert.match(source, /authenticateBizApiKey/, "必须校验 B 端密钥");
  assert.match(source, /getOrCreateAgentKeyForUser/, "必须换成用户派生 key 再打网关");
  assert.match(source, /agentGatewayOrigin\(\)/, "上游 origin 必须走正规化函数");
  assert.match(source, /export const runtime = "nodejs"/, "runtime 必须是 nodejs");
});

test("派生 key 只能出现在 Authorization 头模板里，不进错误响应或 log", () => {
  const source = code(ROUTE);
  // resolved.key 每出现一次，就必须对应一次 Authorization 模板。
  // 一旦有人把它拼进 fail(...) / NextResponse / console，两边计数对不上即红。
  const totalUses = (source.match(/resolved\.key/g) ?? []).length;
  const inAuthHeader = (source.match(/Authorization: `Bearer \$\{resolved\.key\}`/g) ?? []).length;
  assert.ok(inAuthHeader >= 1, "发往网关的请求必须带派生 key");
  assert.equal(totalUses, inAuthHeader, "resolved.key 只能出现在 Authorization 头模板里");
  assert.doesNotMatch(source, /console\./, "整条路由不得打任何 log");
  // fail() 全部是固定文案：调用处不准用模板插值（可能夹带 key / url 细节）。
  for (const m of source.matchAll(/fail\(([^)]*)\)/g)) {
    assert.doesNotMatch(m[1], /\$/, "fail() 参数必须是固定字面量，不得插值");
  }
});

test("SSE 分支必须流式透传：upstream.body 直通 Response，不缓冲不带超时", () => {
  const source = code(ROUTE);
  assert.match(source, /\"text\/event-stream\"/, "SSE 响应头必须声明 event-stream");
  assert.match(source, /\"X-Accel-Buffering\":\s*\"no\"/, "必须关掉反向代理缓冲");
  // 流式直通：Response 构造的第一个参数是上游 body 本体，而不是先读成文本。
  assert.match(source, /new Response\(([A-Za-z]+)\.body/, "必须把 upstream.body 直通给 Response");
  // SSE fetch 不得挂 AbortSignal.timeout —— 事件流合法地可以静默数分钟。
  // 断言方式：截取 SSE 分支（从 events 判定到流式 return）整段，不允许出现任何 signal/timeout。
  const sseStart = source.indexOf('"events"');
  const sseEnd = source.indexOf("new Response(events.body");
  assert.ok(sseStart >= 0 && sseEnd > sseStart, "必须存在 SSE 专用分支");
  const sseBranch = source.slice(sseStart, sseEnd);
  assert.doesNotMatch(sseBranch, /signal|timeout/i, "SSE fetch 不得带超时 signal");
  // text() 只允许出现在 JSON 路径（upstream.text()），且绝不允许对 events 响应调用。
  assert.doesNotMatch(source, /events[^;]*\.text\(/, "不得把 SSE 响应读成文本");
});

test("网关 404（防枚举语义）必须原样透传，不得吞掉或改写", () => {
  const source = code(ROUTE);
  assert.doesNotMatch(source, /already_gone/, "B 端代理不做 404 幂等化改写（那是站内 DELETE 的语义）");
  // 非 2xx 一律保 status 透传：不允许出现「把 4xx 改成 2xx」的分支。
  assert.doesNotMatch(source, /status:\s*(200|201)\b[^\n]*upstream/, "不得把上游非 2xx 改写成 2xx");
});

test("鉴权失败必须透传 authenticateBizApiKey 的 status/message/code", () => {
  const source = code(ROUTE);
  assert.match(source, /auth\.status,\s*auth\.message,\s*auth\.code/, "401/403/429 要按鉴权结果原样回");
});

test("上游 URL 拼接必须带上 query string（SSE 的 ticket 在 query 里）", () => {
  const source = code(ROUTE);
  assert.match(source, /req\.nextUrl\.search/, "转发必须透传 query string");
});
