"use client";

import { memo, useEffect, useRef, useState } from "react";
import { HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPendingQuestion } from "@/lib/agent-chat-types";
import { INPUT_CLASS } from "./MySkillsDialog";

export interface AgentQuestionCardProps {
  question: AgentPendingQuestion;
  /** 選中的標籤，依題目順序組成 string[][]，對齊 opencode /question/{que_*}/reply。 */
  onAnswer: (requestId: string, answers: string[][]) => Promise<boolean | void>;
}

/**
 * 提交一次答案：await onAnswer，失败（reject）或明确返回 false 时解锁 busy；
 * 成功（true/undefined）保持 busy——卡片随后由父层在 reducer 收到答案后移除。
 * 抽成纯函数，供 node --test 用 deferred promise 断言双击防护实际生效
 * （第二次点击在第一次 resolve 前必须被 busy 挡掉，不重复调用 onAnswer）。
 */
export async function submitQuestionAnswer(
  onAnswer: (requestId: string, answers: string[][]) => Promise<boolean | void>,
  requestId: string,
  answers: string[][],
  setBusy: (value: boolean) => void,
): Promise<void> {
  try {
    const ok = await onAnswer(requestId, answers);
    if (ok === false) setBusy(false);
  } catch {
    setBusy(false);
  }
}

/**
 * 清單列語彙（AgentToolCard / AgentSubagentBar 家族，2026-10-03 對版）：
 * 無底色、hover 只換白玻璃底、`rounded-[12px]`、`min-h-12` 保 44px 觸摸靶；
 * hover 只換色不位移（transition-colors）。選中態另加 `bg-ios-blue/[0.10]` + ring。
 */
const OPTION_ROW_CLASS = cn(
  "flex min-h-12 w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left",
  "transition-colors duration-150 hover:bg-white/55",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30",
  "disabled:cursor-wait disabled:opacity-60",
  "touch-manipulation [-webkit-tap-highlight-color:transparent]",
);

/**
 * 主鈕 / 幽靈次鈕：逐字對齊 AgentConfirmCard 已定案語彙（2026-09-20），
 * 不各寫一份——問答卡的「明白，继续」「提交」＝主鈕，「重新说明」「取消」＝幽靈次鈕。
 */
const PRIMARY_BUTTON_CLASS = cn(
  "flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-[#2d3142] px-5 text-ios-footnote font-medium text-white",
  "shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-95",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
  "disabled:cursor-not-allowed disabled:bg-[#2d3142]/60 disabled:shadow-none disabled:active:translate-y-0 disabled:active:scale-100",
  "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
);

const GHOST_BUTTON_CLASS = cn(
  "flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-ios-footnote font-medium",
  "text-muted-foreground transition-all duration-200 hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
);

function AgentQuestionCardComponent({ question, onAnswer }: AgentQuestionCardProps) {
  const { requestId, questions } = question;
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  // 被点中的选项：那颗按钮转圈 + 高亮，不是无声消失，也不让连点送两次。
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  // 每題已選的答案（本地暫存）：最後一題點完才一次提交完整 answers。
  // 一次只顯示一題——不再把多個問題疊在同一張卡裡（用戶 2026-08-15 指正）。
  const picksRef = useRef<string[]>([]);
  // 罪状 5：正常分支也要有可自由输入的「其他…」口——选项清单锁死时，
  // 想说的话说不出去，用户只能硬选一个不想要的答案。
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (otherOpen) otherInputRef.current?.focus();
  }, [otherOpen]);

  const item = questions[current];
  if (!item) return null;

  // 2026-08-26 容错：模型偶尔不给 options（把用户修改需求整段塞进 question，
  // 无选项可点）。此时渲染成「确认式」卡：一句「明白，按这个来」把原文回给
  // agent（answers 传 [question] 让它拿到完整文本），不再是点无可点的空壳。
  const noOptions = item.options.length === 0;
  if (noOptions) {
    return (
      <div className="agent-rise lg-sheet relative overflow-hidden rounded-[20px] p-4">
        {/* 顶缘 specular 亮线：与 AgentConfirmCard / MASTER.md〈Specular Highlight Pattern〉同配方。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
        />
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ios-blue/[0.12] text-ios-blue">
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            {item.header && (
              <p className="text-ios-footnote font-medium text-muted-foreground">{item.header}</p>
            )}
            <p className="text-ios-subhead font-semibold leading-[1.5] break-words text-foreground [overflow-wrap:anywhere]">
              {item.question}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void submitQuestionAnswer(onAnswer, requestId, questions.map(() => []), setBusy);
            }}
            disabled={busy}
            className={GHOST_BUTTON_CLASS}
          >
            重新说明
          </button>
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void submitQuestionAnswer(
                onAnswer,
                requestId,
                questions.map((q) => [q.question]),
                setBusy,
              );
            }}
            disabled={busy}
            className={PRIMARY_BUTTON_CLASS}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            明白，继续
          </button>
        </div>
      </div>
    );
  }

  const pick = async (label: string): Promise<void> => {
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
        // 「其他…」的输入状态随题切换收起，不带进下一题。
        setOtherOpen(false);
        setOtherText("");
      }, 250);
      return;
    }
    // 最後一題：提交全部題目的答案（對齊 opencode answers 契約）
    const answers = questions.map((_, i) =>
      picksRef.current[i] ? [picksRef.current[i]] : [],
    );
    await submitQuestionAnswer(onAnswer, requestId, answers, setBusy);
  };

  return (
    <div
      className="agent-rise lg-sheet relative overflow-hidden rounded-[20px] p-4"
      aria-busy={busy}
    >
      {/* 顶缘 specular 亮线：与 AgentConfirmCard / MASTER.md〈Specular Highlight Pattern〉同配方。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
      />
      <div key={`${requestId}-${current}`}>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ios-blue/[0.12] text-ios-blue">
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            {item.header && (
              <p className="text-ios-footnote font-medium text-muted-foreground">{item.header}</p>
            )}
            <p className="text-ios-subhead font-semibold leading-[1.5] break-words text-foreground [overflow-wrap:anywhere]">
              {item.question}
            </p>
            {questions.length > 1 && (
              <p className="mt-0.5 text-ios-footnote text-muted-foreground">
                {current + 1} / {questions.length}
              </p>
            )}
          </div>
        </div>
        {/* 选项是整行可点的清单项，不是一排无声的小胶囊：点下去有高亮 + 转圈回馈。
            2026-09-20 截斷修復：label/description 都要 break-words——模型吐出的
            選項文字可能是長英文串，白名單式 truncate 在問答卡語義裡是「藏答案」。
            2026-10-03 語彙對版：改用站內清單列（白玻璃 hover、rounded-[12px]），
            不再讓每一列都鋪一層藍底。 */}
        <div className="mt-3 flex flex-col gap-2">
          {item.options.map((opt) => {
            const isPicked = pickedLabel === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                disabled={busy}
                onClick={() => void pick(opt.label)}
                className={cn(
                  OPTION_ROW_CLASS,
                  isPicked && "bg-ios-blue/[0.10] ring-1 ring-ios-blue/35",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-ios-subhead font-semibold text-foreground [overflow-wrap:anywhere]">{opt.label}</span>
                  {opt.description && (
                    <span className="mt-0.5 block break-words text-sm leading-[1.5] text-foreground/60 [overflow-wrap:anywhere]">
                      {opt.description}
                    </span>
                  )}
                </span>
                {isPicked && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ios-blue" aria-hidden="true" />
                )}
              </button>
            );
          })}
          {/* 罪状 5：选项之外的自由输入口。收起时是与选项同款但弱化的一行；
              展开后 textarea + 提交，空文本禁用，busy 防连点。提交走 pick
              同一条路径（answers[current] = [输入文本]），多题流程不另开岔路。 */}
          {otherOpen ? (
            <div className="rounded-[12px] bg-black/[0.03] p-2.5">
              <textarea
                ref={otherInputRef}
                value={otherText}
                onChange={(event) => setOtherText(event.target.value)}
                disabled={busy}
                rows={3}
                maxLength={2000}
                placeholder="输入你的答案…"
                aria-label="其他答案"
                className={cn(
                  INPUT_CLASS,
                  "min-h-0 resize-none text-ios-footnote leading-[1.5] [overflow-wrap:anywhere] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 disabled:opacity-60",
                )}
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOtherOpen(false);
                    setOtherText("");
                  }}
                  disabled={busy}
                  className={GHOST_BUTTON_CLASS}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const text = otherText.trim();
                    if (!text || busy) return;
                    pick(text);
                  }}
                  disabled={busy || otherText.trim().length === 0}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  提交
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setOtherOpen(true)}
              className={OPTION_ROW_CLASS}
            >
              <span className="min-w-0 flex-1 text-ios-subhead font-medium text-muted-foreground">
                其他…
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const AgentQuestionCard = memo(AgentQuestionCardComponent);
