"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { AGENT_TEMPLATE_DOMAIN_LABELS, type AgentPipelineStep, type AgentTemplate } from "@/lib/agent-templates";
import { forceStartAtcTour, maybeStartAtcTour } from "@/lib/atc-tour-content";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import { cn } from "@/lib/utils";
import "../case-showcase.css";
import "./agent-template-carousel.css";

interface AgentTemplateCarouselProps {
  templates: AgentTemplate[];
  /** 第二参 = 卡面圆环选中的环节 indices（升序；全选 = 全部 index，上层 cropTemplate 零开销）。 */
  onUseTemplate: (template: AgentTemplate, selectedSteps: number[]) => void;
}
/** 卡面转角相对环角的压缩比。1 = 严格贴合圆周切线，但边卡会侧得几乎只剩一条线；
 *  0.82 是「还能看清是什么图」和「有空间纵深」之间的平衡（coverflow 的经典做法）。*/
const TILT = 0.82;
/** 環半徑放大（2026-08-25 暴君裁定：在 CaseShowcase 的 ×2 基礎上再翻倍 = ×4），
    不改任何卡片寬高；遠景的留白與中心卡的視覺重量因此更乾淨。 */
const RADIUS_SCALE = 4;
/** 转角上限。夹住之后没有一张卡面会翻过 90°，所以永远不会出现背面。 */
const TILT_MAX = 80;
/** z 位移的软化系数。纯几何的 R(cosφ−1) 会让后排缩得太小，0.78 收一收。 */
const DEPTH = 0.78;
/** 越远越往上抬，环看起来像朝纵深「拱」起，而不是平铺一排。 */
const LIFT = 26;
/** 整段滚动对应的转角：宽屏一圈，窄屏收敛到 200°（手机上主要靠横滑）。 */
const SWEEP_WIDE = 360;
const SWEEP_COMPACT = 200;
/** 拖一张卡的宽度 ≈ 转过一格。 */
/** 拖过「卡宽 × 这个比例」= 转一格。
 *  0.85 太重：手机上一张卡 340px，要拖 289px 才算一格，正常一次滑动只有 0.5 格，
 *  于是「滑了半张又弹回去」。0.62 让一次自然的滑动就足够跨过一格。 */
const DRAG_CARD_RATIO = 0.62;
/** 末速度 → 外推格数的增益。commit() 会把结果夹在 1 格以内，所以这里只影响
 *  「多快算一次甩动」，不影响「能翻几张」。 */
const FLICK_GAIN = 0.34;
/** 连续输入停止多久算一段手势结束。太长会让落格显得迟疑，太短会把一次滚动切成两段。 */
const SETTLE_MS = 130;
const PANEL_MS = 120;

/* ── 弹簧 ──
   原本这里是 `angle += (target − angle) * 0.2`。两个病灶：
   ① 指数逼近永远不会 overshoot，末端是「爬」到位再突然停 —— 这就是「停靠生硬」
      的数学原因，不是参数没调好。
   ② 每帧固定系数 = 收敛速度随刷新率变，120Hz 上动效快一倍。
   换成二阶弹簧（速度 + 劲度 + 阻尼，按 dt 积分）：甩动的速度能连续交接给弹簧，
   末端有极轻的 overshoot，且屏幕无关。 */
/** 输入进行中（滚动）：硬弹簧，几乎贴着手走。 */
const SPRING_TRACK = { k: 340, ratio: 0.9 };
/** 放手后落格：软一档、阻尼比 0.74 → ~4% 的极轻 overshoot（「吻上去」的手感）。 */
const SPRING_SETTLE = { k: 168, ratio: 0.74 };
/** 单帧最大积分步长。切标签页回来时 dt 可能是几百毫秒，直接积分会炸。 */
const MAX_DT = 1 / 30;

/* ── 光照 ──
   光源固定在左前方。卡片转动时高光带扫过表面 —— 「光随转动移动」是大脑判定
   实体/贴图的首要线索，比任何静态材质都重要。 */
const LIGHT_DEG = -13;
/** 玻璃厚度相对卡宽的比例，和 CSS 的 --case-bevel-w 必须同值。 */
const GLASS = 0.062;

/** 把角度收进 (−180, 180]，让 φ 始终表示「离正面多远」。 */
function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** 转到第 index 格时，选与当前值同侧最近的那个等价角 —— 永远走近路，不倒着绕一圈。
 *  step 作参数传入：案例环的格数会随「用户投稿」合入变化，STEP 只在组件内成立。 */
function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

/** GLSL 的 smoothstep：兩端導數為 0，所以是「平台 → 斷崖 → 平台」而不是單調衰減。 */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照。
 *  几何量返回的是「R 的倍率」和「卡宽的倍率」而不是像素 —— 因为这一份公式要同时
 *  服务两个调用方：paint() 乘上实测 R，SSR 的 staticFrame() 交给 CSS calc() 去解。
 *  以前这两处各抄一份，必然分叉。 */
function computeFrame(phi: number) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const depth = (cos + 1) / 2; // 1 = 正对镜头，0 = 环的背面
  const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, phi * TILT));
  const tiltRad = (tilt * Math.PI) / 180;

  /* 镜面对齐度：卡面法线与「视线⊕光源」的半角向量的夹角余弦。
     三次方是收窄高光的经典做法（Phong 的 shininess）；0.22 是环境光底噪，
     否则转到侧面的卡会黑成一片死板。 */
  const align = Math.max(0, Math.cos(tiltRad - (LIGHT_DEG * Math.PI) / 180));
  const sheen = 0.22 + 0.78 * Math.pow(align, 3);

  /* ── 側壁寬度：為什麼是 tan 而不是 sin ──
     一塊厚 T 的板轉 θ 之後，投影輪廓寬 = W·cosθ + T·sinθ。也就是側面出現在
     **正面投影之外**，輪廓因此變寬。上一版把側面畫在卡面「裡面」（scaleX），
     輪廓永遠等於正面投影 —— 那正是「從側面看還是像一張紙」的數學原因，
     不是漸層調得不夠好。

     這條帶子和卡面一起吃了 rotateY 的 cosθ 壓縮，所以要在卡面座標裡給
     T·tanθ，投影出來才剛好是 T·sinθ。tan 在 θ→90° 發散，夾在 1.5（≈56°）:
     再側的卡不透明度只剩 0.07，本來就看不見。 */
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    /** ×R */ xF: sin,
    /** ×R */ zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    /* 靜止時：正面 1.0、相鄰 ±60° 落在 0.21、背面 0.07 —— 側卡不搶鏡頭（原始需求）。
       但 pow(depth, 7) 在 30° 就掉到 0.64：拖動途中兩張卡同時半透明疊在淺色背景上
       → 整片發灰，正是使用者截圖裡那張慘白的卡。smoothstep 給的是**平台加斷崖**，
       0~30° 幾乎不掉（30° → 0.90），45° 才開始讓位，60° 準時交棒。 */
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    /* 模糊量化到 0.5px：filter 每次变化都要重新栅格化这一层。 */
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    /** ×卡宽：高光带随倾角横向扫过 */
    sheenXF: (tilt / TILT_MAX) * 0.55,
    /** ×卡宽：側壁在卡面座標裡的寬度。rotateY(+θ) 时右缘转离视线 → 露出左侧面。 */
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    /* 迎光侧的棱线。左切面同时是迎光侧，所以左棱更亮。 */
    rimL: tilt > 0 ? 0.20 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    /* ×卡宽：照片沉在玻璃背面，侧看时反向错开。錯開量必須小於 .case-photo 的
       scale 餘量（1.075 → 每側 3.75%），否則側看時照片邊緣會露出容器底。 */
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿，用于首帧和无 JS 状态。
 *  没有这一步，六张卡会先叠在正中央闪一帧，水合后才散开。
 *  step 作参数传入：用户投稿案例合入后格数变化，STATIC_FRAMES 随 cases 重建。 */
function staticFrame(index: number, step: number) {
  const f = computeFrame(wrap(index * step));
  return {
    transform: `translate3d(calc(var(--case-radius) * ${f.xF.toFixed(4)}), ${f.lift.toFixed(2)}px, calc(var(--case-radius) * ${f.zF.toFixed(4)})) rotateY(${f.tilt.toFixed(2)}deg)`,
    opacity: f.opacity.toFixed(3),
    zIndex: f.zIndex,
    "--case-depth": f.depth.toFixed(3),
    "--case-blur": `${f.blur}px`,
    "--case-sheen": f.sheen.toFixed(3),
    "--case-sheen-x": `calc(var(--case-card-w) * ${f.sheenXF.toFixed(4)})`,
    "--case-side-l": `calc(var(--case-card-w) * ${f.sideLF.toFixed(4)})`,
    "--case-side-r": `calc(var(--case-card-w) * ${f.sideRF.toFixed(4)})`,
    "--case-rim-l": f.rimL.toFixed(3),
    "--case-rim-r": f.rimR.toFixed(3),
    "--case-parallax": `calc(var(--case-card-w) * ${f.parallaxF.toFixed(4)})`,
  } as React.CSSProperties;
}



function rgbTriple(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ── 圆形环节选择器（2026-08-26；2026-08-29 增送出钮/全选框）──
   卡面底部的流水线步骤从「黑话文字链」换成可拖拽多选的圆环：
   每个圆 = 一个环节（shortName），默认一个都没选；单击圆切换该圆；
   按住拖过 = 只跑扫过的（「选择部分为正」）；左侧勾选框 = 全选，
   右侧箭头 = 送出（预设不可用，不可用态点击播假鼠标引导）。

   监听器规范（项目有血的教训，不许砍）：
   - pointer 事件完整四件套（down/move/up/cancel）+ setPointerCapture，
     否则触控板/触摸扫过无反应；
   - 圆上 touch-action: none（touch-none），防止浏览器把手势抢走触发 pointercancel；
   - 拖拽手势期间吞掉收尾的杂散 click（suppressClickRef），不触发卡片套模板。 */
interface PipelineStepSelectorProps {
  steps: AgentPipelineStep[];
  /** 已选中的步骤 indices；undefined = 一个都没选（默认态，送出钮不可用）。 */
  selected: number[] | undefined;
  onToggle: (index: number, select: boolean) => void;
  /** 拖拽手势的整集提交：以传入集合为新的执行正集（全量 = 全选态，等价勾选框）。 */
  onSelectOnly: (indices: number[]) => void;
  /** 送出（右侧箭头）：仅在至少选了一个环节时可用；不可用态点击 = 播假鼠标引导。 */
  onSubmit: () => void;
}

function PipelineStepSelector({ steps, selected, onToggle, onSelectOnly, onSubmit }: PipelineStepSelectorProps) {
  /**
   * 进行中的拖拽手势。2026-08-27 裁定：拖拽语义为**恒正向选取**——一旦按住
   * 某站开始拖，执行正集立即重置为「已扫过的路径」，此后扫到的站逐个并入，
   * 松手后只跑扫出来的子集（「选择部分为正」）。取消单个环节仍用单击 toggle。
   * 2026-08-29 改版：默认一个都没选（送出钮不可用）；「全选」收归左侧勾选框。
   *
   * pointerup 分流：
   * - 按在站上没动过 → 单击 toggle；
   * - 没按在站上且没动过（点了 Dock 空白）→ 全选（等价勾选框）；
   * - 拖拽动过 → 全部由 move 提交，这里只收尾徽章。
   *
   * 监听器规范（项目有血的教训，不许砍）：
   * - pointer 事件完整四件套（down/move/up/cancel）挂 window **capture 阶段**
   *   （轮播壳 stage 的转卡 move 不许拦）；
   * - 圆上 touch-action: none（touch-none），防浏览器抢手势触发 pointercancel；
   * - 拖拽手势期间吞掉收尾的杂散 click，不触发卡片套模板。
   */
  const gestureRef = useRef<{
    started: boolean;
    chosen: Set<number>;
    pressMoved: boolean;
    startX: number;
    startY: number;
    pressedIndex: number | null;
  } | null>(null);

  /* 拖拽徽章计数：拖选手势进行中 >0，松手即归零。单击不闪。 */
  const [dragCount, setDragCount] = useState<number | null>(null);

  /* 送出钮可用性：至少选了一个环节。默认一个都没选 → 不可用态。 */
  const selectedCount = selected?.length ?? 0;
  const canSubmit = selectedCount > 0;
  /* 勾选框 = 全选开关：所有环节都在正集里 = 勾上。 */
  const allSelected = steps.length > 0 && selectedCount === steps.length;

  const selectFromPoint = (clientX: number, clientY: number): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const hit = document.elementFromPoint(clientX, clientY)?.closest("[data-step-index]");
    if (!hit) return;
    const index = Number(hit.getAttribute("data-step-index"));
    if (Number.isNaN(index)) return;
    if (!gesture.started) {
      // 正集重置为路径起点——预设全选此刻让位给「你拖出的正集」。
      gesture.started = true;
      gesture.chosen.add(index);
      setDragCount(gesture.chosen.size);
      onSelectOnly([...gesture.chosen]);
      return;
    }
    if (gesture.chosen.has(index)) return;
    gesture.chosen.add(index);
    setDragCount(gesture.chosen.size);
    onSelectOnly([...gesture.chosen]);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    /* 全选框/送出钮是独立控件：不进步骤拖选手势，只拦 stage 转卡；
       它们自己的 onClick 负责切换/送出（不可用送出 → 假鼠标引导）。 */
    if ((event.target as Element).closest("[data-atc-control]")) {
      event.stopPropagation();
      return;
    }
    const hit = (event.target as Element).closest("[data-step-index]");
    gestureRef.current = {
      started: false,
      chosen: new Set(),
      pressMoved: false,
      startX: event.clientX,
      startY: event.clientY,
      pressedIndex: hit ? Number(hit.getAttribute("data-step-index")) : null,
    };
    event.stopPropagation(); // 不交给 stage：不进卡片拖拽、不触发套模板
    /* 触控板修复：监听必须挂 **capture 阶段**（第三参 true）。
       冒泡阶段会被轮播壳 stage 的 pointermove（转卡逻辑）截断——capture 在
       捕获顶端先于任何 React handler 执行，任何层都拦不住。 */
    window.addEventListener("pointermove", handleWindowMove, true);
    window.addEventListener("pointerup", handleWindowUp, true);
    window.addEventListener("pointercancel", handleWindowUp, true);
  };

  const handleWindowMove = (event: PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (
      !gesture.pressMoved &&
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 8
    ) {
      gesture.pressMoved = true;
    }
    selectFromPoint(event.clientX, event.clientY);
  };

  const handleWindowUp = (): void => {
    const gesture = gestureRef.current;
    if (gesture && !gesture.pressMoved) {
      if (gesture.pressedIndex !== null) {
        // 单击：切换按下的圆（默认一个没选 → 首次单击 = 选中）
        const index = gesture.pressedIndex;
        const isSelected = selected?.includes(index) ?? false;
        onToggle(index, !isSelected);
      } else {
        // Dock 空白单击：全选（等价勾选框）
        onSelectOnly(Array.from({ length: steps.length }, (_, i) => i));
      }
    }
    gestureRef.current = null;
    setDragCount(null); // 徽章只在拖拽手势存活期间显示
    window.removeEventListener("pointermove", handleWindowMove, true);
    window.removeEventListener("pointerup", handleWindowUp, true);
    window.removeEventListener("pointercancel", handleWindowUp, true);
  };

  /* 三步 driver.js 教学（与专业模式 LoRA 引导同款基建）：圆环首次出现播一次，
     localStorage「看过」永不打扰。8 张卡各有一颗 selector 同帧挂载，模块级
     单飞闸（maybeStartAtcTour 内）保证整页只起一场；延迟到轮播 paint 完成后再启动，
     卸载（gallery 收起/换卡面）即取消，不打断正在生成里的用户。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void maybeStartAtcTour();
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="relative w-full">
      {/* Bug2 拖拽徽章：白玻璃小胶囊，悬浮 Dock 上方；手势结束即消失。 */}
      
      {/* 引导文案：一行讲清「勾选全选 + 单击开关 + 拖拽=选正集」三种动线。 */}
      <p
        data-atc-hint
        className="mb-1.5 select-none text-center text-[11px] leading-[1.4] text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.75)]"
      >
        {dragCount !== null
          ? `已选 ${dragCount}/${steps.length} · 松开完成`
          : "勾选 = 全部执行 · 单击环节开/关 · 按住拖过 = 只跑扫过的"}
      </p>
      <div
        role="group"
        aria-label="选择要套用的环节，右侧箭头送出开工"
        data-atc-dock
        /* 玻璃 Dock（视觉模型复审参数）：全宽等分——左侧全选勾选框、中间环节
           轨道（窄卡独立横向滚动）、右侧送出钮常驻不随轨道滚走；
           深色半透明 + blur + 1px 白 12% 边。 */
        className="atc-step-selector atc-step-dock flex h-8 w-full max-w-full items-center rounded-full border border-white/[0.12] bg-black/[0.35] px-1.5 backdrop-blur-md"
        onPointerDown={handlePointerDown}
        /* 触控板按住拖动在某些环境触发原生 drag（文本/元素拖拽）→ pointercancel
           提前杀手势。整条 Dock 禁 drag。 */
        onDragStart={(event) => event.preventDefault()}
        draggable={false}
        onClick={(event) => {
          /* 鼠标/触摸的 click 是 pointerup 的兼容补发，单击已在 up 里切换过——
             这里一律吞掉，防双切换与冒泡套模板。键盘（detail=0）不走 pointerdown，
             照常放行让圆 onClick 切换。 */
          if ((event as React.MouseEvent).detail !== 0) {
            event.stopPropagation();
          }
        }}
      >
        {/* 全选勾选框（2026-08-29 替换六点把手）：照顾「全选」这个高频动作，
            勾上 = 所有环节进正集 + 送出钮转可用；再点 = 清空回不可用态。 */}
        <button
          type="button"
          role="checkbox"
          aria-checked={allSelected}
          aria-label="全部执行"
          title={allSelected ? "取消全选" : "勾选 = 全部执行"}
          data-atc-control
          onClick={(event) => {
            event.stopPropagation(); // click 一律不冒泡成卡片套模板（含键盘 detail=0）
            onSelectOnly(allSelected ? [] : Array.from({ length: steps.length }, (_, i) => i));
          }}
          className={cn(
            "ml-0.5 mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
            allSelected
              ? "border-white bg-white"
              : "border-white/40 bg-white/[0.06] hover:border-white/70",
          )}
        >
          {allSelected && <Check className="h-3 w-3 text-black" strokeWidth={3.5} aria-hidden="true" />}
        </button>
        {/* 环节轨道：独立横向滚动（滚动条隐藏），两侧控件常驻不随滚走。 */}
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x">
        {steps.map((step, index) => {
        const isSelected = selected?.includes(index) ?? false;
        return (
          <div key={step.name} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              data-step-index={index}
              aria-pressed={isSelected}
              aria-label={`环节：${step.name}${isSelected ? "，已选中" : "，未选中"}`}
              title={step.name}
              onClick={(event) => {
                event.stopPropagation(); // 站上的点击永不触发套模板
                /* 键盘合成 click（detail=0）才在这里切换；鼠标/触摸的 click
                   是兼容补发，切换已在 pointerup 完成。 */
                if ((event as React.MouseEvent).detail !== 0) return;
                onToggle(index, !isSelected);
              }}
              onKeyDown={(event) => {
                /* 站是独立焦点目标：方向键/Home/End 不冒泡给 stage 的轮播键盘导航。 */
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                  event.stopPropagation();
                }
              }}
              /* 2026-08-26 终审（8.8→PASS）：删掉选中态小药丸底（视觉模型：
                 2 字词有底 3 字词裸奔 =「长斑」），统一纯文字等宽分布，
                 状态只用透明度梯度（选中 100% 白 + 字影，未选中 45%）；
                 字影保右侧亮云背景上的识别度。 */
              className={cn(
                "atc-step-chip inline-flex h-10 w-full touch-none select-none items-center justify-center rounded-full px-1",
                "text-[10px] leading-none tracking-[-0.2px] transition-colors duration-150 motion-reduce:transition-none",
                "[text-shadow:0_1px_2px_rgba(0,0,0,0.5)]",
                /* 按压反馈：按下即提亮（触控板用户需要立刻看到「收到了」）。 */
                "cursor-pointer active:brightness-150",
                isSelected
                  ? "font-semibold text-white"
                  : "font-medium text-white/80 hover:text-white/95",
              )}
            >
              {step.shortName}
            </button>
            {/* 三审裁定：拔掉贯穿线——透明度梯度（选中 100% / 未选中 45%）+
                白玻璃高亮胶囊已足以表达流程关系，物理连线是画蛇添足。 */}
          </div>
        );
      })}
        </div>
        {/* 送出钮（2026-08-29）：链最右端的明确 CTA。预设不可用（一个环节都没选），
            不可用态点击 = 播一次假鼠标引导教选取；可用 = 白色实心圆，Dock 上唯一的
            高对比点。aria-disabled 而非 disabled：按钮保持可点，点击本身就是帮助。 */}
        <button
          type="button"
          aria-label={canSubmit ? "送出，按所选环节开工" : "送出（先选环节）"}
          aria-disabled={!canSubmit}
          title={canSubmit ? "按所选环节开工" : "先选环节，或勾选全部"}
          data-atc-control
          onClick={(event) => {
            event.stopPropagation();
            if (!canSubmit) {
              forceStartAtcTour();
              return;
            }
            onSubmit();
          }}
          className={cn(
            "ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-200 motion-reduce:transition-none active:scale-90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
            canSubmit
              ? "cursor-pointer bg-white text-black shadow-[0_2px_12px_rgba(0,0,0,0.4)] hover:bg-white/90"
              : "cursor-pointer border border-white/15 bg-white/[0.08] text-white/70",
          )}
        >
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function AgentTemplateCarousel({ templates, onUseTemplate }: AgentTemplateCarouselProps) {
  /* 案例环数据：官方六例 + 本机发布的「用户投稿」案例（showcase-user-cases）。
     用户案例合入后每格角度改变，由下方的 reset effect 把环拉回第一张。 */
  const cases = templates;
  const COUNT = cases.length;
  const STEP = 360 / COUNT;
  /* 静态帧（首帧/无 JS）：cases 不变时引用稳定，React 的 style diff 直接跳过，
     不会覆写 paint() 每帧写进 node.style 的那份值。 */
  const STATIC_FRAMES = useMemo(
    () => cases.map((_, index) => staticFrame(index, STEP)),
    [cases, STEP],
  );

  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  /* 每張卡的 GL draw()。玻璃是靜物，但玻璃上的**光**要跟著轉動走，所以由這個
     本來就在跑的手勢迴圈推它重畫 —— 事件驅動，GL 那邊不自己開 rAF。 */
  const glDrawRefs = useRef<Array<((tiltDeg: number) => void) | null>>([]);
  const glTiltRefs = useRef<number[]>([]);

  /* 环角只活在 ref 里 —— 每帧 setState 会把 6 张卡的 React 树重算 60 次/秒。
     rAF 直接写 DOM style，React 只在「正面换人」时才 render。 */
  const targetRef = useRef(0);
  const angleRef = useRef(0);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(0);
  const prevCountRef = useRef(COUNT);

  /* 磁力需要三个角度而不是一个，混用就会得到「不够 sticky」：
       rawRef    —— 手指/滚轮真实累加的原始角度，**不带** detent 形变。
                    落格判定必须用它：形变过的角度会低报用户实际走了多远。
       angleRef  —— 屏幕上这一帧的角度（detent 拧过 / 弹簧积分出来的）。
       originRef —— 本次手势起点所在的卡位。落格 = origin + 走过的格数。 */
  const rawRef = useRef(0);
  const originRef = useRef(0);

  /* 二阶弹簧的状态：角速度 + 当前劲度/阻尼档位 + 上一帧时刻。
     dt 积分而不是每帧固定 lerp —— 120Hz 屏和 60Hz 屏必须跑出同一条曲线。 */
  const velRef = useRef(0);
  const springRef = useRef(SPRING_SETTLE);
  const lastTsRef = useRef(0);

  const engagedRef = useRef(false);
  const lastScrollRef = useRef(0);
  const degPerPxRef = useRef(0.3);
  const radiusRef = useRef(812);
  const cardWRef = useRef(520);
  const dragDegPerPxRef = useRef(0.14);
  const reduceRef = useRef(false);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragXRef = useRef(0);
  const velocityRef = useRef(0);
  const lastMoveAtRef = useRef(0);

  const [front, setFront] = useState(0);
  const [panel, setPanel] = useState(0);

  /* ── 环节选择（2026-08-29 语义改版）：每张卡独立记忆选中的环节 indices ──
     key 缺失 = 一个都没选（默认态，送出钮不可用）；全选 = 存满量数组
     （上层 cropTemplate 对全量短路返回原对象，零开销）。空集一律删 key
     归默认态。送出永远不会带空数组：不可用态挡在按钮上。 */
  const [selectedStepsByTemplate, setSelectedStepsByTemplate] = useState<Record<string, number[]>>({});
  const handleStepToggle = useCallback(
    (templateId: string, count: number) => (index: number, select: boolean) => {
      setSelectedStepsByTemplate((prev) => {
        const next = new Set(prev[templateId] ?? []);
        if (select) next.add(index);
        else next.delete(index);
        const sorted = [...next].sort((a, b) => a - b);
        if (sorted.length === 0) {
          const rest = { ...prev };
          delete rest[templateId];
          return rest;
        }
        return { ...prev, [templateId]: sorted };
      });
    },
    [],
  );
  /** 拖拽正集/勾选框整集提交（2026-08-27）：传入集合即新的执行环节；空集 = 清空回默认态。 */
  const handleSelectOnly = useCallback(
    (templateId: string, count: number) => (indices: number[]) => {
      setSelectedStepsByTemplate((prev) => {
        const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
        if (sorted.length === 0) {
          const rest = { ...prev };
          delete rest[templateId];
          return rest;
        }
        return { ...prev, [templateId]: sorted };
      });
    },
    [],
  );

  /* ── 完整模板确认弹窗（2026-08-29）：旧入口「点卡片」保留，但先问一句 ── */
  const [confirmTemplate, setConfirmTemplate] = useState<AgentTemplate | null>(null);

  /** 卡片尺寸、环半径、滚动灵敏度全从舞台实测宽度推出来，写成 CSS 变量。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const section = sectionRef.current;
    if (!stage) return;

    const stageWidth = stage.clientWidth || 1024;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    /* 2026-08-25 暴君裁定：卡片放大 75%（桌面）。2026-08-27 手机端返工：
       SIZE_GAIN 只给桌面——compact 下 340×1.75=595px 塞 390px 视口，
       内容左右截断装不下。手机端用紧凑尺寸（0.78 系数 + 340 上限原样）。 */
    const SIZE_GAIN = compact ? 1 : 1.75;
    const cardW = compact
      ? Math.min(stageWidth * 0.78, 340)
      : Math.min(Math.max(stageWidth * 0.42, 300), 580) * SIZE_GAIN;
    const cardH = Math.round(cardW * 0.75);
    const radius = cardW * (compact ? 0.84 : 0.78) * RADIUS_SCALE;

    radiusRef.current = radius;
    cardWRef.current = cardW;
    dragDegPerPxRef.current = STEP / (cardW * DRAG_CARD_RATIO);

    stage.style.setProperty("--case-card-w", `${Math.round(cardW)}px`);
    stage.style.setProperty("--case-card-h", `${cardH}px`);
    stage.style.setProperty("--case-radius", `${Math.round(radius)}px`);
    stage.style.height = `${Math.round(cardH * 1.2)}px`;

    const travel = (section?.offsetHeight ?? 640) + window.innerHeight;
    degPerPxRef.current = (compact ? SWEEP_COMPACT : SWEEP_WIDE) / Math.max(travel, 1);
  }, [STEP]);

  /** 每帧唯一的写 DOM 处。React 不参与：它只在「正面换人」时 render 一次。 */
  const paint = useCallback((angle: number) => {
    if (angle === paintedRef.current) return;
    paintedRef.current = angle;

    const radius = radiusRef.current;
    const cardW = cardWRef.current;
    let frontIndex = 0;
    let frontDepth = -1;

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      if (!node) continue;

      const f = computeFrame(wrap(i * STEP - angle));
      const s = node.style;

      s.transform = `translate3d(${(radius * f.xF).toFixed(2)}px, ${f.lift.toFixed(2)}px, ${(radius * f.zF).toFixed(2)}px) rotateY(${f.tilt.toFixed(2)}deg)`;
      s.opacity = f.opacity.toFixed(3);
      /* 景深模糊移到 .case-face（正面那一疊）。留在 .case-slab 上的話，側壁作為
         溢出子節點會被 filter 的作用範圍裁掉 —— 而側壁是厚度的唯一證據。 */
      s.zIndex = String(f.zIndex);
      s.pointerEvents = f.depth > 0.4 ? "auto" : "none";
      s.setProperty("--case-depth", f.depth.toFixed(3));
      s.setProperty("--case-blur", `${f.blur}px`);
      /* 光照四件套。这些是「光随转动移动」的实现 —— 静态材质做不出实体感。 */
      s.setProperty("--case-sheen", f.sheen.toFixed(3));
      s.setProperty("--case-sheen-x", `${(cardW * f.sheenXF).toFixed(2)}px`);
      s.setProperty("--case-side-l", `${(cardW * f.sideLF).toFixed(2)}px`);
      s.setProperty("--case-side-r", `${(cardW * f.sideRF).toFixed(2)}px`);
      s.setProperty("--case-rim-l", f.rimL.toFixed(3));
      s.setProperty("--case-rim-r", f.rimR.toFixed(3));
      s.setProperty("--case-parallax", `${(cardW * f.parallaxF).toFixed(2)}px`);

      /* 把傾角推進 shader：高光滑過玻璃、受光側的邊變厚，都是這個值在驅動。
         門檻 0.4° + 只重畫看得見的兩三張（depth > 0.5）—— 拖動時 GPU 上的
         實際負擔是一到兩張卡，不是六張。 */
      const glDraw = glDrawRefs.current[i];
      if (glDraw && f.depth > 0.5 && Math.abs(f.tilt - (glTiltRefs.current[i] ?? 999)) > 0.4) {
        glTiltRefs.current[i] = f.tilt;
        glDraw(f.tilt);
      }

      if (f.depth > frontDepth) {
        frontDepth = f.depth;
        frontIndex = i;
      }
    }

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      const flag = i === frontIndex ? "true" : "false";
      if (node && node.dataset.front !== flag) node.dataset.front = flag;
    }

    if (frontIndex !== frontRef.current) {
      frontRef.current = frontIndex;
      setFront(frontIndex);
      glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[frontIndex].glow));
      /* 面板文案比圆点晚一步落地：快速转两圈时不该把六个标题全闪一遍。 */
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = setTimeout(() => setPanel(frontIndex), PANEL_MS);
    }
  }, [cases]);

  /* ── 弹簧积分器 ──
     ẍ = −k(x−target) − c·ẋ，c = 2ζ√k。ζ<1 让末端有极轻的 overshoot，
     这是「吻上去」和「爬到位再突然停」的全部区别。dt 积分 → 和刷新率解耦。 */
  const tick = useCallback(() => {
    rafRef.current = 0;

    if (reduceRef.current) {
      angleRef.current = targetRef.current;
      velRef.current = 0;
      paint(targetRef.current);
      return;
    }

    const now = performance.now();
    const dt = Math.min((now - lastTsRef.current) / 1000, MAX_DT);
    lastTsRef.current = now;

    const { k, ratio } = springRef.current;
    const c = 2 * ratio * Math.sqrt(k);
    const target = targetRef.current;
    let angle = angleRef.current;
    let vel = velRef.current;

    /* 一次最多追一圈：整段被飞快滚过时不该空转好几圈补进度。 */
    if (Math.abs(target - angle) > 360) angle = target - Math.sign(target - angle) * 360;

    vel += (-k * (angle - target) - c * vel) * dt;
    angle += vel * dt;

    /* 位移和速度必须同时进阈值才算静止 —— 只看位移会把 overshoot 提前截断。 */
    if (Math.abs(target - angle) < 0.02 && Math.abs(vel) < 0.6) {
      angleRef.current = target;
      velRef.current = 0;
      paint(target);
      return;
    }

    angleRef.current = angle;
    velRef.current = vel;
    paint(angle);
    rafRef.current = requestAnimationFrame(tick);
  }, [paint]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /** 落格：按「从手势起点走了几格」决定，而不是 round 到最近的一格。
   *  round 到最近 = 滑了 0.4 张会弹回原位（等于白滑），也允许 flick 凭空多翻一张。
   *  两种症状用户都碰到了，根因是同一个判定。 */
  const commit = useCallback((flickSteps: number) => {
    const travel = (rawRef.current - originRef.current) / STEP;
    const steps = commitSteps(travel, flickSteps);
    const landing = originRef.current + steps * STEP;
    rawRef.current = landing;
    targetRef.current = landing;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 连续输入（滚动 / 触控板横扫）：接收增量。
   *  原始角度累加进 rawRef，屏幕上呈现的是 detent() 拧过的版本 —— 环在卡位附近发黏、
   *  格间快速掠过，这就是「磁力」的可见部分。停手 SETTLE_MS 后按手势落格。 */
  const drive = useCallback((deltaDeg: number) => {
    // 一段滚动 = 一次手势。settle 定时器在，说明还在同一段里，起点不重取。
    if (!settleTimerRef.current) {
      originRef.current = Math.round(rawRef.current / STEP) * STEP;
    }
    rawRef.current += deltaDeg;
    targetRef.current = detent(rawRef.current, STEP);
    springRef.current = SPRING_TRACK;
    schedule();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      commit(0); // 滚动的惯性已经体现在走过的距离里，不再额外外推
    }, SETTLE_MS);
  }, [schedule, commit, STEP]);

  /** 离散跳转（箭头 / 圆点 / 键盘）：软弹簧，末端极轻回弹。 */
  const snap = useCallback((value: number) => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    rawRef.current = value;
    originRef.current = Math.round(value / STEP) * STEP;
    targetRef.current = value;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 拖曳期间手指就是位置本身：不过弹簧、不排 rAF，直接写角度立刻画。
   *  这是「跟手延迟」的解 —— 原本拖曳也要过一遍插值，手和卡永远隔着 ~80ms。
   *  但画出去的是 detent() 版本：手指能摸到卡位的阻力。 */
  const dragBy = useCallback((deltaDeg: number) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    velRef.current = 0;
    rawRef.current += deltaDeg;
    const warped = detent(rawRef.current, STEP);
    angleRef.current = warped;
    targetRef.current = warped;
    paint(warped);
  }, [paint, STEP]);

  const goTo = useCallback((index: number) => {
    snap(nearestAngleFor(index, targetRef.current, STEP));
  }, [snap]);

  const step = useCallback((dir: number) => {
    snap(Math.round(targetRef.current / STEP) * STEP + dir * STEP);
  }, [snap, STEP]);

  useIsoLayoutEffect(() => {
    measure();
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paintedRef.current = Number.NaN;
    paint(angleRef.current);

    const stage = stageRef.current;
    const observer = new ResizeObserver(() => {
      measure();
      paintedRef.current = Number.NaN;
      paint(angleRef.current);
    });
    if (stage) observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, paint]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reduceRef.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /* 案例数量变化后每格角度改变：环回到第一张，避免旧角度在新格距下错位落格。
     模板环 cases 是 props 直傳，數量變化時同樣需要重置。 */
  useEffect(() => {
    if (COUNT === prevCountRef.current) return;
    prevCountRef.current = COUNT;
    targetRef.current = 0;
    angleRef.current = 0;
    rawRef.current = 0;
    originRef.current = 0;
    velRef.current = 0;
    paintedRef.current = Number.NaN;
    if (frontRef.current !== 0) {
      frontRef.current = 0;
      setFront(0);
      setPanel(0);
    }
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paint(0);
  }, [cases, paint]);

  /* 只在这一段进入视野时累计滚动量；离开视野后滚动与它无关。 */
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        engagedRef.current = entry.isIntersecting;
        if (entry.isIntersecting) lastScrollRef.current = window.scrollY;
      },
      { rootMargin: "-12% 0px -12% 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  /* 滚动驱动旋转 —— 注意是 passive 监听、纯读取 scrollY 的增量。
     全程不 preventDefault 纵向滚动：页面永远滚得动，环只是顺带转起来。
     教学拖拽演示期间（atc-tour-locking，2026-08-27 轨迹瞬移返工）短路：
     driver.js 高亮/平滑滚动会顶起 scroll 事件 → drive() 转卡 → data-front
     换卡 → 演示目标漂移。只锁转卡手势，页面滚动本身照常。 */
  useEffect(() => {
    const onScroll = () => {
      if (sectionRef.current?.classList.contains("atc-tour-locking")) return;
      const y = window.scrollY;
      const delta = y - lastScrollRef.current;
      lastScrollRef.current = y;
      if (!engagedRef.current || draggingRef.current || reduceRef.current) return;
      drive(delta * degPerPxRef.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [drive]);

  /* 触控板横扫 / Shift+滚轮。React 的 onWheel 是 passive 注册，preventDefault
     会被忽略，所以必须手动挂 { passive: false }。且只有横向分量占优时才接管，
     纵向一律放行。教学演示期间（atc-tour-locking）同样短路转卡。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (stage.classList.contains("atc-tour-locking")) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      drive(event.deltaX * dragDegPerPxRef.current);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [drive]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    draggingRef.current = true;
    movedRef.current = false;
    dragXRef.current = event.clientX;
    velocityRef.current = 0;
    lastMoveAtRef.current = event.timeStamp;

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    /* 半空中接手：屏幕上是 detent() 拧过的角度，拖曳累加的是原始角度。
       不换算回去，手指一按就会跳一下。 */
    rawRef.current = undetent(angleRef.current, STEP);
    originRef.current = Math.round(rawRef.current / STEP) * STEP;

    stageRef.current?.setAttribute("data-dragging", "true");
    stageRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - dragXRef.current;
    if (Math.abs(dx) < 1) return;
    if (Math.abs(dx) > 3) movedRef.current = true;
    dragXRef.current = event.clientX;

    const dt = Math.max(event.timeStamp - lastMoveAtRef.current, 1);
    lastMoveAtRef.current = event.timeStamp;
    velocityRef.current = dx / dt;

    /* 内容往左拖 = 下一张转到正面，所以取 −dx。
       拖曳期间不走弹簧：手指就是位置本身，任何插值都是延迟。 */
    dragBy(-dx * dragDegPerPxRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stageRef.current?.removeAttribute("data-dragging");
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }

    /* 2026-08-25 點擊根因修復：setPointerCapture 會把後續 pointer 事件（含衍生
       click）重定向到舞台——卡片的 onClick 在多數瀏覽器根本收不到，這就是
       「點卡進不去」反覆修不掉的原因。改成 pointerup 收口：手指沒動過 =
       一次點擊，對釋放點做命中測試找到卡，激活邏輯原地執行。
       movedRef 先置 true：若瀏覽器仍補發 click，onCardClick 會直接閉嘴。 */
    if (!movedRef.current) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const slab = hit instanceof Element ? hit.closest(".case-slab") : null;
      const index = slab ? cardRefs.current.indexOf(slab as HTMLDivElement) : -1;
      if (index >= 0) {
        movedRef.current = true;
        if (index === front) {
          setConfirmTemplate(cases[front]);
        } else {
          goTo(index);
        }
      }
    }

    /* 末速度换算成「格/秒」再乘增益 —— commit() 会把它夹在 1 格以内。
       甩动只表达「方向 + 我确实想翻」，翻几张由真实拖过的距离说话。 */
    const idle = event.timeStamp - lastMoveAtRef.current > 90;
    const flickSteps = idle
      ? 0
      : (-velocityRef.current * 1000 * dragDegPerPxRef.current * FLICK_GAIN) / STEP;
    commit(flickSteps);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(COUNT - 1);
    }
  };

  /* 点边卡 = 把它转到正面；正面卡点击 = 弹「完整模板」确认（旧入口保留，多一步确认）。 */
  const onCardClick = (index: number) => {
    if (movedRef.current) return;
    if (index === front) {
      setConfirmTemplate(cases[front]);
      return;
    }
    goTo(index);
  };

  return (
    <section className="case-viewport agent-template-carousel pb-12" aria-label="助理模板" ref={sectionRef}>
      {/* 2026-08-25 用户裁定：零文案。页头标题/胶囊、底部标题+痛点+启动按钮+
          「查看初始提示词」全部删除——卡面已带全部信息，正面卡点击即启动。 */}

      <div
        ref={stageRef}
        className="case-stage"
        role="group"
        aria-roledescription="轮播"
        aria-label={`助理模板，共 ${COUNT} 张`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={glowRef} className="case-glow" aria-hidden="true" />
        {cases.map((item, index) => (
          <div
            key={item.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            className="case-slab"
            style={STATIC_FRAMES[index]}
            onClick={() => onCardClick(index)}
          >
            {/* ── 側壁：厚度的唯一真證據 ──
                必須是 .case-face 的**兄弟**而不是子節點：它要伸出正面之外才能
                把輪廓撐寬（一塊厚 T 的板轉 θ，投影寬 = W·cosθ + T·sinθ），
                而 .case-face 帶 filter，filter 會把溢出的子節點裁掉。 */}
            <div className="case-side case-side-l" aria-hidden="true" />
            <div className="case-side case-side-r" aria-hidden="true" />

            {/* ── 液態玻璃層：整張卡由 shader 成像 ──
                必須是 .case-slab 的**直接子節點**，兩個理由：
                ① 它的輪廓要外凸、起伏、伸出側壁，全都落在卡框之外，掛進帶
                   filter 的 .case-face 會被裁成直邊 —— 那就又是圓角矩形。
                ② 元件靠 host.parentElement 讀卡片的版面尺寸與四角半徑。
                就緒後它會給 .case-slab 掛上 data-glass="on"，把下面那一疊
                矩形的 HTML 圖層收掉。 */}
            {/* 模板卡：海報區 = 模範級 AI 成片封面照 + 領域漸變疊底（保證文字可讀）
                + 大字水印 + 模板名稱與流水線步驟鏈。2026-08-26：純漸變 placeholder
                換成真實 AI 成片素材（八卡各一條模範作品封面帧）。 */}
            <div className="case-face">
              <div className="case-media">
                <div className="case-photo">
                  {item.showcaseImage ? (
                    <div className={cn("absolute inset-0 bg-gradient-to-br", item.accent)}>
                      {/* 素材影片（2026-08-26 用戶裁定：卡面必須是真影片）：8 秒靜音循環。
                          poster = 封面帧 webp（影片未載入/還在緩衝時不空白）；
                          muted+playsInline+preload=metadata 才允許自動播放，
                          aria-hidden（純視覺層）。 */}
                      {item.showcaseVideo && (
                        /* eslint-disable-next-line jsx-a11y/media-has-caption, @next/next/no-img-element -- 靜態 public 資產背景層 */
                        <video
                          src={item.showcaseVideo}
                          poster={item.showcaseImage}
                          autoPlay
                          loop
                          muted
                          playsInline
                          preload="metadata"
                          aria-hidden="true"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                      {/* 無影片時的靜態兜底：封面帧照。object-cover 鋪滿。 */}
                      {!item.showcaseVideo && (
                        /* eslint-disable-next-line @next/next/no-img-element -- 靜態 public 資產，case-photo 是背景層不走 next/image */
                        <img
                          src={item.showcaseImage}
                          alt=""
                          aria-hidden="true"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                      {/* 2026-08-26 用戶裁定：真影片素材上不再疊領域大字水印——
                          那是無素材時代的 placeholder 裝飾，疊在真成片上就是噪音。 */}
                    </div>
                  ) : (
                  <div className={cn("absolute inset-0 bg-gradient-to-br", item.accent)}>
                    <span className="atc-watermark" aria-hidden="true">
                      {AGENT_TEMPLATE_DOMAIN_LABELS[item.domain]}
                    </span>
                  </div>
                  )}
                  {/* 卡面底部資訊區：標題 + 可交互選擇器 Dock。
                      （2026-08-27 回滾：eyebrow/tagline/珠鏈是錯誤 scope 的改動，
                      用戶指定的是畫布節點卡，不是 carousel 卡面。） */}
                  <div className="atc-info">
                    <div className="atc-title">{item.name}</div>
                    <PipelineStepSelector
                      steps={item.pipeline.steps}
                      selected={selectedStepsByTemplate[item.id]}
                      onToggle={handleStepToggle(item.id, item.pipeline.steps.length)}
                      onSelectOnly={handleSelectOnly(item.id, item.pipeline.steps.length)}
                      onSubmit={() => {
                        /* 送出 = 只跑勾选的环节。canSubmit 已在 selector 里挡住空集，
                           这里再护一层：cropTemplate 对空数组同样返回原模板。 */
                        const picked = selectedStepsByTemplate[item.id] ?? [];
                        if (picked.length > 0) onUseTemplate(item, picked);
                      }}
                    />
                  </div>
                </div>
              </div>
              {/* 最外緣那條掠射亮線。厚玻璃正對鏡頭時唯一「白」的地方就是這裡
                  （Fresnel≈1），只有 1px，沒有任何面積 —— 上一版給了它 43px 的
                  面積，做出來的是塑膠相框。 */}
              <div className="case-edge" aria-hidden="true" />
              <div className="case-surface" aria-hidden="true">
                <div className="case-sheen" />
                <div className="case-rim case-rim-l" />
                <div className="case-rim case-rim-r" />
              </div>
            </div>
            </div>
        ))}
      </div>

      {/* 2026-08-25 用户裁定：底部文案区全删（标题/痛点/启动按钮/查看初始提示词）。
          sr-only 播报保留（无障碍不牺牲），交互入口 = 正面卡点击 + 箭头/圆点。 */}
      <p className="sr-only" aria-live="polite">{`第 ${panel + 1} 张，共 ${COUNT} 张：${cases[panel].name}`}</p>

      <div className="mt-4 flex items-center justify-center gap-3 max-md:gap-1.5">
        {/* 桌面保留箭头；移动端 swipe 转卡即可，箭头只占黄金区（毒舌一审裁定）。 */}
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(-1)} aria-label="上一个模板">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        {/* 移动端：N/M 紧凑指示（9 个圆点在手机上是噪点）；桌面保留圆点。 */}
        <div
          role="tablist"
          aria-label={`模板进度：第 ${front + 1} 张，共 ${COUNT} 张`}
          className="max-md:rounded-full max-md:bg-black/[0.35] max-md:px-3 max-md:py-1.5 max-md:text-[11px] max-md:font-semibold max-md:text-white/85 max-md:[text-shadow:0_1px_2px_rgba(0,0,0,0.6)] flex items-center gap-1"
        >
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`case-dot ${index !== front ? "max-md:hidden" : ""}`}
              aria-current={index === front}
              aria-label={`第 ${index + 1} 个模板：${item.name}`}
              onClick={() => goTo(index)}
            >
              {index === front && <span className="max-md:inline hidden">{front + 1}/{COUNT}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(1)} aria-label="下一个模板">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* 這裡曾經掛著 SVG 位移滤镜 #case-liquid-edge，已移除。
          它是使用者看到的「明顯分層」的成因：feMorphology 的結構元素是**矩形**，
          用它侵蝕一個圓角矩形，得到的遮罩帶方角；再把這塊「銳利核心」蓋回一份
          位移過的副本上，兩者的交界就是畫面裡那個硬邊直角框。stdDeviation="3"
          遠不足以糊掉它。邊緣折射現在由 CaseGlassWebGL 用真 Snell 折射計算，
          幾何厚度由 .case-side 撐出輪廓 —— 兩者都不需要拿矩形核去切圓角。 */}

      {/* 完整模板确认弹窗：旧入口「点卡片」的确认步（2026-08-29）。 */}
      {confirmTemplate && (
        <UseTemplateConfirmDialog
          template={confirmTemplate}
          onCancel={() => setConfirmTemplate(null)}
          onConfirm={() => {
            onUseTemplate(
              confirmTemplate,
              Array.from({ length: confirmTemplate.pipeline.steps.length }, (_, i) => i),
            );
            setConfirmTemplate(null);
          }}
        />
      )}
    </section>
  );
}

/* ── 完整模板确认弹窗（2026-08-29）──
   面板壳逐行复制 history/RerunDialog.tsx 的玻璃弹窗轮子（lg-sheet 玻璃面板 +
   iOS 字級 + portal + Esc/遮罩關閉），白名單改動 = 文案與確認回調，交互殼一行不動。 */
function UseTemplateConfirmDialog({
  template,
  onCancel,
  onConfirm,
}: {
  template: AgentTemplate;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet w-full max-w-sm rounded-ios-2xl p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={titleId} className="text-ios-subhead font-semibold text-foreground">
              使用完整模板
            </p>
            <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.55)]">
              是否使用完整模板开始创作？「{template.name}」的全部 {template.pipeline.steps.length}{" "}
              个环节都会执行。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 环节链摘要：确认前看清楚「完整」包含什么（分隔符与 cropTemplate 同款） */}
        <p className="mt-3 text-ios-caption1 text-[rgba(0,0,0,0.62)]">
          {template.pipeline.steps.map((step) => step.shortName).join("、")}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-4 py-2.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] transition-colors hover:bg-[rgba(0,0,0,0.09)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-medium text-white",
              "shadow-[0_4px_12px_rgba(0,122,255,0.32)] transition-all duration-200",
              "hover:bg-[#0066D6] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.30)]",
              "cursor-pointer",
            )}
          >
            开始创作
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
