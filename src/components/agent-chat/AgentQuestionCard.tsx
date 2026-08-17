"use client";

import { memo, useRef, useState } from "react";
import { HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPendingQuestion } from "@/lib/agent-chat-types";

export interface AgentQuestionCardProps {
  question: AgentPendingQuestion;
  /** 選中的標籤，依題目順序組成 string[][]，對齊 opencode /question/{que_*}/reply。 */
  onAnswer: (requestId: string, answers: string[][]) => void;
}

function AgentQuestionCardComponent({ question, onAnswer }: AgentQuestionCardProps) {
  const { requestId, questions } = question;
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  // 被点中的选项：那颗按钮转圈 + 高亮，不是无声消失，也不让连点送两次。
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  // 每題已選的答案（本地暫存）：最後一題點完才一次提交完整 answers。
  // 一次只顯示一題——不再把多個問題疊在同一張卡裡（用戶 2026-08-15 指正）。
  const picksRef = useRef<string[]>([]);

  const item = questions[current];
  if (!item) return null;

  const pick = (label: string): void => {
    if (busy) return;
    picksRef.current[current] = label;
    setPickedLabel(label);
    setBusy(true);
    if (current < questions.length - 1) {
      // 還有下一題：短暫回饋後切到下一題
      window.setTimeout(() => {
        setCurrent((c) => c + 1);
        setPickedLabel(null);
        setBusy(false);
      }, 250);
      return;
    }
    // 最後一題：提交全部題目的答案（對齊 opencode answers 契約）
    const answers = questions.map((_, i) =>
      picksRef.current[i] ? [picksRef.current[i]] : [],
    );
    onAnswer(requestId, answers);
  };

  return (
    <div className="agent-rise lg-sheet rounded-ios-2xl p-3.5" aria-busy={busy}>
      <div key={`${requestId}-${current}`}>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.12)] text-[#007AFF]">
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            {item.header && (
              <p className="text-sm font-medium text-[rgba(0,0,0,0.42)]">{item.header}</p>
            )}
            <p className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">{item.question}</p>
            {questions.length > 1 && (
              <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.32)]">
                {current + 1} / {questions.length}
              </p>
            )}
          </div>
        </div>
        {/* 选项是整行可点的清单项，不是一排无声的小胶囊：点下去有高亮 + 转圈回馈。 */}
        <div className="mt-3 flex flex-col gap-2">
          {item.options.map((opt) => {
            const isPicked = pickedLabel === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                disabled={busy}
                onClick={() => pick(opt.label)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-2.5 rounded-ios-xl px-4 py-2.5 text-left",
                  "bg-[rgba(0,122,255,0.06)] transition-all duration-150 active:scale-[0.99] active:bg-[rgba(0,122,255,0.14)]",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
                  "disabled:cursor-wait disabled:opacity-60",
                  "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                  isPicked && "bg-[rgba(0,122,255,0.12)] ring-1 ring-[rgba(0,122,255,0.35)]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">{opt.label}</span>
                  {opt.description && (
                    <span className="mt-0.5 block text-sm leading-[1.5] text-[rgba(0,0,0,0.52)]">
                      {opt.description}
                    </span>
                  )}
                </span>
                {isPicked && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#007AFF]" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const AgentQuestionCard = memo(AgentQuestionCardComponent);
