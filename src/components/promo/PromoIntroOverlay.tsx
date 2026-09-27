"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Play, Volume2, VolumeX } from "lucide-react";
import { PROMO_TRIAL_PROMPT } from "./promo-gate";

/**
 * 未登入新訪客的進站宣傳片浮層（2026-09-27 暴君裁定落地）。
 *
 * 為什麼是浮層而不是首頁 hero 卡：定位之爭在「進網站第一刻」就被裁定——
 * 新訪客看見的第一眼若是參數框＋輸入框＋輸出框，就會拿生圖中轉站的尺來量我們
 * （原始決策見記憶 manju-relay-objection-and-demo-onboarding-0922）。浮層把
 * 那第一秒拿去放一部片。
 *
 * 收尾（2026-09-27 暴君第二輪糾正：「你结尾那个引导好差啊」）：
 * 原本是一塊玻璃面板＋「开始试玩」鈕，浮在近白的片尾畫面上——灰糊成一團、
 * 沒有畫面、還要人多按一次。現在直接拿**宣傳片 A 版封面**當結尾畫面
 * （`public/promo/eimu-promo-cover.jpg`，1920×1080），封面裡那個輸入框
 * **換成真的能打字的輸入框**：打一句、按送出，就開新對話把那句送進產線。
 *
 * 座標逐字取自封面渲染源 `promo-video/cover.html` 的 `.prompt`
 * （left 294 / top 690 / width 700 / height 112，皆在 1920×1080 畫布上），
 * 所以真輸入框會精準蓋住封面裡那個畫上去的框、不會露字。整個封面容器做
 * `container-type: size`，框內尺寸全用 cqh 表達 → 任何視窗尺寸下都與畫面等比。
 *
 * 播放政策：瀏覽器一律擋帶聲自動播放，所以本體恆為 muted autoplay，
 * 聲音由右下角按鈕由人開啟；自動播放若整條被擋（省電模式／嚴格站點設定），
 * 退成海報＋播放鈕，不是黑屏。
 *
 * 文案一律簡體（產品語言），圖示一律 lucide（禁 emoji 圖示）。
 */

export interface PromoIntroOverlayProps {
  /**
   * 使用者在結尾輸入框送出了那句話：關浮層、開新對話、直接送進產線。
   * 空字串＝他直接按送出，用片中的原始許願當那句。
   */
  onTrial: (text: string) => void;
  /** 「重播一遍」以外的退路（跳過 / Esc / 先逛逛）＝只關掉浮層，不送任何話。 */
  onDismiss: () => void;
}

const VIDEO_SRC = "/promo/eimu-promo.mp4";
const POSTER_SRC = "/promo/eimu-promo-poster.jpg";
const COVER_SRC = "/promo/eimu-promo-cover.jpg";

/** 封面畫布：1920×1080（見 promo-video/cover.html）。 */
const COVER_W = 1920;
const COVER_H = 1080;
/**
 * `.prompt` 框在畫布上的矩形（見 cover.html）。真輸入框照這組數字蓋上去，並
 * **四周各出血 6px**：封面那張框是畫上去的（自帶文字、游標與送出鈕），蓋不乾淨
 * 就會在圓角邊緣露一線雙層。出血只吃掉框外 6px 的背景漸層，肉眼無感。
 */
const BOX_BLEED = 6;
const BOX = { left: 294 - BOX_BLEED, top: 690 - BOX_BLEED, width: 700 + BOX_BLEED * 2, height: 112 + BOX_BLEED * 2 };
/** 框中心（先把畫面中心對到這裡，再看什麼尺寸下最好用）。 */
const BOX_CX = (BOX.left + BOX.width / 2) / COVER_W;
const BOX_CY = (BOX.top + BOX.height / 2) / COVER_H;

/** 畫布 px → 容器高度百分比（容器已鎖 16:9，故 cqh 即等比縮放）。 */
const cqh = (px: number): string => `${((px / COVER_H) * 100).toFixed(4)}cqh`;
const pct = (value: number, total: number): string => `${((value / total) * 100).toFixed(4)}%`;

export function PromoIntroOverlay({ onTrial, onDismiss }: PromoIntroOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  /** 播放收尾（自然播完，或按了跳過）：換成封面＋可輸入的那一句。 */
  const [settled, setSettled] = useState(false);
  /** 自動播放整條被擋：退成海報＋播放鈕。 */
  const [needsTap, setNeedsTap] = useState(false);
  /** 使用者打的那句話。 */
  const [text, setText] = useState("");
  /** 直式（手機）：封面要放大到框好按的大小。 */
  const [portrait, setPortrait] = useState(false);

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

  // 直式螢幕：封面只佔 56.25vw 的話輸入框只有一百多 px 寬，手指放不下。
  // 直式改成放大到 250vw 再以框為中心——框寬約佔螢幕七成，字也跟著放大。
  useEffect(() => {
    const mq = window.matchMedia("(max-aspect-ratio: 1/1)");
    const apply = (): void => setPortrait(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // 收尾出現時把游標放進輸入框（只有滑鼠裝置；手機自動彈鍵盤會嚇到人）。
  useEffect(() => {
    if (!settled) return;
    if (!window.matchMedia("(hover: hover)").matches) return;
    inputRef.current?.focus();
  }, [settled]);

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
    setText("");
    if (!el) return;
    el.currentTime = 0;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => setNeedsTap(true));
    }
  }, []);

  /** 送出：空框也走得通——直接按送出就是跑片中那句話。 */
  const submit = useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault();
      onTrial(text.trim() || PROMO_TRIAL_PROMPT);
    },
    [onTrial, text],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Eimu 宣传片"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black"
    >
      {settled ? (
        // ── 結尾：宣傳片封面當畫面，封面裡那個輸入框換成真的 ────────────────
        <div className="absolute inset-0 overflow-hidden bg-[#eef1f6]">
          <div
            className="absolute left-1/2 top-1/2 aspect-[16/9]"
            style={{
              // 橫式＝整張封面完整入鏡（contain）：縮到能塞進視窗的最小那組尺寸，
              // 多出來的邊留給同色底。**曾經寫成 max(100vw, 177.78vh) 想「不留
              // 黑邊」，結果視窗比例接近 16:9 時封面被放大到高度溢出——品牌標與
              // 右上「成片」標籤整個被切掉、底下還留一條空帶（2026-09-27 暴君
              // 截圖實錘「你交给我的什么玩意啊」）。海報式結尾就該完整入鏡。
              // 直式＝放大到框好按（手機手指放得下），此時刻意只露出框那一段。
              width: portrait ? "250vw" : "min(100vw, 177.78vh)",
              // 對齊點＝畫面中心：橫式對封面中心，直式對輸入框中心。
              // 百分比是自身尺寸的比例，所以任何縮放都成立。
              transform: portrait
                ? `translate(${(-BOX_CX * 100).toFixed(4)}%, ${(-BOX_CY * 100).toFixed(4)}%)`
                : "translate(-50%, -50%)",
              containerType: "size",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={COVER_SRC}
              alt=""
              draggable={false}
              className="pointer-events-none h-full w-full select-none object-cover"
            />

            {/* 真輸入框：pt-2 那組玻璃樣式逐字沿用 promo-video/cover.html 的 .prompt。
                它會精準蓋住封面裡畫上去的框（座標同源），所以看不到兩層字。 */}
            <form
              onSubmit={submit}
              className="absolute flex items-center border-[1.5px] border-[rgba(255,255,255,0.98)] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(255,255,255,0.86))] backdrop-blur-[24px] [backdrop-filter:blur(24px)_saturate(180%)]"
              style={{
                left: pct(BOX.left, COVER_W),
                top: pct(BOX.top, COVER_H),
                width: pct(BOX.width, COVER_W),
                height: pct(BOX.height, COVER_H),
                borderRadius: cqh(9999),
                paddingLeft: cqh(34),
                paddingRight: cqh(22),
                gap: cqh(18),
                boxShadow:
                  "0 26px 60px rgba(45,49,66,.16), 0 4px 14px rgba(45,49,66,.06), inset 0 2px 0 #fff, inset 0 -1px 0 rgba(0,0,0,.04)",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#2f7bff"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0"
                style={{ width: cqh(44), height: cqh(44) }}
              >
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                <path d="M20 3v4" />
                <path d="M22 5h-4" />
                <path d="M4 17v2" />
                <path d="M5 18H3" />
              </svg>
              <input
                ref={inputRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={PROMO_TRIAL_PROMPT}
                aria-label="说出你想要的画面"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-semibold tracking-[0.01em] text-[#141824] outline-none placeholder:text-[rgba(20,24,36,0.38)]"
                style={{ fontSize: cqh(40) }}
              />
              <button
                type="submit"
                aria-label="开始做"
                title="开始做"
                className="grid shrink-0 cursor-pointer place-items-center rounded-full bg-[#2d3142] text-white lg-transition hover:bg-[#272b39] active:scale-95"
                style={{
                  width: cqh(76),
                  height: cqh(76),
                  boxShadow: "0 12px 26px rgba(45,49,66,.28), inset 0 1.5px 0 rgba(255,255,255,.25)",
                }}
              >
                <ArrowUp className="h-[45%] w-[45%]" strokeWidth={2.6} aria-hidden="true" />
              </button>
            </form>
          </div>

          {/* 兩個退路固定在螢幕上（不隨封面縮放跑掉）。 */}
          <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-6">
            <button
              type="button"
              onClick={replay}
              className="cursor-pointer text-[13px] font-medium text-[#5f6880] lg-transition hover:text-[#141824]"
            >
              重播一遍
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="cursor-pointer text-[13px] font-medium text-[#5f6880] lg-transition hover:text-[#141824]"
            >
              先逛逛
            </button>
          </div>
        </div>
      ) : (
        <>
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
          {needsTap && (
            <button
              type="button"
              onClick={replay}
              className="lg-sheet relative flex items-center gap-2 rounded-full px-5 py-3 text-[15px] font-medium text-white lg-transition hover:scale-[1.02]"
            >
              <Play className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              播放
            </button>
          )}

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
              className="h-full bg-white/75 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.round(progress * 1000) / 10}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
