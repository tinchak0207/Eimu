// agent 對話代理層的不變量測試。
//
// 跟 src/app/api/v1/route.test.ts 同一路數：大部分斷言直接讀原始碼字串，
// 用「文本上不可能出現」來釘死安全屬性 —— 比跑一次功能測試更能擋住回歸，
// 因為回歸往往是「某天有人順手把一行搬走了」，而不是行為測不出來的錯。
// 加解密行為另用 node:test 直接跑純函數。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptAgentKey, encryptAgentKey } from "../../../lib/agent-user-key";

const root = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉註解後再斷言，避免註解裡引用的反例把測試帶跑。 */
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

// ─────────────────────────── 身份與密鑰安全

test("每個 agent 路由都用 resolveAgentCaller，且不得退回未校驗身份", () => {
  for (const relPath of ROUTES) {
    const source = code(relPath);
    assert.match(source, /resolveAgentCaller/, `${relPath} 必須使用 resolveAgentCaller`);
    assert.doesNotMatch(source, /getStoredUserFromHeaders/, `${relPath} 不得使用未校驗的請求頭身份`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得讀取 x-user-id`);
  }
});

test("sse-ticket 路由的 caller.key 只能作為 callAgentGateway 參數，不得進任何回應", () => {
  const source = code("src/app/api/agent/sessions/[id]/sse-ticket/route.ts");
  // 擋的是「把服務端持有的 sk-biz- key 回給瀏覽器」這條泄露路徑。
  // 精準斷言：caller.key 每出現一次，就必須有對應一次 callAgentGateway 呼叫的
  // key 參數。一旦有人把 caller.key 拼進 NextResponse.json / events_url，
  // 總出現次數會比 callAgentGateway 內的次數多，兩邊對不上，測試即紅。
  const totalUses = (source.match(/caller\.key/g) ?? []).length;
  const inGatewayCalls = (source.match(/callAgentGateway\([^)]*caller\.key/g) ?? []).length;
  assert.ok(inGatewayCalls >= 1, "sse-ticket 必須用服務端持有的 key 去取 ticket");
  assert.equal(totalUses, inGatewayCalls, "caller.key 只能出現在 callAgentGateway 的參數裡");
});

test("agent-user-key.ts 不打 log，throw 訊息不得夾帶明文或其變量", () => {
  const source = code("src/lib/agent-user-key.ts");
  assert.doesNotMatch(source, /console\.log/, "不得把任何東西打進 log");
  // 明文 / 解密結果（變量名 clear）不得出現在任何 throw 的訊息裡；
  // 模板插值也一併禁掉，因為那是把敏感值塞進錯誤訊息的最常見寫法。
  assert.doesNotMatch(source, /throw[^;]*\$\{/, "throw 訊息不得用模板插值（可能夾帶敏感變量）");
  // 任何錯誤型別都要掃，不只 Error —— 新增子類（AgentKeyConfigError）不該繞過這條衛生檢查。
  for (const match of source.matchAll(/throw\s+new\s+(?:\w*Error)\(([^)]*)\)/g)) {
    assert.doesNotMatch(match[1], /plaintext|clear/, "throw 訊息不得夾帶明文或其解密結果變量");
  }
});

test("漏配 env 與臨時故障必須是兩種 503，不共用一句「稍後重試」", () => {
  const keySource = code("src/lib/agent-user-key.ts");
  // 型別分開，不靠比對 message 字串。
  assert.match(keySource, /export class AgentKeyConfigError extends Error/);
  assert.match(keySource, /throw new AgentKeyConfigError\("AGENT_KEY_ENCRYPTION_SECRET 未配置/);

  const guard = code("src/lib/agent-session-guard.ts");
  assert.match(guard, /error instanceof AgentKeyConfigError/);
  assert.match(guard, /code: "agent_key_not_configured"/);
  assert.match(guard, /code: "agent_key_unavailable"/);
  // 缺哪個變量只進伺服器日誌，不回給客戶端。
  assert.doesNotMatch(guard, /message: "[^"]*AGENT_KEY_ENCRYPTION_SECRET/);
});

test("agent gateway 預設指向 store 域名，絕不指向 image 域名（404）", () => {
  const source = code("src/lib/agent-gateway.ts");
  assert.match(source, /AGENT_GATEWAY_DEFAULT_ORIGIN\s*=\s*"https:\/\/store\.tinchak0207\.xyz"/);
  assert.doesNotMatch(source, /image\.tinchak0207\.xyz/, "image 域名的 /agent/* 是 404，打過去等於功能全壞");
  assert.match(source, /agentGatewayOrigin\(/, "取 origin 必須走正規化函數");
  assert.match(source, /AGENT_CHAT_ENABLED/, "啟用開關必須讀 AGENT_CHAT_ENABLED");
  assert.match(source, /Bearer/, "打閘道必須帶 Bearer 認證");
});

// ─────────────────────────── 加解密行為

test("AES-GCM round-trip 還原明文", () => {
  const secret = "a".repeat(64);
  const plaintext = "sk-biz-0a1b2c3d4e5f60718293a4b5";
  const payload = encryptAgentKey(plaintext, secret);
  assert.match(payload, /^v1:/, "密文格式應帶 v1 版本前綴");
  assert.equal(decryptAgentKey(payload, secret), plaintext);

  // 64 hex 以外的任意長度 secret 走 sha256 歸一化，也要能 round-trip。
  const shortSecret = "dev-secret-not-64-hex";
  const payload2 = encryptAgentKey("sk-biz-xyz", shortSecret);
  assert.equal(decryptAgentKey(payload2, shortSecret), "sk-biz-xyz");
});

test("篡改 authTag 必須解密失敗", () => {
  const secret = "a".repeat(64);
  const parts = encryptAgentKey("sk-biz-abcdef", secret).split(":");
  const tamperedTag = parts[2][0] === "0" ? `1${parts[2].slice(1)}` : `0${parts[2].slice(1)}`;
  const tampered = [parts[0], parts[1], tamperedTag, parts[3]].join(":");
  assert.throws(() => decryptAgentKey(tampered, secret), "GCM 應偵測 auth tag 被改");
});

test("secret 不對必須解密失敗", () => {
  const payload = encryptAgentKey("sk-biz-abcdef", "a".repeat(64));
  assert.throws(() => decryptAgentKey(payload, "b".repeat(64)), "換一把 key 就該解不出來");
  assert.throws(() => decryptAgentKey(payload, "any-other-secret"));
});

test("壞格式必須解密失敗", () => {
  const secret = "a".repeat(64);
  for (const bad of ["", "garbage", "v1:zz:zz:zz", "v1:", "v1:00:00"]) {
    assert.throws(() => decryptAgentKey(bad, secret), `格式「${bad}」應被判無效`);
  }
});

// ─────────────────────────── 代理端點的本校驗

test("messages 路由校驗 content 空串與長度上限", () => {
  const source = code("src/app/api/agent/sessions/[id]/messages/route.ts");
  assert.match(source, /MAX_MESSAGE_LENGTH/, "消息必須有長度上限");
  assert.match(source, /content\.length\s*===\s*0/, "空消息應回 400");
});

test("confirm 路由要求 request_id 與 approved 同時存在", () => {
  const source = code("src/app/api/agent/sessions/[id]/confirm/route.ts");
  assert.match(source, /!requestId/, "request_id 缺失應回 400");
  assert.match(source, /typeof\s+approved\s*!==\s*"boolean"/, "approved 必須是 boolean");
});

test("question 路由要求 request_id 與 answers", () => {
  const source = code("src/app/api/agent/sessions/[id]/question/route.ts");
  assert.match(source, /!requestId/, "request_id 缺失應回 400");
  assert.match(source, /isAnswers\(answers\)/, "answers 必須是 string[][]");
  assert.match(source, /\/agent\/v1\/sessions\/\$\{id\}\/question/, "必須轉發閘道 question 端點");
});
