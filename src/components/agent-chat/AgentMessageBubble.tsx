"use client";

import { memo, useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from "react";
import { Brain, Check, ChevronDown, Copy, Navigation } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentSteerStatus, AgentUserTurnItem } from "@/lib/agent-chat-types";
import { parseUserAttachmentBlock, AgentAttachmentCards } from "./AgentAttachmentCards";
import { AgentMarkdown } from "./AgentMarkdown";

/**
 * REQ-D2：steer 状态 → 人话（与网關 steer-core.ts 的 SteerStatus 值域一一对应）。
 * 六态都必须说清「生效了没有」：queued=还没生效（本回合结束後生效），
 * injected=本回合内已生效，applied=下一回合已生效，aborted/failed=没生效，
 * uncertain（D2b）=**不知道**（投递已发出但没等到确认，网關永不自动重发）——
 * 不能说成「未生效」（那是假话：可能已经送达），更不能说成已生效。
 * position 只在排队时带来「你是第几条」的信息。
 *
 * 文案落点刻意留在本函数（既有 steer 徽章的唯一取用口，五态本来就住这里）；
 * src/lib/ui-strings.ts 是 D4 另有归属的檔案，本刀不动它。
 */
function steerStatusLabel(status: AgentSteerStatus, position?: number): string {
  switch (status) {
    case "queued":
      return `引导已排队${typeof position === "number" ? `（第 ${position} 条）` : ""}·本回合结束后生效`;
    case "injected":
      return "引导已注入本回合";
    case "applied":
      return "引导已生效";
    case "aborted":
      return "引导已中止（未生效）";
    case "failed":
      return "引导未能送达（未生效）";
    case "uncertain":
      return "引导未确认（未重送）";
  }
}

export interface AgentMessageBubbleProps {
  item: AgentUserTurnItem | AgentAssistantTextItem;
  /** 当前会话 id：附件卡铸读取票用。缺省时附件全部降级成文档式卡。 */
  sessionId?: string | null;
}

/** prefers-reduced-motion：串流游標閃爍與入場動畫都關掉，避免暈動。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function AgentMessageBubbleComponent({ item, sessionId }: AgentMessageBubbleProps) {
  const isUser = item.kind === "user";
  const reducedMotion = usePrefersReducedMotion();

  // 罪状 1：用户消息里的 [ATTACHMENTS_BLOCK] 不再以裸文本示人——正文摘干净，
  // 附件解析成微信式卡片渲染在正文下方。没有区块时解析原样放行，一字不动。
  const userParsed = isUser ? parseUserAttachmentBlock(item.text) : null;
  const hasAttachments = userParsed !== null && userParsed.refs.length > 0;
  const displayText = hasAttachments ? userParsed.cleanText : item.text;

  // 文案（2026-09-20）：已結算＝「已思考 · N 秒」，還在想＝「正在思考…」，
  // 無計時資料＝「已思考」——見下方 reasoningLabel。
  // 單一 write path 語義不變：open 受控於 state（初值＝是否串流中），使用者點 summary
  // 造成的 toggle 由下面 handler 回寫，之後串流 delta 更新或父層 re-render 只會
  // 照著這個值渲染，不會把它打回收合——手動展開／收合優先於任何自動行為。
  // 2026-09-27 暴君裁定 supersede：思考中展開、結算後自動收合成「已思考 · N 秒」
  // 一行（展開的內部推理佔半屏）。使用者一旦手動點過 summary，自動收合就不再介入。
  const reasoningStreaming = item.kind === "assistant" && item.streaming === true;
  const [reasoningOpen, setReasoningOpen] = useState(reasoningStreaming);
  const reasoningTouched = useRef(false);
  useEffect(() => {
    if (!reasoningStreaming && !reasoningTouched.current) setReasoningOpen(false);
  }, [reasoningStreaming]);

  // 思維鏈一鍵複製：summary 上的按鈕要 preventDefault，否則點擊會順帶收合 details。
  const [reasoningCopied, setReasoningCopied] = useState(false);
  const copyReasoning = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (item.kind !== "assistant" || !item.reasoning) return;
    try {
      await navigator.clipboard.writeText(item.reasoning);
      setReasoningCopied(true);
      setTimeout(() => setReasoningCopied(false), 1500);
    } catch {
      // clipboard 不可用（非安全上下文）時靜默失敗，用戶仍可手動選取複製。
    }
  };

  // details 的 toggle 是唯一寫入口：使用者按 summary 造成的開／關在這裡被記下來。
  const onReasoningToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const next = e.currentTarget.open;
    setReasoningOpen((prev) => (prev === next ? prev : next));
  };

  // 思維鏈收合行文案（2026-09-20 真功能，對齊預覽承諾的「已思考 · N 秒」）：
  //   已結算（reasoningMs 有值）→ N 秒，至少 1 秒（瞬時完成也說「1 秒」，
  //     不吐「0 秒」這種像壞掉的數字）；
  //   還在想（streaming 且未結算）→ 正在思考…；
  //   其餘（已完成但沒有計時資料，例如歷史回放重建的條目）→ 已思考，不編秒數。
  // 只是一個字串，渲染在同一顆 span 裡，觸控區／chevron／copy 按鈕都不動。
  const reasoningMs = item.kind === "assistant" ? item.reasoningMs : undefined;
  const reasoningLabel =
    reasoningMs !== undefined
      ? `已思考 · ${Math.max(1, Math.round(reasoningMs / 1000))} 秒`
      : item.kind === "assistant" && item.streaming
        ? "正在思考…"
        : "已思考";

  return (
    <div
      className={cn("agent-rise flex w-full", isUser ? "justify-end" : "justify-start")}
      style={reducedMotion ? { animation: "none" } : undefined}
    >
      <div
        className={cn(
          // min-w-0 + overflow-wrap:anywhere：長 URL／程式碼／JSON 在氣泡內換行，不橫向溢出。
          // 助理條目（正文與思維鏈）一律占滿整行，與工具卡／出圖卡同寬：85% 上限會讓
          // 長文提早折行、右側空出一條，畫面像卡片沒排滿。用戶氣泡維持 85%——右對齊的
          // 短氣泡才是對話的視覺語言。
          // 助理正文走 Markdown 渲染，版式由塊級元素接管，不用 pre-wrap。
          // agent-turn-text：手机正文阶梯锚点（agent-chat.css ≤639.98px → 17px/25px），
          // 桌面 text-[0.9375rem]/leading 一律不动。
          "agent-turn-text min-w-0 break-words [overflow-wrap:anywhere] text-[0.9375rem]",
          item.kind === "user" ? "whitespace-pre-wrap max-w-[85%]" : "w-full",
          isUser
            ? "ml-auto rounded-[20px] rounded-br-[6px] lg-float px-3.5 py-2.5 text-foreground leading-[1.45]"
            : "text-foreground leading-[1.55]",
        )}
      >
        {/* 思維鏈默認收合（09-20 Grok 骨架落地），手動 toggle 優先於任何自動行為
            （write path 語義見上方 reasoningOpen）。open 一律由 state 給值——
            條件式會讓「串流結束」這類 prop 變化重新決定開關，把使用者展開的
            區塊又收回去。 */}
        {item.kind === "assistant" && item.reasoning ? (
          <details
            className="mb-1.5 [&_.brain-chevron]:transition-transform [&[open]>.brain-summary_.brain-chevron]:rotate-180"
            open={reasoningOpen}
            onToggle={onReasoningToggle}
          >
            {/* 觸控目標 ≥44px：行動端沒有 hover，摘要行要按得到（詳情由內部 span 撐高）。
                select-none 只鎖摘要行（避免拖選時把「思考過程」標籤一起圈走），
                展開後的思維鏈內容可自由選取複製。 */}
            <summary onClick={() => { reasoningTouched.current = true; }} className="brain-summary block min-h-11 cursor-pointer touch-manipulation select-none [-webkit-tap-highlight-color:transparent]">
              <span className="flex min-h-11 items-center gap-1.5 text-ios-footnote font-medium text-muted-foreground">
                <Brain className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                {reasoningLabel}
                <ChevronDown className="brain-chevron h-3.5 w-3.5 shrink-0 text-foreground/35" aria-hidden="true" />
                <button
                  type="button"
                  onClick={copyReasoning}
                  aria-label="复制思考过程"
                  title="复制思考过程"
                  className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-black/[0.06] hover:text-foreground/70 active:scale-95"
                >
                  {reasoningCopied ? (
                    <Check className="h-3.5 w-3.5 text-ios-green" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </span>
            </summary>
            <div className="lg-float mt-1 whitespace-pre-wrap break-words rounded-[14px] px-3 py-2.5 text-ios-footnote leading-[1.6] text-muted-foreground [overflow-wrap:anywhere]">
              {item.reasoning}
            </div>
          </details>
        ) : null}
        {/* 空文本时用零宽空格撑住气泡高度，避免 streaming 首帧内容突跳。
            助理正文走 Markdown 渲染（表格/粗体/列表/代码块；图片直链转缩略图、
            行内代码弱化——罪状 3/9）；用户气泡保持纯文本原样。 */}
        {displayText ? (
          item.kind === "assistant" ? (
            <AgentMarkdown text={displayText} />
          ) : (
            displayText
          )
        ) : (
          "​"
        )}
        {/* REQ-D2：回合中追加的指引（steer）状态徽章。
            状态值域的权威是网關的 steer.status 帧（agent-chat-types 的
            AGENT_STEER_STATUSES），这里只翻译成人话——「排队中·本回合结束后生效」
            与「已注入本回合」必须一眼分得开，不许把排队说成已生效。 */}
        {item.kind === "user" && item.steer ? (
          <span
            data-steer-status={item.steer.status}
            className={cn(
              "mt-1.5 flex items-center gap-1 text-[0.75rem] leading-[1.4]",
              item.steer.status === "injected" || item.steer.status === "applied"
                ? "text-ios-green"
                : item.steer.status === "aborted" || item.steer.status === "failed"
                  ? "text-ios-red/80"
                  : item.steer.status === "uncertain"
                    ? // D2b：未确认既不是成功也不是失败（橙＝需要注意的未知），
                      // 文案「未确认（未重送）」承担全部语义，颜色只做视觉分级。
                      "text-ios-orange"
                    : "text-foreground/45",
            )}
          >
            <Navigation className="h-3 w-3 shrink-0" aria-hidden="true" />
            {steerStatusLabel(item.steer.status, item.steer.position)}
          </span>
        ) : null}
        {/* 附件卡（罪状 1）：只在解析出附件时渲染，纯文本消息零开销。 */}
        {hasAttachments && <AgentAttachmentCards refs={userParsed.refs} sessionId={sessionId} />}
        {/* 串流中的打字光标。纯视觉提示，屏读器宣告由 AgentChatPanel 的
            role="status" 区域负责。
            2026-09-20 修：僅在有「可讀正文」時渲染——模型首個 delta 常常只是
            "\n" 或空白，舊條件（length > 0）照樣放行，畫面上就是一個孤零零的
            游標在奇怪的位置閃；改看 trim() 後長度，白字元撐不出游標。 */}
        {item.kind === "assistant" && item.streaming && displayText.trim().length > 0 && (
          <span
            className="agent-caret"
            aria-hidden="true"
            style={{
              // 游標不破行：0 寬 inline-block 永不觸發換行，改用 outline 畫出 2px 游標，
              // 緊貼最後一個字——長串流中游標不會孤零零掉去下一行行首。
              width: 0,
              marginLeft: 0,
              background: "transparent",
              outline: "2px solid currentColor",
              outlineOffset: 0,
              ...(reducedMotion ? { animation: "none" } : {}),
            }}
          />
        )}
      </div>
    </div>
  );
}

export const AgentMessageBubble = memo(AgentMessageBubbleComponent);
