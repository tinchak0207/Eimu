import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 面板接线与空态回馈（09-18）。
//
// 这一片只做「把值接下去」：hook 的 aborting / startingSession → surface → panel →
// composer / batchProgress。照 agent-chat-ui.test.ts 的惯例，全部读源码字符串 + regex
// 断言，不引入 jsdom / react 测试库（组件走 SSR 真渲染的那部分由既有的 ui.test 负责，
// 这里锁的是接线与字面契约）。
const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

const panel = read("src/components/agent-chat/AgentChatPanel.tsx");
const surface = read("src/components/agent-chat/AgentChatSurface.tsx");
const batchProgress = read("src/components/agent-chat/AgentBatchProgress.tsx");

test("surface 把 hook 的 aborting / startingSession 接进 panel", () => {
  // hook 的即时状态镜像要真的被解构出来，不是摆设。
  assert.match(surface, /aborting,/);
  assert.match(surface, /startingSession/);
  // 两个值都要落到 panel 的 props 上（名字逐字）。
  assert.match(surface, /stopPending=\{aborting\}/);
  assert.match(surface, /sessionStarting=\{startingSession\}/);
  // 投递完成要能被下游 await：不再用 void 提前吞掉 promise。
  assert.match(surface, /onSend=\{\(text\) => send\(text\)\}/);
  assert.doesNotMatch(surface, /onSend=\{\(text\) => void send\(text\)\}/);
});

test("panel 把 stopPending 传下去：composer 与 batchProgress 两处都在", () => {
  // 批量进度卡：停止钮在同一行 props 上。
  assert.match(panel, /onStop=\{onStopGeneration\} stopPending=\{stopPending\}/);
  // 输入区：接在 onStop 之后。
  assert.match(panel, /onStop=\{turnActive \? onStopGeneration : undefined\}[\s\S]{0,80}?stopPending=\{stopPending\}/);
  // panel 自己的 props 声明（可选，缺席时默认 falsy ⇒ 行为与接线前逐位元一致）。
  assert.match(panel, /stopPending\?: boolean;/);
  assert.match(panel, /sessionStarting\?: boolean;/);
  assert.match(panel, /stopPending = false/);
  assert.match(panel, /sessionStarting = false/);
});

test("panel 的 onSend 型别放宽，composer 接线回传 promise", () => {
  assert.match(panel, /onSend: \(text: string\) => void \| Promise<void>;/);
  // 首条消息通知照旧触发；接线必须把 promise 回传下去（输入区靠它收在途态）。
  // 2026-09-18 第二版（面板＝在途態单一真相源）：不再直接 `return onSend(text);`，
  // 改成先立面板自己的在途態、把结果存进 result 再回传——下游契约相同（拿得到
  // promise），所以这里钉语义而不是钉当初那行字面。
  assert.match(panel, /if \(items\.length === 0\) onFirstUserMessage\?\.\(\);/);
  assert.match(panel, /let result: void \| Promise<void>;/);
  assert.match(panel, /result = onSend\(text\);/);
  assert.match(panel, /return result;/);
});

test("空态单一 DOM：忙碌不再分流，建号在飞推荐语渲染但强制禁用（零位移）", () => {
  // 既有空态条件逐字保留（另一条测试也钉着它）。
  assert.match(panel, /items\.length === 0 && connection !== "reconnecting" && connection !== "closed"/);

  const emptyStart = panel.indexOf('items.length === 0 && connection !== "reconnecting"');
  assert.ok(emptyStart > -1, "空态条件不存在");
  const emptyEnd = panel.indexOf("<AgentTranscript", emptyStart);
  assert.ok(emptyEnd > emptyStart, "空态三元表达式边界找不到");
  const emptyBlock = panel.slice(emptyStart, emptyEnd);

  // 09-20 零位移定案：忙碌分流分支必须绝迹——分流＝换一套 DOM＝输入框跳位，
  // 前两版（裸 composer 忙碌行 / 同構容器但置中群体不同）都被暴君打回。
  assert.doesNotMatch(emptyBlock, /sessionStarting \|\| turnActive \? \(/, "忙碌分流分支必须已拆");
  assert.doesNotMatch(emptyBlock, /正在建立会话/, "忙碌文字行必须已删");
  // 防重复送出的锁改由「渲染但禁用」承担：建号/首發在飛時 chipState 强制 disabled。
  assert.match(
    emptyBlock,
    /sessionStarting \|\| turnActive \? "disabled" : exampleChipState\(/,
    "推荐语忙碌强制禁用锁不存在（点不到＝不会二次计费）",
  );
  // 单一欢迎 DOM：标题、composer 容器、推荐语各一份。
  assert.match(emptyBlock, /想做点什么？/);
  assert.match(emptyBlock, /\[&_\.agent-composer\]:py-2 \[&_\.agent-composer\]:shadow-\[0_16px_48px_rgba\(0,0,0,0\.10\)\]/);
  assert.match(emptyBlock, /EXAMPLES\.map/);
});

test("推荐语走 handleExampleSend，且带 ref 连点守门", () => {
  assert.match(panel, /const exampleSendRef = useRef\(false\);/);
  assert.match(panel, /if \(exampleSendRef\.current\) return;/);
  assert.match(panel, /exampleSendRef\.current = true;/);
  assert.match(panel, /exampleSendRef\.current = false;/);
  // 硬保险：请求卡死也不能把推荐语永久锁死。
  // 2026-09-18 第二版改用输入区导出的同名常量（`SEND_HARD_TIMEOUT_MS`）而不是
  // 就地写死 20_000——两边同源才不会再漂移，所以这里钉常量名。
  assert.match(panel, /SEND_HARD_TIMEOUT_MS/);
  assert.match(panel, /window\.setTimeout/);
  assert.match(panel, /window\.clearTimeout/);
  // 推荐语按钮改走守门函数，不再直呼 onSend。
  assert.match(panel, /onClick=\{\(\) => handleExampleSend\(ex\)\}/);
  assert.doesNotMatch(panel, /onClick=\{\(\) => onSend\(ex\)\}/);
});

test("batchProgress 的 pending 态与既有 abort 文案并存", () => {
  assert.match(batchProgress, /stopPending\?: boolean;/);
  assert.match(batchProgress, /stopPending = false/);
  assert.match(batchProgress, /disabled=\{stopPending\}/);
  // 非 pending 时的 title 与既有字面逐字保留（旧测试钉着它）。
  assert.match(batchProgress, /立即中止当前这轮生成/);
  assert.match(batchProgress, /title=\{stopPending \? "正在中止，请稍候…" : "立即中止当前这轮生成"\}/);
  // pending 时图标换转圈（2026-09-20 對版預覽：幽靈紅字鈕，spinner 前置 mr-1）。
  assert.match(batchProgress, /Loader2 className="mr-1 h-3\.5 w-3\.5 animate-spin"/);
  assert.match(batchProgress, /disabled:cursor-wait disabled:opacity-60/);
});

test("既有字面未回退", () => {
  // 停止信号仍然只在这轮还开着时给（回合已结束就没有东西可停）。
  assert.match(surface, /onStopGeneration=\{state\.turnActive \? onStopGeneration : undefined\}/);
  // 停止仍然接到 abort 端点，不是往对话里塞一句停止指令。
  assert.match(surface, /const onStopGeneration = useCallback/);
  assert.match(surface, /void abort\(\)/);
  // 2026-09-20 Route C 重设计裁定：决策卡（question/confirm）在場不再锁
  // composerDisabled（改由 composer 上缘 2px 蓝提示条提示「有卡待选」）。
  // 这里锁收窄后的字面，且不许 pending 条件悄悄吃回来。
  assert.match(panel, /composerDisabled = disabled \|\| closed/);
  assert.match(panel, /disabled=\{composerDisabled\}/);
  assert.doesNotMatch(
    panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"),
    /composerDisabled = disabled \|\| closed \|\| pending/,
  );
  // 空态邀问语（2026-09-20 改版值）仍在——欢迎态没被忙碌态替换掉。
  assert.match(panel, /想做点什么？/);
});
