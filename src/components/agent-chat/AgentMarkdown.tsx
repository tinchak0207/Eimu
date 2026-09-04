"use client";

import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isImageUrl,
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
 * - 消息里的平台图片直链自动渲染成缩略图卡，点击放大（灯罩内点任意处关闭）。
 *   原始 URL 保留在 img alt / aria-label 里，屏读器与复制路径不丢。
 */

/** 图片缩略图卡：消息内嵌一颗可点的缩图，点击开灯罩放大。 */
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

function InlineSpan({ span, onOpenImage }: { span: MdInline; onOpenImage: (src: string, alt: string) => void }) {
  switch (span.k) {
    case "text":
      return <>{span.text}</>;
    case "strong":
      return <strong className="font-semibold">{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</strong>;
    case "em":
      return <em>{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</em>;
    case "del":
      return <del className="text-foreground/45">{span.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</del>;
    case "code":
      // 罪状 9：task_id / 端点路径等行内代码弱化——低调等宽小字，不删原文。
      return (
        <code className="break-all rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[12px] leading-none text-foreground/55">
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
    case "br":
      return <br />;
  }
}

function BlockNode({ block, onOpenImage }: { block: MdBlock; onOpenImage: (src: string, alt: string) => void }) {
  switch (block.type) {
    case "p":
      return (
        <p className="my-1 first:mt-0 last:mb-0">
          {block.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}
        </p>
      );
    case "h": {
      const size = block.level <= 1 ? "text-base font-bold" : block.level === 2 ? "text-[15px] font-bold" : "text-[15px] font-semibold";
      return <p className={cn("mt-2 mb-1 first:mt-0", size)}>{block.children.map((c, i) => <InlineSpan key={i} span={c} onOpenImage={onOpenImage} />)}</p>;
    }
    case "code":
      return (
        <pre className="my-1.5 overflow-x-auto rounded-[10px] bg-black/[0.045] px-3 py-2.5 font-mono text-[13px] leading-[1.6] text-foreground/80">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="my-1.5 border-l-2 border-black/15 pl-3 text-foreground/60">
          {block.blocks.map((b, i) => <BlockNode key={i} block={b} onOpenImage={onOpenImage} />)}
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
          <table className="w-full border-collapse text-[13px]">
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

function AgentMarkdownComponent({ text }: { text: string }) {
  // 灯罩：同一气泡里多张缩图共用一个放大层。
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const blocks = parseAgentMarkdown(text);

  return (
    <>
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} onOpenImage={(src, alt) => setLightbox({ src, alt })} />
      ))}
      {/* 灯罩走 portal：气泡带 .agent-rise 入场动画（transform 未清零），
          fixed 元素会被它的 containing block 困在气泡里。lightbox 只在点击后
          （纯客户端）非空，SSR 阶段永不渲染 portal。 */}
      {lightbox &&
        createPortal(
          <div
          role="dialog"
          aria-modal="true"
          aria-label="图片放大查看"
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4 [touch-action:manipulation]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 平台直链，同上 */}
          <img
            src={lightbox.src}
            alt={lightbox.alt || "放大图片"}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[92vw] rounded-ios-xl object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="关闭放大"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          </div>,
          document.body,
        )}
    </>
  );
}

export const AgentMarkdown = memo(AgentMarkdownComponent);
export { isImageUrl };
