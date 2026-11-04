// 赏阅适配器表：ViewKind → 懒加载 Surface。
//
// 用 Record<ViewKind, …> 保证穷尽：新增一种 ViewKind（含交付物注册表新增的种类）而漏了适配器＝编译失败。
// 全部 ssr:false 懒加载——Surface 要碰 <audio>/<video>/canvas/WebGL，且不该进首屏 bundle。

import { createElement, type ComponentType } from "react";
import dynamic from "next/dynamic";
import type { ViewKind, ViewerSurfaceProps } from "@/lib/viewer/types";

function SurfaceLoading() {
  return createElement(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      className: "flex h-full min-h-[160px] w-full items-center justify-center text-[13px] text-white/60",
    },
    "载入中…",
  );
}

export const VIEWER_SURFACES: Record<ViewKind, ComponentType<ViewerSurfaceProps>> = {
  image: dynamic(() => import("./ImageSurface"), { ssr: false, loading: SurfaceLoading }),
  video: dynamic(() => import("./VideoSurface"), { ssr: false, loading: SurfaceLoading }),
  audio: dynamic(() => import("./AudioSurface"), { ssr: false, loading: SurfaceLoading }),
  text: dynamic(() => import("./TextSurface"), { ssr: false, loading: SurfaceLoading }),
  scene3d: dynamic(() => import("./Scene3dSurface"), { ssr: false, loading: SurfaceLoading }),
  document: dynamic(() => import("./DocumentSurface"), { ssr: false, loading: SurfaceLoading }),
  storyboard: dynamic(() => import("./StoryboardSurface"), { ssr: false, loading: SurfaceLoading }),
  collection: dynamic(() => import("./CollectionSurface"), { ssr: false, loading: SurfaceLoading }),
};
