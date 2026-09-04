// 模板卡圆环选择器的首次教学（2026-08-26）。
//
// 与专业模式 LoRA 教学同一条基建：driver.js 按需动态 import（含 driver.css）、
// localStorage「看过」永不复播、键盘 A/D 翻步（bindDesktopTourKeyboard）、
// 弹层定位随视口同步（bindTourViewportSync）、假鼠标演示（runCursorDemo）。
//
// 触发点在 PipelineStepSelector（每张模板卡各一颗，随 gallery 一起挂载）：
// 8 颗同帧 mount 会抢跑，模块级 atcTourStarted 单飞闸保证整页只起一场；
// 送出钮不可用态点击时 forceStartAtcTour() 无视「看过」标记再播一场。

import type { Driver } from "driver.js";
import { bindDesktopTourKeyboard, DESKTOP_TOUR_KEY_HINT } from "@/lib/tour-keyboard";
import {
  bindTourViewportSync,
  firstVisibleAnchor,
  isMobileTourViewport,
  prefersTouchTour,
  tourSide,
} from "@/lib/tour-mobile";
import { runCursorDemo } from "@/components/pro-workstation/workstation-cursor-demo";

export const ATC_TOUR_STORAGE_KEY = "atc-tour-v1";

export interface AtcTourStepContent {
  title: string;
  lines: string[];
}

/**
 * 三步文案（2026-08-29 随送出钮/全选框改版更新）：
 * ① 高亮玻璃 Dock——流水线的每个环节；左边勾选框 = 一键全部执行；
 * ② 高亮任意一个站——单击开/关单环；按住拖过 = 正集重置为扫过的路径
 *    （「选择部分为正」）；点 Dock 空白 = 全选。桌面配假鼠标按住-拖拽-松开的完整演示。
 * ③ 高亮正面模板卡——选好后点右边箭头送出开工；点卡片本身 = 用完整模板开始（有确认弹窗）。
 */
export const ATC_TOUR_CONTENT: AtcTourStepContent[] = [
  {
    title: "流水线环节",
    lines: [
      "玻璃条上是流水线的每个环节；想全部执行，勾一下左边的勾选框。",
      "左右拖动可切换其他模板。",
    ],
  },
  {
    title: "部分选取：按住拖过",
    lines: [
      "想只跑一部分，按住不放拖过想要的环节。",
      "松手后只执行你拖过的站；单击可开关单个，点玻璃条空白 = 全选。",
    ],
  },
  {
    title: "开始创作",
    lines: ["选好后点右边的箭头送出开工；点卡片本身 = 用完整模板开始创作。"],
  },
];

/** 弹层正文：白字体系（深色玻璃底 atc-tour-popover），行距与 lora 教学对齐。 */
function buildAtcTourDescription(
  popover: { description: HTMLElement },
  content: AtcTourStepContent,
  keyboardHint: boolean,
): void {
  popover.description.innerHTML = "";
  for (const line of content.lines) {
    const p = document.createElement("p");
    p.style.margin = "0 0 6px 0";
    p.style.fontSize = "13px";
    p.style.lineHeight = "1.55";
    p.style.color = "hsl(220 10% 40%)";
    p.textContent = line;
    popover.description.appendChild(p);
  }
  if (keyboardHint) {
    const hint = document.createElement("p");
    hint.style.cssText = "margin:8px 0 0;font-size:12px;line-height:1.5;color:hsl(222 18% 22%);font-weight:700;";
    hint.textContent = DESKTOP_TOUR_KEY_HINT;
    popover.description.appendChild(hint);
  }
}

/** module 单飞闸：8 颗 selector 同帧挂载，只有第一颗能把教学启动起来。 */
let atcTourStarted = false;

/** 正面卡的元素解析：paint() 会在首帧给正面 slab 写 data-front="true"。
 *  必须以 .agent-template-carousel 为作用域——首页案例轮播（CaseShowcase）是
 *  同构复制，它的正面卡也带 data-front="true"，裸查询会锚到案例卡上。 */
function frontSelector(suffix: string): string {
  return `.agent-template-carousel .case-slab[data-front="true"]${suffix}`;
}

/**
 * 圆环首次实际可见时播一次三步教学；看过（localStorage）永远不再打扰。
 *
 * 时序：data-front 由轮播 paint() 在 rAF 里写，比 mount 晚一拍——这里短轮询
 * 等它就绪（约 2s 上限）；等不到就放掉单飞闸，让下一次挂载再试。
 */
export async function maybeStartAtcTour(): Promise<void> {
  return startAtcTour(false);
}

/** 送出钮不可用态点击触发（2026-08-29）：无视「看过」标记强制播一场——
 *  用户卡在「点不动」的瞬间，教学就是答案。单飞闸仍生效：引导已在播时
 *  重复点击不会叠场。 */
export function forceStartAtcTour(): void {
  void startAtcTour(true);
}

async function startAtcTour(force: boolean): Promise<void> {
  if (typeof window === "undefined" || atcTourStarted) return;
  if (!force && window.localStorage.getItem(ATC_TOUR_STORAGE_KEY)) return;
  // R9-4：輪播可能尚未 paint（.atc-step-selector 是 mount 後才掛的），
  // 立即 return 會讓「圓環首次可見」的教學整場缺席。先短輪詢等它出現
  // （最多 1s），等不到再放掉——不設單飛閘，讓下次掛載再試。
  if (!document.querySelector(".atc-step-selector")) {
    let appeared = false;
    for (let i = 0; i < 5 && !appeared; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      appeared = Boolean(document.querySelector(".atc-step-selector"));
    }
    if (!appeared) return;
  }
  atcTourStarted = true;

  try {
    let ready = false;
    for (let i = 0; i < 12 && !ready; i += 1) {
      ready = Boolean(document.querySelector(frontSelector("")) && document.querySelector(".atc-step-selector"));
      if (!ready) await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    if (!ready) {
      atcTourStarted = false;
      return;
    }

    // driver.js 仅在引导播放时需要，按需加载（同 ModelPicker 的 LoRA 引导）。
    const [{ driver }] = await Promise.all([
      import("driver.js"),
      import("driver.js/dist/driver.css"),
    ]);

    const isMobile = isMobileTourViewport();
    const showKeyboardHint = !isMobile;
    let unbindKeyboard = () => {};
    let unbindViewport = () => {};
    let tour: Driver | null = null;
    const finish = () => tour?.destroy();

    /* ── 第②步假鼠标拖拽演示（2026-08-27 返工：轨迹瞬移根治）──
       旧 bug：站点解析函数每步重新 query frontSelector，而 driver.js 高亮/
       平滑滚动会触发轮播转卡 → data-front 换卡 → 后续步骤解析漂到另一张卡
       （站1 目标瞬移 800px 到右侧空地按住拖拽）。三重根治：
       ① 快照化：onHighlightStarted 时一次性解析站0/1/2 的 DOM 引用，
         之后所有 CursorStep 的 el 闭包返回同一份快照，不再随 DOM 漂移；
       ② 冻结轮播：演示期间给 .agent-template-carousel 挂 atc-tour-locking，
         stage 的 wheel/scroll 转卡手势直接短路（见 AgentTemplateCarousel.tsx）；
       ③ down 落点校验 + abortOnMissingTarget：每次步骤解析都重验站0 落点
         （isConnected + 中心偏差 <40px），失效则整场干净收尾，绝不硬演。 */
    const tourLock = {
      on: () => document.querySelector(".agent-template-carousel")?.classList.add("atc-tour-locking"),
      off: () => document.querySelector(".agent-template-carousel")?.classList.remove("atc-tour-locking"),
    };

    const dragDemo = !isMobile && !prefersTouchTour()
      ? {
          onHighlightStarted: () => {
            tourLock.on();
            // 一次性快照三个站的 DOM 引用——正面卡的元素此刻是稳定的。
            const snap = [0, 1, 2].map((index) =>
              document.querySelector(frontSelector(` .atc-step-selector [data-step-index="${index}"]`)),
            );
            // 站0 缺席（数据异常）或站0/站1 都不在就没法演示拖过：不硬演，直接收尾。
            if (!snap[0] || !snap[1]) {
              tourLock.off();
              return;
            }
            // down 落点校验锚：站0 快照时的中心坐标。
            const rect0 = snap[0]!.getBoundingClientRect();
            const anchor0 = { x: rect0.left + rect0.width / 2, y: rect0.top + rect0.height / 2 };
            /* 步骤 el 解析（每个 CursorStep 开始时被引擎调用）：返回**快照引用**，
               且每次解析前重验站0 落点——isConnected 且中心偏差 <40px。
               轮播若偷偷转卡（data-front 换卡）：这里返回 null → 引擎 waitForEl
               轮询，短暂漂移（落格弹簧回中）可自愈恢复；持续漂移 2.5s 超时 →
               abortOnMissingTarget 整场干净收尾，绝不在错位坐标按住拖拽。
               站2 不存在（模板不足三环节）就只拖到站1。 */
            const station = (index: number): (() => Element | null) => () => {
              const el = snap[index];
              if (!el || !el.isConnected) return null;
              const s0 = snap[0]!;
              if (!s0.isConnected) return null;
              const r = s0.getBoundingClientRect();
              const drift = Math.hypot(r.left + r.width / 2 - anchor0.x, r.top + r.height / 2 - anchor0.y);
              return drift < 40 ? el : null;
            };

            runCursorDemo(
              [
                { kind: "move", el: station(0), ms: 520 },
                { kind: "pause", ms: 300 },
                { kind: "down", el: station(0) },
                { kind: "pause", ms: 260 },
                { kind: "move", el: station(1), ms: 430 },
                ...(snap[2]
                  ? [{ kind: "move" as const, el: station(2), ms: 430 }]
                  : []),
                { kind: "pause", ms: 480 },
                { kind: "up" },
                { kind: "pause", ms: 240 },
                { kind: "leave" },
              ],
              () => tourLock.off(),
              { abortOnMissingTarget: true },
            );
          },
        }
      : {};

    tour = driver({
      showProgress: true,
      progressText: "{{current}} / {{total}}",
      nextBtnText: "下一步",
      prevBtnText: "上一步",
      doneBtnText: "完成",
      overlayOpacity: 0.4,
      stagePadding: 10,
      stageRadius: 18,
      smoothScroll: false,
      /* Esc 必须能退出：任何盖住界面的浮层都要留键盘出路（pro tour 的裁定）。 */
      allowClose: true,
      // 点遮罩既不退出也不前进——「下一步」只交给按钮。
      overlayClickBehavior: () => {},
      allowKeyboardControl: true,
      popoverClass: "atc-tour-popover",
      onDestroyed: () => {
        unbindKeyboard();
        unbindViewport();
        tourLock.off(); // 教学销毁（走完/跳过/Esc）必解锁轮播
        window.localStorage.setItem(ATC_TOUR_STORAGE_KEY, "1");
        atcTourStarted = false;
      },
      steps: ATC_TOUR_CONTENT.map((content, index) => ({
        element:
          index === 0
            ? firstVisibleAnchor(frontSelector(" .atc-step-selector"), ".atc-step-selector")
            : index === 1
              ? firstVisibleAnchor(
                  frontSelector(' .atc-step-selector [data-step-index="0"]'),
                  '.atc-step-selector [data-step-index="0"]',
                  frontSelector(" .atc-step-selector"),
                  ".atc-step-selector",
                )
              : firstVisibleAnchor(frontSelector(" .case-face"), frontSelector(""), ".atc-info"),
        popover: {
          title: content.title,
          description: "",
          /* 2026-08-27 生产返工：移动端第①②步（Dock/站）用 top——弹窗放
             Dock 上方，不再盖住被讲解的环节条；第③步（正面卡）用 bottom。
             bottom 会让弹窗压在 Dock 上（昨天实测盖脸 + 按钮被右缘切断）。 */
          side: tourSide(index === 2 ? "bottom" : "top", isMobile),
          align: "center" as const,
          onPopoverRender: (popover: { description: HTMLElement; footerButtons: HTMLElement }) => {
            buildAtcTourDescription(popover, content, index === 0 && showKeyboardHint);
            if (popover.footerButtons.querySelector(".atc-tour-skip")) return;
            const skip = document.createElement("button");
            skip.type = "button";
            skip.className = "atc-tour-skip";
            skip.textContent = "跳过引导";
            skip.style.cssText =
              "border:0;background:none;color:hsl(220 10% 49%);font-size:0.68rem;font-weight:700;cursor:pointer;margin-left:auto;padding:0.2rem 0.5rem;";
            skip.onclick = finish;
            popover.footerButtons.appendChild(skip);
          },
        },
        ...(index === 1 ? dragDemo : {}),
      })),
    });

    const activeTour = tour;
    unbindKeyboard = bindDesktopTourKeyboard(activeTour);
    unbindViewport = bindTourViewportSync(activeTour);
    activeTour.drive();

    /* R10-2：任务开始即让位。新手引导只该出现在「还没开始用」时——用户一旦
       在 agent 面板发出第一条消息（transcript 里出现工具卡/message），tour
       就该干净退场，不再罩住正在进行的任务。MutationObserver 观察 .agent-panel
       的 transcript 区域，出现子节点即 destroy（走 onDestroyed 统一收尾）。 */
    const agentPanel = document.querySelector(".agent-panel");
    if (agentPanel) {
      const transcript = agentPanel.querySelector("[class*='transcript'], [class*='items'], [class*='list']");
      const root = transcript ?? agentPanel;
      const yieldTour = new MutationObserver(() => {
        if (root.children.length > 0) {
          yieldTour.disconnect();
          finish();
        }
      });
      yieldTour.observe(root, { childList: true, subtree: true });
    }
  } catch {
    // 动态加载失败属环境问题：放掉单飞闸，不影响任何主流程。
    atcTourStarted = false;
  }
}
