"use client";

import { Component, memo, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import { EntityText } from "@/components/entities/entity-chip";
import { Viewer } from "@/components/viewer/Viewer";
import { useAgentViewerOpen, viewAssetFromUrl } from "./agent-viewer";
import {
  isBareOpenUIInfo,
  isImageUrl,
  isOpenUILang,
  parseAgentMarkdown,
  type MdBlock,
  type MdInline,
} from "@/lib/agent-markdown";

/**
 * 助理消息的 Markdown 渲染（罪状 3 + 罪状 9）。
 *
 * - 表格 / 粗体 / 列表 / 代码块 / 引用照版式渲染，不再糊成纯文本。
 * - 行内代码（task_id、端点路径等）走「低调等宽小字」样式：不删原文，
 *   但不再和正文抢视觉权重。
 * - 消息里的平台图片直链自动渲染成缩略图卡，点击进站内赏阅全屏（缩放/返回键关闭/标记→助理）。
 *   原始 URL 保留在 img alt / aria-label 里，屏读器与复制路径不丢。
 */

/**
 * OpenUI 渲染器懒加载（2026-10-17）：`@openuidev/*` 依赖体积大，不能进主
 * 聊天 bundle；且渲染依赖浏览器状态，SSR 无意义。加载期给固定高度的骨架，
 * 流式增量重渲染时不会因为「从无到有」把下方内容顶来顶去。
 */
const AgentOpenUIBlock = dynamic(() => import("./AgentOpenUIBlock"), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden="true"
      data-openui-skeleton=""
      className="my-1.5 h-[132px] w-full animate-pulse rounded-[12px] border border-black/[0.06] bg-black/[0.035]"
    />
  ),
});

/** 动态 import 失败时的降级：一行可折叠的原文，绝不吞掉这条消息（裸 DSL 块直接当普通文本）。 */
function OpenUIFallback({ code, bare }: { code: string; bare?: boolean }) {
  if (bare) return <p className="my-1 whitespace-pre-wrap break-words">{code}</p>;
  return (
    <details className="my-1.5 rounded-[10px] border border-black/[0.08] bg-black/[0.03]">
      <summary className="min-h-9 cursor-pointer touch-manipulation select-none px-3 py-1.5 text-[0.75rem] text-foreground/55 [-webkit-tap-highlight-color:transparent]">
        交互界面未能加载，点此查看原文
      </summary>
      <pre className="overflow-x-auto px-3 pb-2.5 font-mono text-[0.8125rem] leading-[1.6] text-foreground/80">
        <code>{code}</code>
      </pre>
    </details>
  );
}

/**
 * 兜住 AgentOpenUIBlock 的渲染/加载异常（动态 import 拒绝、渲染器对畸形 DSL
 * 抛错）。降级成可折叠原文；code 变化时重试一次——流式早期半截 DSL 抛错后，
 * 收齐的文本仍有机会正常渲染。
 */
class AgentOpenUIErrorBoundary extends Component<
  { code: string; bare?: boolean; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { code: string }) {
    if (this.state.failed && prev.code !== this.props.code) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return <OpenUIFallback code={this.props.code} bare={this.props.bare} />;
    return this.props.children;
  }
}

/** 图片缩略图卡：消息内嵌一颗可点的缩图，点击开赏阅全屏。 */
function AgentImageThumb({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`放大查看图片：${alt || src}`}
      title={alt || src}
      className={cn(
        "my-1 block max-w-full cursor-zoom-in overflow-hidden rounded-ios-lg border border-black/[0.06] bg-black/[0.03]",
        "transition-opacity duration-150 hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/40",
        "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 平台直链域名不定，next/image 优化器不适用 */}
      <img
        src={src}
        alt={alt || "消息内图片"}
        loading="lazy"
        className="max-h-56 max-w-full object-contain"
      />
    </button>
  );
}

/** 消息内影片：赏阅 inline（倍速/逐帧/标记，点「放大」进全屏）。 */
function MdVideo({ src }: { src: string }) {
  const asset = useMemo(() => viewAssetFromUrl(src, "video"), [src]);
  if (!asset) return null;
  return (
    <div className="my-1 w-full max-w-md" aria-label={`影片：${src}`}>
      <Viewer asset={asset} density="inline" />
    </div>
  );
}

/** 消息内音频：赏阅 inline（波形/歌词/标记，点「放大」进全屏）。 */
function MdAudio({ src }: { src: string }) {
  const asset = useMemo(() => viewAssetFromUrl(src, "audio"), [src]);
  if (!asset) return null;
  return (
    <div className="my-1 w-full max-w-md" aria-label={`音频：${src}`}>
      <Viewer asset={asset} density="inline" />
    </div>
  );
}

function InlineSpan({ span, onOpenImage }: { span: MdInline; onOpenImage: (src: string, alt: string) => void }) {
  switch (span.k) {
    case "text":
      return <EntityText text={span.text} />;
    case "strong":
      return <strong className="font-semibold">{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</strong>;
    case "em":
      return <em>{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</em>;
    case "del":
      return <del className="text-foreground/45">{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</del>;
    case "code":
      // 罪状 9：task_id / 端点路径等行内代码弱化——低调等宽小字，不删原文。
      return (
        <code className="break-all rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[0.75rem] leading-none text-foreground/55">
          {span.text}
        </code>
      );
    case "link":
      return (
        <a
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-ios-blue underline decoration-ios-blue/40 underline-offset-2 transition-colors hover:decoration-ios-blue"
        >
          {span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}
        </a>
      );
    case "img":
      // 消息里的平台图片直链：缩略图卡，点击放大（罪状 9）。
      return <AgentImageThumb src={span.src} alt={span.alt} onOpen={() => onOpenImage(span.src, span.alt)} />;
    case "video":
      // 消息里的平台影片直链：内嵌赏阅播放器（可放大进全屏），不再是一串裸 URL。
      return <MdVideo src={span.src} />;
    case "audio":
      return <MdAudio src={span.src} />;
    case "br":
      return <br />;
  }
}

interface AgentMarkdownProps {
  text: string;
  /** 该条 assistant 消息是否仍在流式输出（透传给 OpenUI 渲染器）。 */
  isStreaming?: boolean;
  /** 既有发送通道（AgentChatPanel.onSend），供 OpenUI 的 @ToAssistant 按钮使用。 */
  onSend?: (text: string) => void;
}

function BlockNode({
  block,
  onOpenImage,
  isStreaming,
  onSend,
}: {
  block: MdBlock;
  onOpenImage: (src: string, alt: string) => void;
  isStreaming?: boolean;
  onSend?: (text: string) => void;
}) {
  switch (block.type) {
    case "p": {
      // 内嵌赏阅（影片/音频）含块级 div/p，不能放进 <p>（hydration 报错）。
      const hasBlockMedia = block.children.some((c) => c.k === "video" || c.k === "audio");
      const Tag = hasBlockMedia ? "div" : "p";
      return (
        <Tag className="my-1 break-words [overflow-wrap:anywhere] first:mt-0 last:mb-0">
          {block.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}
        </Tag>
      );
    }
    case "h": {
      // 手机端阶梯锚点（agent-chat.css ≤639.98px）：h1 → 18px/26px（.agent-turn-title），
      // h2/h3 → 17px/25px（.agent-turn-text）。桌面原 class 序列不动（text-base / text-[0.9375rem]）。
      const size = block.level <= 1
        ? "text-base font-bold agent-turn-title"
        : block.level === 2
          ? "text-[0.9375rem] font-bold agent-turn-text"
          : "text-[0.9375rem] font-semibold agent-turn-text";
      return <p className={cn("mt-2 mb-1 first:mt-0", size)}>{block.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</p>;
    }
    case "code":
      // OpenUI fence：交给客户端渲染器（fence 原文不再重复显示成普通代码块）。
      // 语言名已归一，`OpenUI` / ` openui ` 都命中；其它语言维持原样。
      if (isOpenUILang(block.lang)) {
        const bare = isBareOpenUIInfo(block.lang);
        return (
          <AgentOpenUIErrorBoundary code={block.text} bare={bare}>
            <AgentOpenUIBlock code={block.text} isStreaming={isStreaming} onSend={onSend} bare={bare} />
          </AgentOpenUIErrorBoundary>
        );
      }
      return (
        <pre className="my-1.5 overflow-x-auto rounded-[10px] bg-black/[0.045] px-3 py-2.5 font-mono text-[0.8125rem] leading-[1.6] text-foreground/80">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="my-1.5 border-l-2 border-black/15 pl-3 text-foreground/60">
          {block.blocks.map((b, i) => (
            <BlockNode key={i} block={b} onOpenImage={onOpenImage} isStreaming={isStreaming} onSend={onSend} />
          ))}
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol className="my-1.5 list-decimal space-y-1 pl-5">
          {block.items.map((spans, i) => (
            <li key={i}>{spans.map((c, j) => <InlineSpan key={j} span={c} onOpenImage={onOpenImage} />)}</li>
          ))}
        </ol>
      ) : (
        <ul className="my-1.5 list-disc space-y-1 pl-5">
          {block.items.map((spans, i) => (
            <li key={i}>{spans.map((c, j) => <InlineSpan key={j} span={c} onOpenImage={onOpenImage} />)}</li>
          ))}
        </ul>
      );
    case "table":
      // 表格：横向可滚（窄气泡不撑爆），13px 正文下限，斑马线弱分隔。
      return (
        <div className="my-1.5 overflow-x-auto rounded-[10px] border border-black/[0.07]">
          <table className="w-full border-collapse text-[0.8125rem]">
            <thead>
              <tr className="bg-black/[0.035]">
                {block.head.map((cell, i) => (
                  <th key={i} className="border-b border-black/[0.08] px-2.5 py-1.5 text-left font-semibold text-foreground/75">
                    {cell.map((c, j) => <InlineSpan key={j} span={c} onOpenImage={onOpenImage} />)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="odd:bg-black/[0.015]">
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-black/[0.05] px-2.5 py-1.5 align-top last:border-b-0">
                      {cell.map((c, k) => <InlineSpan key={k} span={c} onOpenImage={onOpenImage} />)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function AgentMarkdownComponent({ text, isStreaming, onSend }: AgentMarkdownProps) {
  // 缩图点击 → 站内赏阅全屏（与 portal 全屏同一个壳，不再自带灯罩）。
  const openViewer = useAgentViewerOpen();
  const onOpenImage = (src: string, alt: string) => {
    const asset = viewAssetFromUrl(src, "image", { title: alt.trim() || undefined });
    if (asset) openViewer([asset]);
  };
  const blocks = parseAgentMarkdown(text);

  return (
    <>
      {blocks.map((b, i) => (
        <BlockNode
          key={i}
          block={b}
          onOpenImage={onOpenImage}
          isStreaming={isStreaming}
          onSend={onSend}
        />
      ))}
    </>
  );
}

export const AgentMarkdown = memo(AgentMarkdownComponent);
export { isImageUrl };
