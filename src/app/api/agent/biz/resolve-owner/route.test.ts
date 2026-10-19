// /api/agent/biz/resolve-owner B 端密钥属主解析端点的不变量测试。
//
// 与 src/app/api/agent/biz/[...path]/route.test.ts 同一路数：读原始码字串
// 断言安全属性，挡住「某天有人顺手把一行搬走了」式的回归。重点三件事：
// 1. 鉴权链路与派生 key 换发必须齐全（readBearerToken → authenticateBizApiKey
//    → getOrCreateAgentKeyForUser → canonical_key）；
// 2. 派生 key 只能出现在 canonical_key 字段，不进错误响应或 log；
// 3. 鉴权失败透传 authenticateBizApiKey 的 status/message/code，派生故障
//    区分 agent_key_not_configured / agent_key_unavailable 两个 code。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/** 去掉注解后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROUTE = "src/app/api/agent/biz/resolve-owner/route.ts";

test("resolve-owner 必须走 readBearerToken + authenticateBizApiKey + 派生 key 换发", () => {
  const source = code(ROUTE);
  assert.match(source, /readBearerToken/, "必须从 Authorization 头取 Bearer 令牌");
  assert.match(source, /authenticateBizApiKey/, "必须校验 B 端密钥");
  assert.match(source, /getOrCreateAgentKeyForUser\(auth\.key\.userId\)/, "必须解析到属主的派生 key");
  assert.match(source, /consumeRateLimit:\s*false/, "网关侧有 TTL 缓存，鉴权不计限流");
  assert.match(source, /export const runtime = "nodejs"/, "runtime 必须是 nodejs");
  assert.match(source, /export async function POST/, "只开 POST");
  assert.doesNotMatch(source, /export async function (GET|DELETE|PUT)/, "不得暴露其他方法");
});

test("canonical_key 只出现在响应字段里，不进错误响应或 log", () => {
  const source = code(ROUTE);
  // 只数「使用」处（剥掉 let 宣告与赋值行），防有人把派生 key 拼进 fail/模板。
  const uses = source
    .split("\n")
    .filter((line) => !/^\s*(let\s+)?canonicalKey\s*[:=]/.test(line))
    .join("\n");
  const totalUses = (uses.match(/canonicalKey/g) ?? []).length;
  const inResponse = (source.match(/canonical_key:\s*canonicalKey/g) ?? []).length;
  assert.equal(inResponse, 1, "响应必须带 canonical_key 字段");
  assert.equal(totalUses, inResponse, "canonicalKey 只能出现在 canonical_key 响应字段里");
  assert.doesNotMatch(source, /console\./, "整条路由不得打任何 log");
  // fail() 全部是固定文案：调用处不准用模板插值（可能夹带 key / url 细节）。
  for (const m of source.matchAll(/fail\(([^)]*)\)/g)) {
    assert.doesNotMatch(m[1], /\$/, "fail() 参数必须是固定字面量，不得插值");
  }
});

test("错误语义：鉴权失败透传，派生故障区分 not_configured / unavailable", () => {
  const source = code(ROUTE);
  assert.match(source, /auth\.status,\s*auth\.message,\s*auth\.code/, "401/403/429 要按鉴权结果原样回");
  assert.match(source, /AgentKeyConfigError/, "必须区分漏配 env 的情形");
  assert.match(source, /agent_key_not_configured/, "漏配 env 走 not_configured code");
  assert.match(source, /agent_key_unavailable/, "临时故障走 unavailable code");
  assert.match(source, /503/, "派生故障一律 503（服务侧问题，不是调用方的问题）");
});
