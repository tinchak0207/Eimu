"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AgentAudioItem, AgentChatState, AgentImageItem, AgentVideoItem } from "@/lib/agent-chat-types";
import type { AgentImageCardProps } from "./AgentImageCard";
import type { AgentVideoCardProps } from "./AgentVideoCard";
import type { AgentAudioCardProps } from "./AgentAudioCard";

/**
 * 会话产物上下文（2026-10-18）：OpenUI 成品组件（ImageResult / VideoPlayer / AudioPlayer /
 * AlbumPlayer / ImageGallery / CompareView / DeliverableCard）只收 taskId，从这里查真实条目。
 *
 * 真源＝当前会话 transcript 里已到达的 image.done / video.done / audio.done 条目——
 * 子代理产物经网关 /internal/emit（subagentParentState）同样落进父会话的这三类事件，
 * 因此天然覆盖子代理交付路径。动作回调与面板上的媒体卡同一组（下载/再来/变体/存图库）。
 */
export type AgentMediaItem = AgentImageItem | AgentVideoItem | AgentAudioItem;

export type AgentArtifactsValue = {
  items: AgentMediaItem[];
  imageActions?: Pick<AgentImageCardProps, "onSaveToLibrary" | "onEdit" | "onDownload" | "onRerun" | "onRerunVariant">;
  videoActions?: Pick<AgentVideoCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;
  audioActions?: Pick<AgentAudioCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;
};

const AgentArtifactsContext = createContext<AgentArtifactsValue | undefined>(undefined);

export function AgentArtifactsProvider({
  items,
  imageActions,
  videoActions,
  audioActions,
  children,
}: {
  items: AgentChatState["items"];
  imageActions?: AgentArtifactsValue["imageActions"];
  videoActions?: AgentArtifactsValue["videoActions"];
  audioActions?: AgentArtifactsValue["audioActions"];
  children: ReactNode;
}) {
  const media = useMemo(
    () =>
      items.filter(
        (it): it is AgentMediaItem => it.kind === "image" || it.kind === "video" || it.kind === "audio",
      ),
    [items],
  );
  const value = useMemo(
    () => ({ items: media, imageActions, videoActions, audioActions }),
    [media, imageActions, videoActions, audioActions],
  );
  return <AgentArtifactsContext.Provider value={value}>{children}</AgentArtifactsContext.Provider>;
}

export function useAgentArtifacts(): AgentArtifactsValue | undefined {
  return useContext(AgentArtifactsContext);
}

/**
 * 按 ref 查会话产物：先精确匹配 task_id，再精确匹配产物 URL（无 task_id 的成片/子代理产物
 * 在会话任务表里只有 URL）。只在会话已有条目里查——任意字符串都不会变成可加载的地址。
 */
export function resolveArtifact(items: readonly AgentMediaItem[], ref: string): AgentMediaItem | undefined {
  const key = ref.trim();
  if (!key) return undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].taskId && items[i].taskId === key) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].url === key) return items[i];
  }
  return undefined;
}

// ── OpenUI 1.0 Query 只读工具（toolProvider）────────────────────────────────
/**
 * 一件产物的真实元数据。来源只有两处：会话条目本身（task_id / recipe / 扣费 / 歌名 / 曲序）
 * 与浏览器对该 URL 的实测（分辨率 / 时长）。取不到的字段一律空串或 null，绝不估算。
 * 「耗时」目前 image/video/audio.done 都不带，故不提供该字段。
 */
export type ArtifactMeta = {
  found: boolean;
  taskId: string;
  kind: "image" | "video" | "audio" | "";
  title: string;
  model: string;
  size: string;
  resolution: string;
  duration: string;
  durationSec: number | null;
  cost: string;
  costCoins: number | null;
  trackNo: number | null;
  mediaKind: string;
  lyricStatus: string;
};

const EMPTY_META: Omit<ArtifactMeta, "taskId"> = {
  found: false,
  kind: "",
  title: "",
  model: "",
  size: "",
  resolution: "",
  duration: "",
  durationSec: null,
  cost: "",
  costCoins: null,
  trackNo: null,
  mediaKind: "",
  lyricStatus: "",
};

type Probe = { width?: number; height?: number; durationSec?: number };
const probeCache = new Map<string, Promise<Probe>>();
const PROBE_TIMEOUT_MS = 6000;

/** 浏览器实测分辨率/时长（只读元数据，preload=metadata 不下载全片）；超时或失败给空。 */
function probeMedia(item: AgentMediaItem): Promise<Probe> {
  if (typeof document === "undefined") return Promise.resolve({});
  const key = `${item.kind}:${item.url}`;
  let hit = probeCache.get(key);
  if (!hit) {
    hit = new Promise<Probe>((resolve) => {
      const done = (p: Probe) => {
        clearTimeout(timer);
        resolve(p);
      };
      const timer = window.setTimeout(() => resolve({}), PROBE_TIMEOUT_MS);
      if (item.kind === "image") {
        const img = new Image();
        img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => done({});
        img.src = item.url;
        return;
      }
      const el = document.createElement(item.kind === "video" ? "video" : "audio");
      el.preload = "metadata";
      el.muted = true;
      el.onloadedmetadata = () => {
        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined;
        const v = el as HTMLVideoElement;
        done({ durationSec: d, width: v.videoWidth || undefined, height: v.videoHeight || undefined });
      };
      el.onerror = () => done({});
      el.src = item.url;
    });
    probeCache.set(key, hit);
  }
  return hit;
}

export function formatDuration(sec: number | undefined | null): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 会话条目 → 不需要实测的元数据部分（纯函数，供单测）。 */
export function staticArtifactMeta(items: readonly AgentMediaItem[], item: AgentMediaItem): Omit<ArtifactMeta, "resolution" | "duration" | "durationSec"> {
  const audios = items.filter((it) => it.kind === "audio");
  const trackIndex = item.kind === "audio" ? audios.indexOf(item) : -1;
  const cost = typeof item.costCoins === "number" && Number.isFinite(item.costCoins) ? item.costCoins : null;
  return {
    found: true,
    taskId: item.taskId ?? "",
    kind: item.kind,
    title: item.kind === "audio" ? (item.title ?? "") : "",
    model: item.kind === "image" ? (item.recipe?.model ?? "") : "",
    size: item.kind === "image" ? (item.recipe?.size ?? "") : "",
    cost: cost === null ? "" : `${cost} 金币`,
    costCoins: cost,
    trackNo: trackIndex >= 0 ? trackIndex + 1 : null,
    mediaKind: item.kind === "image" ? "" : (item.mediaKind ?? ""),
    lyricStatus: item.kind === "audio" ? (item.lyricStatus ?? "") : "",
  };
}

async function fullMeta(items: readonly AgentMediaItem[], item: AgentMediaItem): Promise<ArtifactMeta> {
  const base = staticArtifactMeta(items, item);
  const p = await probeMedia(item);
  return {
    ...base,
    resolution: p.width && p.height ? `${p.width}×${p.height}` : "",
    durationSec: typeof p.durationSec === "number" ? Math.round(p.durationSec * 10) / 10 : null,
    duration: formatDuration(p.durationSec),
  };
}

export type ArtifactToolProvider = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

/** OpenUI `Query("artifact", {taskId})` / `Query("artifacts", {kind})` 的只读实现。 */
export function buildArtifactTools(items: readonly AgentMediaItem[]): ArtifactToolProvider {
  return {
    artifact: async (args) => {
      const ref = typeof args?.taskId === "string" ? args.taskId : "";
      const item = ref ? resolveArtifact(items, ref) : undefined;
      if (!item) return { ...EMPTY_META, taskId: ref };
      return fullMeta(items, item);
    },
    artifacts: async (args) => {
      const kind = typeof args?.kind === "string" ? args.kind : "";
      const list = items.filter((it) => !kind || it.kind === kind).slice(-24);
      const rows = await Promise.all(list.map((it) => fullMeta(items, it)));
      return { rows, count: rows.length };
    },
  };
}

/** AgentOpenUIBlock 用：没有会话上下文时返回 null（Query 拿到默认值，字段为空）。 */
export function useArtifactToolProvider(): ArtifactToolProvider | null {
  const ctx = useAgentArtifacts();
  const items = ctx?.items;
  return useMemo(() => (items ? buildArtifactTools(items) : null), [items]);
}
