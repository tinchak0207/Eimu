"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { ARTIFACT_MISSING_TEXT, type ArtifactSlotProps, type GalleryLayout } from "@/lib/openui/artifact-slot";
import { loadLyricPreview, loadWaveform } from "@/lib/openui/artifact-preview";
import { CompareViewer } from "@/components/viewer/CompareViewer";
import { Viewer } from "@/components/viewer/Viewer";
import { stableAssetId } from "@/lib/viewer/from-items";
import { viewAssetFromMediaItem } from "./agent-viewer";
import type { ViewAsset } from "@/lib/viewer/types";
import { AgentImageCard } from "./AgentImageCard";
import { AgentVideoCard } from "./AgentVideoCard";
import { AgentAudioCard } from "./AgentAudioCard";
import { useAgentChatSend } from "./agent-chat-send-context";
import { resolveArtifact, useAgentArtifacts, type AgentArtifactsValue, type AgentMediaItem } from "./agent-artifacts-context";

/**
 * OpenUI 成品组件的真实渲染（2026-10-18）：经 ArtifactSlotRendererProvider 注入 eimu-library。
 * 复用聊天里既有的 AgentImageCard / AgentVideoCard / AgentAudioCard（下载、再来一版、变体、
 * 存图库都原样保留），不另写播放器；点成员 → 站内赏阅打开整个合集并停在该成员，
 * 前后滑块用赏阅的 CompareViewer。
 */

function Missing({ count }: { count?: number }) {
  return (
    <p className="text-sm text-muted-foreground" data-openui-artifact-missing="">
      {count && count > 1 ? `${count} 件${ARTIFACT_MISSING_TEXT}` : ARTIFACT_MISSING_TEXT}
    </p>
  );
}

/** set＝所在合集：点该成员时赏阅打开整个合集并停在它（缺省＝只看本件）。 */
function MediaCard({ item, ctx, set }: { item: AgentMediaItem; ctx: AgentArtifactsValue; set?: readonly AgentMediaItem[] }) {
  if (item.kind === "image") return <AgentImageCard item={item} {...ctx.imageActions} viewerSet={set} />;
  if (item.kind === "video") return <AgentVideoCard item={item} {...ctx.videoActions} viewerSet={set} />;
  return <AgentAudioCard item={item} {...ctx.audioActions} viewerSet={set} />;
}

/**
 * 盲选用的「裸」媒体：只给种类与 URL（不带 taskId/配方/模型/花费），赏阅 inline 与其放大都不会
 * 泄露来历，避免先入为主；id 用 URL 摘要。
 */
function BareMedia({ item }: { item: AgentMediaItem }) {
  const asset = useMemo<ViewAsset>(
    () => ({ id: stableAssetId(item.url), kind: item.kind, url: item.url }),
    [item],
  );
  return <Viewer asset={asset} density="inline" />;
}

function Gallery({ found, layout, ctx }: { found: AgentMediaItem[]; layout: GalleryLayout; ctx: AgentArtifactsValue }) {
  const [hero, setHero] = useState(0);
  if (layout === "hero" && found.length > 1) {
    const main = found[Math.min(hero, found.length - 1)];
    return (
      <div className="flex flex-col gap-2" data-openui-gallery="hero">
        <MediaCard item={main} ctx={ctx} set={found} />
        <div className="grid grid-cols-4 gap-2">
          {found.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-label={`查看第 ${index + 1} 张`}
              aria-pressed={index === hero}
              onClick={() => setHero(index)}
              className={`overflow-hidden rounded-ios-md border-2 ${index === hero ? "border-[#007aff]" : "border-transparent"}`}
            >
              {item.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.url} alt="" className="aspect-square w-full object-cover" loading="lazy" />
              ) : (
                <span className="flex aspect-square items-center justify-center bg-black/5 text-xs">{index + 1}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (layout === "strip") {
    return (
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [overscroll-behavior-x:contain]" data-openui-gallery="strip">
        {found.map((item) => (
          <div key={item.id} className="w-[72%] max-w-[300px] shrink-0 snap-start">
            <MediaCard item={item} ctx={ctx} set={found} />
          </div>
        ))}
      </div>
    );
  }
  if (layout === "masonry") {
    return (
      <div className="columns-2 gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid" data-openui-gallery="masonry">
        {found.map((item) => (
          <div key={item.id}>
            <MediaCard item={item} ctx={ctx} set={found} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-openui-gallery="grid">
      {found.map((item) => (
        <MediaCard key={item.id} item={item} ctx={ctx} set={found} />
      ))}
    </div>
  );
}

/** 视频封面帧：先显示 posterAt 秒处的真实画面，点播放才展开完整播放卡。 */
function VideoPoster({ item, posterAt, ctx }: { item: AgentMediaItem; posterAt: number; ctx: AgentArtifactsValue }) {
  const [open, setOpen] = useState(false);
  if (open) return <MediaCard item={item} ctx={ctx} />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="播放视频"
      className="group relative block w-full overflow-hidden rounded-ios-lg bg-black"
      data-openui-video-poster={posterAt}
    >
      <video src={`${item.url}#t=${posterAt}`} preload="metadata" muted playsInline className="block max-h-[420px] w-full object-contain" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur group-active:scale-95">
          <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" />
        </span>
      </span>
    </button>
  );
}

/** 歌词片段 / 波形：只读真实来源（歌单 LRC、音频解码），取不到就什么都不显示。 */
function AudioPreview({ item, preview }: { item: AgentMediaItem; preview: "lyrics" | "waveform" }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (preview === "lyrics") void loadLyricPreview(item.url).then((v) => !cancelled && setLines(v));
    else void loadWaveform(item.url).then((v) => !cancelled && setPeaks(v));
    return () => {
      cancelled = true;
    };
  }, [item.url, preview]);
  if (preview === "lyrics") {
    if (!lines || lines.length === 0) return null;
    return (
      <div className="rounded-ios-md bg-black/[0.035] px-3 py-2 text-[13.5px] leading-6 text-foreground/75" data-openui-lyrics="">
        {lines.map((line, i) => (
          <p key={i} className="m-0">{line}</p>
        ))}
      </div>
    );
  }
  if (!peaks || peaks.length === 0) return null;
  const w = 240;
  const bw = w / peaks.length;
  return (
    <svg viewBox={`0 0 ${w} 40`} className="h-10 w-full" preserveAspectRatio="none" aria-hidden data-openui-waveform="">
      {peaks.map((p, i) => {
        const bh = Math.max(1.5, p * 38);
        return <rect key={i} x={i * bw + bw * 0.15} y={(40 - bh) / 2} width={bw * 0.7} height={bh} rx={bw * 0.3} fill="#007aff" opacity={0.7} />;
      })}
    </svg>
  );
}

/** 前后滑块：赏阅的 CompareViewer（只读查看控件，不收集任何参数）；前=A、后=B。 */
function SliderCompare({ before, after }: { before: AgentMediaItem; after: AgentMediaItem }) {
  const a = useMemo(() => viewAssetFromMediaItem(before), [before]);
  const b = useMemo(() => viewAssetFromMediaItem(after), [after]);
  return <CompareViewer a={a} b={b} mode="slider" />;
}

const LETTERS = ["A", "B", "C", "D"];

function CompareView({ found, mode, question, ctx }: { found: AgentMediaItem[]; mode: "side" | "blind" | "slider"; question?: string; ctx: AgentArtifactsValue }) {
  const blind = mode === "blind";
  const send = useAgentChatSend();
  const [picked, setPicked] = useState<number | null>(null);
  const pick = useCallback(
    (index: number) => {
      const item = found[index];
      if (!send || !item) return;
      setPicked(index);
      const ref = item.taskId || item.url;
      void send(`我选方案 ${LETTERS[index]}\n所选产物：task_id=${ref}`);
    },
    [found, send],
  );
  const images = found.filter((it) => it.kind === "image");
  if (mode === "slider" && images.length >= 2) {
    return (
      <div className="flex flex-col gap-3" data-openui-compare="slider">
        {question ? <p className="text-sm font-medium">{question}</p> : null}
        <SliderCompare before={images[0]} after={images[1]} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-openui-compare={blind ? "blind" : "side"}>
      {question ? <p className="text-sm font-medium">{question}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {found.map((item, index) => (
          <div key={item.id} className="flex flex-col gap-2 rounded-ios-lg border border-border/60 p-2" data-openui-candidate={LETTERS[index]}>
            <span className="text-sm font-semibold">方案 {LETTERS[index]}</span>
            {blind ? <BareMedia item={item} /> : <MediaCard item={item} ctx={ctx} set={found} />}
            <button
              type="button"
              className="min-h-11 rounded-ios-md border border-border bg-background px-3 text-sm font-medium disabled:opacity-50"
              disabled={!send || picked !== null}
              onClick={() => pick(index)}
            >
              {picked === index ? "已选择" : "选这个"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OpenUIArtifactSlot({ kind, refs, title, caption, mode, layout, preview, posterAt }: ArtifactSlotProps) {
  const ctx = useAgentArtifacts();
  if (!ctx) return <Missing />;
  const found: AgentMediaItem[] = [];
  let missing = 0;
  for (const ref of refs) {
    const item = resolveArtifact(ctx.items, ref);
    if (item && !found.includes(item)) found.push(item);
    else if (!item) missing += 1;
  }
  if (found.length === 0) return <Missing count={Math.max(missing, 1)} />;

  const singleKinds = kind === "image" || kind === "video" || kind === "audio";
  const list = singleKinds ? found.slice(0, 1) : found;
  const albumCover = kind === "album" ? found.find((it) => it.kind === "audio" && it.cover) : undefined;

  return (
    <section className="flex flex-col gap-3" data-openui-artifact={kind}>
      {title ? (
        <div className="flex items-center gap-3">
          {albumCover && albumCover.kind === "audio" && albumCover.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={albumCover.cover} alt="" className="h-16 w-16 shrink-0 rounded-ios-md object-cover" />
          ) : null}
          <h3 className="text-base font-semibold">{title}</h3>
        </div>
      ) : null}
      {caption && kind !== "compare" ? <p className="text-sm text-muted-foreground">{caption}</p> : null}
      {kind === "compare" ? (
        <CompareView found={found.slice(0, 4)} mode={mode ?? "side"} question={caption} ctx={ctx} />
      ) : kind === "gallery" ? (
        <Gallery found={found} layout={layout ?? "grid"} ctx={ctx} />
      ) : kind === "video" && typeof posterAt === "number" ? (
        <VideoPoster item={list[0]} posterAt={posterAt} ctx={ctx} />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((item, index) => (
            <div key={item.id} className="flex flex-col gap-1">
              {kind === "album" ? <span className="text-sm text-muted-foreground">{`${index + 1}.`}</span> : null}
              <MediaCard item={item} ctx={ctx} set={list.length > 1 ? list : undefined} />
              {kind === "audio" && preview ? <AudioPreview item={item} preview={preview} /> : null}
            </div>
          ))}
        </div>
      )}
      {missing > 0 ? <Missing count={missing} /> : null}
    </section>
  );
}

export default OpenUIArtifactSlot;
