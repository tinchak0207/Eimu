import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 與 agent-chat-ui.test.ts 同一個坑：tsconfig jsx=preserve 讓 tsx 對 .tsx 退回
// classic runtime（React.createElement），元件源碼不 import React。SSR 渲染前
// 補全局 React 樁，否則一渲染就 ReferenceError: React is not defined。
(globalThis as unknown as Record<string, unknown>).React ??= React;

// 觸控 placeholder 的真行為斷言（決策純函數）＋ SSR 真渲染斷言用的元件本體。
import {
  AgentComposer,
  LocalFileModeMenuView,
  PLAIN_UPLOAD_TIMEOUT_MS,
  PLACEHOLDER_SAFETY_PX,
  UploadTimeoutError,
  VIDEO_UPLOAD_TIMEOUT_MS,
  placeholderFitsWidth,
  resolveBasePlaceholder,
  withUploadDeadline,
} from "./AgentComposer";
import { createDeviceBridgeController, supportsSetMode, type BridgeStatus } from "@/lib/device-bridge-display";

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

/**
 * 思考级别徽章 button 的开标签（用于「不再被包着」的反面断言）。
 * 以 aria-haspopup="listbox" 唯一定位；从它往前找最近的 <button，再取该标签的收尾 >。
 * 标签内 className 的 cn(...) 不含 > 字元，故第一个 > 即标签收尾。
 */
const badgeTagAnchor = code.indexOf('aria-haspopup="listbox"');
const badgeButtonTag = code.slice(
  code.lastIndexOf("<button", badgeTagAnchor),
  code.indexOf(">", badgeTagAnchor) + 1,
);

/**
 * 思考级别 chip 根 div 的开标签：从 function ThinkingLevelMenu 往下找第一个 <div，
 * 取该标签的收尾 >。用于「chip 容器不得挂 relative」的反面断言（锚定链约束）。
 */
const chipRootAnchor = code.indexOf("function ThinkingLevelMenu");
const chipDivAt = code.indexOf("<div", chipRootAnchor);
const chipRootTag = code.slice(chipDivAt, code.indexOf(">", chipDivAt) + 1);

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

test("思考级别菜单：工具行同排、「+」右边、收起态 iconX、键盘/外部点击/焦点环齐备", () => {
  const popover = read("src/components/agent-chat/AgentSettingsPopover.tsx");
  // 四列已撤：设定弹层不得再出现中途输入 / 模型性格 / 成本需求 / 野兽模式。
  // 断言去注释后的源码——注释里解释「这些行已移除」是合法的，不是渲染出来的 UI。
  assert.doesNotMatch(readCode(popover), /中途输入|模型性格|成本需求|野兽模式/);

  // 菜单落在输入区（AgentComposer），工具行流内、「+」右边（暴君 2026-10-03 三选一定案）。
  assert.match(code, /function ThinkingLevelMenu/);
  // 定位锁定：chip 容器**不得**再挂 relative（挂了面板会贴着 chip 往上开、
  // 下半压在输入框上）；展开面板的 containing block 回到 composer 根，
  // 其 class 逐字对齐同档 SkillSlashMenu 的同名定位语汇。
  assert.match(code, /shrink-0 ml-0\.5/, "chip 在工具行流内、「+」右边（非悬浮）");
  assert.doesNotMatch(chipRootTag, /relative/, "chip 容器不得挂 relative（面板锚在 composer 根）");
  assert.match(
    code,
    /absolute bottom-full left-1\.5 z-50 mb-2 w-max/,
    "面板逐字对齐 SkillSlashMenu：bottom-full + left-1.5 + mb-2",
  );
  // 徽章折行/溢出回归锁：chip 是工具行 flex 子项，必须靠 w-max（按内容定宽）
  // ＋ whitespace-nowrap（文字永不折行）保住单行胶囊。
  assert.match(code, /whitespace-nowrap/);
  assert.match(code, /w-max/);
  assert.match(code, /<ThinkingLevelMenu disabled=\{!canAttach\} \/>/);
  // 收起态＝lucide Brain + 级别字 + 尾端 ChevronDown：emoji 与自绘 SVG 都彻底移除
  // （PRODUCT.md「UI 禁用 emoji 圖示」；图标家族统一走 lucide）。
  // 用码点的转义写死（而非字面 emoji），让整个 src/ 不再出现该字元。
  assert.doesNotMatch(code, /\u{1F9E0}/u);
  assert.match(code, /<Brain /);
  assert.match(code, /ChevronDown/);
  assert.match(code, /aria-hidden="true"/);
  // 反面锁：徽章 button 不再被包着——class 不含任何胶囊语汇（无框/无底/无影/无圆胶囊）。
  assert.ok(badgeButtonTag.length > 0, "徽章 button 开标签必须能定位到");
  assert.doesNotMatch(
    badgeButtonTag,
    /border(-|\/|"|\s)|bg-white\/|backdrop-blur|rounded-full/,
  );
  // 收起态锚点仍在工具行流内，「+」右边（缩小范围到已被 <button> 收尾截断的开标签）。
  assert.match(badgeButtonTag, /flex w-max/);
  assert.match(code, /AGENT_THINKING_LEVEL_LABELS\[level\]/);
  // 可 Tab 到、Enter/Space 可開（真 button）＋ Esc 可關 ＋ 點擊外部收起。
  assert.match(code, /aria-haspopup="listbox"/);
  assert.match(code, /aria-expanded=\{open\}/);
  assert.match(code, /aria-label=\{`思考级别：\$\{label\}（低\/中\/高\/极限）`\}/);
  assert.match(code, /event\.key === "Escape"/);
  assert.match(code, /addEventListener\("pointerdown"/);
  // 焦點環走 --ring 主題 token。
  assert.match(code, /focus-visible:ring-2 focus-visible:ring-ring\/40/);
  // 展開後四檔：說明行已刪，說明字串改掛每列 title（真源仍是 AGENT_THINKING_LEVEL_HINTS）。
  assert.match(code, /title=\{AGENT_THINKING_LEVEL_HINTS\[lv\]\}/);
  // 當前檔右端一顆勾。
  assert.match(code, /<Check /);
  // 寫入：顯式級別 localStorage ＋ 既有唯一寫入者 saveAgentSettings（三欄 patch）。
  assert.match(code, /writeCachedAgentThinkingLevel\(next\)/);
  assert.match(code, /saveAgentSettings\(agentThinkingLevelPatch\(next\)\)/);
  // 面板不得再用會帶 translateX(-50%) 的 agent-pop-in（配 left-0 會左移半個寬度、
  // 內容滑出面板外＝生產上「級別名跑到面板左緣之外」的根因）。
  assert.doesNotMatch(code, /agent-pop/);
});

test("attachFilesRef：可選介面把既有附件入口註冊出去（不傳＝不變）", () => {
  // prop 存在且型別正確（可選）。
  assert.match(
    composer,
    /attachFilesRef\?: MutableRefObject<\(\(files: File\[\]\) => void\) \| null>;/,
  );
  // effect 只在傳了 ref 時註冊；註冊的是既有 enqueueFiles（不另寫一份入隊邏輯）。
  assert.match(composer, /if \(!attachFilesRef\) return;/);
  assert.match(composer, /attachFilesRef\.current = \(files: File\[\]\) => \{/);
  assert.match(composer, /void enqueueFiles\(files\);/);
  // 卸載歸 null。
  assert.match(composer, /attachFilesRef\.current = null;/);
});

test("觸控裝置 placeholder：coarse 換「传上来」版，fine/桌面保留「拖进来」（決策函數真行為斷言）", () => {
  // 獨立 oracle：期望字串由本測試自帶，不從實作模組取（禁同源斷言）。
  const DESKTOP_LONG = "描述你想做的，或把剧本／资产图拖进来";
  // coarse pointer（手機/平板）→ 上傳語彙；手機拖不了檔，「拖进来」是做不到的動作。
  const touch = resolveBasePlaceholder(DESKTOP_LONG, true);
  assert.ok(touch.includes("传上来"), "coarse pointer 必須換「传上来」版");
  assert.ok(!touch.includes("拖进来"), "觸控裝置不得再說「拖进来」");
  // fine pointer（桌面）→ 原值一字不動。
  assert.equal(resolveBasePlaceholder(DESKTOP_LONG, false), DESKTOP_LONG);
  // 呼叫端自訂 placeholder 永不被換——coarse 只作用內建長句。
  assert.equal(resolveBasePlaceholder("自訂提示", true), "自訂提示");
});

test("placeholder SSR/首幀＝桌面長句（hydration 安全），掛載後 effect 才按 matchMedia 切觸控版", () => {
  // 真渲染斷言：SSR 與首幀同路徑（effect 未跑，coarse=false）→ textarea 帶「拖进来」。
  const markup = renderToStaticMarkup(
    createElement(AgentComposer, { disabled: false, onSend: () => {} }),
  );
  assert.match(markup, /placeholder="[^"]*拖进来[^"]*"/);
  // 切換點探針（變更探針，非行為斷言）：掛載後一次性 matchMedia("(pointer: coarse)") 判定，
  // 選中的基礎句走 resolveBasePlaceholder，DEFAULT_PLACEHOLDER 原值保留（桌面/源碼釘不動）。
  assert.match(code, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(code, /resolveBasePlaceholder\(placeholder, coarsePointer\)/);
  assert.match(code, /const DEFAULT_PLACEHOLDER = "描述你想做的，或把剧本／资产图拖进来"/);
});

test("placeholderFits 边界：measured == clientWidth 与 clientWidth-4 都回落 compact（纯函数注入量测）", () => {
  // 2026-10-03 手机实锤：390px 下 textarea clientWidth=284，同字型 canvas 量到长句
  // 288px → nowrap 直接裁尾。placeholderFitsWidth 是注入式纯函数（measured,
  // availableWidth），无需真 DOM。独立 oracle：边界值由本测试自备，不向实现取。
  const clientWidth = 284;
  // 临界值与 4px 之差（本刀真凶）都必须回落 COMPACT_PLACEHOLDER。
  assert.equal(placeholderFitsWidth(clientWidth, clientWidth), false, "measured == clientWidth 必须回落 compact");
  assert.equal(
    placeholderFitsWidth(clientWidth - 4, clientWidth),
    false,
    "measured == clientWidth - 4 必须回落 compact",
  );
  // 加了 8px 安全边際后刚好塞得下 → 才显示长句；有余量当然显示。
  assert.equal(placeholderFitsWidth(clientWidth - PLACEHOLDER_SAFETY_PX, clientWidth), true);
  assert.equal(placeholderFitsWidth(200, clientWidth), true);
  // 量不到内容宽（availableWidth ≤ 0）时不误切短句（沿用原行为）。
  assert.equal(placeholderFitsWidth(999, 0), true);
  assert.equal(placeholderFitsWidth(999, -1), true);
  // 安全边際必须是 ≥8 的正值：改回 0px 边界就是回到「临界值赌命」的老坑。
  assert.ok(PLACEHOLDER_SAFETY_PX >= 8, "安全边際须 ≥8px");
  // 变更探针：量字用的 font 不再直接取 style.font（textarea 上会回空串，ctx.font
  // 落回 10px sans-serif 量成 180px → 永远「放得下」）。
  assert.match(code, /function resolveMeasureFont\(/);
  assert.match(code, /if \(style\.font\) return style\.font;/);
  assert.match(code, /ctx\.font = resolveMeasureFont\(window\.getComputedStyle\(el\)\)/);
  // 决策纯函数比对的是 clientWidth（与 spec/测试注入口径一致）。
  assert.match(code, /placeholderFitsWidth\(ctx\.measureText\(text\)\.width, el\.clientWidth\)/);
});

// 2026-10-04 缺陷 A：直传/上传等待必须有 deadline，逾时落 UploadTimeoutError
// 让人话终态（不得永久停在 uploading）。行为断言，不靠源码字面。
test("withUploadDeadline：限时内完成原样返回，不误杀", async () => {
  const value = await withUploadDeadline(Promise.resolve("ok"), 1_000);
  assert.equal(value, "ok");
});

test("withUploadDeadline：逾时抛 UploadTimeoutError 且带人话", async () => {
  const never = new Promise<never>(() => {});
  await assert.rejects(
    withUploadDeadline(never, 10),
    (err: unknown) => {
      assert.ok(err instanceof UploadTimeoutError);
      assert.equal((err as Error).message, "上传超时，请重试。");
      return true;
    },
  );
});

test("withUploadDeadline：底层先失败时原样透传错误（不吞成逾时）", async () => {
  await assert.rejects(withUploadDeadline(Promise.reject(new Error("网络失败")), 1_000), /网络失败/);
});

test("VIDEO_UPLOAD_TIMEOUT_MS 是数分钟级（不短于数十 MB 的正常上传）", () => {
  assert.ok(VIDEO_UPLOAD_TIMEOUT_MS >= 120_000, "原片直传上限不得短于 2 分钟");
});

// 2026-10-04「永久 pending」族残餘：uploadPlainFile（非影片附件）原本裸 await
// uploadAgentAttachments，站内代理卡死时 chip 永久停在 uploading、连 job.catch 都不落。
test("uploadPlainFile：经 withUploadDeadline + PLAIN_UPLOAD_TIMEOUT_MS 收口（逾时必落明确失败）", async () => {
  // 行为：非影片附件上限必须比原片 180s 短（几 MB 档，站内代理直传）。
  assert.ok(PLAIN_UPLOAD_TIMEOUT_MS > 0, "上限必须为正");
  assert.ok(
    PLAIN_UPLOAD_TIMEOUT_MS < VIDEO_UPLOAD_TIMEOUT_MS,
    "非影片附件上限应短于原片直传（档更小、路径更短）",
  );
  // 行为：套上 deadline 后，永不 settle 的上传必落 UploadTimeoutError 人话。
  // 用缩短的注入值（20ms），不靠等真实的 PLAIN_UPLOAD_TIMEOUT_MS。
  const started = Date.now();
  await assert.rejects(
    withUploadDeadline(new Promise<never>(() => {}), 20),
    (err: unknown) => {
      assert.ok(err instanceof UploadTimeoutError);
      assert.equal((err as Error).message, "上传超时，请重试。");
      return true;
    },
  );
  assert.ok(Date.now() - started < 1_000, "逾时必须由注入的缩短值触发，不靠等真实上限");
});

test("uploadPlainFile 组合探针：deadline 包住 uploadAgentAttachments，逾时经 job.catch 落 error chip", () => {
  // 组合探针（非行为 oracle）：确认 uploadPlainFile 真的把 deadline 套在这条路径上，
  // 且逾时错误最终由 enqueueFiles 的 job.catch 写成带 message 的 error 终态。
  const plainRegion = code.slice(
    code.indexOf("const uploadPlainFile = useCallback"),
    code.indexOf("const uploadVideoFile = useCallback"),
  );
  assert.ok(plainRegion.length > 0, "uploadPlainFile 本体必须能定位到");
  assert.match(
    plainRegion,
    /withUploadDeadline\(\s*uploadAgentAttachments\(session, \[file\]\),\s*PLAIN_UPLOAD_TIMEOUT_MS,\s*\)/,
    "非影片附件路径必须用 withUploadDeadline + PLAIN_UPLOAD_TIMEOUT_MS 包住上传",
  );
  // enqueueFiles 的失败收口：任何 reject（含 UploadTimeoutError 的人话）写成 error 终态。
  assert.match(
    code,
    /job\.catch\(\(err\) => \{\s*const message = err instanceof Error \? err\.message : "上传失败。";\s*patchAttachment\(id, \{ status: "error", errorMessage: message \}\);/,
    "job.catch 必须把逾时错误落成带人话的 error chip（不得静默消失）",
  );
});

// ═══════════════════════════ 本機檔案權限模式控件（2026-10-04）═══════════════════════════
//
// 分兩層驗：
//   1. 展示層（LocalFileModeMenuView）以真 SSR 渲染釘四檔文案／選中態／舊產物 disabled。
//   2. 薄殼的資料路徑：注入假 window.eimuLocal，用 shell 實際走的預設讀法
//      （createDeviceBridgeController() → getDeviceBridgeApi → globalThis.eimuLocal）
//      驗 init 讀 status／切檔叫 setMode／舊產物 disable 降級／卸載取消訂閱。
// oracle：期望字串由本測試自備（獨立於實作模組），不從 LOCAL_FILE_MODES 取。

type GlobalWithLocal = typeof globalThis & { eimuLocal?: unknown };

function setEimuLocal(api: unknown): void {
  const g = globalThis as GlobalWithLocal;
  if (api === undefined) delete g.eimuLocal;
  else g.eimuLocal = api;
}

interface ModeFake {
  calls: { setMode: string[]; enable: number; disable: number; unsub: number; status: number };
  api: unknown;
}

function makeModeApi(hasSetMode: boolean): ModeFake {
  const calls: ModeFake["calls"] = { setMode: [], enable: 0, disable: 0, unsub: 0, status: 0 };
  const mkStatus = (mode: string): BridgeStatus => ({
    enabled: mode !== "off",
    state: mode === "off" ? "off" : "online",
    roots: ["/home/me/docs"],
    deviceId: "dev-1",
    mode: mode as BridgeStatus["mode"],
  });
  const bridge: Record<string, unknown> = {
    async status() {
      calls.status += 1;
      return mkStatus("ask");
    },
    async enable() {
      calls.enable += 1;
      return mkStatus("auto");
    },
    async disable() {
      calls.disable += 1;
      return mkStatus("off");
    },
  };
  if (hasSetMode) {
    bridge.setMode = async (mode: string) => {
      calls.setMode.push(mode);
      return mkStatus(mode);
    };
  }
  const api = {
    bridge,
    onBridgeStatus() {
      return () => {
        calls.unsub += 1;
      };
    },
    async pickFiles() {
      return [] as string[];
    },
  };
  return { calls, api };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("本機檔案權限控件（展示層）：四檔標題／副標逐字可見＋當前檔右端一勾", () => {
  const markup = renderToStaticMarkup(
    createElement(LocalFileModeMenuView, {
      open: true,
      onToggleOpen: () => {},
      onPick: () => {},
      supported: true,
      known: true,
      mode: "ask",
      rootsCount: 2,
      busy: false,
    }),
  );
  // 四檔標題逐字（oracle 由測試自備）。
  for (const title of ["關閉", "每次詢問", "授權範圍內自動", "完全訪問"]) {
    assert.ok(markup.includes(title), `四檔必須含標題「${title}」`);
  }
  // 四檔副標逐字（含 full 的敏感路徑警告）。
  for (const sub of [
    "agent 不能讀取本機檔案。",
    "每次讀取前先問你。",
    "已授權資料夾內自動讀取，範圍外會先問你。",
    "整個家目錄可讀；敏感位置（~/.ssh、~/.aws、私鑰等）一律不讀。",
  ]) {
    assert.ok(markup.includes(sub), `四檔必須含副標「${sub}」`);
  }
  // 恰好一列被標記為選中（ask），且帶勾圖示。
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1, "只能有一列選中");
  assert.match(markup, /lucide-check/, "選中列右端一顆勾");
  // 已授權數量（檢視用，非授權入口）。
  assert.ok(markup.includes("已授權 2 個資料夾"), "應顯示已授權資料夾數量");
  // 不得出現「選擇資料夾」之類的授權入口按鈕。
  assert.ok(!markup.includes("選擇資料夾") && !markup.includes("选择文件夹"), "控件不得內建授權入口");
});

test("本機檔案權限控件（展示層）：roots 空顯示『尚未授權任何資料夾』", () => {
  const markup = renderToStaticMarkup(
    createElement(LocalFileModeMenuView, {
      open: true,
      onToggleOpen: () => {},
      onPick: () => {},
      supported: true,
      known: true,
      mode: "off",
      rootsCount: 0,
      busy: false,
    }),
  );
  assert.ok(markup.includes("尚未授權任何資料夾"), "空 roots 必須明說尚未授權");
});

test("本機檔案權限控件（展示層）：舊產物 supported=false ⇒ disabled＋『需更新桌面版』，不崩", () => {
  const markup = renderToStaticMarkup(
    createElement(LocalFileModeMenuView, {
      open: true, // 即便被要求開，disabled 態也不得長出清單
      onToggleOpen: () => {},
      onPick: () => {},
      supported: false,
      known: true,
      mode: "auto",
      rootsCount: 0,
      busy: false,
    }),
  );
  assert.match(markup, /disabled=""/, "舊產物時控件必須 disabled");
  assert.ok(markup.includes("需更新桌面版"), "舊產物時必須提示需更新桌面版");
  assert.ok(!markup.includes('role="option"'), "disabled 態不得展開四檔清單");
});

test("純瀏覽器（無 eimuLocal）：AgentComposer SSR 不渲染本機檔案權限控件（漸進增強、非報錯）", () => {
  setEimuLocal(undefined);
  const markup = renderToStaticMarkup(createElement(AgentComposer, { disabled: false, onSend: () => {} }));
  assert.ok(!markup.includes("本機檔案權限"), "無 eimuLocal 時控件不得渲染");
  assert.ok(markup.includes("思考级别"), "既有思考級別控件仍在（沒被建壞）");
});

test("薄殼資料路徑：注入假 eimuLocal ⇒ init 讀 status、切檔呼叫 setMode、卸載取消訂閱", async () => {
  const { api, calls } = makeModeApi(true);
  setEimuLocal(api);
  try {
    assert.equal(supportsSetMode(api), true);
    const ctl = createDeviceBridgeController(); // 預設讀法＝globalThis.eimuLocal（與 shell 一致）
    ctl.init();
    await tick();
    assert.equal(ctl.getSnapshot().available, true);
    assert.equal(ctl.getSnapshot().status?.mode, "ask");
    await ctl.setMode("full");
    assert.deepEqual(calls.setMode, ["full"], "切檔必須呼叫 bridge.setMode");
    assert.equal(ctl.getSnapshot().status?.mode, "full");
    ctl.dispose();
    assert.equal(calls.unsub, 1, "卸載必須取消 onBridgeStatus 訂閱");
  } finally {
    setEimuLocal(undefined);
  }
});

test("薄殼資料路徑：舊產物（無 setMode）⇒ supportsSetMode false，off 走 disable 降級", async () => {
  const { api, calls } = makeModeApi(false);
  setEimuLocal(api);
  try {
    assert.equal(supportsSetMode(api), false);
    const ctl = createDeviceBridgeController();
    ctl.init();
    await tick();
    await ctl.setMode("off");
    assert.equal(calls.disable, 1, "舊產物 off 必須降級走 disable()");
    assert.deepEqual(calls.setMode, []);
    await ctl.setMode("auto");
    assert.equal(calls.enable, 1, "舊產物非 off 必須降級走 enable()");
    ctl.dispose();
  } finally {
    setEimuLocal(undefined);
  }
});
