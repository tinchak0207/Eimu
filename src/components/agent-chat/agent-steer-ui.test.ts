// agent-steer-ui.test.ts —— REQ-D2（steer 回合中引导）前端接线与字面契约锁。
//
// 惯例同 agent-composer-buttons.test.ts / agent-chat-ui.test.ts：只读源码 + regex
// 断言，不引入 jsdom / react 测试库。这里锁四件事：
//   ① 回合进行中「引导」与「停止」两颗钮在 UI 上分得开（有字＝引导、空框＝停止）
//   ② 引导走独立端点，且**不落回** sendAgentMessage（不另起用户消息＝不多烧一个回合）
//   ③ 用户气泡带 steer 状态徽章，五态文案齐全（排队中／已注入／已生效／已中止／未生效）
//   ④ 停止优先：abort 里同步改判排队中的 steer
// 跑法（必带超时）：timeout 240 npx tsx --test src/components/agent-chat/agent-steer-ui.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去注释源码：顺序类断言必须走这里（注释里出现同名符号会把索引带偏）。 */
function readCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const composer = read("src/components/agent-chat/AgentComposer.tsx");
const panel = read("src/components/agent-chat/AgentChatPanel.tsx");
const bubble = read("src/components/agent-chat/AgentMessageBubble.tsx");
const hook = read("src/hooks/use-agent-chat.ts");
const hookCode = readCode(hook);
const client = read("src/lib/agent-chat-client.ts");

test("回合进行中：有字是「引导」（方向标），空框仍是「停止」（红方块）——两颗钮不互相冒充", () => {
  // steerActive 缺省 false：不传时渲染与改动前逐位一致。
  assert.match(composer, /steerActive\?: boolean;/);
  assert.match(composer, /steerActive = false,/);
  // 送出钮的引导形态：title 直说「插进当前回合、不打断它」+ data-steer 可被测试/埋点选到。
  assert.match(composer, /title=\{steerActive \? "引导本轮：这条会插进当前回合，不打断它" : undefined\}/);
  assert.match(composer, /data-steer=\{steerActive \? "true" : undefined\}/);
  // 图标分流：steer ⇒ Navigation，普通送出 ⇒ ArrowUp（旧字面必须还在，别条测试钉着它）。
  assert.match(composer, /<Navigation className="h-4 w-4" aria-hidden="true" \/>/);
  assert.match(composer, /<ArrowUp className="h-4 w-4" aria-hidden="true" \/>/);
  // 停止钮契约逐字不动：空框 + 回合在跑才出现，红方块 + 既有 aria-label。
  assert.match(composer, /\{onStop && !canSend && !sending \? \(/);
  assert.match(composer, /aria-label="中止助理生成"/);
  assert.match(composer, /\{sending \? \(/);
});

test("面板把 turnActive 接成 steerActive：与 onStop 同源同一颗真相", () => {
  assert.match(panel, /steerActive=\{turnActive\}/);
  // 停止信号仍在（既有字面不动）：回合结束就没有东西可停。
  assert.match(panel, /onStop=\{turnActive \? onStopGeneration : undefined\}/);
});

test("用户气泡带 steer 状态徽章：五态文案齐全，排队与已生效一眼分得开", () => {
  assert.match(bubble, /data-steer-status=\{item\.steer\.status\}/);
  assert.match(bubble, /item\.kind === "user" && item\.steer \?/);
  // 五态人话（与网關 steer-core.ts 的 SteerStatus 值域一一对应）。
  assert.match(bubble, /引导已排队\$\{typeof position === "number" \? `（第 \$\{position\} 条）` : ""\}·本回合结束后生效/);
  assert.match(bubble, /"引导已注入本回合"/);
  assert.match(bubble, /"引导已生效"/);
  assert.match(bubble, /"引导已中止（未生效）"/);
  assert.match(bubble, /"引导未能送达（未生效）"/);
  // 值域收口：switch 覆盖五态且无 default 逃逸（漏一态会 TS 报返回值不全）。
  assert.match(bubble, /function steerStatusLabel\(status: AgentSteerStatus, position\?: number\): string \{/);
});

test("引导腿不落回 sendAgentMessage：不另起用户消息，且只在「回合进行中 + steer 设定」时启用", () => {
  // 触发条件逐字：turnActive 为假 ⇒ steering 为假 ⇒ 下面路径与改动前逐位等價。
  assert.match(
    hookCode,
    /const steering = stateRef\.current\.turnActive && readCachedAgentSettings\(\)\.interrupt_mode === "steer";/,
  );
  assert.match(hookCode, /const steerId = steering \? newSteerId\(\) : "";/);
  // 乐观插入带 steer 徽章（普通路径不带）。
  assert.match(hookCode, /\{ type: "user", text: trimmed, steer: \{ id: steerId, status: "queued" \} \}/);
  assert.match(hookCode, /await steerAgentSession\(sid, trimmed, \{ steerId \}\);/);
  // 顺序铁律：steer 腿在 sendAgentMessage 之前 return（否则同一条指引会既注入又另起一回合）。
  const steerThen = hookCode.indexOf("if (steering) {");
  const steerReturn = hookCode.indexOf("return;\n      }", steerThen);
  const plainSend = hookCode.indexOf("await sendAgentMessage(");
  assert.ok(steerThen > -1 && steerReturn > steerThen, "steer 腿必须能定位到且以 return 收口");
  assert.ok(plainSend > steerReturn, "steer 腿必须排在 sendAgentMessage 之前并提前 return");
  // ack 落地 + 失败诚实标「未生效」。
  assert.match(hookCode, /dispatch\(\{\s*\n\s*type: "steer-ack",/);
  assert.match(hookCode, /dispatch\(\{ type: "steer-ack", steerId, status: "failed" \}\);/);
  assert.match(hookCode, /引导未能提交，请重试。/);
  // 中断设定为 queue 时不再打断回合（旧 abort-then-send 语义已由 steer 取代）。
  assert.doesNotMatch(hookCode, /await requestAbort\(sid\);\s*\n\s*dispatchNotice\("info", "已打断上一轮/);
});

test("停止优先：abort 落地后本端同步改判排队中的 steer 为已中止", () => {
  const abortAt = hookCode.indexOf("const abort = useCallback");
  assert.ok(abortAt > -1, "abort 必须能定位到");
  const abortRegion = hookCode.slice(abortAt, hookCode.indexOf("const end = useCallback"));
  assert.match(abortRegion, /dispatch\(\{ name: "turn\.done", event_id: 0, data: \{\} \}\);/);
  assert.match(abortRegion, /dispatch\(\{ type: "steer-abort-queued" \}\);/);
  // 改判发生在 turn.done 之后（先收尾再改判，画面顺序不乱）。
  assert.ok(
    abortRegion.indexOf('dispatch({ type: "steer-abort-queued" });') >
      abortRegion.indexOf('dispatch({ name: "turn.done", event_id: 0, data: {} });'),
    "改判必须排在 turn.done 之后",
  );
});

test("端点链路齐备：client → 站内中继 → 网關 /steer（三处都不得缺席）", () => {
  assert.match(client, /export async function steerAgentSession\(/);
  assert.match(client, /`\/api\/agent\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/steer`/);
  assert.match(client, /content: content\.trim\(\)/);
  assert.match(client, /if \(d\.status === "injected"\)/);
  assert.match(client, /if \(d\.status === "queued"\)/);
  // 认不得的回应抛错而不是假装成功（诚实标准：HTTP 200 ≠ 可用）。
  assert.match(client, /throw new AgentChatError\("parse_error", "服务器未返回有效的引导状态。"\);/);

  const relay = "src/app/api/agent/sessions/[id]/steer/route.ts";
  assert.ok(existsSync(join(root, relay)), "中继路由必须存在（复制 abort 路由，只换网關路径）");
  const relayCode = read(relay);
  assert.match(relayCode, /callAgentGateway\(`\/agent\/v1\/sessions\/\$\{id\}\/steer`, \{/);
  assert.match(relayCode, /export async function POST\(req: NextRequest/);
  assert.match(relayCode, /resolveAgentCaller\(req\)/);
  // D2b（2026-09-23）修復鎖：中繼**必須把 body 轉發**。
  // 舊實作只送 `{ method, key }`——正文與 steer_id 全丟在站內：網關只會回
  // 400 "content is required"（REQ-D2 前端→網關這段根本走不通），而且 steer_id
  // 丟了＝命令身份層永遠由網關自鑄新 id，重放偵測對不上（本刀的整個前提）。
  const relayFn = relayCode.slice(relayCode.indexOf("export async function POST"));
  assert.match(relayFn, /await req\.json\(\)/, "中繼必須讀取請求 body");
  assert.match(relayFn, /body: \{[\s\S]*content,[\s\S]*steer_id: steerId/, "content 與 steer_id 必須原樣轉發給網關");
  assert.match(relayFn, /empty_message/, "空正文本地誠實拒絕（不吞）");
});

// ─────────────── F-D2（2026-09-23）對抗性驗收缺陷的具名回歸 ───────────────

test("D2-2 409 契約落地：引導端點回 409 時落回正常送出腿（訊息不得被吞）", () => {
  const client2 = read("src/lib/agent-chat-client.ts");
  // 判定器在 client：409 只有一個語義（沒有可引導的回合），與失敗區分開。
  assert.match(client2, /export function isSteerUnavailableError\(err: unknown\): boolean \{/);
  assert.match(client2, /err\.status === 409/);
  assert.match(client2, /err\.code === "no_active_turn"/);
  assert.match(hook, /isSteerUnavailableError,/);

  // hook：409 走旗標（不吞訊息），非 409 才在 steer 腿收口。
  assert.match(hookCode, /let fellBackToPlainSend = false;/);
  assert.match(hookCode, /if \(isSteerUnavailableError\(err\)\) \{/);
  assert.match(hookCode, /fellBackToPlainSend = true;/);
  assert.match(hookCode, /if \(!fellBackToPlainSend\) return;/);
  assert.match(hookCode, /dispatchNotice\("info", "当前没有进行中的回合，已改为直接发送消息。"\)/);
  // 徽章仍诚实标「未生效」（保留），但内容继续往下走。
  assert.match(hookCode, /dispatch\(\{ type: "steer-ack", steerId, status: "failed" \}\);\s*\n\s*if \(isSteerUnavailableError/);

  const fallbackAt = hookCode.indexOf("if (isSteerUnavailableError(err)) {");
  const plainSendAt = hookCode.indexOf("await sendAgentMessage(");
  assert.ok(fallbackAt > -1 && plainSendAt > fallbackAt, "正常送出腿必须在 409 分支之后（落回才送得出去）");
  // 409 分支本身絕不得 return——那正是「訊息被吞」的實錘（舊版改完徽章就 return）。
  // 收口只能靠下面那個把關旗標的條件式 return。
  const branch = hookCode.slice(fallbackAt, hookCode.indexOf("} else {", fallbackAt));
  assert.doesNotMatch(branch, /\breturn;/, "409 分支內不得出現 return");
  assert.match(branch, /fellBackToPlainSend = true;/);
  assert.match(hookCode.slice(fallbackAt, plainSendAt), /if \(!fellBackToPlainSend\) return;/);
  // 409 時不再補「已加入队列」提示（避免與 fallback 提示重複誤導）。
  assert.match(hookCode, /if \(stateRef\.current\.turnActive && !fellBackToPlainSend\) \{/);
});

test("D2-3 逾時收口接線：TTL 兩端鏡像、排隊時排定清掃、存檔還原帶 savedAt", () => {
  const gatewayCore = read("deploy-staging/gateway/steer-core.ts");
  const types = read("src/lib/agent-chat-types.ts");
  // 鏡像鎖：兩端 TTL 必須逐字同值（網關判逾時、前端判逾時用的是同一個時鐘契約）。
  assert.match(gatewayCore, /export const STEER_QUEUE_TTL_MS = 30 \* 60 \* 1000;/);
  assert.match(types, /export const AGENT_STEER_QUEUE_TTL_MS = 30 \* 60 \* 1000;/);

  // hook：排隊 ack 後排定清掃；存檔還原把 savedAt 一起送進 reducer 並排定剩餘時窗。
  assert.match(hookCode, /const steerExpiryTimerRef = useRef<number \| null>\(null\);/);
  assert.match(hookCode, /if \(ack\.status === "queued"\) armSteerExpiry\(AGENT_STEER_QUEUE_TTL_MS\);/);
  assert.match(hookCode, /dispatch\(\{ type: "steer-expire", now: Date\.now\(\) \}\)/);
  assert.match(hookCode, /case "steer-expire":\s*\n\s*return expireQueuedSteers\(state, \{ now: action\.now, ttlMs: AGENT_STEER_QUEUE_TTL_MS \}\);/);
  assert.match(
    hookCode,
    /dispatch\(\{ type: "restore", items: saved\.items, lastEventId, savedAt: saved\.savedAt \}\)/,
    "restore 必须带存档时刻（逾时判定的兜底锚点）",
  );
  assert.match(hookCode, /armSteerExpiry\(saved\.savedAt \+ AGENT_STEER_QUEUE_TTL_MS - Date\.now\(\)\)/);
  // reducer：還原路徑必須先掃一趟（存檔裡的「排队中」不得原樣復活）。
  assert.match(hookCode, /return expireQueuedSteers\(restored, \{/);
});
