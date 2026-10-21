// agent 对话代理层的不变量测试。
//
// 跟 src/app/api/v1/route.test.ts 同一路数：大部分断言直接读原始码字串，
// 用「文本上不可能出现」来钉死安全属性 —— 比跑一次功能测试更能挡住回归，
// 因为回归往往是「某天有人顺手把一行搬走了」，而不是行为测不出来的错。
// 加解密行为另用 node:test 直接跑纯函数。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptAgentKey, encryptAgentKey } from "../../../lib/agent-user-key";

const root = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉注解后再断言，避免注解里引用的反例把测试带跑。 */
function code(relPath: string): string {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ROUTES = [
  "src/app/api/agent/sessions/route.ts",
  "src/app/api/agent/sessions/[id]/messages/route.ts",
  "src/app/api/agent/sessions/[id]/confirm/route.ts",
  "src/app/api/agent/sessions/[id]/question/route.ts",
  "src/app/api/agent/sessions/[id]/sse-ticket/route.ts",
  "src/app/api/agent/sessions/[id]/route.ts",
  "src/app/api/agent/quota/route.ts",
];

// ─────────────────────────── 身份与密钥安全

test("每个 agent 路由都用 resolveAgentCaller，且不得退回未校验身份", () => {
  for (const relPath of ROUTES) {
    const source = code(relPath);
    assert.match(source, /resolveAgentCaller/, `${relPath} 必须使用 resolveAgentCaller`);
    assert.doesNotMatch(source, /getStoredUserFromHeaders/, `${relPath} 不得使用未校验的请求头身份`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得读取 x-user-id`);
  }
});

test("sse-ticket 路由的 caller.key 只能作为 callAgentGateway 参数，不得进任何回应", () => {
  const source = code("src/app/api/agent/sessions/[id]/sse-ticket/route.ts");
  // 挡的是「把服务端持有的 sk-biz- key 回给浏览器」这条泄露路径。
  // 精准断言：caller.key 每出现一次，就必须有对应一次 callAgentGateway 呼叫的
  // key 参数。一旦有人把 caller.key 拼进 NextResponse.json / events_url，
  // 总出现次数会比 callAgentGateway 内的次数多，两边对不上，测试即红。
  const totalUses = (source.match(/caller\.key/g) ?? []).length;
  const inGatewayCalls = (source.match(/callAgentGateway\([^)]*caller\.key/g) ?? []).length;
  assert.ok(inGatewayCalls >= 1, "sse-ticket 必须用服务端持有的 key 去取 ticket");
  assert.equal(totalUses, inGatewayCalls, "caller.key 只能出现在 callAgentGateway 的参数里");
});

test("agent-user-key.ts 不打 log，throw 讯息不得夹带明文或其变量", () => {
  const source = code("src/lib/agent-user-key.ts");
  assert.doesNotMatch(source, /console\.log/, "不得把任何东西打进 log");
  // 明文 / 解密结果（变量名 clear）不得出现在任何 throw 的讯息里；
  // 模板插值也一并禁掉，因为那是把敏感值塞进错误讯息的最常见写法。
  assert.doesNotMatch(source, /throw[^;]*\$\{/, "throw 讯息不得用模板插值（可能夹带敏感变量）");
  // 任何错误型别都要扫，不只 Error —— 新增子类（AgentKeyConfigError）不该绕过这条卫生检查。
  for (const match of source.matchAll(/throw\s+new\s+(?:\w*Error)\(([^)]*)\)/g)) {
    assert.doesNotMatch(match[1], /plaintext|clear/, "throw 讯息不得夹带明文或其解密结果变量");
  }
});

test("漏配 env 与临时故障必须是两种 503，不共用一句「稍后重试」", () => {
  const keySource = code("src/lib/agent-user-key.ts");
  // 型别分开，不靠比对 message 字串。
  assert.match(keySource, /export class AgentKeyConfigError extends Error/);
  assert.match(keySource, /throw new AgentKeyConfigError\("AGENT_KEY_ENCRYPTION_SECRET 未配置/);

  const guard = code("src/lib/agent-session-guard.ts");
  assert.match(guard, /error instanceof AgentKeyConfigError/);
  assert.match(guard, /code: "agent_key_not_configured"/);
  assert.match(guard, /code: "agent_key_unavailable"/);
  // 缺哪个变量只进伺服器日志，不回给客户端。
  assert.doesNotMatch(guard, /message: "[^"]*AGENT_KEY_ENCRYPTION_SECRET/);
});

test("agent gateway 预设指向 store 域名，绝不指向 image 域名（404）", () => {
  const source = code("src/lib/agent-gateway.ts");
  assert.match(source, /AGENT_GATEWAY_DEFAULT_ORIGIN\s*=\s*"https:\/\/store\.tinchak0207\.xyz"/);
  assert.doesNotMatch(source, /image\.tinchak0207\.xyz/, "image 域名的 /agent/* 是 404，打过去等于功能全坏");
  assert.match(source, /agentGatewayOrigin\(/, "取 origin 必须走正规化函数");
  assert.match(source, /AGENT_CHAT_ENABLED/, "启用开关必须读 AGENT_CHAT_ENABLED");
  assert.match(source, /Bearer/, "打闸道必须带 Bearer 认证");
});

// ─────────────────────────── 加解密行为

test("AES-GCM round-trip 还原明文", () => {
  const secret = "a".repeat(64);
  const plaintext = "sk-biz-0a1b2c3d4e5f60718293a4b5";
  const payload = encryptAgentKey(plaintext, secret);
  assert.match(payload, /^v1:/, "密文格式应带 v1 版本前缀");
  assert.equal(decryptAgentKey(payload, secret), plaintext);

  // 64 hex 以外的任意长度 secret 走 sha256 归一化，也要能 round-trip。
  const shortSecret = "dev-secret-not-64-hex";
  const payload2 = encryptAgentKey("sk-biz-xyz", shortSecret);
  assert.equal(decryptAgentKey(payload2, shortSecret), "sk-biz-xyz");
});

test("篡改 authTag 必须解密失败", () => {
  const secret = "a".repeat(64);
  const parts = encryptAgentKey("sk-biz-abcdef", secret).split(":");
  const tamperedTag = parts[2][0] === "0" ? `1${parts[2].slice(1)}` : `0${parts[2].slice(1)}`;
  const tampered = [parts[0], parts[1], tamperedTag, parts[3]].join(":");
  assert.throws(() => decryptAgentKey(tampered, secret), "GCM 应侦测 auth tag 被改");
});

test("secret 不对必须解密失败", () => {
  const payload = encryptAgentKey("sk-biz-abcdef", "a".repeat(64));
  assert.throws(() => decryptAgentKey(payload, "b".repeat(64)), "换一把 key 就该解不出来");
  assert.throws(() => decryptAgentKey(payload, "any-other-secret"));
});

test("坏格式必须解密失败", () => {
  const secret = "a".repeat(64);
  for (const bad of ["", "garbage", "v1:zz:zz:zz", "v1:", "v1:00:00"]) {
    assert.throws(() => decryptAgentKey(bad, secret), `格式「${bad}」应被判无效`);
  }
});

// ─────────────────────────── 代理端点的本校验

test("messages 路由校验 content 空串与长度上限", () => {
  const source = code("src/app/api/agent/sessions/[id]/messages/route.ts");
  assert.match(source, /MAX_MESSAGE_LENGTH/, "消息必须有长度上限");
  assert.match(source, /content\.length\s*===\s*0/, "空消息应回 400");
});

test("confirm 路由要求 request_id 与 approved 同时存在", () => {
  const source = code("src/app/api/agent/sessions/[id]/confirm/route.ts");
  assert.match(source, /!requestId/, "request_id 缺失应回 400");
  assert.match(source, /typeof\s+approved\s*!==\s*"boolean"/, "approved 必须是 boolean");
});

test("question 路由要求 request_id 与 answers", () => {
  const source = code("src/app/api/agent/sessions/[id]/question/route.ts");
  assert.match(source, /!requestId/, "request_id 缺失应回 400");
  assert.match(source, /isAnswers\(answers\)/, "answers 必须是 string[][]");
  assert.match(source, /\/agent\/v1\/sessions\/\$\{id\}\/question/, "必须转发闸道 question 端点");
});
