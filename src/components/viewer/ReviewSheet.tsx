"use client";

// 赏阅评审面板：看 → 指出哪一处不对 → 整理成助理能逐处执行的一段话。
// 交互语义移植自 eval-av-agent-bench/scripts/lyric-align/player/index.html 的「标记」面板
// （范围快照 → 标签 chips → 备注 → 保存 → 列表 → 复制给助理 / 发回），
// 但标签、措辞、存取全部改走 src/lib/viewer/review.ts，所以音/视/图/文/3D 的反馈长得一样。
// 本档不认识任何种类：「此刻指在哪」永远问 controller.capture()，「跳过去」永远问 controller.reveal()。

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Copy, Flag, Repeat, Send, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TAGS_BY_KIND,
  composeFeedback,
  describeLocator,
  loadAnnotations,
  newAnnotation,
  saveAnnotations,
  tagDefsFor,
} from "@/lib/viewer/review";
import type { Annotation, Locator, ViewAsset, ViewerActions, ViewerController } from "@/lib/viewer/types";

/* ---------- 标记存取 hook ---------- */

export interface AnnotationsApi {
  annotations: readonly Annotation[];
  add(locator: Locator, tags: string[], note?: string, excerpt?: string): Annotation;
  remove(id: string): void;
  clear(): void;
}

const EMPTY: readonly Annotation[] = Object.freeze([]);

/**
 * 模块级共享：同一件成品可能同时被内嵌 Viewer 和全屏 Viewer 持有，写一边另一边要立刻看到。
 * mem 兜底：localStorage 不可用（隐私模式/配额）时标记仍在本页会话里有效，不静默丢。
 */
const mem = new Map<string, Annotation[]>();
const listeners = new Set<(assetId: string) => void>();

function readList(assetId: string): Annotation[] {
  const hit = mem.get(assetId);
  if (hit) return hit;
  const fresh = loadAnnotations(assetId);
  mem.set(assetId, fresh);
  return fresh;
}

function writeList(assetId: string, list: Annotation[]): void {
  mem.set(assetId, list);
  saveAnnotations(assetId, list);
  listeners.forEach((fn) => fn(assetId));
}

export function useAnnotations(assetId: string): AnnotationsApi {
  const [state, setState] = useState<{ id: string; list: readonly Annotation[] } | null>(null);

  useEffect(() => {
    setState({ id: assetId, list: readList(assetId) });
    const onChange = (changed: string) => {
      if (changed === assetId) setState({ id: assetId, list: readList(assetId) });
    };
    listeners.add(onChange);
    // 另一个分页/另一个窗口改了同一份存储。
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.endsWith(assetId)) {
        mem.delete(assetId);
        setState({ id: assetId, list: readList(assetId) });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [assetId]);

  const add = useCallback<AnnotationsApi["add"]>(
    (locator, tags, note, excerpt) => {
      const a = newAnnotation(assetId, locator, tags, note, excerpt);
      writeList(assetId, [...readList(assetId), a]);
      return a;
    },
    [assetId],
  );
  const remove = useCallback((id: string) => {
    writeList(
      assetId,
      readList(assetId).filter((a) => a.id !== id),
    );
  }, [assetId]);
  const clear = useCallback(() => writeList(assetId, []), [assetId]);

  return {
    annotations: state && state.id === assetId ? state.list : EMPTY,
    add,
    remove,
    clear,
  };
}

/* ---------- 复制 / 回流 ---------- */

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
}

function findHost(): Window | null {
  if (typeof window === "undefined") return null;
  if (window.opener && window.opener !== window) return window.opener as Window;
  if (window.parent !== window) return window.parent;
  return null;
}

/* ---------- 面板 ---------- */

export interface ReviewSheetProps {
  asset: ViewAsset;
  review: AnnotationsApi;
  controllerRef: { current: ViewerController | null };
  actions?: ViewerActions;
  open: boolean;
  onClose(): void;
  /** 面板已开时适配器再次请求标记（F 键）：数值变化＝重新抓一次此刻。 */
  recaptureKey?: number;
}

interface Draft {
  locator: Locator;
  excerpt?: string;
}

function captureDraft(controller: ViewerController | null): Draft {
  if (!controller) return { locator: { t: "whole" } };
  try {
    const { locator, excerpt } = controller.capture();
    return { locator, ...(excerpt ? { excerpt } : {}) };
  } catch {
    return { locator: { t: "whole" } };
  }
}

export function ReviewSheet({ asset, review, controllerRef, actions, open, onClose, recaptureKey }: ReviewSheetProps) {
  const { annotations } = review;
  const tags = TAGS_BY_KIND[asset.kind];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pointOnly, setPointOnly] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [host, setHost] = useState<Window | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  useEffect(() => setHost(findHost()), []);

  const startDraft = useCallback(() => {
    setDraft(captureDraft(controllerRef.current));
    setPointOnly(false);
    setChosen([]);
    setNote("");
  }, [controllerRef]);

  // 打开（含 F 键触发）即抓一次快照；换件则清掉旧草稿。
  useEffect(() => {
    if (open) startDraft();
    else setDraft(null);
  }, [open, asset.id, startDraft, recaptureKey]);

  const effectiveLocator: Locator | null = useMemo(() => {
    if (!draft) return null;
    const loc = draft.locator;
    return pointOnly && loc.t === "time" ? { t: "time", a: loc.a } : loc;
  }, [draft, pointOnly]);

  const feedback = useMemo(() => composeFeedback(asset, annotations), [asset, annotations]);
  const hasMarks = annotations.length > 0;
  const canSendToChat = !!actions?.onSendFeedback;
  const canPostMessage = !canSendToChat && !!host;

  const toggleTag = (id: string) =>
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = () => {
    if (!effectiveLocator) return;
    review.add(effectiveLocator, [...chosen], note, draft?.excerpt);
    say(`已标记 ${describeLocator(effectiveLocator)}`);
    setDraft(null);
    setChosen([]);
    setNote("");
  };

  const loopRange = (() => {
    if (!effectiveLocator || effectiveLocator.t !== "time" || !controllerRef.current?.loop) return null;
    const { a, b } = effectiveLocator;
    // 点标记没有区间时取前 3 秒后 5 秒（与原播放器同语义）。
    return b != null ? { a, b } : { a: Math.max(0, a - 3), b: a + 5 };
  })();

  const doLoop = () => {
    if (!loopRange) return;
    controllerRef.current?.loop?.(loopRange);
    controllerRef.current?.reveal({ t: "time", a: loopRange.a });
    controllerRef.current?.play?.();
    say(`循环试听 ${describeLocator({ t: "time", a: loopRange.a, b: loopRange.b })}`);
  };

  const doCopy = async () => {
    if (!hasMarks) return;
    say((await copyText(feedback)) ? "已复制，回到对话粘贴发送即可" : "复制失败，请手动选择文字");
  };

  const doSend = () => {
    if (!hasMarks) return;
    if (actions?.onSendFeedback) {
      actions.onSendFeedback(feedback, annotations, asset);
      say("已填入助理输入框，确认后请自己点发送");
      return;
    }
    if (!host) return;
    try {
      host.postMessage(
        {
          type: "eimu-viewer:feedback",
          text: feedback,
          annotations,
          asset: { id: asset.id, url: asset.url, title: asset.title },
        },
        "*",
      );
      say("已发给助理");
    } catch {
      say("发送失败，请用「复制给助理」");
    }
  };

  // 面板内的按键只在面板内处理，不漏给适配器（输入备注时空格/字母不能触发播放等快捷键）。
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Tab 要放行给外层的焦点陷阱，否则键盘用户会从面板里 Tab 出全屏层。
    if (e.key === "Tab") return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  const rangeIsTime = draft?.locator.t === "time" && draft.locator.b != null;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="评审标记"
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-30 flex flex-col border-white/10 bg-[rgba(16,18,26,0.97)] text-white shadow-[0_-12px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl",
        "inset-x-0 bottom-0 max-h-[82dvh] rounded-t-2xl border-t",
        "md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[380px] md:rounded-none md:border-l md:border-t-0",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-2 md:pt-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Flag className="h-4 w-4 text-white/70" aria-hidden="true" />
          评审标记
          {hasMarks && <span className="text-[13px] font-normal text-white/60">已标 {annotations.length} 处</span>}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起评审面板"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] [overscroll-behavior:contain]">
        {/* 新标记 */}
        {draft && effectiveLocator ? (
          <section aria-label="新标记" className="border-b border-white/10 pb-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <b className="text-[20px] font-semibold tabular-nums">{describeLocator(effectiveLocator)}</b>
              {draft.excerpt && <span className="text-[13px] text-white/60">「{draft.excerpt}」</span>}
            </div>
            {rangeIsTime && (
              <div role="group" aria-label="标记范围" className="mt-2.5 inline-flex rounded-full border border-white/15 p-0.5">
                {[
                  { id: false, label: "整段" },
                  { id: true, label: "此刻" },
                ].map((opt) => (
                  <button
                    key={String(opt.id)}
                    type="button"
                    aria-pressed={pointOnly === opt.id}
                    onClick={() => setPointOnly(opt.id)}
                    className={cn(
                      "min-h-11 rounded-full px-4 text-[13px] [touch-action:manipulation]",
                      pointOnly === opt.id ? "bg-white/20 text-white" : "text-white/60 hover:text-white",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <div role="group" aria-label="问题标签" className="mt-3 flex flex-wrap gap-2">
              {tags.map((t) => {
                const on = chosen.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleTag(t.id)}
                    className={cn(
                      "min-h-11 rounded-full border px-3.5 text-[14px] [touch-action:manipulation] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                      on
                        ? t.good
                          ? "border-emerald-400/70 bg-emerald-500/20 text-white"
                          : "border-red-400/70 bg-red-500/20 text-white"
                        : "border-white/15 text-white/85 hover:bg-white/10",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={120}
              placeholder="补一句想法（可选）"
              aria-label="补充说明"
              autoComplete="off"
              className="mt-3 min-h-11 w-full rounded-xl border border-white/15 bg-white/[0.07] px-3 text-[14px] text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
            />
            <div className="mt-3 flex gap-2.5">
              {loopRange && (
                <button
                  type="button"
                  onClick={doLoop}
                  className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/15 text-[14px] font-semibold hover:bg-white/10 [touch-action:manipulation]"
                >
                  <Repeat className="h-4 w-4" aria-hidden="true" />
                  循环试听这段
                </button>
              )}
              <button
                type="button"
                onClick={save}
                className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-ios-blue text-[14px] font-semibold text-white hover:bg-ios-blue/90 [touch-action:manipulation]"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                保存标记
              </button>
            </div>
          </section>
        ) : (
          <div className="border-b border-white/10 py-4">
            <button
              type="button"
              onClick={startDraft}
              className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-ios-blue text-[14px] font-semibold text-white hover:bg-ios-blue/90 [touch-action:manipulation]"
            >
              <Flag className="h-4 w-4" aria-hidden="true" />
              标记此刻
            </button>
          </div>
        )}

        {/* 已有标记 */}
        {hasMarks ? (
          <ul aria-label="本件已有标记" className="mt-1">
            {annotations.map((a) => {
              const reasons = [...tagDefsFor(asset.kind, a.tags).map((t) => t.label), ...(a.note ? [a.note] : [])];
              const goodOnly = a.tags.length > 0 && tagDefsFor(asset.kind, a.tags).every((t) => t.good);
              return (
                <li key={a.id} className="flex items-start gap-2 border-b border-white/10 py-1.5">
                  <button
                    type="button"
                    onClick={() => controllerRef.current?.reveal(a.locator)}
                    aria-label={`跳到 ${describeLocator(a.locator)}`}
                    className={cn(
                      "min-h-11 min-w-[84px] shrink-0 text-left text-[13px] font-semibold tabular-nums [touch-action:manipulation]",
                      goodOnly ? "text-emerald-300" : "text-red-300",
                    )}
                  >
                    {describeLocator(a.locator)}
                  </button>
                  <div className="min-w-0 flex-1 py-3 text-[13px] text-white/85">
                    {reasons.join("；") || "（未写原因）"}
                    {a.excerpt && <i className="mt-0.5 block not-italic text-white/50">「{a.excerpt}」</i>}
                  </div>
                  <button
                    type="button"
                    onClick={() => review.remove(a.id)}
                    aria-label={`删除标记 ${describeLocator(a.locator)}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white [touch-action:manipulation]"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-[13px] text-white/60">
            看到哪里不对，就在那里标一下；攒几处后一次交给助理，它会逐处改，没标的地方不动。
          </p>
        )}

        {/* 回流 */}
        <div className="mt-4 flex gap-2.5">
          <button
            type="button"
            onClick={() => void doCopy()}
            disabled={!hasMarks}
            className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/20 text-[14px] font-semibold hover:bg-white/10 disabled:opacity-40 [touch-action:manipulation]"
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            复制给助理
          </button>
          {(canSendToChat || canPostMessage) && (
            <button
              type="button"
              onClick={doSend}
              disabled={!hasMarks}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-ios-blue text-[14px] font-semibold text-white hover:bg-ios-blue/90 disabled:opacity-40 [touch-action:manipulation]"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              发给助理
            </button>
          )}
        </div>
        <p className="mt-2.5 text-[13px] text-white/50">
          {canSendToChat
            ? "「发给助理」只会预填输入框，不会自动送出，也不会替你花钱。"
            : "复制后回到对话粘贴发送即可。"}
        </p>
        <p role="status" aria-live="polite" className="mt-1 min-h-[1.25rem] text-[13px] text-emerald-300">
          {notice}
        </p>
      </div>
    </aside>
  );
}
