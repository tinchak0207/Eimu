// 赏阅：把站内既有的成品形状（agent 媒体卡 item / 历史条目）投影成 ViewAsset。
// 纯函式、零 React。只搬真实有的字段：没有的就不写，不编造标题/封面/来历。

import type { AgentAudioItem, AgentImageItem, AgentVideoItem } from "@/lib/agent-chat-types";
import type { HistoryEntry, HistoryResult } from "@/lib/history-types";
import {
  DELIVERABLE_KINDS,
  deliverableKindLabel,
  deliverableKindsOfResult,
  isDeliverableKind,
  type DeliverableKind,
} from "@/lib/deliverable-kind";
import type { ViewAsset, ViewKind } from "./types";

const EXTRA_KIND_LABEL: Record<Exclude<ViewKind, DeliverableKind>, string> = {
  text: "文本",
  scene3d: "3D 场景",
  document: "文档",
  storyboard: "分镜",
  collection: "合集",
};

/** 种类中文名：交付物种类走注册表（image/video/audio），扩展种类在此补。纯函式，服务端也可调用。 */
export function viewKindLabel(kind: ViewKind): string {
  return isDeliverableKind(kind) ? deliverableKindLabel(kind) : EXTRA_KIND_LABEL[kind];
}

/** URL 的稳定摘要（FNV-1a 双路 → 53 位）：同一 URL 永远同一个 id，标记与续播据此存取。 */
export function stableAssetId(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `u${h1.toString(36)}${h2.toString(36)}`;
}

function clean(value: string | null | undefined): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : undefined;
}

/** 只留有值的字段；全空则整个 provenance 不出现。 */
function provenanceOf(p: NonNullable<ViewAsset["provenance"]>): ViewAsset["provenance"] | undefined {
  const out: NonNullable<ViewAsset["provenance"]> = {};
  if (p.taskId) out.taskId = p.taskId;
  if (p.prompt) out.prompt = p.prompt;
  if (p.model) out.model = p.model;
  if (typeof p.costCoins === "number" && Number.isFinite(p.costCoins)) out.costCoins = p.costCoins;
  if (typeof p.createdAt === "number" && Number.isFinite(p.createdAt) && p.createdAt > 0) out.createdAt = p.createdAt;
  if (typeof p.take === "number" && Number.isFinite(p.take)) out.take = p.take;
  return Object.keys(out).length ? out : undefined;
}

function withProvenance(asset: ViewAsset, p: NonNullable<ViewAsset["provenance"]>): ViewAsset {
  const provenance = provenanceOf(p);
  return provenance ? { ...asset, provenance } : asset;
}

/** "2048x2048" / "1024×768" → 宽高；解析不了就不给。 */
function parseSize(size: string | undefined): { width: number; height: number } | null {
  const m = size?.trim().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 图片：id 用 URL 摘要而不是 taskId——一个任务可能出多张图（best-of-N），
 * 共用 taskId 会让不同图的标记串台；taskId 仍写进 provenance。
 */
export function viewAssetFromImageItem(item: AgentImageItem): ViewAsset {
  const size = parseSize(item.recipe?.size);
  const asset: ViewAsset = {
    id: stableAssetId(item.url),
    kind: "image",
    url: item.url,
    ...(size ?? {}),
  };
  return withProvenance(asset, {
    taskId: item.taskId,
    prompt: clean(item.recipe?.prompt),
    model: clean(item.recipe?.model),
    costCoins: item.costCoins,
  });
}

export function viewAssetFromVideoItem(item: AgentVideoItem): ViewAsset {
  const asset: ViewAsset = {
    id: item.taskId ?? stableAssetId(item.url),
    kind: "video",
    url: item.url,
    ...(item.mediaKind === "film" ? { title: "成片" } : {}),
  };
  return withProvenance(asset, { taskId: item.taskId, costCoins: item.costCoins });
}

export function viewAssetFromAudioItem(item: AgentAudioItem): ViewAsset {
  const title = clean(item.title);
  const cover = clean(item.cover);
  const status = clean(item.lyricStatus);
  const asset: ViewAsset = {
    id: item.taskId ?? stableAssetId(item.url),
    kind: "audio",
    url: item.url,
    ...(title ? { title } : {}),
    ...(cover ? { cover } : {}),
    // 歌词本身（lrc/plain）卡上没有；只如实带状态，由 AudioSurface 决定是否去取。
    ...(status ? { lyrics: { status } } : {}),
  };
  return withProvenance(asset, { taskId: item.taskId, costCoins: item.costCoins });
}

/* ---------- 历史条目 ---------- */

function looksLikeUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(https?:\/\/|data:image\/|\/)/i.test(value.trim());
}

/** 一个 result 的代表媒体：优先 mediaType（写入方显式给的），否则按注册表优先序（video > audio > image）。 */
function kindAndUrlOf(result: HistoryResult): { kind: DeliverableKind; url: string } | null {
  const explicit = isDeliverableKind(result.mediaType) ? result.mediaType : null;
  const kind = explicit ?? deliverableKindsOfResult(result)[0] ?? null;
  if (kind) {
    const spec = DELIVERABLE_KINDS.find((k) => k.id === kind);
    const direct = spec ? clean(result[spec.resultField]) : undefined;
    if (direct) return { kind, url: direct };
  }
  // 老记录只有 image 栏位（URL 或 data URL）。
  if (looksLikeUrl(result.image)) return { kind: "image", url: result.image.trim() };
  return null;
}

function titleFromPrompt(prompt: string): string | undefined {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > 28 ? `${flat.slice(0, 28)}…` : flat;
}

/**
 * 历史条目 → ViewAsset。单成果＝该种类；多成果＝collection（children 各一件，take 为第几个候选）。
 * 没有任何可看的成果（失败/生成中/纯 workflow）返回 null。
 */
export function viewAssetFromHistoryEntry(entry: HistoryEntry): ViewAsset | null {
  const found = entry.results
    .map((result, index) => ({ result, index, media: kindAndUrlOf(result) }))
    .filter((r): r is { result: HistoryResult; index: number; media: { kind: DeliverableKind; url: string } } => r.media !== null);
  if (found.length === 0) return null;

  const prompt = clean(entry.prompt);
  const title = prompt ? titleFromPrompt(prompt) : undefined;
  const multi = found.length > 1;

  const children = found.map(({ result, index, media }): ViewAsset => {
    const asset: ViewAsset = {
      id: multi ? `${entry.id}#${result.resultId ?? index}` : entry.id,
      kind: media.kind,
      url: media.url,
      ...(title ? { title } : {}),
    };
    return withProvenance(asset, {
      taskId: result.taskId ?? entry.taskId,
      prompt,
      model: clean(result.modelId) ?? clean(entry.modelId),
      createdAt: entry.generatedAt,
      take: multi ? index + 1 : undefined,
    });
  });

  if (!multi) return children[0];
  return withProvenance(
    { id: entry.id, kind: "collection", ...(title ? { title } : {}), children },
    { taskId: entry.taskId, prompt, createdAt: entry.generatedAt },
  );
}
