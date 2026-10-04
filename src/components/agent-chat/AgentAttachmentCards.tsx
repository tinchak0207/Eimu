"use client";

// 用户消息里的附件卡（罪状 1）：把 [ATTACHMENTS_BLOCK] 里的裸文本行解析成
// 微信式卡片组，渲染在用户气泡内、正文下方。
//
// 三种卡：
//   - image：圆角缩略图直显（<img> 直连网关 ?t=<ticket>），点击新窗口看原图；
//     加载失败 / 铸票失败 → 降级成文档式横条卡（不许破图）。
//   - video（原片直传成功）：微信式单个可播气泡（<video controls> 直连网关
//     读回 URL ?t=<ticket>）；无票 / 坏票 / 加载失败 → 降级成文档式横条卡。
//   - video-group（旧抽帧降级态，保留兼容）：一条影片在区块里展开成 4 张抽帧
//     JPEG（<原文件名去扩展名>-frame-N.jpg，同目录同前缀）→ 合并成一张「视频」
//     徽标卡 + 4 张帧缩略横排（帧复用 image 逻辑）。
//   - document：横条卡（FileText + 文件名 + 人类可读大小），不可点——
//     没有预览能力就不装有点击的样子（诚实原则）。
//
// 票据：每会话缓存一张（TTL 1h，留 60s 提前量），过期重铸；铸不出票静默降级，
// 绝不为附件卡阻塞转录渲染。

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAttachmentRef } from "@/lib/agent-chat-types";
import { buildAssetUrl, freshTicketValue, mintUploadsTicket, type AgentUploadsTicket } from "@/lib/agent-uploads";
import { formatBytes } from "@/lib/video-frames";

// ─────────────────────────── 解析（纯函数，node --test 可测）

export interface ParsedUserAttachments {
  /** 摘除附件区块（含前后多余空行）后的正文。 */
  cleanText: string;
  refs: AgentAttachmentRef[];
}

const ATTACHMENTS_BLOCK_RE = /\[ATTACHMENTS_BLOCK\]([\s\S]*?)\[\/ATTACHMENTS_BLOCK\]/;
/** 区块行：「1. <path> | <mime> | <size>」。 */
const ATTACHMENT_LINE_RE = /^\s*\d+\.\s*(.+?)\s*$/;
/** 影片抽帧的文件名（video-frames.ts 的命名契约：<base>-frame-<N>.jpg）。 */
const VIDEO_FRAME_NAME_RE = /^(.*)-frame-\d+\.jpg$/i;

function kindFromMime(mime: string): AgentAttachmentRef["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/** path 取 basename 并解掉 URL 编码噪音；解不动（含孤立 % 的怪名）原样保留。 */
export function attachmentDisplayName(path: string): string {
  const raw = path.split("/").pop() ?? path;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 从用户消息文本里摘除 [ATTACHMENTS_BLOCK]…[/ATTACHMENTS_BLOCK] 整段并解析 refs。
 * 没有区块时原样返回（refs 为空），正文一个字都不动。
 */
export function parseUserAttachmentBlock(text: string): ParsedUserAttachments {
  const match = text.match(ATTACHMENTS_BLOCK_RE);
  if (!match || match.index === undefined) return { cleanText: text, refs: [] };

  const refs: AgentAttachmentRef[] = [];
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.match(ATTACHMENT_LINE_RE);
    if (!line) continue;
    const [pathPart, mimePart, sizePart] = line[1].split("|").map((s) => s.trim());
    if (!pathPart) continue;
    const mime = mimePart ?? "";
    const sizeNum = sizePart === undefined || sizePart === "" ? NaN : Number(sizePart);
    refs.push({
      kind: kindFromMime(mime),
      path: pathPart,
      name: attachmentDisplayName(pathPart),
      ...(mime ? { mime } : {}),
      ...(Number.isFinite(sizeNum) ? { size: sizeNum } : {}),
    });
  }

  // 区块前通常是消息正文 + 一个 \n；摘除后把前后多余空白擦干净。
  const head = text.slice(0, match.index);
  const tail = text.slice(match.index + match[0].length);
  return { cleanText: `${head}${tail}`.trim(), refs };
}

// ─────────────────────────── 卡片模型（影片抽帧分组）

export type AttachmentCardModel =
  | { kind: "single"; ref: AgentAttachmentRef }
  | { kind: "video-group"; name: string; frames: AgentAttachmentRef[] };

function dirOf(path: string | undefined): string {
  const parts = (path ?? "").split("/");
  return parts.slice(0, -1).join("/");
}

/** 连续出现、同目录同前缀的抽帧（≥2 张）合并成一张视频卡；其余逐张原样。 */
export function groupAttachmentRefs(refs: AgentAttachmentRef[]): AttachmentCardModel[] {
  const out: AttachmentCardModel[] = [];
  let i = 0;
  while (i < refs.length) {
    const ref = refs[i];
    const name = ref.name ?? "";
    const m = name.match(VIDEO_FRAME_NAME_RE);
    if (ref.kind === "image" && m) {
      const groupKey = `${dirOf(ref.path)}/${m[1].toLowerCase()}`;
      const frames: AgentAttachmentRef[] = [];
      let j = i;
      while (j < refs.length) {
        const r = refs[j];
        const rm = (r.name ?? "").match(VIDEO_FRAME_NAME_RE);
        if (r.kind === "image" && rm && `${dirOf(r.path)}/${rm[1].toLowerCase()}` === groupKey) {
          frames.push(r);
          j += 1;
        } else {
          break;
        }
      }
      if (frames.length > 1) {
        out.push({ kind: "video-group", name: attachmentDisplayName(m[1]), frames });
        i = j;
        continue;
      }
    }
    out.push({ kind: "single", ref });
    i += 1;
  }
  return out;
}

/**
 * 这组卡要不要读票：image 缩略、video-group 帧、video 原片气泡都要
 * （没票拼不出网关 URL，一律降级成文档卡）；document 不需要。
 */
export function groupsNeedTicket(groups: AttachmentCardModel[]): boolean {
  return groups.some(
    (g) => g.kind === "video-group" || g.ref.kind === "image" || g.ref.kind === "video",
  );
}

// ─────────────────────────── 票据 hook（每会话一张，静默降级）

interface TicketState {
  ticket: AgentUploadsTicket | null;
  minting: boolean;
  failed: boolean;
}

function useUploadsTicket(sessionId: string | null, needed: boolean): TicketState {
  const [state, setState] = useState<TicketState>({ ticket: null, minting: false, failed: false });
  const inflightRef = useRef<Promise<void> | null>(null);
  // 换会话时旧会话的在途铸票 promise 不会被取消，只是不再被引用——它的
  // .then/.catch 落地时仍会照常触发，若不加代际号会拿旧会话的结果覆盖
  // 新会话已经铸好/铸失败的 state（经典的跨 epoch 竞态）。
  const epochRef = useRef(0);

  // 换会话：旧票按会话铸的，直接作废；同时递增代际号让旧会话的在途 promise
  // 落地时自认过期，不再写 state。
  useEffect(() => {
    epochRef.current += 1;
    setState({ ticket: null, minting: false, failed: false });
    inflightRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !needed) return;
    // 有新票 / 已判死失败 / 在途：都不再铸。failed 保持到换会话为止——
    // 反复重试只会反复打网关，附件卡已经降级成文档卡，不缺这张票。
    if (freshTicketValue(state.ticket) !== null || state.failed || inflightRef.current) return;
    const epoch = epochRef.current;
    const job = mintUploadsTicket(sessionId)
      .then((ticket) => {
        if (epochRef.current === epoch) setState({ ticket, minting: false, failed: false });
      })
      .catch(() => {
        if (epochRef.current === epoch) setState({ ticket: null, minting: false, failed: true });
      })
      .finally(() => {
        if (epochRef.current === epoch) inflightRef.current = null;
      });
    inflightRef.current = job;
    // state 整体进依赖：任何一次 setState 后重跑守卫判断；ticket 过期时
    // （freshTicketValue 回 null）下一次渲染自动重铸。
  }, [sessionId, needed, state]);

  return state;
}

// ─────────────────────────── 卡片

/** 文档式横条卡：也是 image 加载失败的统一降级壳。不可点。
 *
 * 宿主表面是用户气泡的 .lg-float（--lg-bg-secondary = 白 0.56 浅色玻璃），
 * 所以卡内文字必须用深色 token（text-foreground / text-muted-foreground），
 * 卡片填充用 bg-foreground/[0.08] 这类「深色低透明度」。切勿改回 text-white /
 * bg-white/1x —— 白字叠浅色玻璃的对比度约 1.0，整张卡会彻底看不见。
 */
function DocumentCard({ attRef }: { attRef: AgentAttachmentRef }) {
  return (
    <div className="flex items-center gap-2 rounded-ios-xl bg-foreground/[0.08] px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-foreground/60" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-ios-footnote font-medium text-foreground" title={attRef.name}>
        {attRef.name ?? "附件"}
      </span>
      {typeof attRef.size === "number" && Number.isFinite(attRef.size) && (
        <span className="shrink-0 text-ios-caption1 tabular-nums text-muted-foreground">{formatBytes(attRef.size)}</span>
      )}
    </div>
  );
}

/**
 * 图片缩略（主图与大帧共用）。降级链路：
 * 铸票中 → 骨架；铸票失败 / 无票 / <img> 挂掉 → 文档式横条卡，绝不破图。
 */
export function AttachmentThumb({
  sessionId,
  attRef,
  ticket,
  minting,
  imgClassName,
  wrapperClassName,
  chromeClassName,
  skeletonClassName,
}: {
  sessionId: string | null;
  attRef: AgentAttachmentRef;
  ticket: string | null;
  minting: boolean;
  mintFailed: boolean;
  imgClassName: string;
  wrapperClassName?: string;
  /** 只上在成功态 <a> 上的视觉壳（圆角/描边/按压缩放）——降级成文档卡时不能带。 */
  chromeClassName?: string;
  /** 铸票中骨架的完整类名。不给则沿用 wrapper+img 的旧拼法（抽帧横排）。 */
  skeletonClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  const url = ticket !== null && attRef.path ? buildAssetUrl(sessionId ?? "", attRef.path, ticket) : null;

  if (broken || url === null) {
    return (
      <div className={cn("min-w-0", wrapperClassName)}>
        <DocumentCard attRef={attRef} />
      </div>
    );
  }

  if (minting) {
    // 票在途：骨架占位，票到了原图顶上来，不跳版。
    return (
      <div
        className={
          skeletonClassName ??
          cn("animate-pulse rounded-ios-lg bg-foreground/10", wrapperClassName, imgClassName)
        }
        aria-hidden="true"
      />
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`打开原图：${attRef.name ?? "附件"}`}
      className={cn("block overflow-hidden", wrapperClassName, chromeClassName)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 网关签票 URL（带 ticket，必要时经本站 proxy），next/image 无法优化且 fill／宽高推导会绑死附件自适应版面 */}
      <img
        src={url}
        alt={attRef.name ?? "附件图片"}
        loading="lazy"
        onError={() => setBroken(true)}
        className={imgClassName}
        draggable={false}
      />
    </a>
  );
}

/**
 * 原片直传成功的影片气泡（微信式）：一个 <video controls> 可点播放，
 * src 直连网关读回 URL（GET /agent/v1/uploads/<session>/<name>?t=<ticket>）。
 * 降级链路与 image 一致：铸票中 → 骨架；无票 / 坏票 / 加载失败 → 文档式横条卡，
 * 绝不破图，也绝不放 4 张缩图（那是旧抽帧降级态的形态）。
 */
export function VideoBubble({
  sessionId,
  attRef,
  ticket,
  minting,
}: {
  sessionId: string | null;
  attRef: AgentAttachmentRef;
  ticket: string | null;
  minting: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const url = ticket !== null && attRef.path ? buildAssetUrl(sessionId ?? "", attRef.path, ticket) : null;

  if (broken || url === null) {
    return <DocumentCard attRef={attRef} />;
  }

  if (minting) {
    // 票在途：等高骨架占位，票到了原片顶上来，不跳版。
    return <div className="h-32 w-full max-w-xs animate-pulse rounded-ios-lg bg-foreground/10" aria-hidden="true" />;
  }

  return (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      onError={() => setBroken(true)}
      aria-label={attRef.name ?? "视频附件"}
      title={attRef.name ?? "视频"}
      className="max-h-56 w-full max-w-xs rounded-ios-lg bg-black object-contain"
    />
  );
}

export interface AgentAttachmentCardsProps {
  refs: AgentAttachmentRef[];
  /** 当前会话 id：铸票与 URL 兜底用。缺省时全部降级成文档式卡。 */
  sessionId?: string | null;
}

function AgentAttachmentCardsComponent({ refs, sessionId }: AgentAttachmentCardsProps) {
  const groups = useMemo(() => groupAttachmentRefs(refs), [refs]);
  const needsTicket = groupsNeedTicket(groups);
  const { ticket, minting, failed } = useUploadsTicket(sessionId ?? null, needsTicket);

  if (groups.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {groups.map((group, i) => {
        if (group.kind === "video-group") {
          return (
            <div key={`video-${group.name}-${i}`} className="rounded-ios-xl bg-foreground/[0.06] p-2">
              <div className="flex items-center gap-1.5 px-0.5 pb-1.5">
                <Film className="h-3.5 w-3.5 shrink-0 text-foreground/60" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ios-footnote font-semibold text-foreground" title={group.name}>
                  {group.name}
                </span>
                <span className="shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-ios-caption1 font-medium text-foreground/80">
                  视频
                </span>
              </div>
              <div className="flex gap-1.5">
                {group.frames.map((frame) => (
                  <AttachmentThumb
                    key={frame.path ?? frame.name}
                    sessionId={sessionId ?? null}
                    attRef={frame}
                    ticket={ticket !== null ? ticket.ticket : null}
                    minting={minting}
                    mintFailed={failed}
                    wrapperClassName="h-20 min-w-0 flex-1"
                    chromeClassName="rounded-ios-lg"
                    imgClassName="h-20 w-full object-cover"
                  />
                ))}
              </div>
            </div>
          );
        }

        const ref = group.ref;
        if (ref.kind === "video") {
          return (
            <VideoBubble
              key={ref.path ?? `video-${i}`}
              sessionId={sessionId ?? null}
              attRef={ref}
              ticket={ticket !== null ? ticket.ticket : null}
              minting={minting}
            />
          );
        }
        if (ref.kind === "image") {
          // 单图附件＝真图缩略（Grok 式）：右对齐跟用户泡泡同侧，高约 240px、
          // 宽约 260px（≈65% 移动端正文流宽），1px 淡描边让白图也有边界；
          // 宿主是 .lg-float 浅色玻璃，骨架/垫底一律深色低透明度 token。
          return (
            <AttachmentThumb
              key={ref.path ?? `img-${i}`}
              sessionId={sessionId ?? null}
              attRef={ref}
              ticket={ticket !== null ? ticket.ticket : null}
              minting={minting}
              mintFailed={failed}
              wrapperClassName="w-fit max-w-full self-end"
              chromeClassName="rounded-[18px] border border-black/[0.06] bg-black/[0.04] transition-transform active:scale-[0.98]"
              skeletonClassName="h-60 w-48 animate-pulse self-end rounded-[18px] border border-black/[0.06] bg-black/[0.04]"
              imgClassName="block max-h-60 w-auto max-w-[min(100%,260px)] object-cover"
            />
          );
        }
        return <DocumentCard key={ref.path ?? `doc-${i}`} attRef={ref} />;
      })}
    </div>
  );
}

export const AgentAttachmentCards = memo(AgentAttachmentCardsComponent);
