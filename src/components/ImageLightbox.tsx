import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useViewer } from "@/components/viewer/ViewerHost";
import { stableAssetId } from "@/lib/viewer/from-items";
import type { ViewAsset } from "@/lib/viewer/types";

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
  /** 可选说明文字（如「参考图 2/6」）；不传则不渲染任何额外元素。 */
  caption?: string;
  /** 可选底部操作区（如 ImageDisplay 的复制按钮）；不传则不渲染任何额外元素。 */
  footer?: React.ReactNode;
}

/**
 * 单图放大：对外契约（src/alt/onClose/caption/footer）不变，内部是赏阅（Viewer）的薄封装——
 * 调用方（ImageDisplay / ReferenceImageUpload / AssetReviewPanel / ShotReviewPanel）零改动换壳。
 * 无 ViewerProvider 的环境（独立挂载/测试）退回下方 LegacyImageLightbox。
 */
export function ImageLightbox(props: ImageLightboxProps) {
  const { available } = useViewer();
  return available ? <ViewerBackedLightbox {...props} /> : <LegacyImageLightbox {...props} />;
}

function ViewerBackedLightbox({ src, alt, onClose, caption, footer }: ImageLightboxProps) {
  const { open, close, update } = useViewer();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const asset = useMemo<ViewAsset>(
    () => ({ id: stableAssetId(src), kind: "image", url: src, ...(alt ? { title: alt } : {}) }),
    [src, alt],
  );
  // 本组件持有的会话是否还活着：用户关闭（壳回调 onClose）后置 false，卸载时只关自己的会话。
  const liveRef = useRef(false);
  const footerRef = useRef(footer);
  const captionRef = useRef(caption);
  useEffect(() => {
    footerRef.current = footer;
    captionRef.current = caption;
  });

  useEffect(() => {
    liveRef.current = true;
    open(asset, {
      caption: captionRef.current,
      extraFooter: footerRef.current,
      onClose: () => {
        if (!liveRef.current) return;
        liveRef.current = false;
        onCloseRef.current();
      },
    });
    return () => {
      if (liveRef.current) {
        liveRef.current = false;
        close();
      }
    };
  }, [asset, open, close]);

  // footer 常带状态（复制中/已复制）：原位更新，不重挂载舞台。
  useEffect(() => {
    if (liveRef.current) update({ caption, extraFooter: footer });
  }, [caption, footer, update]);

  return null;
}

/**
 * 降级实现（仅 Provider 缺席时使用）。全屏放大灯箱：从 ImageDisplay 的 zoom portal 逐字搬出复用（2026-09-10 暴君
 * 裁定：参考图缩图点击放大与生成图「点一下放大」必须是同一个窗口）。
 * 挂载即 pushState + 监听 Esc / 浏览器后退；点背板关闭；img 阻止冒泡。
 */
function LegacyImageLightbox({ src, alt, onClose, caption, footer }: ImageLightboxProps) {
  // onClose 多为调用处的内联箭头（每次 render 新引用）；经 ref 中转，
  // 生命周期 effect 只在挂载时跑一次，保证 pushState 不随父组件重渲染重复入栈。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    window.history.pushState({ zoomed: true }, "");

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };

    const handlePopState = () => {
      onCloseRef.current();
    };

    document.addEventListener("keydown", handleEscape);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  return createPortal(
    <div
      // /74 不在 Tailwind 默认透明度刻度上，整个类静默编译成空——放大层的深色
      // 底其实是全透明的。写成 rgba() 任意值才真正生效（与历史灯箱同一修法）。
      className="fixed inset-0 z-[95] flex min-h-[100dvh] w-screen cursor-pointer items-center justify-center bg-[rgba(31,34,48,0.74)] p-6 backdrop-blur-md"
      onClick={onClose}
    >
      <div className="absolute inset-x-0 top-[max(1.5rem,env(safe-area-inset-top))] flex justify-center">
        <div className="lg-float rounded-full px-4 py-2 text-sm text-[#6f7987]">
          按 Esc 关闭
        </div>
      </div>
      {caption ? (
        <div className="absolute inset-x-0 top-[calc(max(1.5rem,env(safe-area-inset-top))+3rem)] flex justify-center">
          <div className="lg-float rounded-full px-4 py-1.5 text-[13px] font-medium text-[#6f7987]">
            {caption}
          </div>
        </div>
      ) : null}
      {footer ? (
        <div className="absolute inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] flex justify-center">{footer}</div>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-[88dvh] max-w-[92vw] rounded-[1.7rem] object-contain shadow-[0_30px_80px_rgba(0,0,0,0.22)]"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
