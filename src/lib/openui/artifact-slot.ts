/**
 * OpenUI 成品组件 → 会话真实产物的渲染插槽（2026-10-18）。
 *
 * eimu-library.ts 会被 Node 脚本（tools/gen-openui-prompt.mts）直接 require，不能 import
 * 聊天卡片（AgentImageCard 等，带 lucide/next/CSS 依赖）。所以成品组件只渲染
 * `<ArtifactSlot>`，真正的实现由客户端的 AgentOpenUIBlock 通过 Context 注入
 * （见 src/components/agent-chat/OpenUIArtifactSlot.tsx）。
 *
 * 数据只认 taskId：会话产物的 task_id，或会话任务表里该产物的原 URL。前端只在当前会话
 * 已到达的 image.done / video.done / audio.done 条目里查（子代理产物也经同一事件进父会话）；
 * 查不到就显示「产物未找到」，绝不按模型给的字符串去拉任意 URL。
 */
import { createContext, createElement, useContext, type ComponentType } from "react";

export type ArtifactSlotKind = "image" | "gallery" | "video" | "audio" | "album" | "compare" | "deliverable";

/** ImageGallery 版式：grid 等宽网格 / masonry 瀑布流 / hero 首图大+其余缩略 / strip 横向胶片条。 */
export type GalleryLayout = "grid" | "masonry" | "hero" | "strip";
export const GALLERY_LAYOUTS: readonly GalleryLayout[] = ["grid", "masonry", "hero", "strip"];

export type ArtifactSlotProps = {
  kind: ArtifactSlotKind;
  refs: string[];
  title?: string;
  caption?: string;
  /** CompareView：side 并排 / blind 盲选 / slider 前后滑块（两张图）。 */
  mode?: "side" | "blind" | "slider";
  /** ImageGallery 版式。 */
  layout?: GalleryLayout;
  /** AudioPlayer 预览：lyrics 歌词片段 / waveform 波形（取不到就不显示）。 */
  preview?: "lyrics" | "waveform";
  /** VideoPlayer 封面帧（秒）；给了就先显示该帧+播放键，点开才换成完整播放卡。 */
  posterAt?: number;
};

const ArtifactSlotRendererContext = createContext<ComponentType<ArtifactSlotProps> | null>(null);

export const ArtifactSlotRendererProvider = ArtifactSlotRendererContext.Provider;

/** 统一的「查不到」文案（渲染层与演示页共用）。 */
export const ARTIFACT_MISSING_TEXT = "产物未找到";

/** 只保留非空字符串 ref，去重，最多 12 个（防模型灌爆）。 */
export function normalizeArtifactRefs(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const ref = item.trim();
    if (ref && !out.includes(ref)) out.push(ref);
    if (out.length >= 12) break;
  }
  return out;
}

export function ArtifactSlot(props: ArtifactSlotProps) {
  const Renderer = useContext(ArtifactSlotRendererContext);
  if (!Renderer) {
    return createElement(
      "p",
      { className: "text-sm text-muted-foreground", "data-openui-artifact-missing": "" },
      ARTIFACT_MISSING_TEXT,
    );
  }
  return createElement(Renderer, props);
}
