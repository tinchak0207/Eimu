"use client";

// 赏阅 · 文本适配器：阅读器 + 选中即标记。
//
// 偏移口径：Locator span 的 from/to 是相对「渲染出来的纯文本」（阅读区 textContent）的字符偏移——
// markdown 的 ** # - 等记号不计入，和用户眼睛看到的字一一对应；excerpt 同口径取自选区原文（截断 60 字）。
// 已有标记 / reveal 的高亮走 CSS Custom Highlight API，不改 DOM（不与 React 抢节点）。

import {
  Component,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Flag } from "lucide-react";
import { AgentMarkdown } from "@/components/agent-chat/AgentMarkdown";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";

/* ---------------------------------------------------------------- 纯逻辑 */

const EXCERPT_MAX = 60;

interface SelSnapshot {
  from: number;
  to: number;
  excerpt: string;
}

function makeExcerpt(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > EXCERPT_MAX ? s.slice(0, EXCERPT_MAX) + "…" : s;
}

/** Range → 相对 root 纯文本的字符偏移。 */
function offsetsOf(root: Node, range: Range): { from: number; to: number } {
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const from = pre.toString().length;
  return { from, to: from + range.toString().length };
}

/** 纯文本偏移 → Range（跨多个文本节点）。越界会被夹到末尾；空区间返回 null。 */
function rangeFromOffsets(root: Node, from: number, to: number): Range | null {
  if (!(to > from) || from < 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let sNode: Text | null = null;
  let sOff = 0;
  let eNode: Text | null = null;
  let eOff = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const len = t.data.length;
    if (!sNode && from < pos + len) {
      sNode = t;
      sOff = from - pos;
    }
    if (sNode && to <= pos + len) {
      eNode = t;
      eOff = to - pos;
      break;
    }
    pos += len;
    if (sNode) {
      eNode = t;
      eOff = len;
    }
  }
  if (!sNode || !eNode) return null;
  const r = document.createRange();
  r.setStart(sNode, sOff);
  r.setEnd(eNode, eOff);
  return r;
}

/** 点击处的纯文本偏移（不同浏览器的 caret API 名字不同）。 */
function offsetAtPoint(root: Node, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let off = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      off = p.offset;
    }
  } else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      off = r.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(node, off);
  return pre.toString().length;
}

/* CSS Custom Highlight API：用 globalThis 取，避免依赖 lib.dom 版本。 */
interface HighlightRegistryLike {
  set(name: string, h: unknown): unknown;
  delete(name: string): unknown;
}
function highlightRegistry(): HighlightRegistryLike | null {
  const c = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return c?.highlights ?? null;
}
function setHighlight(name: string, ranges: Range[]) {
  const reg = highlightRegistry();
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg) return;
  if (!H || !ranges.length) {
    reg.delete(name);
    return;
  }
  reg.set(name, new H(...ranges));
}

/* ---------------------------------------------------------------- Markdown 兜底 */

/** AgentMarkdown 抛错时退化成纯文本阅读，绝不白屏。 */
class ReaderBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { text: string }) {
    if (this.state.failed && prev.text !== this.props.text) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <div className="whitespace-pre-wrap break-words">{this.props.text}</div> : this.props.children;
  }
}

/* ---------------------------------------------------------------- 组件 */

export default function TextSurface(props: ViewerSurfaceProps) {
  return <TextSurfaceInner key={props.asset.id} {...props} />;
}

function TextSurfaceInner({ asset, density, annotations, controllerRef, onRequestMark, active }: ViewerSurfaceProps) {
  const full = density === "full";
  const hid = "eimu-tx-" + useId().replace(/[^a-zA-Z0-9]/g, "");

  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastSelRef = useRef<SelSnapshot | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ onRequestMark, annotations });
  live.current = { onRequestMark, annotations };

  const inlineText = asset.text && asset.text.length > 0 ? asset.text : null;
  const [fetched, setFetched] = useState<string | null>(null);
  const [loading, setLoading] = useState(!inlineText && !!asset.url);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [btn, setBtn] = useState<{ top: number; left: number } | null>(null);
  const [more, setMore] = useState(false);

  const text = inlineText ?? fetched;

  /* ---- 取正文：asset.text 优先，否则 fetch(asset.url) ---- */
  useEffect(() => {
    if (inlineText || !asset.url) return;
    const ac = new AbortController();
    setLoading(true);
    setFailed(false);
    fetch(asset.url, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("http " + r.status);
        return r.text();
      })
      .then((t) => {
        setFetched(t);
        setLoading(false);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setFailed(true);
        setLoading(false);
      });
    return () => ac.abort();
  }, [inlineText, asset.url, nonce]);

  /* ---- 已有 span 标记 → 高亮底色（不改 DOM） ---- */
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !active || !text) {
      setHighlight(`${hid}-m`, []);
      setHighlight(`${hid}-g`, []);
      return;
    }
    const plain: Range[] = [];
    const good: Range[] = [];
    for (const a of annotations) {
      if (a.locator.t !== "span") continue;
      const r = rangeFromOffsets(root, a.locator.from, a.locator.to);
      if (r) (a.tags.includes("best") ? good : plain).push(r);
    }
    setHighlight(`${hid}-m`, plain);
    setHighlight(`${hid}-g`, good);
    return () => {
      setHighlight(`${hid}-m`, []);
      setHighlight(`${hid}-g`, []);
    };
  }, [annotations, text, active, hid]);

  useEffect(
    () => () => {
      setHighlight(`${hid}-r`, []);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    },
    [hid],
  );

  /* ---- 选区 → 浮出「标记」 ---- */
  useEffect(() => {
    if (!active) {
      setBtn(null);
      return;
    }
    const onSel = () => {
      const root = contentRef.current;
      const wrap = wrapRef.current;
      const sel = document.getSelection();
      if (!root || !wrap || !sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      const inside = root.contains(r.startContainer) && root.contains(r.endContainer);
      if (sel.isCollapsed) {
        // 在正文里点了一下＝放弃原选区；点到别处（如标记面板、浮钮本身）则保留，免得吞掉标记。
        if (inside) {
          lastSelRef.current = null;
          setBtn(null);
        }
        return;
      }
      if (!inside) return;
      const { from, to } = offsetsOf(root, r);
      const raw = (root.textContent ?? "").slice(from, to);
      if (!raw.trim()) return;
      lastSelRef.current = { from, to, excerpt: makeExcerpt(raw) };
      const rect = r.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;
      const above = rect.top - wr.top - 52;
      const top = coarse || above < 0 ? rect.bottom - wr.top + 10 : above;
      const left = Math.max(0, Math.min(wr.width - 96, rect.left - wr.left + rect.width / 2 - 48));
      setBtn({ top, left });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [active]);

  /* ---- 渐隐：inline 内容还能往下滚时才显示 ---- */
  const measure = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    setMore(sc.scrollHeight - sc.clientHeight - sc.scrollTop > 6);
  }, []);
  useEffect(() => {
    if (full) return;
    measure();
    const sc = scrollRef.current;
    if (!sc || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [full, measure, text]);

  /* ---- F 键标记（仅 full；输入框里不抢） ---- */
  useEffect(() => {
    if (!full || !active) return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tg = e.target instanceof HTMLElement ? e.target : null;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        live.current.onRequestMark();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [full, active]);

  /* ---- 发布 controller ---- */
  useEffect(() => {
    const ctl: ViewerController = {
      capture() {
        const s = lastSelRef.current;
        if (!s) return { locator: { t: "whole" } };
        return { locator: { t: "span", from: s.from, to: s.to }, excerpt: s.excerpt };
      },
      reveal(loc: Locator) {
        const root = contentRef.current;
        const sc = scrollRef.current;
        if (loc.t !== "span" || !root || !sc) return;
        const r = rangeFromOffsets(root, loc.from, loc.to);
        if (!r) return;
        const rect = r.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        sc.scrollTo({ top: sc.scrollTop + (rect.top - sr.top) - sc.clientHeight / 3, behavior: "smooth" });
        if (highlightRegistry()) {
          setHighlight(`${hid}-r`, [r]);
          if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
          revealTimerRef.current = setTimeout(() => setHighlight(`${hid}-r`, []), 2600);
        } else {
          // 无 Highlight API：用原生选区代替高亮。
          const sel = document.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(r);
        }
      },
    };
    controllerRef.current = ctl;
    return () => {
      if (controllerRef.current === ctl) controllerRef.current = null;
    };
  }, [controllerRef, hid]);

  /* ---- 点已有标记＝选中它的位置 ---- */
  const onContentClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const root = contentRef.current;
    const sel = document.getSelection();
    if (!root || !sel || !sel.isCollapsed) return;
    const off = offsetAtPoint(root, e.clientX, e.clientY);
    if (off == null) return;
    for (const a of live.current.annotations) {
      const l = a.locator;
      if (l.t === "span" && off >= l.from && off < l.to) {
        const r = rangeFromOffsets(root, l.from, l.to);
        if (r) {
          sel.removeAllRanges();
          sel.addRange(r);
        }
        return;
      }
    }
  };

  /* ---------------------------------------------------------------- 渲染 */

  const body = text ? (
    <ReaderBoundary text={text}>
      <AgentMarkdown text={text} />
    </ReaderBoundary>
  ) : null;

  const typo = full
    ? "text-[18px] leading-[1.85]"
    : "text-[16px] leading-[1.75]";
  // AgentMarkdown 的段落 / 标题为聊天气泡尺寸：在阅读器里统一放大并加行距。
  const mdTune =
    "[&_p]:my-[0.8em] [&_p.agent-turn-title]:mt-[1.4em] [&_p.agent-turn-title]:text-[1.45em] [&_p.agent-turn-title]:leading-[1.4] " +
    "[&_p.agent-turn-text]:mt-[1.2em] [&_p.agent-turn-text]:text-[1.2em] [&_p.agent-turn-text]:leading-[1.5] " +
    "[&_ol]:my-[0.8em] [&_ul]:my-[0.8em] [&_li]:leading-[1.75]";

  const content = (
    <div ref={wrapRef} className="relative">
      <div
        ref={contentRef}
        onClick={onContentClick}
        className={`select-text break-words text-foreground ${typo} ${mdTune}`}
      >
        {body}
      </div>
      {btn && (
        <button
          type="button"
          // 按下时别让正文失去选区（鼠标）；触屏上选区即使被收起，lastSel 仍在。
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            live.current.onRequestMark();
            setBtn(null);
          }}
          className="absolute z-10 flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full bg-neutral-900 px-4 text-[13px] font-semibold text-white shadow-lg active:opacity-80"
          style={{ top: btn.top, left: btn.left }}
        >
          <Flag className="h-4 w-4" aria-hidden />
          标记
        </button>
      )}
    </div>
  );

  const state = loading ? (
    <div className="space-y-3 py-2" aria-busy="true" aria-label="正在加载">
      <div className="h-4 w-3/4 animate-pulse rounded bg-black/[0.06]" />
      <div className="h-4 w-full animate-pulse rounded bg-black/[0.06]" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-black/[0.06]" />
    </div>
  ) : failed ? (
    <div role="alert" className="flex flex-col items-center gap-2 py-6 text-center text-[15px] text-foreground/65">
      <span>文字加载失败，可能是网络波动</span>
      <button
        type="button"
        onClick={() => setNonce((n) => n + 1)}
        className="min-h-11 touch-manipulation rounded-full border border-black/15 px-5 text-foreground active:opacity-70"
      >
        重试
      </button>
    </div>
  ) : !text ? (
    <p className="py-6 text-center text-[15px] text-foreground/55">没有可阅读的文字内容</p>
  ) : null;

  const highlightCss = (
    <style>{`::highlight(${hid}-m){background-color:rgba(255,210,74,.5);color:inherit}::highlight(${hid}-g){background-color:rgba(52,199,89,.35);color:inherit}::highlight(${hid}-r){background-color:rgba(236,65,65,.35);color:inherit}`}</style>
  );

  if (full) {
    return (
      <div ref={scrollRef} className="h-full min-h-0 w-full overflow-y-auto overscroll-contain bg-[#0a0a0a] px-3 py-5 min-[900px]:px-6 min-[900px]:py-10">
        {highlightCss}
        <article className="mx-auto box-content max-w-[72ch] rounded-2xl bg-white px-5 py-8 shadow-[0_24px_60px_rgba(0,0,0,.45)] min-[900px]:px-12 min-[900px]:py-14">
          {state ?? content}
        </article>
      </div>
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-black/[0.08] bg-white">
      {highlightCss}
      <div ref={scrollRef} onScroll={measure} className="max-h-72 overflow-y-auto overscroll-contain px-4 py-3">
        {state ?? content}
      </div>
      {more && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" />}
    </div>
  );
}
