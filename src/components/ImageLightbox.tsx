import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

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
 * 全屏放大灯箱：从 ImageDisplay 的 zoom portal 逐字搬出复用（2026-09-10 暴君
 * 裁定：参考图缩图点击放大与生成图「点一下放大」必须是同一个窗口）。
 * 挂载即 pushState + 监听 Esc / 浏览器后退；点背板关闭；img 阻止冒泡。
 */
export function ImageLightbox({ src, alt, onClose, caption, footer }: ImageLightboxProps) {
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
