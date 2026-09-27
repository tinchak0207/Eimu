"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, Play } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 未登入新訪客的進站宣傳片浮層（2026-09-27 暴君裁定落地）。
 *
 * 為什麼是浮層而不是首頁 hero 卡：定位之爭在「進網站第一刻」就被裁定——
 * 新訪客看見的第一眼若是參數框＋輸入框＋輸出框，就會拿生圖中轉站的尺來量我們
 * （原始決策見記憶 manju-relay-objection-and-demo-onboarding-0922）。浮層把
 * 那第一秒拿去放一部片，播完直接接上真實產線（預填試玩那句話）。
 *
 * 播放政策：瀏覽器一律擋帶聲自動播放，所以本體恆為 muted autoplay，
 * 聲音由右下角按鈕由人開啟；自動播放若整條被擋（省電模式／嚴格站點設定），
 * 退成海報＋播放鈕，不是黑屏。
 *
 * 文案一律簡體（產品語言），圖示一律 lucide（禁 emoji 圖示）。
 */

export interface PromoIntroOverlayProps {
  /** 「开始试玩」：把片中那句話預填進輸入框。 */
  onTrial: () => void;
  /** 「先逛逛」/ Esc / 跳過後收尾＝直接關掉浮層。 */
  onDismiss: () => void;
}

const VIDEO_SRC = "/promo/eimu-promo.mp4";
const POSTER_SRC = "/promo/eimu-promo-poster.jpg";

export function PromoIntroOverlay({ onTrial, onDismiss }: PromoIntroOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  /** 播放收尾（自然播完，或按了跳過）：浮出試玩入口。 */
  const [settled, setSettled] = useState(false);
  /** 自動播放整條被擋：退成海報＋播放鈕。 */
  const [needsTap, setNeedsTap] = useState(false);

  // 浮層開著時鎖住底下的頁面捲動，否則手機上手指會把首頁連同影片一起滑走。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // 自動播放：瀏覽器政策只保證靜音自動播放，失敗就擺播放鈕，別留黑屏。
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => setNeedsTap(true));
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const handleTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el || !el.duration || !Number.isFinite(el.duration)) return;
    setProgress(Math.min(1, el.currentTime / el.duration));
  }, []);

  const settle = useCallback(() => setSettled(true), []);

  const toggleSound = useCallback(() => {
    const el = videoRef.current;
    setMuted((current) => {
      const next = !current;
      if (el) {
        el.muted = next;
        // 由人按下的靜音解除，順手把音量補到滿——不然會停在瀏覽器給的預設值上。
        if (!next) el.volume = 1;
      }
      return next;
    });
  }, []);

  const replay = useCallback(() => {
    const el = videoRef.current;
    setSettled(false);
    setProgress(0);
    if (!el) return;
    el.currentTime = 0;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => setNeedsTap(true));
    }
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Eimu 宣传片"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black"
    >
      <video
        ref={videoRef}
        src={VIDEO_SRC}
        poster={POSTER_SRC}
        className="absolute inset-0 h-full w-full object-contain"
        autoPlay
        muted
        playsInline
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onEnded={settle}
      />

      {/* 自動播放被擋時唯一出路：一個真的能按的播放鈕。 */}
      {needsTap && !settled && (
        <button
          type="button"
          onClick={replay}
          className="lg-sheet relative flex items-center gap-2 rounded-full px-5 py-3 text-[15px] font-medium text-white lg-transition hover:scale-[1.02]"
        >
          <Play className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          播放
        </button>
      )}

      {/* 收尾面板：播完（或跳過）就把震撼接到真實產線上。 */}
      {settled ? (
        <div className="relative mx-4 w-full max-w-[34rem] rounded-[2.4rem] bg-black/55 p-7 text-center ring-1 ring-white/[0.12] backdrop-blur-2xl sm:p-9">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white/70 to-transparent" />
          <h2 className="text-[1.65rem] font-semibold leading-tight tracking-[-0.03em] text-white sm:text-[1.95rem]">
            一句话，成了这部片
          </h2>
          <p className="mx-auto mt-4 max-w-[26rem] text-[14px] leading-7 text-white/60">
            没有追问，智能体自己拆剧本、定角色、排分镜，一次铺开 21 个生成节点。
          </p>
          <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={onTrial}
              className="rounded-full bg-white px-6 py-3.5 text-sm font-medium text-[#2d3142] lg-transition hover:-translate-y-[1px] hover:bg-white/90"
            >
              开始试玩
            </button>
            <button
              type="button"
              onClick={replay}
              className="rounded-full px-6 py-3.5 text-sm font-medium text-white/70 lg-transition hover:bg-white/10 hover:text-white"
            >
              重播一遍
            </button>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-5 text-[13px] text-white/45 lg-transition hover:text-white/75"
          >
            先逛逛，从首页开始
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={settle}
            className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 rounded-full border border-white/10 bg-white/10 px-4 py-2 text-[13px] font-medium text-white/85 backdrop-blur-md lg-transition hover:bg-white/20 hover:text-white sm:right-6 sm:top-6"
          >
            跳过
          </button>

          <button
            type="button"
            onClick={toggleSound}
            aria-label={muted ? "开启声音" : "关闭声音"}
            title={muted ? "开启声音" : "关闭声音"}
            className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/85 backdrop-blur-md lg-transition hover:bg-white/20 hover:text-white sm:right-6 sm:bottom-6"
          >
            {muted ? (
              <VolumeX className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Volume2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>

          {/* 真實播放進度（不是裝飾百分比）：影片還有多久由這條線講。 */}
          <div className="absolute inset-x-0 bottom-0 z-10 h-[3px] bg-white/10">
            <div
              className={cn(
                "h-full bg-white/75",
                progress === 0 ? "" : "transition-[width] duration-200 ease-out",
              )}
              style={{ width: `${Math.round(progress * 1000) / 10}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
