"use client";

/**
 * Eimu 聊天里的 OpenUI（生成式 UI）渲染块。
 *
 * 输入是模型产出的 openui-lang DSL（markdown ```openui fence 的正文），
 * 由 @openuidev/react-lang 的 Renderer 客户端求值渲染。流式半截程序由
 * Renderer 自己处理，这里只负责：
 * - Eimu 主题接入（ThemeProvider + openui-eimu.css）
 * - 动作分派（@ToAssistant → onSend、@OpenUrl → 新窗口、其它忽略）
 * - 失败兜底（DSL 过大 / 语句过多 / 求值为空 / 渲染异常 → 可折叠原文）
 * - 部分失败提示（根有效但个别内容被丢弃时，在卡片下方列出原文，不静默丢）
 * - 容错修复（2026-10-18）：交给 Renderer 前先过 repairOpenUISource（别名/模糊
 *   映射、命名参数、按钮错位、补 root；映射不了的组件变成可见的降级 Callout）
 * - 裸 DSL 块（bare）解析失败时退回普通可读文本，而不是折叠原文
 * - 流式期间不显示任何错误/降级 UI，避免半截程序闪烁
 *
 * 不做数据请求、不写 localStorage；表单状态只放 ref（v1 刷新后重置）。
 */
import "@openuidev/react-ui/index.css";
import "@/styles/openui-eimu.css";

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  createParser,
  Renderer,
  type ActionEvent,
  type OpenUIError,
  type ParseResult,
} from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";

import {
  countComponentCalls,
  countOpenUIStatements,
  eimuArgOrder,
  eimuLibrary,
  maxBracketDepth,
  maxReferenceDepth,
} from "@/lib/openui/eimu-library";
import { buildOpenUIActionMessage, safeOpenUrl } from "@/lib/openui/action-message";
import { repairOpenUISource, type RepairNote } from "@/lib/openui/repair";

/** 预检解析器：与 Renderer 同一个 eimuLibrary schema（模块级单例）。 */
const precheckParser = createParser(eimuLibrary.toJSONSchema());

export type AgentOpenUIBlockProps = {
  /** openui-lang 源码（不含 ```openui 围栏） */
  code: string;
  /** LLM 是否仍在输出；流式期间表单交互禁用 */
  isStreaming?: boolean;
  /** @ToAssistant 动作的发送通道（复用聊天面板既有的发送逻辑） */
  onSend?: (text: string) => void;
  /** 由裸 DSL 识别包出的块：失败时退回普通文本。 */
  bare?: boolean;
};

/** 超过这个长度直接降级，避免解析器在超大输入上卡住聊天面板。 */
const MAX_CODE_LENGTH = 40_000;
/** 3000 条 statement 求值约 2.4-2.9s；300 条作为聊天面板的硬闸。 */
const MAX_STATEMENTS = 300;
/** 单条 statement 内联上万个 Tag 约 3s；800 次调用作为硬闸。 */
const MAX_COMPONENT_CALLS = 800;
/**
 * Renderer 在 215 层 ref 链/深括号会抛 RangeError（200 未崩），取安全值 120；
 * ref 链（`a1 = Card([a2]); a2 = Card([a3]); …`）每行括号深度只有 2，靠引用链闸兜住。
 */
const MAX_BRACKET_DEPTH = 120;
const MAX_REFERENCE_DEPTH = 150;
/** 裸 DSL 误判/解析失败：当普通文本显示（与正文段落同样式），用户读得到全部内容。 */
function PlainTextFallback({ code }: { code: string }) {
  return (
    <p className="my-1 whitespace-pre-wrap break-words" data-openui-plain-fallback="">
      {code}
    </p>
  );
}

function RawFallback({
  code,
  errors,
  detail,
  bare,
}: {
  code: string;
  errors?: OpenUIError[];
  /** 渲染异常信息（ErrorBoundary 捕获，非解析器错误）。 */
  detail?: string;
  bare?: boolean;
}) {
  if (bare) return <PlainTextFallback code={code} />;
  return (
    <details
      className="my-1.5 rounded-[10px] border border-black/[0.08] bg-black/[0.03]"
      data-openui-fallback=""
    >
      <summary className="min-h-9 cursor-pointer touch-manipulation select-none px-3 py-1.5 text-[0.75rem] text-foreground/55 [-webkit-tap-highlight-color:transparent]">
        交互界面未能渲染，点此查看原文
      </summary>
      {errors && errors.length > 0 ? (
        <div className="space-y-1 px-3 pb-1 text-[0.75rem] leading-[1.5] text-foreground/60">
          {errors.slice(0, 3).map((error, index) => (
            <p key={`${error.code}-${error.statementId ?? index}`}>
              {error.component ? `${error.component}: ` : ""}
              {error.message}
            </p>
          ))}
        </div>
      ) : detail ? (
        <p className="px-3 pb-1 text-[0.75rem] leading-[1.5] text-foreground/60">{detail}</p>
      ) : null}
      <pre className="overflow-x-auto px-3 pb-2.5 font-mono text-[0.8125rem] leading-[1.6] text-foreground/80">
        <code>{code}</code>
      </pre>
    </details>
  );
}

/** 错误对应的源语句（按 statementId 找 `id = ...` 行），让被丢弃的内容可见。 */
function sourceOf(code: string, statementId?: string): string | null {
  if (!statementId) return null;
  const line = code.split("\n").find((l) => new RegExp(`^\\s*${statementId.replace(/[$]/g, "\\$")}\\s*=`).test(l));
  return line ? line.trim() : null;
}

/** 根有效、但个别语句被丢弃（参数错/类型不符）或组件被降级时的紧凑提示，附原文。 */
function PartialErrors({ errors, code, notes }: { errors: OpenUIError[]; code: string; notes: RepairNote[] }) {
  const unknown = notes.filter((n) => n.kind === "unknown-component" || n.kind === "unknown-arg");
  const total = errors.length + unknown.length;
  return (
    <details
      className="mt-1.5 rounded-[10px] border border-black/[0.06] bg-black/[0.02]"
      data-openui-partial-errors=""
    >
      <summary className="min-h-9 cursor-pointer touch-manipulation select-none px-3 py-1.5 text-[0.75rem] text-foreground/55 [-webkit-tap-highlight-color:transparent]">
        部分内容未能按原样渲染（{total}），点此查看原文
      </summary>
      <div className="space-y-1.5 px-3 pb-2 text-[0.75rem] leading-[1.5] text-foreground/60">
        {unknown.slice(0, 5).map((note, index) => (
          <p key={`n-${index}`}>
            {note.kind === "unknown-component" ? `未识别组件「${note.detail}」，已改为提示块显示其文字` : `未识别参数「${note.detail}」，已忽略`}
          </p>
        ))}
        {errors.slice(0, 5).map((error, index) => {
          const src = sourceOf(code, error.statementId);
          return (
            <div key={`${error.code}-${error.statementId ?? index}`}>
              <p>
                {error.component ? `${error.component}: ` : ""}
                {error.message.length > 160 ? `${error.message.slice(0, 160)}…` : error.message}
              </p>
              {src ? (
                <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[0.75rem] text-foreground/70">
                  {src}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

type BoundaryProps = { code: string; bare?: boolean; children: ReactNode };
type BoundaryState = { failed: boolean; detail?: string };

/** 渲染器抛错时绝不把整个聊天面板打崩；code 变化（流式收齐）后重试一次。 */
class OpenUIRenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 不能只依赖 getDerivedStateFromError：部分 renderer 内部异常会被 React 捕获后
    // 只留下空白，这里把原始错误显示出来。
    console.error("[openui] renderer crashed", error, info.componentStack);
    this.setState({ detail: error?.message || String(error) });
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.failed && prevProps.code !== this.props.code) {
      this.setState({ failed: false, detail: undefined });
    }
  }

  render() {
    if (this.state.failed) {
      return <RawFallback code={this.props.code} detail={this.state.detail} bare={this.props.bare} />;
    }
    return this.props.children;
  }
}

export default function AgentOpenUIBlock({ code: sourceCode, isStreaming, onSend, bare }: AgentOpenUIBlockProps) {
  // 容错修复：合规程序是恒等变换；流式半截尾句原样保留（不会来回跳变）。
  const repair = useMemo(() => {
    try {
      return repairOpenUISource(sourceCode, eimuArgOrder);
    } catch {
      return { code: sourceCode, notes: [] as RepairNote[], changed: false };
    }
  }, [sourceCode]);
  const code = repair.code;
  // 表单状态只保存在 ref：不持久化、不因 state 更新触发父级/自身重渲染。
  const formStateRef = useRef<Record<string, unknown>>({});
  const contentRef = useRef<HTMLDivElement | null>(null);
  const limitWarnedRef = useRef(false);
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const [hasRenderableRoot, setHasRenderableRoot] = useState(false);
  const [renderEmpty, setRenderEmpty] = useState(false);

  const statementCount = useMemo(() => countOpenUIStatements(code), [code]);
  const componentCallCount = useMemo(() => countComponentCalls(code), [code]);
  const bracketDepth = useMemo(() => maxBracketDepth(code), [code]);
  const refDepth = useMemo(() => maxReferenceDepth(code), [code]);

  const tooLarge = code.length > MAX_CODE_LENGTH;
  const tooManyStatements = statementCount > MAX_STATEMENTS;
  const tooManyCalls = componentCallCount > MAX_COMPONENT_CALLS;
  const tooDeep = bracketDepth > MAX_BRACKET_DEPTH;
  const tooDeepRefs = refDepth > MAX_REFERENCE_DEPTH;
  const overLimit = tooLarge || tooManyStatements || tooManyCalls || tooDeep || tooDeepRefs;

  useEffect(() => {
    if (overLimit && !limitWarnedRef.current) {
      limitWarnedRef.current = true;
      console.warn("[openui] program limit exceeded; showing raw fallback", {
        statementCount,
        componentCallCount,
        bracketDepth,
        refDepth,
        codeLength: code.length,
        limits: {
          statements: MAX_STATEMENTS,
          componentCalls: MAX_COMPONENT_CALLS,
          bracketDepth: MAX_BRACKET_DEPTH,
          referenceDepth: MAX_REFERENCE_DEPTH,
          codeLength: MAX_CODE_LENGTH,
        },
      });
    }
  }, [overLimit, statementCount, componentCallCount, bracketDepth, refDepth, code.length]);

  /**
   * 求值为空的检测：解析出 root 但实际什么都没画（循环引用、参数缺失、
   * Renderer 内部吞掉的异常）时也要回落。流式期间不判定（半截程序为空正常）。
   * 只在 code / isStreaming / errors 变化后跑一次，避免 setState 循环。
   */
  useEffect(() => {
    setRenderEmpty(false);
    if (isStreaming || !code.trim()) return;

    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const el = contentRef.current;
      if (!el) return;
      const text = (el.innerText ?? el.textContent ?? "").trim();
      const hasVisual = Boolean(
        el.querySelector(
          'img,video,canvas,svg,table,button,input,textarea,select,hr,[class*="separator"],[class*="divider"],[role="button"],[role="slider"],[role="combobox"]',
        ),
      );
      setRenderEmpty(text.length === 0 && !hasVisual);
    };

    const raf = requestAnimationFrame(measure);
    // Renderer 的查询/表单挂载可能晚一拍，补一次 150ms 的兜底测量。
    const timer = window.setTimeout(measure, 150);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [code, isStreaming, errors]);

  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === "continue_conversation") {
        const message = buildOpenUIActionMessage(event);
        if (message) onSend?.(message);
        return;
      }
      if (event.type === "open_url") {
        const href = safeOpenUrl(event.params?.url);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      // 自定义动作（本库未注册）不在 v1 支持范围：只留调试线索。
      console.debug("[openui] ignored action", event.type, event.params);
    },
    [onSend],
  );

  /** 收齐后的预检：与 Renderer 同 schema；没有 root 直接走降级，不等 DOM 测量。 */
  const precheck = useMemo(() => {
    if (isStreaming) return null;
    try {
      const r = precheckParser.parse(code);
      return { root: Boolean(r.root), errors: r.meta.errors as OpenUIError[] };
    } catch {
      return { root: false, errors: [] as OpenUIError[] };
    }
  }, [code, isStreaming]);

  const handleStateUpdate = useCallback((next: Record<string, unknown>) => {
    formStateRef.current = next;
  }, []);

  const handleParseResult = useCallback((result: ParseResult | null) => {
    const next = Boolean(result?.root);
    setHasRenderableRoot((prev) => (prev === next ? prev : next));
  }, []);

  const handleError = useCallback((next: OpenUIError[]) => {
    setErrors(next);
  }, []);

  if (!code.trim()) return null;

  if (tooLarge || tooManyStatements || tooManyCalls || tooDeep || tooDeepRefs) {
    return (
      <div className="eimu-openui-block" data-openui-block="">
        <RawFallback code={sourceCode} bare={bare} />
      </div>
    );
  }

  // 收齐后：预检无 root / 解析器有错且没产出 root / 有 root 但 DOM 全空 → 原文兜底。
  const showRawFallback =
    !isStreaming && (precheck?.root === false || renderEmpty || (errors.length > 0 && !hasRenderableRoot));
  if (showRawFallback && bare) {
    // 裸 DSL 误判：整块当普通文本，不渲染卡片外壳。
    return <PlainTextFallback code={sourceCode} />;
  }
  // 根有效但部分语句被丢弃/组件被降级 → 卡片下方提示并附原文；流式期间一律不显示（防闪烁）。
  const partialErrors = errors.length > 0 ? errors : (precheck?.errors ?? []);
  const hasUnknown = repair.notes.some((n) => n.kind === "unknown-component" || n.kind === "unknown-arg");
  const showPartialErrors = !isStreaming && !showRawFallback && (partialErrors.length > 0 || hasUnknown);

  return (
    <div className="eimu-openui-block" data-openui-block="">
      <OpenUIRenderErrorBoundary code={code} bare={bare}>
        <div ref={contentRef} data-openui-content="">
          <ThemeProvider mode="light">
            <Renderer
              response={code}
              library={eimuLibrary}
              isStreaming={isStreaming}
              onAction={handleAction}
              onStateUpdate={handleStateUpdate}
              onParseResult={handleParseResult}
              onError={handleError}
            />
          </ThemeProvider>
        </div>
        {showPartialErrors ? <PartialErrors errors={partialErrors} code={code} notes={repair.notes} /> : null}
      </OpenUIRenderErrorBoundary>
      {showRawFallback ? <RawFallback code={sourceCode} errors={errors.length ? errors : precheck?.errors} /> : null}
    </div>
  );
}
