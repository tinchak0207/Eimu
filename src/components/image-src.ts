"use client";

import { useMemo } from "react";
import type { ImageResult } from "@/lib/image-types";

/**
 * 成片 src 的统一解析入口（普通模式与专业模式共用）。
 *
 * 一张 1024×1024 PNG 的 base64 是 1~4MB 的字符串。`"data:image/png;base64," + image`
 * 每次求值都要新分配一份同样大小的字符串，随后立刻变成垃圾。放在组件 body 里裸写
 * 就等于「每次 render 拷贝几 MB」——而 render 会因为进度条 tick、isLoading 翻转、
 * images 数组更新而在生成期间高频触发。
 *
 * 两种消费方式各有合适的缓存键：
 *  - 有 ImageResult 对象可用时（专业模式的队列 / 图库）按对象身份缓存，
 *    对象随 GC 释放，无需手动清理；
 *  - 只有裸 base64 字符串时（普通模式的 ImageDisplay）用 useMemo 按值缓存，
 *    字符串不能作为 WeakMap 的键，用 Map 会把几 MB 的内容永久钉在内存里。
 */
function toDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

const resultSrcCache = new WeakMap<ImageResult, string>();

/** 按 ImageResult 对象身份缓存 data URL，避免每次 render 重新分配多 MB 字符串。 */
export function resultSrc(image: ImageResult): string | undefined {
  if (image.image) {
    let url = resultSrcCache.get(image);
    if (!url) {
      url = toDataUrl(image.image);
      resultSrcCache.set(image, url);
    }
    return url;
  }
  return image.imageUrl ?? undefined;
}

/**
 * 裸 base64 / URL 版本：只在 image 或 imageUrl 真正变化时才重做拼接。
 * 语义与 `image ? data-url : imageUrl || null` 完全一致，包括空串按 falsy 处理。
 */
export function useResolvedImageSrc(
  image: string | null | undefined,
  imageUrl: string | null | undefined,
): string | null {
  return useMemo(() => (image ? toDataUrl(image) : imageUrl || null), [image, imageUrl]);
}
