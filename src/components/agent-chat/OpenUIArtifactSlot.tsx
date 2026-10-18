"use client";

import { useCallback, useState } from "react";
import { ARTIFACT_MISSING_TEXT, type ArtifactSlotProps } from "@/lib/openui/artifact-slot";
import { AgentImageCard } from "./AgentImageCard";
import { AgentVideoCard } from "./AgentVideoCard";
import { AgentAudioCard } from "./AgentAudioCard";
import { useAgentChatSend } from "./agent-chat-send-context";
import { resolveArtifact, useAgentArtifacts, type AgentArtifactsValue, type AgentMediaItem } from "./agent-artifacts-context";

/**
 * OpenUI 成品组件的真实渲染（2026-10-18）：经 ArtifactSlotRendererProvider 注入 eimu-library。
 * 复用聊天里既有的 AgentImageCard / AgentVideoCard / AgentAudioCard（下载、再来一版、变体、
 * 存图库、音频卡的滚动歌词播放器深链都原样保留），不另写播放器。
 */

function Missing({ count }: { count?: number }) {
  return (
    <p className="text-sm text-muted-foreground" data-openui-artifact-missing="">
      {count && count > 1 ? `${count} 件${ARTIFACT_MISSING_TEXT}` : ARTIFACT_MISSING_TEXT}
    </p>
  );
}

function MediaCard({ item, ctx }: { item: AgentMediaItem; ctx: AgentArtifactsValue }) {
  if (item.kind === "image") return <AgentImageCard item={item} {...ctx.imageActions} />;
  if (item.kind === "video") return <AgentVideoCard item={item} {...ctx.videoActions} />;
  return <AgentAudioCard item={item} {...ctx.audioActions} />;
}

/** 盲选用的「裸」媒体：不带配方/花费/模型信息，避免先入为主。 */
function BareMedia({ item }: { item: AgentMediaItem }) {
  if (item.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.url} alt="候选" className="w-full rounded-ios-md object-cover" loading="lazy" />;
  }
  if (item.kind === "video") {
    return <video src={item.url} controls playsInline preload="metadata" className="w-full rounded-ios-md bg-black" />;
  }
  return <audio src={item.url} controls preload="metadata" className="w-full" />;
}

const LETTERS = ["A", "B", "C", "D"];

function CompareView({ found, blind, question, ctx }: { found: AgentMediaItem[]; blind: boolean; question?: string; ctx: AgentArtifactsValue }) {
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
  return (
    <div className="flex flex-col gap-3" data-openui-compare={blind ? "blind" : "side"}>
      {question ? <p className="text-sm font-medium">{question}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {found.map((item, index) => (
          <div key={item.id} className="flex flex-col gap-2 rounded-ios-lg border border-border/60 p-2" data-openui-candidate={LETTERS[index]}>
            <span className="text-sm font-semibold">方案 {LETTERS[index]}</span>
            {blind ? <BareMedia item={item} /> : <MediaCard item={item} ctx={ctx} />}
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

export function OpenUIArtifactSlot({ kind, refs, title, caption, mode }: ArtifactSlotProps) {
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
        <CompareView found={found.slice(0, 4)} blind={mode === "blind"} question={caption} ctx={ctx} />
      ) : (
        <div className={kind === "gallery" ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "flex flex-col gap-3"}>
          {list.map((item, index) => (
            <div key={item.id} className="flex flex-col gap-1">
              {kind === "album" ? <span className="text-sm text-muted-foreground">{`${index + 1}.`}</span> : null}
              <MediaCard item={item} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
      {missing > 0 ? <Missing count={missing} /> : null}
    </section>
  );
}

export default OpenUIArtifactSlot;
