import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AgentComposer 输入区三颗按钮的回归锁：IME 组字守卫、送出连点锁、中止进行中态。
 *
 * 与前身 agent-chat-ui.test.ts 同惯例：只读源码 + regex 断言，不引入 jsdom /
 * react 测试库（node --test 直跑，零依赖）。跨文件字面契约（disabled / aria-label）
 * 由 agent-chat-ui.test.ts 与这里双向锁住，任何一边改字面都会红。
 */

const root = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

const composer = read("src/components/agent-chat/AgentComposer.tsx");

/**
 * 去掉注释后的源码。顺序类断言（谁在谁之前）必须走这里：
 * 注释里解释「为什么 isComposing 要在 preventDefault 之前」会把索引带偏。
 */
function readCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = readCode(composer);

/** handleKeyDown 本体（到下一个同名声明为止），用于隔离 preventDefault 的其他出现点。 */
const keyDownRegion = code.slice(
  code.indexOf("const handleKeyDown"),
  code.indexOf("const handlePaste"),
);

/** 停止钮分支：从三元条件到送出钮的 aria-label 之间。 */
const stopRegion = code.slice(
  code.indexOf("onStop && !canSend"),
  code.indexOf('aria-label="发送"'),
);

/** 送出钮本体：aria-label="发送" 之后到组件收尾。 */
const sendRegion = code.slice(code.indexOf('aria-label="发送"'));

/** handleSend 本体（到下一个 useCallback 声明为止），隔离其他 catch/return。 */
const handleSendRegion = code.slice(
  code.indexOf("const handleSend = useCallback"),
  code.indexOf("const consumedNonceRef"),
);

test("IME 组字中的 Enter 不送出：isComposing 判定在 preventDefault 之前", () => {
  assert.ok(keyDownRegion.length > 0, "handleKeyDown 必须能定位到");
  const composingAt = keyDownRegion.indexOf("event.nativeEvent.isComposing");
  const legacyAt = keyDownRegion.indexOf("event.keyCode === 229");
  const preventAt = keyDownRegion.indexOf("event.preventDefault()");
  const sendAt = keyDownRegion.indexOf("handleSend()");

  assert.ok(composingAt >= 0, "必须有 event.nativeEvent.isComposing 守卫");
  assert.ok(legacyAt >= 0, "必须保留 keyCode === 229 旧式 IME 判定");
  assert.ok(preventAt >= 0, "preventDefault 必须仍在");
  assert.ok(sendAt >= 0, "handleSend 调用必须仍在");
  // 组字判定在 preventDefault 之前：对组字中的 Enter 调 preventDefault
  // 会让部分浏览器吃不到候选词确认（「按了 Enter 字不见」）。
  assert.ok(composingAt < preventAt, "isComposing 判定必须在 preventDefault 之前");
  assert.ok(legacyAt < preventAt, "keyCode 229 判定必须在 preventDefault 之前");
  // 组字时提前 return，绝不落到 handleSend。
  assert.match(
    keyDownRegion,
    /if \(event\.nativeEvent\.isComposing \|\| event\.keyCode === 229\) return;/,
  );
});

test("Enter 送出 / Shift+Enter 换行的字面契约不变", () => {
  assert.match(composer, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(keyDownRegion, /if \(!canSend\) return;/);
});

test("送出锁：ref 同步挡连点 + finally 解锁 + 20s 硬保险", () => {
  // ref 与 state 成对存在：state 驱动 spinner，ref 负责同一帧里的连点。
  assert.match(composer, /const \[sending, setSending\] = useState\(false\);/);
  assert.match(composer, /const sendingRef = useRef\(false\);/);
  // handleSend 开头的同步守卫（在 canSend 检查之前，任何路径都先挡）。
  assert.match(composer, /if \(sendingRef\.current\) return;/);
  // 上锁：通过资格检查后立刻写 ref + state。
  assert.match(composer, /sendingRef\.current = true;\s*\n\s*setSending\(true\);/);
  // 解锁幂等：清计时器 + ref + state 一起清。
  assert.match(composer, /const unlockSend = useCallback\(\(\) => \{/);
  assert.match(composer, /sendingRef\.current = false;\s*\n\s*setSending\(false\);/);
  assert.match(composer, /clearTimeout\(sendUnlockTimerRef\.current\)/);
  // promise 统一化 + 吞异常 + finally 解锁（错误提示由 hook 的 notice 负责）。
  assert.match(composer, /Promise\.resolve\(onSend\(finalText\)\)/);
  assert.match(composer, /\.catch\(\(\) => \{\}\)\s*\n\s*\.finally\(unlockSend\)/);
  // 同步 throw 也要解锁，否则按钮永久假死。
  assert.match(handleSendRegion, /\} catch \{\s*unlockSend\(\);/);
  // 硬保险：relay fetch 无 timeout，请求卡死不能把送出钮永久锁死（≤20s）。
  assert.match(composer, /const SEND_HARD_TIMEOUT_MS = 20_000;/);
  assert.match(composer, /setTimeout\(unlockSend, SEND_HARD_TIMEOUT_MS\)/);
});

test("onSend 允许返回 promise（投递完成前保持进行中态）", () => {
  assert.match(composer, /onSend: \(text: string\) => void \| Promise<void>;/);
});

test("送出钮：字面契约不回归，sending 时只换图标与 aria-busy", () => {
  // 这两条字面是别条工作线 / 既有测试的断点，必须逐字存在。
  assert.match(composer, /disabled=\{disabled \|\| !canSend\}/);
  assert.match(composer, /aria-label="发送"/);
  // 锁连点靠 ref，不许把 sending 塞进 disabled 属性（会弄红既有断言）。
  assert.doesNotMatch(sendRegion, /disabled=\{disabled \|\| !canSend \|\| sending\}/);
  assert.match(sendRegion, /aria-busy=\{sending\}/);
  assert.match(sendRegion, /<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" \/>/);
  assert.match(sendRegion, /<ArrowUp className="h-4 w-4" aria-hidden="true" \/>/);
});

test("输入区其余契约不动：disabled / canSend / autoGrow", () => {
  assert.match(composer, /disabled=\{disabled\}/);
  assert.match(composer, /const canSend = computeCanSend\(trimmed, readyRefs\.length, attachments\);/);
  assert.match(composer, /function autoGrow\(el: HTMLTextAreaElement\)/);
  assert.match(composer, /autoGrow\(event\.currentTarget\)/);
  assert.match(composer, /textareaRef\.current\.style\.height = "auto"/);
});

test("中止钮停止进行中态：stopPending 默认 false 时行为与今天一致", () => {
  assert.match(composer, /stopPending\?: boolean;/);
  // 缺省 false：不传时既不 disabled 也不换文案/图标。
  assert.match(composer, /stopPending = false,/);
  assert.ok(stopRegion.length > 0, "停止钮分支必须能定位到");
  assert.match(stopRegion, /disabled=\{stopPending\}/);
  assert.match(
    stopRegion,
    /title=\{stopPending \? "正在中止，请稍候…" : "立即中止当前这轮生成"\}/,
  );
  assert.match(stopRegion, /aria-label="中止助理生成"/);
  assert.match(stopRegion, /<Loader2 className="h-3\.5 w-3\.5 animate-spin" aria-hidden="true" \/>/);
  assert.match(stopRegion, /<Square className="h-3\.5 w-3\.5" aria-hidden="true" \/>/);
  // 极简纪律：圆钮旁不加文字胶囊/徽章。
  assert.doesNotMatch(stopRegion, /正在中止，请稍候…<\/span>|中止中<\/span>|\{stopPending && \(/);
});
