import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

const panel = read("src/components/agent-chat/AgentChatPanel.tsx");
const composer = read("src/components/agent-chat/AgentComposer.tsx");
const transcript = read("src/components/agent-chat/AgentTranscript.tsx");
const bubble = read("src/components/agent-chat/AgentMessageBubble.tsx");
const toolCard = read("src/components/agent-chat/AgentToolCard.tsx");
const imageCard = read("src/components/agent-chat/AgentImageCard.tsx");
const confirmCard = read("src/components/agent-chat/AgentConfirmCard.tsx");
const questionCard = read("src/components/agent-chat/AgentQuestionCard.tsx");
const noticeRow = read("src/components/agent-chat/AgentNoticeRow.tsx");
const surface = read("src/components/agent-chat/AgentChatSurface.tsx");
const anchorCard = read("src/components/agent-chat/AgentAnchorCard.tsx");
const batchProgress = read("src/components/agent-chat/AgentBatchProgress.tsx");
const disclosure = read("src/components/agent-chat/AgentParamDisclosure.tsx");
const chatCss = read("src/components/agent-chat/agent-chat.css");
const promptInput = read("src/components/PromptInput.tsx");
// Task 3：PromptInput 的高度鎖 / 無描述框模式集合抽到 hooks —— 斷言按「舊檔＋新檔」拼接讀取。
const promptInputHeightLock = read("src/components/prompt-input/use-height-lock.ts");
const playground = read("src/components/ImagePlayground.tsx");
const navbar = read("src/components/Navbar.tsx");
const agentRoute = read("src/app/agent/page.tsx");

/**
 * 去掉注释后的源码。doesNotMatch 一律要走这里——
 * 注释里出现「不要这样写」的反例是常态，拿原文断言会把注释当违规。
 */
function readCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const AGENT_COMPONENTS: Array<[string, string]> = [
  ["AgentChatPanel", panel],
  ["AgentComposer", composer],
  ["AgentTranscript", transcript],
  ["AgentMessageBubble", bubble],
  ["AgentToolCard", toolCard],
  ["AgentImageCard", imageCard],
  ["AgentConfirmCard", confirmCard],
  ["AgentQuestionCard", questionCard],
  ["AgentNoticeRow", noticeRow],
  ["AgentAnchorCard", anchorCard],
  ["AgentBatchProgress", batchProgress],
  ["AgentParamDisclosure", disclosure],
];

/** 用 tag 栈判断 JSX 里是否出现嵌套 <button>（已知全站坑）。 */
function hasNestedButtons(source: string): boolean {
  const stack: string[] = [];
  const re = /<\/?button\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tag = m[0];
    if (tag.startsWith("</")) {
      stack.pop();
    } else {
      stack.push(tag);
      if (stack.length > 1) return true;
    }
  }
  return false;
}

test("composer is disabled when session closed, and trims before sending", () => {
  // 面板把「disabled 属性或会话已关闭」折叠成一个布尔传下去。
  assert.match(panel, /composerDisabled = disabled \|\| closed/);
  assert.match(panel, /disabled=\{composerDisabled\}/);
  // textarea 与发送按钮都必须跟随禁用。
  assert.match(composer, /disabled=\{disabled\}/);
  assert.match(composer, /disabled=\{disabled \|\| !trimmed\}/);
  // 空消息必须被拒绝：发送前 trim。
  assert.match(composer, /\.trim\(\)/);
});

test("transcript is a polite live region and streaming is announced", () => {
  assert.match(panel, /aria-live="polite"/);
  // 串流状态不能只靠视觉光标，必须有无障碍播报。
  assert.match(panel, /role="status"/);
  assert.match(panel, /助手正在输入/);
});

test("composer has a real label, Enter sends and Shift+Enter newlines", () => {
  assert.match(composer, /htmlFor="agent-composer-input"/);
  assert.match(composer, /id="agent-composer-input"/);
  assert.match(composer, /aria-label="发送"/);
  assert.match(composer, /event\.key === "Enter" && !event\.shiftKey/);
});

test("image action buttons are disabled when no callback is wired", () => {
  // wiring 阶段之前四个动作一律 disabled，不允许伪造 handler。
  assert.match(imageCard, /disabled=\{!onSaveToLibrary\}/);
  assert.match(imageCard, /disabled=\{!onEdit\}/);
  assert.match(imageCard, /disabled=\{!onUpscale\}/);
  assert.match(imageCard, /disabled=\{!onDownload\}/);
  assert.doesNotMatch(imageCard, /fetch\(/);
  // 回调以可选 props 形式接收，供后续步骤直接接上。
  assert.match(imageCard, /onSaveToLibrary\?: \(item: AgentImageItem\) => void/);
});

test("reconnecting shows an unobtrusive retry affordance", () => {
  assert.match(panel, /connection === "reconnecting"/);
  assert.match(panel, /onRetryConnection/);
  assert.match(panel, /重试/);
  // 重连不能挡住正文：转录区始终渲染（不在 reconnecting 分支里跳空态）。
  assert.doesNotMatch(panel, /items\.length === 0 && connection === "reconnecting"/);
});

test("closed session surfaces its reason", () => {
  assert.match(panel, /closedReason/);
  assert.match(panel, /原因：\{closedReason\}/);
});

test("empty open session shows a prompt to start, not a blank void", () => {
  assert.match(panel, /items\.length === 0 && connection === "open"/);
  assert.match(panel, /和智能体聊聊/);
});

test("D-24 half sentence is carried into the composer, never auto-sent", () => {
  // 药丸点下去只能填进输入框：直接 send 等于替用户开一轮扣费的生成（D-5）。
  assert.match(surface, /const continueDraft = useCallback/);
  assert.match(surface, /setPrefill\(\{ text, nonce: Date\.now\(\) \}\)/);
  assert.doesNotMatch(surface, /onClick=\{sendDraft\}/);
  // 续写信号一路透传到输入区。
  assert.match(surface, /prefill=\{prefill\}/);
  assert.match(panel, /prefill=\{prefill\}/);
  assert.match(panel, /onPrefillConsumed=\{onPrefillConsumed\}/);

  // 靠 nonce 去重，不靠文本比较：同一句话点第二次也要能重新填进来。
  assert.match(composer, /consumedNonceRef\.current === prefill\.nonce/);
  // 框里已有内容时接在后面，不覆盖用户刚打的字。
  assert.match(composer, /return base \? `\$\{base\} \$\{incoming\}` : incoming/);
  // 光标落到末尾，下一个动作就是继续打字。
  assert.match(composer, /setSelectionRange\(el\.value\.length, el\.value\.length\)/);
  // 注入后必须回报上游清空信号，否则重渲染会反复盖掉新输入。
  assert.match(composer, /onPrefillConsumed\?\.\(\)/);
  /*
   * 这个 effect 不许 return cancelAnimationFrame：onPrefillConsumed 会立刻把
   * prefill 置空，依赖一变清理函数就跑在 rAF 回调之前，光标永远等不到。
   */
  assert.doesNotMatch(composer, /return \(\) => cancelAnimationFrame/);
});

test("D-17 有存档时默认开新对话，不拦人做选择题", () => {
  /*
   * hook 在有存档时故意不自动建号（use-agent-chat.ts: `if (existing && !forceNewRef.current) return`），
   * 所以外壳必须替使用者把决定做掉——开新的。不做就是一个永远「未连接」的死面板。
   *
   * 旧版是摆一张「继续上次 / 结束它开新的」的卡并禁用输入区。那张卡在教用户
   * 管理会话：每次刷新拦一次，还要读懂「开新的会删掉上面这段对话」才敢按。
   */
  assert.match(surface, /resumable,/);
  assert.match(surface, /discardAndStartNew,/);
  // mount 后发现存档 → 存快照 → 静默续上，不问（2026-08-21 会话持久化后
  // 由删旧开新改为 resume；discardAndStartNew 保留在 hook 里但已无 UI 调用方）。
  assert.match(surface, /didAutoDiscardRef/);
  assert.match(surface, /setHistorySnapshot\(\{ itemCount: resumable\.itemCount, savedAt: resumable\.savedAt \}\)/);
  assert.match(surface, /void resume\(\)/);
  // 存档信息收进一颗默认折起来的按钮，想看的人自己点。
  assert.match(surface, /对话历史/);
  assert.match(surface, /aria-expanded=\{showHistory\}/);
  // 2026-08-21（第三版）：Header 重排——拖拽手柄 + 「AI 助理」+ 呼吸绿点 +
  // 右侧图标组（历史记录/开新对话/收起）。對話流里不再有散落的「對話歷史」
  // 文字链接和常驻「已连接」状态行；開新對話留在歷史裡可切回（留舊開新）。
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  assert.match(hook, /startNewSession/);
  assert.match(surface, /onStartNewSession/);
  assert.match(surface, /AI 助理<\/h2>/);
  assert.match(surface, /bg-emerald-500 animate-pulse/);
  assert.match(surface, /bg-slate-300/);
  assert.match(surface, /aria-label="历史记录"/);
  assert.match(surface, /aria-label="开新对话"/);
  assert.match(surface, /aria-label="收起"/);
  assert.match(surface, /top-full right-0/);

  /*
   * 下面查的是「界面上没有这些字」，所以要剥掉注释再查——
   * 注释里为了说明改版原因引用了旧文案，那不是渲染出来的东西。
   */
  const code = readCode(surface);
  // 会话已经删掉了，折叠层里不许出现一颗按下去必然失败的「继续」。
  assert.doesNotMatch(code, /继续这个对话/);
  // 那些教训用户的文案一并撤掉。
  assert.doesNotMatch(code, /上次的对话还在/);
  assert.doesNotMatch(code, /结束它，开新的/);
  assert.doesNotMatch(code, /开新的会删掉上面这段对话/);
  // 自动开新意味着永远有会话可送：输入区不再因为存档被禁用，
  // 也不再有「在等你选择」这个状态。
  assert.doesNotMatch(code, /disabled=\{resumable !== null\}/);
  assert.doesNotMatch(code, /awaitingChoice=\{resumable !== null\}/);
});

test("送出到第一个字之间必须有可见的思考中间态", () => {
  /*
   * 网关要先跑完一轮推理才吐 message.delta。这段真空期画面上不动，
   * 人会以为消息没送出去，于是再送一次——重复扣费的心理成因就在这里。
   */
  // 这轮开着、但最后一条不是助手文本 = 还没开始讲话，泡泡要在。
  assert.match(panel, /turnActive && items\[items\.length - 1\]\?\.kind !== "assistant"/);
  assert.match(panel, /正在思考…/);
  // 动的东西才算回馈：静态一行字看不出系统是活的还是卡住了。
  assert.match(panel, /animate-bounce/);
  assert.match(panel, /animationDelay/);
  // 屏读器要听得到，但三颗点本身是装饰，不该被逐颗念出来。
  assert.match(panel, /role="status" aria-label="助手正在思考"/);
});

test("composer textarea grows with content and collapses after send", () => {
  // rows=1 固定高度下写长愿望只看得见最后一行。
  assert.match(composer, /function autoGrow\(el: HTMLTextAreaElement\)/);
  assert.match(composer, /autoGrow\(event\.currentTarget\)/);
  assert.match(composer, /autoGrow\(el\)/);
  // 上限交给 CSS，不在 JS 里另写一个数字。
  assert.match(composer, /max-h-32/);
  // 送出后清空文字，高度要一起收回来。
  assert.match(composer, /textareaRef\.current\.style\.height = "auto"/);
});

test("D-26 first-image anchor is offered, and never offered when it cannot hold", () => {
  // 锚定卡真的被接上，不是造了个孤儿组件。
  assert.match(surface, /deriveBatchAnchor\(state\.items\)/);
  assert.match(surface, /buildAnchorMessage\(anchor\)/);
  assert.match(surface, /buildReanchorMessage\(anchor\)/);
  assert.match(panel, /<AgentAnchorCard/);
  // 第 100 张不漂移是这颗按钮的全部意义，写在卡上。
  assert.match(anchorCard, /第 100 张不会跟第 1 张跑偏/);
  // 同一张图问过就不再问。
  assert.match(surface, /anchorAskedFor/);
  // 花费确认优先：两张要人做决定的卡不同时摆。
  assert.match(panel, /anchor && pendingConfirms\.length === 0 && pendingQuestions\.length === 0/);
  // 截断过的参数摘要要说出来，不让人以为锚得住全部。
  assert.match(anchorCard, /anchor\.truncated/);
});

test("D-26 stop button promises only what the gateway can deliver", () => {
  // 网关现在有 abort 端点：/session/:id/abort 打到 opencode，正在跑的一轮直接终止。
  // 按钮文案「立即中止」是准确描述，不再要求「当前这张跑完就停」。
  assert.match(batchProgress, /立即中止当前这轮生成/);
  assert.match(batchProgress, /停下/);
  // 回合结束时没有东西可停，按钮就不该在。
  assert.match(surface, /onStopGeneration=\{state\.turnActive \? onStopGeneration : undefined\}/);
  // 停止按钮接到 abort 端点（hook 的 abort），不是往对话里送一句停止指令。
  assert.match(surface, /const onStopGeneration = useCallback/);
  assert.match(surface, /void abort\(\)/);
});

test("batch progress does not announce a denominator it does not have", () => {
  // 总数 Y 推不出来。role="progressbar" 的 aria-valuemax 缺省 100，
  // 配上 aria-valuenow 会让屏读器念出「X / 100」——虚报。
  assert.doesNotMatch(readCode(batchProgress), /role="progressbar"/);
  assert.doesNotMatch(readCode(batchProgress), /aria-valuenow/);
  assert.match(batchProgress, /role="status"/);
  // 已出张数与已花币都是从 transcript 真实条目数出来的，不是估的。
  assert.match(batchProgress, /已出 \{images\} 张/);
});

test("D-23 params are a bottom drawer on narrow screens, an accordion on wide", () => {
  // 断点判定走同一个 hook，不在组件里另写一个 matchMedia 字符串。
  assert.match(disclosure, /useIsNarrow/);
  assert.match(disclosure, /agent-param-drawer/);
  // 抽屉是模态：要有 dialog 语义与可达的关闭方式（Esc + 点遮罩 + 关闭按钮）。
  assert.match(disclosure, /role="dialog"/);
  assert.match(disclosure, /aria-modal="true"/);
  assert.match(disclosure, /event\.key === "Escape"/);
  assert.match(disclosure, /aria-label="关闭参数"/);
  // 关掉后焦点还给触发按钮，否则键盘用户被扔回文档开头。
  assert.match(disclosure, /triggerRef\.current\?\.focus\(\)/);
  // 锁滚动必须存原值再还原：直接写 "" 会解开页面别处的锁。
  assert.match(disclosure, /previousOverflow/);
  assert.doesNotMatch(readCode(disclosure), /document\.body\.style\.overflow = ""/);
  // 拉宽窗口时抽屉变手风琴，遮罩必须跟着消失：解锁写在 drawerOpen 的 effect 里。
  assert.match(disclosure, /\[drawerOpen, close\]/);
  // 抽屉与手风琴共用一个 open，转屏不会莫名收起。
  assert.match(disclosure, /const drawerOpen = open && narrow/);
  // 安全区：home indicator 不许盖住最后一行参数。
  assert.match(chatCss, /safe-area-inset-bottom/);
  // 位移入场对晕动症不友好，要给 reduced-motion 出口。
  assert.match(chatCss, /prefers-reduced-motion/);
});

test("no component nests a button inside another button", () => {
  for (const [name, source] of AGENT_COMPONENTS) {
    assert.ok(!hasNestedButtons(source), `${name} must not nest <button> inside another <button>`);
  }
});

/**
 * D-1 + D-24 状态B：AI 助理是卡片上的一个 toggle，和「改图」「放大」同级。
 *
 * 这条锁的是使用者反复强调的那句话：**不要去 /agent 独立页**，
 * 按下入口只该换掉卡片中间那块控件区。
 */
test("D-1 AI 助理 is a toggle beside 改图/放大, not a page takeover", () => {
  const code = readCode(promptInput);

  // 三颗按钮同一套语法：toggle 回 generate，而不是单向打开。
  assert.match(code, /onModeChange\(mode === "edit" \? "generate" : "edit"\)/);
  assert.match(code, /onModeChange\(mode === "upscale" \? "generate" : "upscale"\)/);
  assert.match(code, /onModeChange\(mode === "agent" \? "generate" : "agent"\)/);
  // 选中态也要跟邻居一致：未选中时是灰的，不许自己常亮蓝底冒充「已开启」。
  assert.match(code, /mode === "agent"\s*\?\s*"bg-\[rgba\(0,122,255,0\.12\)\] text-\[#007AFF\]/);
  assert.match(code, /aria-pressed=\{mode === "agent"\}/);

  // 聊天区长在模式控件区里（和 edit / upscale 两块同级），不是另一层壳。
  assert.match(code, /\{displayMode === "agent" && \(/);
  assert.match(code, /<AgentChatSurface/);
  assert.match(code, /variant="inline"/);

  // 单向入口的旧 prop 必须已经消失，否则等于两套入口并存。
  assert.doesNotMatch(code, /onOpenAgent/);
});

test("D-1 the agent face never grows a second send button or a second textarea", () => {
  // MODES_WITHOUT_TEXTAREA 宣告隨高度鎖抽到 use-height-lock.ts（Task 3），
  // 斷言語義不變：PromptInput 及其抽出 hooks 構成的同一組件表面。
  const code = readCode(promptInput) + "\n" + readCode(promptInputHeightLock);
  // 送出归聊天区自己的输入区：卡片底部那颗 CTA 在 agent 面不存在。
  // 2026-08-22：agent 面底行整排由三元換成返回條（工作站態同款），
  // CTA/pro-toggle 只存在於非 agent 分支。
  assert.match(code, /\{displayMode === "agent" \? \(/);
  assert.match(code, /返回生成/);
  // 键盘旁路也要堵掉，否则 Enter 还能从别处触发一次生成。
  assert.match(code, /if \(displayMode === "agent"\) return;/);
  // 两个输入框并排会有「我该往哪打字」的歧义。
  assert.match(code, /MODES_WITHOUT_TEXTAREA = new Set<PromptInputMode>\(\["upscale", "agent"\]\)/);
  // 聊天区内部靠 flex-1 + min-h-0 自己滚，外层必须给定高度。
  // 2026-08-22：高度改为「generate 面实测自然高」锁定（contentRef/contentHeight），
  // 所有模式共用同一外框——不再在组件中写死 clamp 或单一 CSS 变量高度。
  assert.match(code, /AGENT_SURFACE_HEIGHT = "var\(--agent-surface-height\)"/);
  assert.match(code, /contentRef/);
  assert.match(code, /contentHeight/);
  assert.match(code, /height: contentHeight/);
});

test("ImagePlayground no longer hides itself to make room for the agent", () => {
  const code = readCode(playground);
  // 整页翻面的那套状态机全部退场。
  assert.doesNotMatch(code, /agentOpen/);
  assert.doesNotMatch(code, /agentAnim/);
  assert.doesNotMatch(code, /runAgentTransition/);
  // 工作台、案例轮播都不许再被 hidden 掉。
  assert.doesNotMatch(code, /agentOpen && "hidden"/);
  // 占满视口的聊天壳（含它专用的 offset 变量）不该再出现。
  assert.doesNotMatch(code, /agent-shell-offset/);
  // D-12 回流改走 PromptInput，但必须仍然接着。
  assert.match(code, /onParamsReflected=\{handleParamsReflected\}/);
});

test("nothing routes users to a standalone /agent page", () => {
  // 导航栏不再有「助理」链接：它会把人带离卡片。
  assert.doesNotMatch(readCode(navbar), /href="\/agent"/);
  // 旧书签落地后回首页并直接开在 agent 面，不是渲染一个独立页。
  assert.match(agentRoute, /router\.replace\(`\/\$\{query\}`\)/);
  assert.match(agentRoute, /\?agent=1/);
  assert.doesNotMatch(readCode(agentRoute), /variant="page"/);
  // 首页要认这个 query 才算真的接住了交接。
  assert.match(readCode(playground), /params\.get\("agent"\) !== "1"/);
  assert.match(readCode(playground), /setMode\("agent"\)/);
  // 读完抹掉 query：留着它刷新会重复注入同一句话。
  assert.match(readCode(playground), /window\.history\.replaceState/);
});

// "AI 助理" 标题和余额 chip 已移除——这张卡片的 chrome 只剩口吻切换，
// 所以不再需要「标题等级」的回归锁。

/**
 * toggle 变便宜之后带出来的两个后果，各锁一条。
 */
test("toggling the agent shut and open again resumes silently, no D-17 prompt", () => {
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  // 标记必须是模块级的：组件卸载时所有 ref 一起死，ref 存不住这件事。
  assert.match(hook, /^let sessionTouchedInThisVisit = false;/m);
  // 开过会话、续过会话都算「本次访问碰过」。
  assert.match(hook, /sessionTouchedInThisVisit = true;/);
  // 同一次访问 + 有存档 → 直接 resume，不走二选一。
  assert.match(hook, /if \(sessionTouchedInThisVisit && loadPersisted\(\)\) \{\s*void resume\(\);/);
  // 二选一卡不能闪一帧：mount 那次读档就要先判断。
  assert.match(hook, /if \(!sessionTouchedInThisVisit\) \{\s*setResumable\(/);
  // 刷新后归零 → D-17 的「继续上次 / 开新的」照旧。这条靠模块级变量天然成立，
  // 但不许有人把它挪进 sessionStorage 之类跨刷新的地方。
  assert.doesNotMatch(hook, /sessionStorage[\s\S]{0,40}sessionTouchedInThisVisit/);
  assert.doesNotMatch(hook, /localStorage[\s\S]{0,40}sessionTouchedInThisVisit/);
});

test("a handoff sentence from /history expires when the agent face is left", () => {
  const code = readCode(playground);
  assert.match(code, /if \(mode !== "agent" && agentSeed\) setAgentSeed\(""\)/);
  // 聊天区挂载时读一次：交接语优先，其次是卡片里已经打好的半句话。
  assert.match(readCode(promptInput), /initialPrompt=\{agentSeed \|\| input\.trim\(\)\}/);
});

/**
 * 一开就 401 的回归锁。
 *
 * 病根：agent 代理的 requireVerifiedUser → authenticateImageUser 在
 * image-billing.ts 里是 `if (!auth || !userId) return 401`，userId 读的是
 * `x-user-id`（或 `New-Api-User`）。传輸层曾经刻意只送 Authorization，
 * 于是已登录用户开 AI 助理必 401。两个头必须成对送。
 */
test("the agent transport sends token and user id together, never half", () => {
  const client = read("src/lib/agent-chat-client.ts");
  const code = readCode(client);

  // 单一出口：身份头只有一处产生，不许各个 fetch 自己拼。
  assert.match(code, /function authHeaders\(reason: string\): Record<string, string>/);
  assert.match(code, /const token = getStoredToken\(\);\s*const userId = getStoredUser\(\)\?\.id;/);
  assert.match(code, /if \(!token \|\| !userId\) \{\s*throw new AgentChatError\("not_authenticated"/);
  assert.match(code, /Authorization: `Bearer \$\{token\}`, "x-user-id": String\(userId\)/);

  // 两个 fetch 都走 helper：JSON 请求 + 附件上传。
  const helperUses = code.match(/authHeaders\(/g) ?? [];
  assert.ok(helperUses.length >= 3, `authHeaders 应在定义外至少被用 2 次，实际 ${helperUses.length - 1}`);
  assert.match(code, /const headers = authHeaders\("尚未登录，无法使用 Agent 助手。"\);/);
  assert.match(code, /const headers = authHeaders\("尚未登录，无法上传附件。"\);/);

  // 不许再出现绕过 helper 的裸头。helper 自身那行有 x-user-id 紧跟，排除掉。
  assert.doesNotMatch(code, /Authorization: `Bearer \$\{token\}` \}/);
  assert.doesNotMatch(code, /headers: \{ Authorization/);

  // 服务端那侧的前提，一起钉住：少了 id 就是 401，不是 500 也不是放行。
  const billing = readCode(read("src/lib/image-billing.ts"));
  assert.match(billing, /headers\.get\("x-user-id"\) \?\? headers\.get\("New-Api-User"\)/);
  assert.match(billing, /if \(!auth \|\| !userId\) \{\s*return \{ ok: false, status: 401/);
});

test("a 401 says which kind of 401 it is", () => {
  const guard = readCode(read("src/lib/agent-session-guard.ts"));

  // 没送凭证 → 自己的 code，不跟「凭证被拒」共用一句话。
  assert.match(guard, /code: "agent_not_signed_in"/);
  assert.match(guard, /if \(!authHeader \|\| !idHeader\)/);
  assert.match(guard, /req\.headers\.get\("x-user-id"\) \?\? req\.headers\.get\("New-Api-User"\)/);
  // 凭证被上游拒 → 另一句，别再叫「请先登录」误导已登录的人。
  assert.match(guard, /登录状态已失效，请重新登录后再试。/);

  // code 的归属在 guard，不在七条路由里各写一遍。
  assert.match(guard, /export function agentCallerFailureCode/);
  assert.match(guard, /if \(caller\.code\) return caller\.code;/);

  const routes = [
    "src/app/api/agent/quota/route.ts",
    "src/app/api/agent/sessions/route.ts",
    "src/app/api/agent/sessions/[id]/route.ts",
    "src/app/api/agent/sessions/[id]/messages/route.ts",
    "src/app/api/agent/sessions/[id]/confirm/route.ts",
    "src/app/api/agent/sessions/[id]/attachments/route.ts",
    "src/app/api/agent/sessions/[id]/sse-ticket/route.ts",
  ];
  for (const rel of routes) {
    const code = readCode(read(rel));
    assert.match(code, /agentCallerFailureCode\(caller\)/, `${rel} 应改用 guard 的 code 判断`);
    assert.doesNotMatch(code, /caller\.status >= 500 \?/, `${rel} 还留着复制来的 code 三元式`);
  }

  // 客户端把它当「没登录」处理：关连线提示登录，而不是无穷重连。
  const client = readCode(read("src/lib/agent-chat-client.ts"));
  assert.match(client, /if \(code === "agent_not_signed_in"\) return "not_authenticated";/);
  assert.match(client, /mapErrorCode\(data, res\.status\)/);
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  assert.match(hook, /err\.code === "not_authenticated"[\s\S]{0,80}closedRef\.current = true;/);
});

/**
 * D-27：AI 助理输入框接受「Ctrl+V 粘贴文件」与「拖拽放入」，与附件按钮共用同一条上传管道。
 * 核心契约：纯文本粘贴必须放行（文件獥查为空就不该拦），有文件才截下走附件。
 */
test("composer accepts pasted files (Ctrl+V) and dragged-in files, sharing the upload pipeline", () => {
  const code = readCode(composer);

  // 公共入队函数存在，且三个入口（文件选择、粘贴、拖放）都走它。
  assert.match(code, /const enqueueFiles = useCallback/);
  assert.match(code, /enqueueFiles\(Array\.from\(event\.target\.files \?\? \[\]\)\)/);
  assert.match(code, /onPaste=\{handlePaste\}/);
  assert.match(code, /handlePaste[\s\S]{0,400}enqueueFiles\(Array\.from\(files\)\)/);

  // 文本粘贴放行：没有文件就不 intercept，浏览器默认插入文本。
  assert.match(code, /const files = event\.clipboardData\?\.files;/);
  assert.match(code, /if \(!files \|\| files\.length === 0\) return;/);

  // 拖拽四件套挂在根元素上，drop 收文件、dragover 必须 preventDefault 才能 drop。
  assert.match(code, /onDragEnter=\{handleDragEnter\}/);
  assert.match(code, /onDragOver=\{handleDragOver\}/);
  assert.match(code, /onDragLeave=\{handleDragLeave\}/);
  assert.match(code, /onDrop=\{handleDrop\}/);
  assert.match(code, /event\.dataTransfer\.dropEffect = "copy"/);

  // 拖入悬停要有可见反馈，且提示条不吃鼠标事件。
  // 2026-08-22 lg-* 迁移：composer 根元素挂 lg-float 玻璃后，拖拽高亮必须用
  // !important 前缀才能盖过 .lg-float 的 background/box-shadow（同特异性下
  // 手写 utilities 层的 lg-* 排在生成的 utility 之后）。
  assert.match(code, /dragActive && "!ring-2 !ring-ios-blue\/45 !bg-ios-blue\/\[0\.04\]"/);
  assert.match(code, /松开以添加附件/);
  assert.match(code, /pointer-events-none/);

  // drop 复位高亮状态、有文件才 enqueue；无文件时不 preventDefault（文本拖入按默认插入）。
  assert.match(code, /handleDrop[\s\S]{0,120}setDragActive\(false\)/);
  assert.match(code, /const files = event\.dataTransfer\.files;/);
  assert.match(code, /event\.preventDefault\(\);[\s\S]{0,40}enqueueFiles\(Array\.from\(files\)\)/);

  // disabled 输入区三个入口一律不收。
  assert.match(code, /if \(disabled\) return;/);
});

/**
 * D-27b：生图输入框（PromptInput）也支持参考图的拖拽 / Ctrl+V 粘贴，
 * 且模型不支持参考图时隐藏上传入口（否则上传完被清空，等于「上传后立马消失」）。
 */
test("PromptInput accepts reference images by drag & paste, and hides upload when model can't take them", () => {
  const code = readCode(promptInput);

  // 拖拽四件套挂在描述框容器上，悬停提示「松开以添加参考图」。
  assert.match(code, /onDragEnter=\{handleDragEnter\}/);
  assert.match(code, /onDragOver=\{handleDragOver\}/);
  assert.match(code, /onDragLeave=\{handleDragLeave\}/);
  assert.match(code, /onDrop=\{handleDrop\}/);
  assert.match(code, /松开以添加参考图/);
  // 容器级拖拽要 preventDefault，否则浏览器直接打开图片。
  assert.match(code, /event\.dataTransfer\.dropEffect = "copy"/);
  assert.match(code, /event\.preventDefault\(\);/);

  // Ctrl+V：剪贴板有文件才拦，交给同一管道；纯文本粘贴必须放行。
  assert.match(code, /onPaste=\{handlePaste\}/);
  assert.match(code, /event\.clipboardData\?\.files/);
  assert.match(code, /if \(files\.length === 0\) return;/);

  // 与 ReferenceImageUpload 共用一条处理管道：acceptFiles 经 ref 传入。
  assert.match(code, /refUploadRef/);
  assert.match(code, /ref=\{refUploadRef\}/);
  assert.match(code, /acceptFiles\(files\)/);

  // 模型不支持参考图时整个入口隐藏，杜绝「上传后立马消失」。
  assert.match(code, /const referenceImagesSupported = Boolean\(selectedModel\?\.referenceImages\);/);
  assert.match(code, /displayMode === "generate" && referenceImagesSupported &&/);
  // 能力开关与容器拖拽/粘贴 handler 串起来：不支持时不挂。
  assert.match(code, /if \(!referenceImagesSupported \|\| displayMode !== "generate"\) return;/);
});
