"use client";

import { memo, useState } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPendingQuestion } from "@/lib/agent-chat-types";

export interface AgentQuestionCardProps {
  question: AgentPendingQuestion;
  /** 選中的標籤，依題目順序組成 string[][]，對齊 opencode /question/{que_*}/reply。 */
  onAnswer: (requestId: string, answers: string[][]) => void;
}

function AgentQuestionCardComponent({ question, onAnswer }: AgentQuestionCardProps) {
  const { requestId, questions } = question;
  const [busy, setBusy] = useState(false);

  const pick = (questionIndex: number, label: string): void => {
    if (busy) return;
    setBusy(true);
    const answers = questions.map((_, i) => (i === questionIndex ? [label] : []));
    onAnswer(requestId, answers);
  };

  return (
    <div className="agent-rise lg-sheet rounded-ios-2xl p-3.5">
      {questions.map((item, qi) => (
        <div key={`${requestId}-${qi}`} className={qi > 0 ? "mt-3" : undefined}>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.12)] text-[#007AFF]">
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              {item.header && (
                <p className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.40)]">{item.header}</p>
              )}
              <p className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">{item.question}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {item.options.map((opt) => (
              <button
                key={opt.label}
                type="button"
                disabled={busy}
                onClick={() => pick(qi, opt.label)}
                className={cn(
                  "rounded-ios-xl px-3.5 py-2.5 text-left transition-all duration-200",
                  "bg-[rgba(0,122,255,0.06)] hover:bg-[rgba(0,122,255,0.12)]",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
                  "disabled:cursor-wait disabled:opacity-60",
                )}
              >
                <span className="block text-ios-footnote font-semibold text-[rgba(0,0,0,0.82)]">{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-ios-caption1 leading-[1.45] text-[rgba(0,0,0,0.48)]">
                    {opt.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const AgentQuestionCard = memo(AgentQuestionCardComponent);
