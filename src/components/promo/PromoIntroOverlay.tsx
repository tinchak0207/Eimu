"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Play, Volume2, VolumeX } from "lucide-react";
import { PROMO_TRIAL_PROMPT } from "./promo-gate";
import { PromoLoginPopover } from "./PromoLoginPopover";
import { DesktopDownloadButton } from "@/components/DesktopDownloadButton";

/**
 * 未登入新访客的进站宣传片浮层（2026-09-27 项目负责人裁定落地）。
 *
 * 为什么是浮层而不是首页 hero 卡：定位之争在「进网站第一刻」就被裁定——
 * 新访客看见的第一眼若是参数框＋输入框＋输出框，就会拿生图中转站的尺来量我们
 * （原始决策见记忆 manju-relay-objection-and-demo-onboarding-0922）。浮层把
 * 那第一秒拿去放一部片。
 *
 * 收尾（2026-09-27 项目负责人第二轮纠正：「你结尾那个引导好差啊」）：
 * 原本是一块玻璃面板＋「开始试玩」钮，浮在近白的片尾画面上——灰糊成一团、
 * 没有画面、还要人多按一次。现在直接拿**宣传片 A 版封面**当结尾画面
 * （`public/promo/eimu-promo-cover.jpg`，1920×1080），封面里那个输入框
 * **换成真的能打字的输入框**：打一句、按送出，就开新对话把那句送进产线。
 *
 * 座标逐字取自封面渲染源 `promo-video/cover.html` 的 `.prompt`
 * （left 294 / top 690 / width 700 / height 112，皆在 1920×1080 画布上），
 * 所以真输入框会精准盖住封面里那个画上去的框、不会露字。整个封面容器做
 * `container-type: size`，框内尺寸全用 cqh 表达 → 任何视窗尺寸下都与画面等比。
 *
 * 播放政策：浏览器一律挡带声自动播放，所以本体恒为 muted autoplay，
 * 声音由右下角按钮由人开启；自动播放若整条被挡（省电模式／严格站点设定），
 * 退成海报＋播放钮，不是黑屏。
 *
 * 文案一律简体（产品语言），图示一律 lucide（禁 emoji 图示）。
 */

export interface PromoIntroOverlayProps {
  /**
   * 使用者在结尾输入框送出了那句话：关浮层、开新对话、直接送进产线。
   * 空字串＝他直接按送出，用片中的原始许愿当那句。
   */
  onTrial: (text: string) => void;
  /** 「重播一遍」以外的退路（跳过 / Esc / 先逛逛）＝只关掉浮层，不送任何话。 */
  onDismiss: () => void;
  /**
   * 未登入（宣传片观众的大多数）：送出时不送讯息，改成在送出钮上方长出登入小框。
   * 判定留在上层（那里才有登入态），这里只负责表现。
   */
  needsLogin?: boolean;
  /** 使用者放弃登入（关掉小框）：上层清掉待送的那句话——之后无关的登入不该补送。 */
  onLoginDismiss?: () => void;
}

const VIDEO_SRC = "/promo/eimu-promo.mp4";
const POSTER_SRC = "/promo/eimu-promo-poster.jpg";
const COVER_SRC = "/promo/eimu-promo-cover.jpg";

/** 封面画布：1920×1080（见 promo-video/cover.html）。 */
const COVER_W = 1920;
const COVER_H = 1080;
/**
 * `.prompt` 框在画布上的矩形（见 cover.html）。真输入框照这组数字盖上去，并
 * **四周各出血 6px**：封面那张框是画上去的（自带文字、游标与送出钮），盖不干净
 * 就会在圆角边缘露一线双层。出血只吃掉框外 6px 的背景渐层，肉眼无感。
 */
const BOX_BLEED = 6;
const BOX = { left: 294 - BOX_BLEED, top: 690 - BOX_BLEED, width: 700 + BOX_BLEED * 2, height: 112 + BOX_BLEED * 2 };
/** 框中心（先把画面中心对到这里，再看什么尺寸下最好用）。 */
const BOX_CX = (BOX.left + BOX.width / 2) / COVER_W;
const BOX_CY = (BOX.top + BOX.height / 2) / COVER_H;

/** 画布 px → 容器高度百分比（容器已锁 16:9，故 cqh 即等比缩放）。 */
const cqh = (px: number): string => `${((px / COVER_H) * 100).toFixed(4)}cqh`;
const pct = (value: number, total: number): string => `${((value / total) * 100).toFixed(4)}%`;

export function PromoIntroOverlay({
  onTrial,
  onDismiss,
  needsLogin = false,
  onLoginDismiss,
}: PromoIntroOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  /** 播放收尾（自然播完，或按了跳过）：换成封面＋可输入的那一句。 */
  const [settled, setSettled] = useState(false);
  /** 自动播放整条被挡：退成海报＋播放钮。 */
  const [needsTap, setNeedsTap] = useState(false);
  /** 使用者打的那句话。 */
  const [text, setText] = useState("");
  /** 直式（手机）：封面要放大到框好按的大小。 */
  const [portrait, setPortrait] = useState(false);
  /**
   * 送出钮的 0.2 秒转圈（2026-09-27 项目负责人裁定）：按下到「长出登入框」之间要有
   * 「真的在做事」的反馈，否则人只看到一个小框冒出来＝没接住他的动作。
   */
  const [sending, setSending] = useState(false);
  /** 登入小框（未登入时）：长在送出钮正上方，不遮盖结尾画面。 */
  const [loginOpen, setLoginOpen] = useState(false);
  const sendTimerRef = useRef<number | null>(null);

  // 浮层开著时锁住底下的页面卷动，否则手机上手指会把首页连同影片一起滑走。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // 自动播放：浏览器政策只保证静音自动播放，失败就摆播放钮，别留黑屏。
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => setNeedsTap(true));
    }
  }, []);

  // 直式萤幕：封面只占 56.25vw 的话输入框只有一百多 px 宽，手指放不下。
  // 直式改成放大到 250vw 再以框为中心——框宽约占萤幕七成，字也跟著放大。
  useEffect(() => {
    const mq = window.matchMedia("(max-aspect-ratio: 1/1)");
    const apply = (): void => setPortrait(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // 收尾出现时把游标放进输入框（只有滑鼠装置；手机自动弹键盘会吓到人）。
  useEffect(() => {
    if (!settled) return;
    if (!window.matchMedia("(hover: hover)").matches) return;
    inputRef.current?.focus();
  }, [settled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Esc 先收小框（一层一层退），没有小框才是退出整个浮层。
      if (loginOpen) {
        setLoginOpen(false);
        onLoginDismiss?.();
        return;
      }
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loginOpen, onDismiss, onLoginDismiss]);

  // 卸载时把那个 0.2 秒的计时器收干净（人可能在转圈途中就按了先逛逛）。
  useEffect(
    () => () => {
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current);
    },
    [],
  );

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
        // 由人按下的静音解除，顺手把音量补到满——不然会停在浏览器给的预设值上。
        if (!next) el.volume = 1;
      }
      return next;
    });
  }, []);

  const replay = useCallback(() => {
    const el = videoRef.current;
    setSettled(false);
    setLoginOpen(false);
    setProgress(0);
    setText("");
    if (!el) return;
    el.currentTime = 0;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => setNeedsTap(true));
    }
  }, []);

  /**
   * 送出：空框也走得通——直接按送出就是跑片中那句话。
   * 未登入走「转圈 0.2 秒 → 送出钮上方长出登入小框」（项目负责人 2026-09-27：
   * 直接弹全屏登入墙会让人丧失兴趣，先给一个正在开跑的反馈再问他要不要登入）。
   */
  const submit = useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault();
      if (sending) return;
      const payload = text.trim() || PROMO_TRIAL_PROMPT;
      // 未登入也先交给上层：上层据登入态分流，未登入那条只把这句话存成 pending
      // （ref ＋ sessionStorage）、不关浮层。以前这里未登入直接跳过 onTrial ⇒ pending
      // 从没写进去，微信登入成功后补送 effect 无话可送、停在「正在进入…」；GitHub
      // 跳转回来那句话也已经丢了（2026-09-30 E2E 实锤）。
      onTrial(payload);
      if (!needsLogin) return;
      setSending(true);
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current);
      sendTimerRef.current = window.setTimeout(() => {
        sendTimerRef.current = null;
        setSending(false);
        setLoginOpen(true);
      }, 200);
    },
    [needsLogin, onTrial, sending, text],
  );

  /** 关掉登入小框（先不登录／点画面空白处）：留人在结尾画面上。 */
  const dismissLogin = useCallback(() => {
    setLoginOpen(false);
    onLoginDismiss?.();
  }, [onLoginDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Eimu 宣传片"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black"
    >
      {settled ? (
        // ── 结尾：宣传片封面当画面，封面里那个输入框换成真的 ────────────────
        <div
          className="absolute inset-0 overflow-hidden bg-[#eef1f6]"
          // 点封面空白处＝关掉登入小框（结尾画面不遮盖，随手点一下就回到原样）。
          onClick={loginOpen ? dismissLogin : undefined}
        >
          <div
            className="absolute left-1/2 top-1/2 aspect-[16/9]"
            style={{
              // 横式＝整张封面完整入镜（contain）：缩到能塞进视窗的最小那组尺寸，
              // 多出来的边留给同色底。**曾经写成 max(100vw, 177.78vh) 想「不留
              // 黑边」，结果视窗比例接近 16:9 时封面被放大到高度溢出——品牌标与
              // 右上「成片」标签整个被切掉、底下还留一条空带（2026-09-27 项目负责人
              // 截图实锤「你交给我的什么玩意啊」）。海报式结尾就该完整入镜。
              // 直式＝放大到框好按（手机手指放得下），此时刻意只露出框那一段。
              width: portrait ? "250vw" : "min(100vw, 177.78vh)",
              // 对齐点＝画面中心：横式对封面中心，直式对输入框中心。
              // 百分比是自身尺寸的比例，所以任何缩放都成立。
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

            {/* 真输入框：pt-2 那组玻璃样式逐字沿用 promo-video/cover.html 的 .prompt。
                它会精准盖住封面里画上去的框（座标同源），所以看不到两层字。 */}
            <form
              onSubmit={submit}
              onClick={(event) => event.stopPropagation()}
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
                disabled={sending}
                className="grid shrink-0 cursor-pointer place-items-center rounded-full bg-[#2d3142] text-white lg-transition hover:bg-[#272b39] active:scale-95 disabled:cursor-progress"
                style={{
                  width: cqh(76),
                  height: cqh(76),
                  boxShadow: "0 12px 26px rgba(45,49,66,.28), inset 0 1.5px 0 rgba(255,255,255,.25)",
                }}
              >
                {sending ? (
                  <Loader2 className="h-[45%] w-[45%] animate-spin" strokeWidth={2.6} aria-hidden="true" />
                ) : (
                  <ArrowUp className="h-[45%] w-[45%]" strokeWidth={2.6} aria-hidden="true" />
                )}
              </button>
            </form>

            {/* 登入小框：钉在送出钮正上方（同一套容器座标，任何缩放都对得住），
                自身尺寸用 CSS px——它是要给手指按的 UI，不该跟著封面缩放。
                点画面空白处＝关掉它（结尾画面其余部分全程可见，不遮盖）。 */}
            {loginOpen && (
              <div
                className="absolute z-10"
                style={{
                  left: pct(BOX.left + BOX.width / 2, COVER_W),
                  bottom: cqh(COVER_H - BOX.top + 16),
                  transform: "translateX(-50%)",
                }}
              >
                <PromoLoginPopover onDismiss={dismissLogin} />
              </div>
            )}

            {/* 结尾画面的大下载钮（项目负责人：2026.08.29 那行下方放一颗大的、内容自动识别）：
                座标在 DesktopDownloadButton 内以封面画布为准（cqh()/pct()），与本容器同一个
                `container-type: size` 座标系；落在 .prompt 与 .cap 之下、不重叠。 */}
            <DesktopDownloadButton variant="hero" />
          </div>

          {/* 两个退路固定在萤幕上（不随封面缩放跑掉）。 */}
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
            // 播放钮的去留绑真实播放状态：真的在播了就收掉。以前只在 play() 被挡时
            // 设 true、从不复位，按下播放后那颗钮就一直钉在画面正中间挡片
            // （2026-09-30 手机实锤）。
            onPlaying={() => setNeedsTap(false)}
            onEnded={settle}
          />

          {/* 自动播放被挡时唯一出路：整屏都是播放钮（手机上点哪都能播），
              中间那颗只是视觉提示；一开始播就消失。 */}
          {needsTap && (
            <button
              type="button"
              onClick={replay}
              aria-label="播放"
              className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/30"
            >
              <span className="lg-sheet flex items-center gap-2 rounded-full px-5 py-3 text-[15px] font-medium text-white">
                <Play className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                点击播放
              </span>
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

          {/* 真实播放进度（不是装饰百分比）：影片还有多久由这条线讲。 */}
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
