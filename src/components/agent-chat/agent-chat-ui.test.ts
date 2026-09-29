import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig 的 jsx=preserve 让 tsx 对 .tsx 退回 classic runtime（React.createElement），
// 而组件源码不 import React（Next 构建走 automatic）。测试里做 SSR 渲染前补一个
// 全局 React 桩，否则组件一渲染就 ReferenceError: React is not defined。
(globalThis as unknown as Record<string, unknown>).React ??= React;

// 罪状 1/4 行为断言用的纯函数（解析与 reducer 都不碰 DOM，node --test 直测）。
import {
  VideoBubble,
  groupAttachmentRefs,
  groupsNeedTicket,
  parseUserAttachmentBlock,
} from "./AgentAttachmentCards";
import {
  AgentSubagentBar,
  MARQUEE_HARD_CAP,
  MARQUEE_KEEP,
  marqueeText,
} from "./AgentSubagentBar";
import { AgentToolCard, toolArgPreview, toolDisplayName } from "./AgentToolCard";
import { AgentAudioCard } from "./AgentAudioCard";
import { AgentBatchProgress } from "./AgentBatchProgress";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { reportPreview } from "./AgentSubagentReportCard";
import { submitConfirmDecision } from "./AgentConfirmCard";
import { submitQuestionAnswer } from "./AgentQuestionCard";
import { computeCanSend, hasPendingAttachments, nextSendBusy, AgentComposer } from "./AgentComposer";
import Module, { createRequire } from "node:module";

// AgentChatPanel.tsx 唯一带副作用 `import "./agent-chat.css"` 的组件文件——
// node --test 走 CJS require 装载 .tsx，没有 css loader，静态 import 会在模块
// 图加载阶段就炸掉（比测试文件自己的顶层代码更早执行）。这里用同步 require（走
// createRequire，避免顶层 await——tsx 编译输出是 CJS，不支持顶层 await）之前
// 把 .css 扩展名注册成空模块，规避掉，不影响其余文件的正常断言方式（读源码字符串）。
(Module as unknown as { _extensions: Record<string, (m: unknown, filename: string) => void> })._extensions[
  ".css"
] = (m) => {
  (m as { exports: unknown }).exports = {};
};
const requireHere = createRequire(import.meta.url);
const { resolveConfirmGroup, exampleChipState } = requireHere("./AgentChatPanel.tsx") as {
  resolveConfirmGroup: (
    requestIds: string[],
    approved: boolean,
    onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>,
  ) => Promise<boolean>;
  exampleChipState: (
    example: string,
    pendingExample: string | null,
    sendPending: boolean,
  ) => "pending" | "disabled" | "idle";
};
import { agentChatReducer, appendUserTurn, lastNonEmptyLine } from "../../lib/agent-chat-reducer";
import {
  EMPTY_AGENT_CHAT_STATE,
  type AgentAssistantTextItem,
  type AgentAttachmentRef,
  type AgentAudioItem,
  type AgentSseEvent,
  type AgentSubagentItem,
  type AgentSubagentReportItem,
} from "../../lib/agent-chat-types";

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
const videoCard = read("src/components/agent-chat/AgentVideoCard.tsx");
const audioCard = read("src/components/agent-chat/AgentAudioCard.tsx");
const confirmCard = read("src/components/agent-chat/AgentConfirmCard.tsx");
const questionCard = read("src/components/agent-chat/AgentQuestionCard.tsx");
const noticeRow = read("src/components/agent-chat/AgentNoticeRow.tsx");
const subagentReportCard = read("src/components/agent-chat/AgentSubagentReportCard.tsx");
const surface = read("src/components/agent-chat/AgentChatSurface.tsx");
const anchorCard = read("src/components/agent-chat/AgentAnchorCard.tsx");
const batchProgress = read("src/components/agent-chat/AgentBatchProgress.tsx");
const disclosure = read("src/components/agent-chat/AgentParamDisclosure.tsx");
const chatCss = read("src/components/agent-chat/agent-chat.css");
const promptInput = read("src/components/PromptInput.tsx");
// Task 3：高度鎖 / 無描述框模式集合抽到 hooks；Task 9：動作列抽到 ActionRow —— 斷言按「舊檔＋新檔」拼接讀取。
const promptInputHeightLock = read("src/components/prompt-input/use-height-lock.ts");
const actionRow = read("src/components/prompt-input/ActionRow.tsx");
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
  ["AgentVideoCard", videoCard],
  ["AgentAudioCard", audioCard],
  ["AgentConfirmCard", confirmCard],
  ["AgentQuestionCard", questionCard],
  ["AgentNoticeRow", noticeRow],
  ["AgentAnchorCard", anchorCard],
  ["AgentBatchProgress", batchProgress],
  ["AgentSubagentReportCard", subagentReportCard],
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

test("composer is disabled only when the panel says so, and trims before sending", () => {
  // 面板把「disabled 属性或会话已关闭」折叠成一个布尔传下去。
  // 2026-09-20（Route C 重设计裁定）：决策卡（question/confirm）在場**不再锁
  // 输入框**——旧契约（R9-3 死线 4）用 disabled + 「等待卡片选择…」表达
  // 「在等你选择」，新契约改由 composer 上缘 2px 蓝提示条（见 decisionPending
  // 正向断言）承担「有卡待选」的提示，发送照常走 onSend。composerDisabled
  // 因此收窄为 disabled || closed，这条锁死它不许再悄悄吃回 pending 条件。
  assert.match(panel, /composerDisabled = disabled \|\| closed/);
  assert.doesNotMatch(
    readCode(panel),
    /composerDisabled = disabled \|\| closed \|\| pending/,
    "决策卡不得再回魂锁 composer（2px 提示条才是新契约）",
  );
  assert.match(panel, /disabled=\{composerDisabled\}/);
  assert.match(panel, /先选上方方案，或直接补充要求/);
  // textarea 与发送按钮都必须跟随禁用。
  assert.match(composer, /disabled=\{disabled\}/);
  assert.match(composer, /disabled=\{disabled \|\| !canSend\}/);
  // 罪状 2a：只附文件不打字也发得出去——canSend = 有文本 || 有已传成功的附件，
  // 且没有仍在 uploading/extracting 的附件（computeCanSend 抽成纯函数，见下方回归测试）。
  assert.match(composer, /const canSend = computeCanSend\(trimmed, readyRefs\.length, attachments\);/);
  // 空消息必须被拒绝：发送前 trim。
  assert.match(composer, /\.trim\(\)/);
  // 决策卡在場的新提示：composer 上缘 2px 蓝提示条（不锁输入的替代回馈）。
  assert.match(panel, /decisionPending \? \(/);
  assert.match(panel, /h-\[2px\] rounded-full bg-ios-blue\/70/);
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

test("video action buttons are disabled when no callback is wired", () => {
  // 与图片卡同惯例：回调缺席就 disabled，绝不伪造 handler。
  assert.match(videoCard, /disabled=\{!onSaveToLibrary\}/);
  assert.match(videoCard, /disabled=\{!onDownload\}/);
  assert.doesNotMatch(videoCard, /fetch\(/);
  assert.match(videoCard, /onSaveToLibrary\?: \(item: AgentVideoItem\) => void/);
  // 影片查看器不得抄图片的捏合/滚轮缩放手势（对播放中的影片无语义）。
  assert.doesNotMatch(videoCard, /pinch|wheel|clampPan/);
  // 查看器仍走图片 Lightbox 的关闭三件套：Esc + history 弹层 + 背景点击。
  assert.match(videoCard, /pushState\(\{ agentVideoLightbox: true \}, ""\)/);
  assert.match(videoCard, /event\.key === "Escape"/);
  assert.match(videoCard, /addEventListener\("popstate"/);
  // transcript 把 video 条目渲染成 AgentVideoCard，动作走 videoActions。
  assert.match(transcript, /case "video":/);
  assert.match(transcript, /<AgentVideoCard item=\{item\} \{\.\.\.videoActions\} \/>/);
});

test("audio card plays via native <audio> and keeps the disabled action contract", () => {
  // 与图片/影片卡同惯例：回调缺席就 disabled，绝不伪造 handler。
  assert.match(audioCard, /disabled=\{!onSaveToLibrary\}/);
  assert.match(audioCard, /disabled=\{!onDownload\}/);
  assert.doesNotMatch(audioCard, /fetch\(/);
  assert.match(audioCard, /onSaveToLibrary\?: \(item: AgentAudioItem\) => void/);
  // 播放面：原生 <audio controls preload="metadata">，src 照旧绑 item.url。
  assert.match(audioCard, /<audio/);
  assert.match(audioCard, /controls/);
  assert.match(audioCard, /preload="metadata"/);
  assert.match(audioCard, /src=\{item\.url\}/);
  // 音频卡不得残留影片专属资产（全屏灯箱 / history 弹层 / 捏合缩放）。
  assert.doesNotMatch(audioCard, /createPortal|pushState|pinch|wheel|clampPan/);
  // transcript 把 audio 条目渲染成 AgentAudioCard，动作走 audioActions。
  assert.match(transcript, /case "audio":/);
  assert.match(transcript, /<AgentAudioCard item=\{item\} \{\.\.\.audioActions\} \/>/);
  // 实渲染断言的输入：src 与文案逐字来自条目本身（不假造 URL）。
  const rendered: AgentAudioItem = {
    kind: "audio",
    id: "audio-1",
    seq: 1,
    url: "https://example.invalid/audio/1.m4a",
    costCoins: 3,
    mediaKind: "music",
  };
  const markup = renderToStaticMarkup(createElement(AgentAudioCard, { item: rendered }));
  assert.match(markup, /<audio/, "SSR 渲染必须真的产出 <audio> 元素");
  assert.match(markup, /src="https:\/\/example\.invalid\/audio\/1\.m4a"/, "播放源绑定条目 url");
  assert.match(markup, /音乐/, "mediaKind=music 徽章显示成曲语义");
});

test("思維鏈串流中展開、結算後收合，沒有 reasoning 就不渲染 details", () => {
  /*
   * 2026-09-27 暴君裁定 supersede 下方 09-20 裁定：思考中展開，結算後收合成
   *「已思考 · N 秒」一行（展開的內部推理佔半屏）。
   *
   * 2026-09-20 暴君同日再裁定：把「預設收合」（當日上午隨 Grok 極簡骨架預覽
   * 批准）再推翻回「預設展開」——思考過程開門見山，不要人再點一次。靜態 markup
   * 就是「首次渲染」的字面證據：React 把 open 布林屬性序列化成 open=""，
   * 預設展開＝序列化結果裡 details 帶 open=""。
   */
  const assistant = (overrides: Partial<AgentAssistantTextItem>) =>
    createElement(AgentMessageBubble, {
      item: {
        kind: "assistant",
        id: "asst-1",
        seq: 1,
        text: "",
        reasoning: "先算 336 的立方根，n(n+1)(n+2)=336…",
        streaming: true,
        ...overrides,
      } as AgentAssistantTextItem,
    });

  // ① 串流中（還沒有正文）＝ 思維鏈已展開＋折疊殼文案「正在思考…」。
  const streaming = renderToStaticMarkup(assistant({}));
  assert.match(streaming, /<details[^>]*\sopen=""/, "串流中的思維鏈默認展開");
  assert.match(streaming, /正在思考…/, "串流中的折疊殼文案＝正在思考…");

  // ② 已完成（streaming:false、正文已到）＝ 收合，只剩「已思考」摘要行。
  const settled = renderToStaticMarkup(assistant({ streaming: false, text: "答案是 6, 7, 8" }));
  assert.match(settled, /<details/, "已完成條目仍保留可點開的思維鏈");
  assert.doesNotMatch(settled, /<details[^>]*\sopen=""/, "已完成條目默認收合");

  // ③ 沒有 reasoning 的助理條目：連 details 都不渲染，不留空殼。
  const noReasoning = renderToStaticMarkup(assistant({ reasoning: undefined, text: "只有正文" }));
  assert.doesNotMatch(noReasoning, /<details/, "沒有思維鏈就沒有折疊殼");
  assert.match(noReasoning, /只有正文/, "正文不受影響");

  /*
   * ④ 手動展開不被重渲染打回：open 受控於 state，而 state 只有 toggle 一個寫入口；
   * 舊的「streaming && !item.text 才給 open」條件式屬性必須絕跡——它會在串流
   * 結束那一幀重新決定開關，正是「收起又被攤回去」的成因。
   */
  const code = readCode(bubble);
  assert.match(code, /open=\{reasoningOpen\}/, "open 一律由 state 給值");
  assert.match(code, /onToggle=\{onReasoningToggle\}/, "toggle 是使用者手動開關的寫入口");
  const stateWrites = code.match(/setReasoningOpen\(/g) ?? [];
  assert.equal(stateWrites.length, 2, "寫入口只有 toggle 與結算收合兩處");
  assert.doesNotMatch(code, /item\.streaming && !item\.text/, "自動展開條件已拆掉");
  assert.match(code, /reasoningOpen, setReasoningOpen\] = useState\(reasoningStreaming\)/, "seed＝是否串流中");
  assert.match(code, /!reasoningStreaming && !reasoningTouched\.current/, "結算收合不得覆蓋使用者手動開關");
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
  // 第二輪就緒優化刀A：空態不等 SSE open——idle/connecting/open 都顯示，
  // 只排除 reconnecting/closed（沒壞就先給歡迎語）。
  assert.match(panel, /items\.length === 0 && connection !== "reconnecting" && connection !== "closed"/);
  // 2026-09-20 空態重構：邀問語「想做点什么？」，舊「和智能体聊聊」連同 hint
  // （说一句话，它自动选好模型、风格和比例）一起下線。
  assert.match(panel, /想做点什么？/);
  assert.doesNotMatch(readCode(panel), /和智能体聊聊/, "舊空態歡迎語不得回魂");
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
   * 所以外壳必须替使用者把决定做掉。进页默认新聊天（暴君裁定 2026-09-01）：
   * 不静默续旧——旧对话留在网关历史下拉，随时切回。同一次访问 toggle 往返
   * 仍静默续上（sessionTouchedInThisVisit 时 resumable 根本不会被设置）。
   */
  assert.match(surface, /resumable,/);
  assert.match(surface, /discardAndStartNew,/);
  // mount 后发现存档 → 直接开新会话；深链（initialSessionId）让路给
  // switchSession，避免建号赛跑。discardAndStartNew 保留在 hook 里但已无 UI 调用方。
  assert.match(surface, /didAutoFreshStartRef/);
  assert.doesNotMatch(surface, /setHistorySnapshot\(\{ itemCount: resumable\.itemCount, savedAt: resumable\.savedAt \}\)/);
  assert.doesNotMatch(surface, /void resume\(\)/);
  assert.match(surface, /void startNewSession\(\)/);
  assert.match(surface, /if \(initialSessionId\) return;/);
  // 存档信息收进一颗默认折起来的按钮，想看的人自己点。
  assert.match(surface, /对话历史/);
  assert.match(surface, /aria-expanded=\{showHistory\}/);
  // 2026-08-21（第三版）：Header 重排——拖拽手柄 + 「AI 助理」+ 呼吸绿点 +
  // 右侧图标组（历史记录/开新对话/收起）。對話流里不再有散落的「對話歷史」
  // 文字链接和常驻「已连接」状态行；開新對話留在歷史裡可切回（留舊開新）。
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  assert.match(hook, /startNewSession/);
  assert.match(surface, /onStartNewSession/);
  /*
   * 2026-09-20 Route D 頭部重構：常駐呼吸绿点（bg-emerald-500 animate-pulse）與
   * bg-slate-300 已移除——新頭部＝lg-tint-blue 圆标 + SquarePen（开新对话）/
   * SlidersHorizontal（直接生成）幽靈鈕。
   * 2026-09-22 首屏翻面後第三顆鈕語義改寫：它不是「收起助理、回到原本的地方」
   * （已經沒有原本的地方了），而是「走另一條路：自己选模型和参数直接出图」。
   *
   * 2026-09-27 暴君糾正定版（兩輪）：先是「AI 助理 / 随时待命」那兩行被指為廢話，
   * 接著標題與星芒圆标整組被要求拆掉——頂欄現在是純圖示列、零文字：那個位置放
   * 资产 / 历史 兩顆圖示（原本埋在 ⋯ 選單裡），右側 新会话 / 直接生成 / 设置。
   * ⋯（MoreHorizontal）連同收納選單整組退役，原位換成齒輪。連線異常態文字不再由
   * 頂欄承擔（對話區本就有重試入口與「原因：…」行），所以頂欄不再出現狀態文案。
   */
  const surfaceCode = readCode(surface);
  assert.doesNotMatch(surfaceCode, /bg-emerald-500 animate-pulse/, "常駐呼吸绿点已移除");
  assert.doesNotMatch(surfaceCode, /bg-slate-300/, "bg-slate-300 已移除");
  // 標題與 logo 圆标整組拆掉：頂欄零文字（只看得到圖示與 aria-label）。
  assert.doesNotMatch(surfaceCode, /AI 助理<\/h2>/, "頂欄標題已拆");
  assert.doesNotMatch(surfaceCode, /lg-tint-blue/, "頂欄星芒圆标已拆");
  assert.doesNotMatch(surfaceCode, /随时待命/, "常態描述不得回魂");
  assert.doesNotMatch(surfaceCode, /正在重新连接…|会话已结束|连接中…/, "狀態文案不再掛在頂欄");
  assert.doesNotMatch(surfaceCode, /更多选项/, "⋯ 選單已退役");
  // 五顆直接入口：資產／歷史在左（原標題位），新會話／直接生成／設置在右。
  assert.match(surface, /aria-label="我的资产"/);
  assert.match(surface, /aria-label="对话历史"/);
  assert.match(surface, /title="对话历史"/);
  assert.match(surface, /aria-label="开新对话"/);
  assert.match(surface, /aria-label="直接生成"/);
  assert.match(surface, /aria-label="设置"/);
  assert.match(surface, /onClick=\{openSettings\}/);
  // 右簇要自己頂到最右——中間已沒有 flex-1 的標題塊可以撐。
  assert.match(surface, /ml-auto flex items-center gap-0\.5/);
  // 2026-09-05 暴君裁定：多功能欄彈窗水平置中（fixed left-1/2 + -translate-x-1/2），
  // 不再掛在按鈕右下角（舊 absolute top-full right-0 作廢）。
  assert.match(surface, /fixed left-1\/2 .*-translate-x-1\/2/);
  assert.doesNotMatch(surface, /top-full right-0/);

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
  assert.match(composer, /max-h-\[15rem\]/);
  // 送出后清空文字，高度要一起收回来。
  assert.match(composer, /textareaRef\.current\.style\.height = "auto"/);
});

/**
 * 2026-09-18 送出在途（暴君原話：「发送按钮要有一个loading态，用于点击模板/发送文字/
 * 点击这些按钮时的等待态」）。
 *
 * 「本輪尚未开始」的真相源在 AgentChatPanel（它同时知道 turnActive 与 onSend 的
 * promise），面板把它当成一个可选 prop 餵进输入区。这里用真渲染的静态 markup 钉三件事：
 * ①在途＝空輸入也转圈（不是 disabled 灰钮，否则看不出「正在送」）；
 * ②非在途不常转圈；③在途压过「輸入框空 → 停止钮」的替换语义，两者不得互相盖掉。
 */
test("09-18 送出在途：空輸入也必須是轉圈送出鈕（aria-busy + spinner，不是灰鈕）", () => {
  const markup = renderToStaticMarkup(
    createElement(AgentComposer, { disabled: false, onSend: () => {}, externalSendPending: true }),
  );
  // 屏读器也要知道这条正在送。
  assert.match(markup, /aria-busy="true"/, "在途时 aria-busy 必须为 true");
  // 转圈是序列化出来的真图标（lucide loader + animate-spin），不是靠 class 猜。
  assert.match(markup, /class="lucide lucide-loader-circle[^"]*animate-spin"/, "在途必须渲染转圈图标");
  // 两颗图标互斥：同屏出现等于两套语义。
  assert.doesNotMatch(markup, /lucide-arrow-up/, "在途不得同时渲染送图标");
  // 連點在属性层就挡死（邏輯层还有 sendingRef / externalSendPending 两道）。
  assert.match(markup, /disabled="" aria-label="发送"/, "在途时送出钮必须 disabled（防连点）");
  // 样式沿用 2026-09-20 改版词汇：主色深底 #2d3142 + cursor-wait——
  // 在途是「正在送」不是「不可用」。
  assert.match(markup, /bg-\[#2d3142\]/, "在途仍是既有主色深底钮，不退回灰钮");
  assert.match(markup, /cursor-wait/, "在途带既有 cursor-wait");
  // 縮到只查送出鈕：2026-09-20 暴君裁定附件鈕與送出鈕同風格，`disabled:bg-[#bcc2ca]`
  // 合法出現在附件鈕 class 裡；本斷言原意是「送出鈕在途時不上灰底」，故只釘送出鈕那一段。
  const sendBtn = markup.match(/<button[^>]*aria-label="发送"[^>]*class="([^"]*)"/)?.[1] ?? "";
  assert.ok(sendBtn.length > 0, "必须能定位到送出钮的 class");
  assert.doesNotMatch(
    sendBtn,
    /disabled:bg-\[#bcc2ca\]/,
    "送出钮在途期间不上浅灰 disabled 样式（白轉圈压在灰底上等于没有回馈）",
  );
});

test("09-18 非在途：送出鈕回到送圖示，不得常轉圈", () => {
  const markup = renderToStaticMarkup(
    createElement(AgentComposer, { disabled: false, onSend: () => {} }),
  );
  assert.doesNotMatch(markup, /aria-busy="true"/, "常態不得宣稱在途");
  assert.match(markup, /class="lucide lucide-arrow-up[^"]*"/, "常態渲染送图标");
  assert.doesNotMatch(markup, /lucide-loader-circle/, "常態不得有转圈图标");
  // 常態且輸入框空：disabled 样式逐字保留（#bcc2ca 浅灰，2026-09-20 改版值；
  // 这时候「不可用」才是对的语义）。
  assert.match(
    markup,
    /disabled:bg-\[#bcc2ca\]/,
    "非在途的 disabled 样式原样保留",
  );
});

test("09-18 在途壓過停止鈕：有 onStop、輸入框空、在途 → 仍是轉圈送出鈕（回歸鎖）", () => {
  const inFlight = renderToStaticMarkup(
    createElement(AgentComposer, {
      disabled: false,
      onSend: () => {},
      onStop: () => {},
      externalSendPending: true,
    }),
  );
  assert.match(inFlight, /aria-label="发送"/, "真空期送出钮位置必须是送出钮");
  assert.match(inFlight, /aria-busy="true"/, "在途时 aria-busy 为真");
  assert.match(inFlight, /lucide-loader-circle/, "真空期是转圈，不是停止钮");
  assert.doesNotMatch(inFlight, /aria-label="中止助理生成"/, "本輪还没开始，不许被停止钮盖掉");
  assert.doesNotMatch(inFlight, /lucide-square/, "停止图标也不得出现");

  // 对照：不在途、有 onStop、輸入框空 → 停止钮语义逐位元保留（没被本次改动削弱）。
  const stopped = renderToStaticMarkup(
    createElement(AgentComposer, { disabled: false, onSend: () => {}, onStop: () => {} }),
  );
  assert.match(stopped, /aria-label="中止助理生成"/, "本輪已开始、輸入框空 → 停止钮");
  assert.match(stopped, /lucide-square/, "停止图标仍在");
  assert.doesNotMatch(stopped, /lucide-loader-circle/, "停了就该是停止钮，不是转圈");
  assert.doesNotMatch(stopped, /aria-busy="true"/, "停止钮不是送出钮的在途態");
});

test("nextSendBusy：兩邊都放下才真的放下，否則維持在途", () => {
  assert.equal(nextSendBusy(false, false, false), null, "本來就不在途、沒有新信号 → 不动");
  assert.equal(nextSendBusy(false, true, false), true, "输入区自己的投递在飞 → 在途");
  assert.equal(nextSendBusy(false, false, true), true, "面板餵進來的在途 → 在途");
  assert.equal(nextSendBusy(true, true, false), null, "已在途、内部仍在飞 → 维持");
  assert.equal(
    nextSendBusy(true, false, true),
    null,
    "内部结算了但面板还在途 → 维持（不许提前把锁放掉）",
  );
  assert.equal(nextSendBusy(true, false, false), false, "两边都放下 → 真的放下");
});

test("exampleChipState：被點的那一顆優先進行中態，其餘在途期間禁用", () => {
  assert.equal(exampleChipState("画一只橘猫", null, false), "idle", "不在途＝可以按");
  assert.equal(exampleChipState("画一只橘猫", "画一只橘猫", true), "pending", "被点的那一颗自己转圈");
  assert.equal(exampleChipState("画一只狼", "画一只橘猫", true), "disabled", "在途期间其余一律禁用");
  assert.equal(
    exampleChipState("画一只橘猫", null, true),
    "disabled",
    "面板在途但没有指定那一颗（文字送出路径）也要全禁用",
  );
});

test("09-18 面板掌握「本輪尚未開始」：模板 chip 與輸入區兩條路徑共用同一個在途態", () => {
  const code = readCode(panel);
  // 模板路徑：点击那一刻进在途態并标记被点的那一颗。
  assert.match(code, /const handleExampleSend = \(ex: string\) => \{/);
  assert.match(code, /beginSendPending\(\);\s*\n\s*setPendingExample\(ex\);/);
  // 既有同幀连点锁必须留着（空態併發 send 是已记录的竞态，两条消息两次计费）。
  assert.match(code, /if \(exampleSendRef\.current\) return;/);
  assert.match(code, /exampleSendRef\.current = true;/);
  assert.match(code, /exampleSendRef\.current = false;/);
  // chip 三态：被点的那一颗转圈（aria-busy），在途期间全部禁用（带 aria-busy 与既有禁用视觉）。
  // 09-20 零位移定案：建号/首發在飛（sessionStarting/turnActive）時多一層強制 disabled，
  // exampleChipState 本體呼叫不變（單一真相源仍在）。
  assert.match(
    code,
    /const chipState =\s*sessionStarting \|\| turnActive \? "disabled" : exampleChipState\(ex, pendingExample, sendPending\);/,
  );
  assert.match(code, /disabled=\{chipState !== "idle"\}/);
  assert.match(code, /aria-busy=\{chipState === "pending" \? true : undefined\}/);
  assert.match(code, /chipState === "disabled" && "opacity-50"/);
  assert.match(code, /chipState === "pending" && "inline-flex items-center gap-1\.5"/);
  assert.match(code, /text-ios-footnote/, "chip 既有排版与字级不动");
  // 輸入區路徑：同一个 promise 结算时解除；面板把在途態餵给 composer（单一真相源，
  // composer 不自己猜），模板 chip 在途期间点不动。
  assert.match(code, /externalSendPending=\{sendPending\}/);
  assert.match(code, /Promise\.resolve\(result\)\.catch\(\(\) => \{\}\)\.finally\(endSendPending\)/);
  // 三条解除路径，全在面板侧：turnActive/closed、promise 结算、20s 硬保险（同一个常量）。
  assert.match(code, /if \(turnActive \|\| closed\) endSendPending\(\);/);
  assert.match(
    code,
    /sendPendingTimerRef\.current = window\.setTimeout\(endSendPending, SEND_HARD_TIMEOUT_MS\)/,
  );
  // 硬保险只能沿用既有值（防锁死的安全阀），不许被改长。
  assert.match(composer, /const SEND_HARD_TIMEOUT_MS = 20_000;/);
  // 立起在途態的入口只有两个：模板 chip 与輸入區送出。
  assert.equal((code.match(/beginSendPending\(\);/g) ?? []).length, 2, "只准这两条入口");
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
  assert.match(batchProgress, /停止/);
  assert.doesNotMatch(readCode(batchProgress), /停下/, "旧「停下」文案不得回魂");
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
  // 2026-09-20 Route B：无总数时的诚实呈现文案由「已出 X 张」改为
  // 「正在生成 X 张」（进行中的动态语义，不是完成时的静态计数）。
  assert.match(batchProgress, /正在生成 \{images\} 张/);
  assert.doesNotMatch(readCode(batchProgress), /已出 \{images\} 张/, "旧「已出」文案不得回魂");
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
  // Task 9：模式切換 toggle 按鈕在 ActionRow —— 拼接讀取，斷言語義不變。
  const code = readCode(promptInput) + "\n" + readCode(actionRow);

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
  const code = readCode(promptInput) + "\n" + readCode(promptInputHeightLock) + "\n" + readCode(actionRow);
  // 送出归聊天区自己的输入区：卡片底部那颗 CTA 在 agent 面不存在。
  // 2026-08-25 用户裁定：agent 面的「返回生成」底行是废层（聊天面 Header 的
  // onExit 收起按钮做同一件事）——ActionRow 在 agent 面整组件不渲染（return null），
  // 返回由 Header 承担，底行高度由聊天区 flex-1 吃掉。
  assert.match(code, /if \(displayMode === "agent"\) return null;/);
  // Header 那顆鈕（SlidersHorizontal）必須真的接著「回 generate」——底行删了
  // 之后它是首頁直接生圖的唯一入口（2026-09-22 首屏翻面：語義＝走另一條路，
  // 不是收起，因為首屏本來就在 agent 面、沒有「原本的地方」可回）。
  assert.match(code, /onExit=\{\(\) => onModeChange\("generate"\)\}/);
  // 键盘旁路也要堵掉，否则 Enter 还能从别处触发一次生成。
  assert.match(code, /if \(displayMode === "agent"\) return;/);
  // 两个输入框并排会有「我该往哪打字」的歧义。
  assert.match(code, /MODES_WITHOUT_TEXTAREA = new Set<PromptInputMode>\(\["upscale", "agent"\]\)/);
  // 聊天区内部靠 flex-1 + min-h-0 自己滚，外层必须给定高度。
  // 2026-08-22：高度改为「generate 面实测自然高」锁定（contentRef/contentHeight），
  // 所有模式共用同一外框——不再在组件中写死 clamp 或单一 CSS 变量高度。
  // 2026-09-22 首屏翻面：高度鎖只在 generate/edit 量測，首屏落在 agent 面時
  // contentHeight 恆為 null ⇒ 兜底 surfaceHeight 吃 --agent-surface-height，
  // 等第一次進 generate 量到真高後自動讓位（見 PromptInput 的 surfaceHeight）。
  assert.match(code, /AGENT_SURFACE_HEIGHT = "var\(--agent-surface-height\)"/);
  assert.match(code, /contentRef/);
  assert.match(code, /contentHeight/);
  assert.match(code, /height: surfaceHeight/);
  // 常量必須真的被餵進 agent 面的兜底分支（此前只斷言宣告字串，宣告留著、
  // JSX 零引用也照樣過關——那正是它當了死碼的原因）。
  assert.match(code, /displayMode === "agent" \? AGENT_SURFACE_HEIGHT : null/);
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
 * 09-12 建号权收归发送按钮（回归锁重铸）。
 *
 * 旧锁钉的是「toggle 往返静默 resume」（autoStart 时代行为）。autoStart 与
 * 预建整链已拆除——进助理/开新/套模板一律不建号，首条消息 send() 才 lazy
 * 建号；toggle 重开＝空态，旧会话去历史 dropdown 切回。sessionTouchedInThisVisit
 * 仍存活，职责收窄：压住重开面板时的存档快照提示。
 */
test("entering the agent never creates a session: send() owns the lazy create", () => {
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  // 自动建号的三个源头全部拆干净：autoStart、预建取用、过期自动开新。
  assert.doesNotMatch(hook, /autoStart/);
  assert.doesNotMatch(hook, /precreated|PrecreatedSession/);
  assert.doesNotMatch(hook, /上次对话已过期[\s\S]{0,80}void start\(\)/);
  // 开新＝清空回空态，不再跑建号核心。
  assert.doesNotMatch(hook, /const startNewSession[\s\S]*?runStartCore\(\)/);
  // send() 的 ensure 必须钉在乐观插入之前，且判空在 ensure 之后（防幽灵回声）。
  assert.match(
    hook,
    /if \(!sessionIdRef\.current\) \{\s*forceNewRef\.current = true;\s*await start\(\);\s*\}[\s\S]*?const sid = sessionIdRef\.current;[\s\S]*?dispatch\(\{ type: "user"/,
  );
  // 标记仍是模块级（组件卸载 ref 一起死，ref 存不住这件事）。
  assert.match(hook, /^let sessionTouchedInThisVisit = false;/m);
  // 不许有人把它挪进跨刷新的存储。
  assert.doesNotMatch(hook, /sessionStorage[\s\S]{0,40}sessionTouchedInThisVisit/);
  assert.doesNotMatch(hook, /localStorage[\s\S]{0,40}sessionTouchedInThisVisit/);
  // 首页挂载不再预建会话（PromptInput）；助理挂载不再传 autoStart（Surface）。
  const input = readCode(promptInput);
  assert.doesNotMatch(input, /stashPrecreatedSession|createAgentSession/);
  assert.doesNotMatch(readCode(surface), /autoStart/);
  // 模板注入不再等 connection open——等它就饿死（空态永不连线）。
  assert.match(
    readCode(surface),
    /injectedNonceRef\.current = agentInjection\.nonce;[\s\S]{0,120}void send\(agentInjection\.text/,
  );
  assert.doesNotMatch(
    readCode(surface),
    /injectedNonceRef\.current = agentInjection\.nonce;[\s\S]{0,200}if \(connection !== "open"\)/,
  );
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
  // 裸 401/403（token 过期但网关没回专门 body code）会被 mapHttpStatus 映成
  // "unauthorized"，不是 "not_authenticated"——hook 必须用同时认两者的
  // isTerminalAuthError 判断，只认 not_authenticated 会漏掉这种情况，
  // 造成过期登录态无限重连（而不是终止并提示重新登录）。
  assert.match(
    client,
    /export function isTerminalAuthError\(err: unknown\): boolean \{\s*return err instanceof AgentChatError && \(err\.code === "not_authenticated" \|\| err\.code === "unauthorized"\);/,
  );
  const hook = readCode(read("src/hooks/use-agent-chat.ts"));
  assert.match(hook, /isTerminalAuthError\(err\)[\s\S]{0,80}closedRef\.current = true;/);
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
  // 2026-09-24（决策 18）：拖拽中提示改「松开以添加素材」（原文「松开以添加附件」——
  // 「附件」搭配「图片」暗示让用户以为只能拖图；素材才是中性语义）。
  assert.match(code, /松开以添加素材/);
  assert.match(code, /pointer-events-none/);

  // 2026-09-24（决策 17/18）：上传入口语义中性化——去掉「只收图片」暗示，
  // placeholder 明说可以把剧本/资产图拖进来（拖拽落点只支援拖进输入框，决策 19）。
  assert.match(code, /aria-label="添加素材"/);
  assert.match(code, /title="添加素材（剧本 \/ 图片 \/ 影片 \/ 文档）"/);
  assert.match(code, /placeholder = "描述你想做的，或把剧本／资产图拖进来"/);

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

// ─────────────────────────── 罪状 1/4/5 行为断言（纯函数直测）

/** 建一帧被 TypeScript 检过型别的 SSE 事件。 */
function evt(event: AgentSseEvent): AgentSseEvent {
  return event;
}

test("attachment block is stripped from user text and parsed into refs", () => {
  const text = [
    "帮我把这张图改成夜景",
    "[ATTACHMENTS_BLOCK]",
    "[附件]",
    "1. uploads/s1/IMG%20one.png | image/png | 204800",
    "2. uploads/s1/notes.txt | text/plain | 1024",
    "[/ATTACHMENTS_BLOCK]",
  ].join("\n");
  const { cleanText, refs } = parseUserAttachmentBlock(text);
  // 正文摘干净：区块连同前后多余空白不留在气泡里。
  assert.equal(cleanText, "帮我把这张图改成夜景");
  assert.equal(refs.length, 2);
  // mime 推 kind、name 解 URL 编码噪音、size 落数字。
  assert.equal(refs[0].kind, "image");
  assert.equal(refs[0].name, "IMG one.png");
  assert.equal(refs[0].size, 204800);
  assert.equal(refs[1].kind, "document");
  // 没有区块的正文原样放行，一字不动。
  assert.deepEqual(parseUserAttachmentBlock("纯文本消息"), { cleanText: "纯文本消息", refs: [] });
});

test("subagent delta 保留全文（模型層不截斷），lastLine 只當渲染預覽", () => {
  // 末行仍是預覽（置頂跑馬燈只滾一行）。
  assert.equal(lastNonEmptyLine("a\n\nb\n"), "b");
  let state = appendUserTurn(EMPTY_AGENT_CHAT_STATE, "你好");
  state = agentChatReducer(state, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  state = agentChatReducer(state, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: "第一行\n第二行" } }));
  const sub = state.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.lastLine, "第二行");
  // 舊斷言測的是「模型裡永遠只存一行（防溢出）」；F4 新契約把截斷下移到渲染層
  // （truncate + 整行展開），模型必須留全文，否則展開無從展開。
  assert.equal(sub.text, "第一行\n第二行");
});

test("subagent started→done settles the card, turn.done retires it into an expandable report", () => {
  let state = agentChatReducer(EMPTY_AGENT_CHAT_STATE, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  let sub = state.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.status, "running");
  assert.equal(sub.label, "搜索素材");
  state = agentChatReducer(state, evt({ name: "subagent.done", event_id: 2, data: { id: "sa1", status: "ok", summary: "找到 3 张候选图" } }));
  sub = state.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.status, "ok");
  assert.equal(sub.summary, "找到 3 张候选图");
  // 回合收尾：状态栏退场（旧断言的意图保留），但 summary 必须转存成产出卡（F3），
  // 不再随状态栏一起消失——「中止后画面比中止前更空」就是不修这条的产物。
  state = agentChatReducer(state, evt({ name: "turn.done", event_id: 3, data: {} }));
  assert.ok(!state.items.some((it) => it.kind === "subagent"));
  const report = state.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report);
  assert.equal(report.text, "找到 3 张候选图");
  assert.equal(report.status, "ok");
  // 2026-09-19 暴君裁定：置顶三卡 + 弹出面板两套重复 UI 合并为一份内联列表，
  // pickVisibleSubagents 名额裁剪随置顶卡一起下线。
  const mk = (i: number, status: AgentSubagentItem["status"]): AgentSubagentItem => ({
    kind: "subagent",
    id: `subagent-${i}`,
    seq: i,
    subagentId: `sa${i}`,
    label: `任务${i}`,
    lastLine: "",
    status,
  });
  const all = [mk(1, "ok"), mk(2, "ok"), mk(3, "ok"), mk(4, "running")];
  const markupAll = renderToStaticMarkup(createElement(AgentSubagentBar, { items: all }));
  for (const it of all) {
    assert.match(markupAll, new RegExp(it.label), "内联列表全量渲染，不再有名额裁剪");
  }
  // 2026-09-20 Route B：折叠头文案改「派出 N 个子代理」（Grok 级细行语言）。
  assert.match(markupAll, /派出 4 个子代理/, "折叠头计数与列表同源");
});

test("F2 工具卡人話化：默認渲染只有人話，函數名與 raw JSON 收進展開抽屜", () => {
  // 純函數：工具名 → 人話標題；未知工具原樣回落（不假造名字）。
  assert.equal(toolDisplayName("subagent_dispatch"), "派遣子代理");
  // 2026-09-11 T1 全量表落地：bash 的顯示名由舊「执行命令」改名為「终端命令」
  // （語義收斂到「这是一次终端命令」，不再暗示是人工執行命令）。
  assert.equal(toolDisplayName("bash"), "终端命令");
  assert.equal(toolDisplayName("never_seen_tool"), "never_seen_tool");
  // 參數預覽只認白名單欄位；挑不到就不顯示（默認渲染沒有 raw JSON 片段）。
  assert.equal(toolArgPreview('{"async":false,"label":"视频牌价预检","prompt":"..."}'), "视频牌价预检");
  assert.equal(toolArgPreview('{"async":false,"count":4}'), undefined, "沒人話欄位就不端 JSON");
  assert.equal(toolArgPreview('{"label":"被网关截断的半截 JSON…'), "被网关截断的半截 JSON…", "半截 JSON 只摘白名單值");
  assert.equal(toolArgPreview("ls -la /opt/agent-harness"), "ls -la /opt/agent-harness");
  assert.equal(toolArgPreview("{broken"), undefined);

  // SSR 默認渲染（2026-09-20 R2 對版預覽）：行＝類型圖標 + 人話標題 + 狀態詞，
  // 摘要與幣數收進展開面板（預設不掛載）——默認 DOM 更乾淨，看不見函數名與 JSON。
  const markup = renderToStaticMarkup(
    createElement(AgentToolCard, {
      item: {
        kind: "tool",
        id: "tool-1",
        seq: 1,
        tool: "subagent_dispatch",
        argsSummary: '{"async":false,"label":"视频牌价预检","prompt":"查牌价"}',
        status: "running",
      },
    }),
  );
  assert.match(markup, /派遣子代理/, "標題必須是人話");
  assert.match(markup, /运行中/, "行尾狀態詞（對版預覽語彙）");
  assert.doesNotMatch(markup, /subagent_dispatch/, "默認渲染不得出現原始函數名");
  assert.doesNotMatch(markup, /async/, "默認渲染不得出現 raw JSON 欄位");
  assert.doesNotMatch(markup, /\{/, "默認渲染不含 JSON 片段");
  // 摘要的人話欄位仍要被提取（入展開面板用）：toolArgPreview 純函數已在上面斷言。
  // 展開抽屜仍然帶著完整參數與原始函數名（收起來不等於刪掉）。
  const card = readCode(read("src/components/agent-chat/AgentToolCard.tsx"));
  assert.match(card, /argsSummary=\{item\.argsSummary\}/);
  assert.match(card, /toolName=\{item\.tool\}/);
  const src = read("src/components/agent-chat/AgentParamDisclosure.tsx");
  assert.match(src, /\{toolName !== undefined &&/, "展開區顯示原始函數名");
  assert.match(src, /\{everOpened && \(/, "展開內容首次展開才掛載（默認 DOM 不含 raw JSON）");
});

test("T1 工具名映射全量表：關鍵映射逐字正確、未知工具回落原名、video_gen 空指針已刪", () => {
  // 暴君逐條核準的顯示名（簡體）：抽 8 條關鍵映射逐字斷言，防止後續被潤色改字。
  const expected: Array<[string, string]> = [
    ["bash", "终端命令"],
    ["quote_bundle", "整包报价"],
    ["subagent_dispatch", "派遣子代理"],
    ["timeline_ops", "时间线操作"],
    ["workflow_start", "启动工作流"],
    ["blender_exec", "执行 Blender 脚本"],
    ["run_py", "运行 Python 脚本"],
    ["image_quote", "查询图片单价"],
  ];
  for (const [tool, title] of expected) {
    assert.equal(toolDisplayName(tool), title, `${tool} 的显示名必须是核準值`);
  }
  // 兜底不變：未知工具原樣回落原名（不假造名字）。
  assert.equal(toolDisplayName("不存在的工具"), "不存在的工具");
  // video_gen 是空指針（網關無此工具）：表裡不得有鍵，行為上也只能回原名。
  const table = /const TOOL_TITLES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(toolCard)?.[1] ?? "";
  assert.ok(table.length > 0, "必須能取到 TOOL_TITLES 表體");
  assert.ok(!/\bvideo_gen\b/.test(table), "video_gen 空指針不得留在表裡");
  assert.equal(toolDisplayName("video_gen"), "video_gen");
  // 覆蓋率下限：97 個網關工具 + 內建，防止整表被誤縮（重複鍵會靜默吃掉前一條）。
  const keys = [...table.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 100, `TOOL_TITLES 至少 100 條，實際 ${keys.length}`);
  assert.equal(new Set(keys).size, keys.length, "鍵不得重複");
});

test("F3/F4 產出卡：截斷預覽 + 整行展開全文（渲染層才截斷）", () => {
  const report = read("src/components/agent-chat/AgentSubagentReportCard.tsx");
  // 一行預覽 + 整行可點展開（沿用工具卡家族的展開語言）。
  assert.match(report, /aria-expanded=\{open\}/);
  assert.match(report, /aria-controls=\{bodyId\}/);
  assert.match(report, /truncate/, "預覽層才截斷");
  assert.match(report, /whitespace-pre-wrap/, "展開區顯示全文（保換行）");
  assert.match(report, /\{item\.text \|\| "（无输出）"\}/, "展開區放全文");
  assert.match(report, /已中止/, "中止態誠實標示");
  // 產出卡進轉錄（不在置頂狀態欄渲染）。
  assert.match(transcript, /case "subagent_result":/);
  assert.match(transcript, /<AgentSubagentReportCard item=\{item\} \/>/);
  // 預覽純函數：第一個非空行，空文本誠實回空字串。
  assert.equal(reportPreview(""), "");
  assert.equal(reportPreview("\n\n第二行\n第三行"), "第二行");
});

test("subagent bar：running 逐字滑窗（append-only + 立即釘右緣）、折叠头默认展开可收合（2026-09-11 逐字滑窗合同；09-19 去重裁定）", () => {
  const src = read("src/components/agent-chat/AgentSubagentBar.tsx");
  // 2026-09-10 暴君裁定：卡片级展开语义下线（单行卡无展开按钮）。
  assert.ok(!/aria-expanded=\{expanded\}/.test(src), "单行卡不再有展开语义");
  // 兩套被否決的做法都不得回魂：循環跑馬燈（9s linear infinite + translateX(-50%)）
  // 語義相反；「尾部跟隨 + 逐幀插值」與文字增長兩套運動打架＝使用者看到的
  // 「滿了就整行清掉」。
  assert.ok(!/subagent-marquee/.test(src), "循环跑马灯动画类名已下线（语义与尾部跟隨相反）");
  assert.ok(!/translateX\(-50%\)/.test(src), "不再以 transform 循环平移文本");

  // 切出 MarqueeLine 函数体做源码层行为断言（避免命中同文件其他区块的写法）。
  const body = src.slice(src.indexOf("function MarqueeLine"), src.indexOf("interface SubagentCardProps"));
  assert.ok(body.length > 100, "MarqueeLine 函数体切片命中");

  // ① 舊做法在 MarqueeLine 裡一個都不准留：rAF 逐幀插值、reduced-motion 分支
  //    （沒有動畫可關就不需要出口）、truncate（結尾省略號）、slice(-N)（尾段窗
  //    ＝每次更新整串替換＝清空重填的觀感來源）。否定式一律走 readCode：
  //    註解裡引用舊做法當反例是常態，拿原文斷言會把註解當違規。
  const code = readCode(body);
  assert.ok(!/requestAnimationFrame/.test(code), "不得再有 rAF 逐幀插值（與文字增長打架）");
  assert.ok(!/prefers-reduced-motion/.test(code), "不得再有 reduced-motion 分支（已無動畫）");
  assert.ok(!/truncate/.test(code), "running 跑马灯行不得出现 truncate（結尾省略號）");
  assert.ok(!/slice\(-/.test(code), "不得再有尾段截取（整串替換＝清空重填）");
  assert.ok(!/transition/.test(code), "不得用 transition（平滑滾動＝另一套運動）");

  // ② 逐字滑窗的實作契約：內容一進 DOM 就**直接賦值**把視窗釘到最右，
  //    用 useLayoutEffect 在 layout 前釘位（不得留一幀舊位置，那看起來就是頓）。
  assert.match(
    body,
    /scroller\.scrollLeft = scroller\.scrollWidth - scroller\.clientWidth;/,
    "每次更新把 scrollLeft 立即釘到最右（scrollWidth - clientWidth，無插值）",
  );
  assert.match(body, /useLayoutEffect\(/, "用 useLayoutEffect 在 paint 前釘位");
  // 內容是單一 nowrap 文字節點：只有追加才會有「最左邊被擠出去」的自然滑窗。
  assert.match(body, /whitespace-nowrap/, "內容節點 nowrap（滑窗靠排版自然溢出）");
  assert.ok(!/\{content\}\{content\}/.test(code), "不得雙份文本（那是循環跑馬燈的寫法）");

  // ③ 量測 ref 恆常掛載：scroller/track 兩個 ref 都掛在無條件渲染的節點上，
  //    且函數只有一條 return 路徑（不再「未溢出分支不渲染量測節點」而死鎖）。
  assert.match(body, /ref=\{scrollerRef\}/, "scroller ref 掛在恆常渲染的容器上");
  assert.match(body, /ref=\{trackRef\}/, "track ref 掛在恆常渲染的內容節點上");
  assert.ok(!/if \(!overflowing\)/.test(code), "不得再有依 overflowing 分支的提早 return");
  // 頂格 2 空格的 `return (` 是函數體 JSX 出口（effect 清理函數縮排更深，不計）。
  assert.equal((body.match(/^ {2}return \($/gm) ?? []).length, 1, "MarqueeLine 只有一條 JSX 渲染路徑");
  assert.ok(!/\{!overflowing \?/.test(code), "不得再各分支渲染一套 DOM");
  // 左緣漸隱遮罩保留：它負責暗示「左邊還有」（不再靠省略號佔位）。
  assert.match(body, /left-0 z-10 w-6 bg-gradient-to-r/, "左緣漸隱遮罩保留");

  // ④ marqueeText 純函數：壓空白 + 去前後空白 + 只有跨門檻才整塊裁，且不補省略號。
  const fn = src.slice(src.indexOf("export function marqueeText"), src.indexOf("function MarqueeLine"));
  assert.ok(fn.length > 50, "marqueeText 函数体切片命中");
  assert.ok(!/…/.test(readCode(fn)), "不補省略號佔位（左緣遮罩負責暗示左邊還有）");
  // 常數 export 給測試用，值不得漂移。
  assert.equal(MARQUEE_HARD_CAP, 6000);
  assert.equal(MARQUEE_KEEP, 3000);
  // 換行/連續空白壓成單一空格（「一直在吐」不因換行整行跳掉）。
  assert.equal(marqueeText("第一行\n第二行  第三行"), "第一行 第二行 第三行");
  // 前後空白去掉，免得開頭空一格、滑窗看起來像抖了一下。
  assert.equal(marqueeText("  前後空白  "), "前後空白");
  assert.equal(marqueeText("\n\t  \n"), "", "只有空白＝空字串（不得變成空格）");
  assert.equal(marqueeText(""), "");
  assert.equal(marqueeText("短"), "短", "短文本原樣，一字不動");
  // 剛好 HARD_CAP：不裁（等號那一格不算跨門檻）。
  assert.equal(marqueeText("甲".repeat(MARQUEE_HARD_CAP)), "甲".repeat(MARQUEE_HARD_CAP), "6000 字不裁");
  // 超過 HARD_CAP 一字：一次裁到 KEEP，且必須是原文尾段（最新吐出的那一段）。
  const over = "甲".repeat(5000) + "乙".repeat(1001);
  assert.equal(over.length, MARQUEE_HARD_CAP + 1, "構造 6001 字");
  const cut = marqueeText(over);
  assert.equal(cut.length, MARQUEE_KEEP, "6001 字 → 一次裁到 3000 字");
  assert.equal(cut, over.slice(-MARQUEE_KEEP), "取的是原文尾段（最新的字）");
  assert.ok(!cut.includes("…"), "裁完也不補省略號（佔位不是內容）");
  // append-only：未跨門檻時，後一次輸出是前一次的前綴——這是「只追加不替換」的
  // 可測形式，也是連續滑窗不跳動的前提。
  const grow1 = marqueeText("字".repeat(100));
  const grow2 = marqueeText("字".repeat(100) + "新");
  assert.ok(grow2.startsWith(grow1) && grow2.length === grow1.length + 1, "未跨門檻時只追加不替換");

  // ⑤ 資料源：running 態餵「活動流」——reasoning 也算在工作（跑馬燈的目的只是
  //    讓使用者感知子代理在跑），再依序回落 text / lastLine / 誠實空文案。
  assert.match(src, /<MarqueeLine text=\{item\.activity \|\| item\.text \|\| item\.lastLine \|\| "正在输出…"\} \/>/, "running 态餵活動流（含 reasoning）");
  // SSR 行為層（真渲染，非源碼猜測）：activity 優先於 text；換行壓成空格；
  // 短文字也照渲染（量測節點恆常掛載＝不再有量測死鎖）。
  const runningItem: AgentSubagentItem = {
    kind: "subagent",
    id: "subagent-9",
    seq: 9,
    subagentId: "sa9",
    label: "任务9",
    lastLine: "旧行摘要",
    text: "第一段\n第二段 收尾",
    activity: "先想一下\n再核價",
    status: "running",
  };
  const markup = renderToStaticMarkup(createElement(AgentSubagentBar, { items: [runningItem] }));
  assert.match(markup, /先想一下 再核價/, "running 行渲染活動流（reasoning 也在內）");
  assert.doesNotMatch(markup, /第一段 第二段 收尾/, "有 activity 時不再餵 text");
  assert.doesNotMatch(markup, /truncate/, "running 行不得再走 truncate");
  // 沒有 activity 的舊資料（或只有正文的舊幀）回落 text，不留空白行。
  const noActivityMarkup = renderToStaticMarkup(
    createElement(AgentSubagentBar, { items: [{ ...runningItem, activity: undefined }] }),
  );
  assert.match(noActivityMarkup, /第一段 第二段 收尾/, "沒有 activity 時回落 text");
  // 空输出诚实文案，不假造内容（running 卡的 fallback「正在输出…」）。
  assert.match(src, /正在输出…/);
  // 2026-09-19 暴君裁定：「折叠头放列表上方，默认展开可收合；
  // 弹出面板（lg-sheet/关闭钮/Esc）与置顶名额裁剪两套重复 UI 下线。
  // 2026-09-20 Route B：折叠头文案改「派出 N 个子代理」（无底色细行语言）。
  assert.match(src, /派出 \{items\.length\} 个子代理/);
  assert.match(src, /useState\(true\)/, "折叠头默认展开");
  assert.match(src, /aria-expanded=\{open\}/, "折叠头带展开语义（可收合）");
  assert.ok(!/SubagentMenu/.test(readCode(src)), "弹出面板已下线（只有一份内联列表）");
  assert.ok(!/lg-sheet/.test(readCode(src)), "弹层材质随面板一起下线");
  assert.ok(!/pickVisibleSubagents/.test(readCode(src)), "置顶名额裁剪已下线（列表全量渲染）");
});

// ───────────────────── 资产入库：recipe 分支（E1 白名单） ────────────────

import { buildChatSaveItem } from "../../lib/agent-chat-asset-builders";
import type { AgentImageItem } from "../../lib/agent-chat-types";

function imageItem(overrides: Partial<AgentImageItem>): AgentImageItem {
  return {
    kind: "image",
    id: "img-1",
    seq: 1,
    url: "https://cdn.example.com/out/1.png",
    costCoins: 1,
    recipe: undefined,
    ...overrides,
  } as AgentImageItem;
}

test("onSaveToLibrary with a real recipe saves a kind:recipe asset", () => {
  const item = imageItem({
    recipe: {
      prompt: "赛博朋克都市夜景，霓虹灯反射在雨后街道上",
      model: "sdxl-1.0",
      size: "1024x1024",
      lora: "lora-cyberpunk-v3",
    },
  });
  const saved = buildChatSaveItem(item, "session-9", "2026-08-30T00:00:00.000Z");
  assert.equal(saved.kind, "recipe");
  // recipe 的 prompt 落到 content，模型/尺寸/lora 各自进白名单栏位。
  assert.equal(saved.title, "第 1 张");
  assert.equal(saved.content, "赛博朋克都市夜景，霓虹灯反射在雨后街道上");
  assert.equal(saved.modelId, "sdxl-1.0");
  assert.equal(saved.size, "1024x1024");
  assert.deepEqual(saved.loraModelVersionIds, ["lora-cyberpunk-v3"]);
  assert.equal(saved.imageUrl, item.url);
  assert.deepEqual(saved.source, { type: "chat", id: "img-1", sessionId: "session-9" });
  assert.equal(saved.createdAt, "2026-08-30T00:00:00.000Z");
});

test("onSaveToLibrary without recipe keeps the original reference behavior", () => {
  const saved = buildChatSaveItem(imageItem({}), "session-9", "2026-08-30T00:00:00.000Z");
  assert.equal(saved.kind, "reference");
  assert.equal(saved.imageUrl, "https://cdn.example.com/out/1.png");
  // 参考资产不携带配方栏位。
  assert.equal(saved.content, undefined);
  assert.equal(saved.modelId, undefined);
  assert.equal(saved.size, undefined);
  assert.equal(saved.loraModelVersionIds, undefined);
});

test("recipe with an empty prompt falls back to reference (no phantom recipe)", () => {
  const saved = buildChatSaveItem(imageItem({ recipe: { prompt: "", model: "sdxl-1.0" } }), null, "2026-08-30T00:00:00.000Z");
  assert.equal(saved.kind, "reference");
  // 无会话 id 时 source 不带 sessionId。
  assert.deepEqual(saved.source, { type: "chat", id: "img-1" });
});

// 歷史會話下拉標題（網關 09-12 title 契約）：優先顯示摘要標題，無標題降級時間標籤。
// formatSessionLabel 身在 client 組件、模組鏈含 CSS import，tsx 測試進程無法直接
// import 該檔，故以同等邏輯做行為斷言，並用源碼錨點保證生產碼與鏡像邏輯不漂移。
function formatSessionLabelMirror(it: { created_at: number; title?: string | null }): string {
  const t = typeof it.title === 'string' ? it.title.trim() : '';
  if (t) return t;
  const d = new Date(it.created_at);
  const date = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} 的对话`;
}

test("history session dropdown prefers gateway title, falls back to time label", () => {
  // 源碼錨點：渲染點確為「標題優先＋時間兜底」雙軌（與上方鏡像邏輯同形）。
  const surfaceCode = readCode(surface);
  assert.match(surfaceCode, /typeof it\.title === 'string' \? it\.title\.trim\(\) : ''/);
  assert.match(surfaceCode, /if \(t\) return t;/);

  const created = new Date("2026-09-12T03:04:00Z").getTime();
  const timeLabel = formatSessionLabelMirror({ created_at: created });
  // title 有值 → 原樣顯示（含 trim 後內容）。
  assert.equal(formatSessionLabelMirror({ created_at: created, title: "海报构图三轮修" }), "海报构图三轮修");
  assert.equal(formatSessionLabelMirror({ created_at: created, title: "  trimmed title  " }), "trimmed title");
  // title null/空串/全空格/缺欄 → 降級時間標籤（原兜底文案不動）。
  assert.match(timeLabel, /^\d+\/\d+ \d{1,2}:\d{2} 的对话$/);
  assert.equal(formatSessionLabelMirror({ created_at: created, title: null }), timeLabel);
  assert.equal(formatSessionLabelMirror({ created_at: created, title: "" }), timeLabel);
  assert.equal(formatSessionLabelMirror({ created_at: created, title: "   " }), timeLabel);
  assert.equal(formatSessionLabelMirror({ created_at: created }), timeLabel);
});

test("批量进度「已用 N 币」不把报价类工具的估价、失败工具算成花费", () => {
  const html = renderToStaticMarkup(
    createElement(AgentBatchProgress, {
      items: [
        { kind: "tool", id: "q1", seq: 1, tool: "video_quote", status: "ok", costCoins: 600 },
        { kind: "tool", id: "q2", seq: 2, tool: "quote_bundle", status: "ok", costCoins: 11 },
        { kind: "tool", id: "g0", seq: 3, tool: "image_generate", status: "failed", costCoins: 5 },
        { kind: "tool", id: "g1", seq: 4, tool: "image_generate", status: "ok", costCoins: 3 },
      ],
    }),
  );
  assert.match(html, /已用 3 币/);
  assert.doesNotMatch(html, /614|619/);
});
