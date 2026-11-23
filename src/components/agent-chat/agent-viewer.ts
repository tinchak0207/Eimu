"use client";

// 聊天侧进「赏阅」的唯一接线点：媒体卡 / OpenUI 成品 / Markdown 内嵌图 / 附件卡都从这里开全屏。
//   - 卡片已有的 下载 / 存图库 / 再来 / 微调 回调在此映射成 ViewerActions（不另造一套）；
//   - 「发给助理」走会话上下文的 onSendFeedback（与「微调」同一条预填路径，只预填、不自动送出）；
//   - Provider 缺席（useViewer().available===false）时退回在新标签打开资源 URL，点击不会没反应。

import type { AgentImageItem } from "@/lib/agent-chat-types";
import { agentHistoryEntryForMedia } from "@/lib/agent-media-history";
import { canHistoryEntryRerun } from "@/lib/history-rerun";
import {
  stableAssetId,
  viewAssetFromAudioItem,
  viewAssetFromImageItem,
  viewAssetFromVideoItem,
} from "@/lib/viewer/from-items";
import type { ViewAsset, ViewerActions } from "@/lib/viewer/types";
import { useViewer } from "@/components/viewer/ViewerHost";
import type { AgentImageCardProps } from "./AgentImageCard";
import type { AgentVideoCardProps } from "./AgentVideoCard";
import type { AgentAudioCardProps } from "./AgentAudioCard";
import { useAgentArtifacts, type AgentArtifactsValue, type AgentMediaItem } from "./agent-artifacts-context";

export function viewAssetFromMediaItem(item: AgentMediaItem): ViewAsset {
  if (item.kind === "image") return viewAssetFromImageItem(item);
  if (item.kind === "video") return viewAssetFromVideoItem(item);
  return viewAssetFromAudioItem(item);
}

const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const VIDEO_EXT = /\.(m4v|mov|mp4|ogv|webm)$/i;
const AUDIO_EXT = /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav)$/i;

/** 按 URL 扩展名推种类（忽略 query/hash）；推不出返回 null。data:/blob: 用 MIME 前缀。 */
export function viewKindOfUrl(url: string): "image" | "video" | "audio" | null {
  const src = url.trim();
  const mime = src.match(/^data:(image|video|audio)\//i);
  if (mime) return mime[1].toLowerCase() as "image" | "video" | "audio";
  const path = src.split(/[?#]/)[0];
  if (IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  if (AUDIO_EXT.test(path)) return "audio";
  return null;
}

/** 任意 URL → ViewAsset（Markdown 内嵌、用户附件）。id 用 URL 摘要；推不出种类返回 null。 */
export function viewAssetFromUrl(
  url: string,
  kind?: "image" | "video" | "audio",
  extra?: { title?: string; mime?: string },
): ViewAsset | null {
  const src = url.trim();
  const k = kind ?? viewKindOfUrl(src);
  if (!src || !k) return null;
  return {
    id: stableAssetId(src),
    kind: k,
    url: src,
    ...(extra?.title ? { title: extra.title } : {}),
    ...(extra?.mime ? { mime: extra.mime } : {}),
  };
}

/**
 * 通用开启器：开 set 的第 index 件。附上会话的「发给助理」；Provider 缺席时新标签打开资源。
 */
export function useAgentViewerOpen(): (set: readonly ViewAsset[], index?: number, actions?: ViewerActions) => void {
  const viewer = useViewer();
  const ctx = useAgentArtifacts();
  const sendFeedback = ctx?.onSendFeedback;
  return (set, index = 0, actions) => {
    if (set.length === 0) return;
    if (!viewer.available) {
      const url = set[Math.min(Math.max(index, 0), set.length - 1)]?.url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const merged: ViewerActions = { ...actions };
    if (sendFeedback) merged.onSendFeedback = (text) => sendFeedback(text);
    viewer.open(set, { index, actions: merged });
  };
}

type ImageSrc = Pick<AgentImageCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onRerunVariant">;
type VideoSrc = Pick<AgentVideoCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;
type AudioSrc = Pick<AgentAudioCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;

interface MediaSources {
  image?: ImageSrc;
  video?: VideoSrc;
  audio?: AudioSrc;
}

/** 把媒体卡的回调映射成 ViewerActions：只给「集合里确有成员能用」的动作，没有就不给（壳里对应钮 disabled）。 */
function buildMediaActions(set: readonly AgentMediaItem[], src: MediaSources): ViewerActions {
  const byId = new Map<string, AgentMediaItem>();
  for (const it of set) byId.set(viewAssetFromMediaItem(it).id, it);
  const itemOf = (asset: ViewAsset) => byId.get(asset.id);
  // 图只有配方完整才放行重跑/微调（与图片卡同一判据）。
  const imageRerunnable = (it: AgentImageItem) => canHistoryEntryRerun(agentHistoryEntryForMedia(it));
  const anyImage = (pred: (it: AgentImageItem) => boolean) =>
    set.some((it) => it.kind === "image" && pred(it));
  const anyKind = (kind: AgentMediaItem["kind"]) => set.some((it) => it.kind === kind);

  const actions: ViewerActions = {};

  if ((src.image?.onDownload && anyKind("image")) || (src.video?.onDownload && anyKind("video")) || (src.audio?.onDownload && anyKind("audio"))) {
    actions.onDownload = async (asset) => {
      const it = itemOf(asset);
      if (!it) return false;
      if (it.kind === "image") return src.image?.onDownload ? src.image.onDownload(it) : false;
      if (it.kind === "video") return src.video?.onDownload ? src.video.onDownload(it) : false;
      return src.audio?.onDownload ? src.audio.onDownload(it) : false;
    };
  }

  if ((src.image?.onSaveToLibrary && anyKind("image")) || (src.video?.onSaveToLibrary && anyKind("video")) || (src.audio?.onSaveToLibrary && anyKind("audio"))) {
    actions.onSaveToLibrary = async (asset) => {
      const it = itemOf(asset);
      if (!it) return false;
      if (it.kind === "image") return src.image?.onSaveToLibrary ? src.image.onSaveToLibrary(it) : false;
      if (it.kind === "video") return src.video?.onSaveToLibrary ? src.video.onSaveToLibrary(it) : false;
      return src.audio?.onSaveToLibrary ? src.audio.onSaveToLibrary(it) : false;
    };
  }

  if (
    (src.image?.onRerun && anyImage(imageRerunnable)) ||
    (src.video?.onRerun && anyKind("video")) ||
    (src.audio?.onRerun && anyKind("audio"))
  ) {
    actions.onRerun = (asset, count) => {
      const it = itemOf(asset);
      if (!it) return;
      // 图：打开既有 RerunDialog（组数在对话框里选，明码计价），count 不直接使用。
      if (it.kind === "image") {
        if (imageRerunnable(it)) src.image?.onRerun?.(it);
      } else if (it.kind === "video") src.video?.onRerun?.(it, count);
      else src.audio?.onRerun?.(it, count);
    };
  }

  if (
    (src.image?.onRerunVariant && anyImage(imageRerunnable)) ||
    (src.video?.onVariant && anyKind("video")) ||
    (src.audio?.onVariant && anyKind("audio"))
  ) {
    actions.onVariant = (asset) => {
      const it = itemOf(asset);
      if (!it) return;
      if (it.kind === "image") {
        if (imageRerunnable(it)) src.image?.onRerunVariant?.(it);
      } else if (it.kind === "video") src.video?.onVariant?.(it);
      else src.audio?.onVariant?.(it);
    };
  }

  return actions;
}

function sourcesFrom(ctx: AgentArtifactsValue | undefined, own: MediaSources | undefined): MediaSources {
  return {
    image: own?.image ?? ctx?.imageActions,
    video: own?.video ?? ctx?.videoActions,
    audio: own?.audio ?? ctx?.audioActions,
  };
}

/**
 * 一组媒体成员的 ViewerActions（含会话「发给助理」）。own = 本卡 props 里的回调，优先于会话上下文。
 * 卡内联的 <Viewer density="inline"> 与全屏同用这一份，动作不分叉。
 */
export function useAgentMediaActions(own?: MediaSources): (set: readonly AgentMediaItem[]) => ViewerActions {
  const ctx = useAgentArtifacts();
  const sendFeedback = ctx?.onSendFeedback;
  return (set) => {
    const actions = buildMediaActions(set, sourcesFrom(ctx, own));
    if (sendFeedback) actions.onSendFeedback = (text) => sendFeedback(text);
    return actions;
  };
}

/**
 * 媒体卡 / OpenUI 成品的开启器：item 是被点的成员，siblings 是同一合集（缺省＝只有它自己），
 * 赏阅打开合集并停在 item 上，可在全屏里左右切成员。
 */
export function useAgentMediaViewerOpen(
  own?: MediaSources,
): (item: AgentMediaItem, siblings?: readonly AgentMediaItem[]) => void {
  const open = useAgentViewerOpen();
  const actionsFor = useAgentMediaActions(own);
  return (item, siblings) => {
    const at = siblings ? siblings.indexOf(item) : -1;
    const set = siblings && at >= 0 ? siblings : [item];
    open(set.map(viewAssetFromMediaItem), Math.max(0, at), actionsFor(set));
  };
}
