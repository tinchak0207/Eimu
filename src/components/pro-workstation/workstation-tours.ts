import type { MutableRefObject } from "react";
import type { Driver } from "driver.js";
import {
  bindTourViewportSync,
  firstVisibleAnchor,
  isMobileTourViewport,
  refreshTourAfterLayout,
  scrollAnchorIntoView,
  tourSide,
} from "@/lib/tour-mobile";
import { bindDesktopTourKeyboard, DESKTOP_TOUR_KEY_HINT } from "@/lib/tour-keyboard";
import {
  LORA_TOUR_STEP_COUNT,
  LORA_TOUR_STORAGE_KEY,
  TOUR_STORAGE_KEY,
} from "./workstation-constants";
import type { InspectorTab, LeftPanelTab, MobilePanel, WorkspaceMode } from "./workstation-constants";
import { runCursorDemo } from "./workstation-cursor-demo";

export interface WorkstationToursOptions {
  tourRef: MutableRefObject<Driver | null>;
  loraTourRef: MutableRefObject<Driver | null>;
  loraGridWaitingRef: MutableRefObject<boolean>;
  loraTourAdvancingRef: MutableRefObject<boolean>;
  isPixaiModelRef: MutableRefObject<boolean>;
  setMobilePanel: (panel: MobilePanel) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setLoraPanelOpen: (open: boolean) => void;
  setModelMenuOpen: (open: boolean) => void;
  toggleSection: (key: string, open: boolean) => void;
  activateWorkspace: (mode: WorkspaceMode) => void;
  advanceLoraTourFromModelSelection: (tour: Driver) => Promise<void>;
}

export function createWorkstationTours({
  tourRef,
  loraTourRef,
  loraGridWaitingRef,
  loraTourAdvancingRef,
  isPixaiModelRef,
  setMobilePanel,
  setLeftPanelTab,
  setInspectorTab,
  setLoraPanelOpen,
  setModelMenuOpen,
  toggleSection,
  activateWorkspace,
  advanceLoraTourFromModelSelection,
}: WorkstationToursOptions) {
  const startTour = async () => {
    if (typeof window === "undefined") return;
    // driver.js 仅在引导播放时需要，按需加载，不占专业模式进场 chunk
    const { driver } = await import("driver.js");
    tourRef.current?.destroy();
    const isMobile = isMobileTourViewport();
    if (!isMobile) activateWorkspace("canvas");
    const showKeyboardHint = !isMobile;
    let unbindKeyboard = () => {};
    let unbindViewport = () => {};
    /**
     * 手机端每一步都要先把对应工作面切出来再高亮。
     *
     * 手机版一次只显示四个面中的一个（`data-mobile-panel`），另外三个是
     * `display:none` —— 锚点 rect 全零时 driver.js 会退化成「stage 罩满全屏 +
     * 弹层贴底部、没有箭头」，看起来就是引导彻底错位/失焦。
     */
    const enterMobilePanel = (panel: MobilePanel, tab?: LeftPanelTab) => {
      if (!isMobile) return;
      setMobilePanel(panel);
      if (tab) setLeftPanelTab(tab);
      refreshTourAfterLayout(() => tourRef.current);
    };
    const tour = driver({
      showProgress: true,
      progressText: "第 {{current}} / {{total}} 步",
      nextBtnText: "下一步",
      prevBtnText: "上一步",
      doneBtnText: "完成",
      overlayOpacity: 0.4,
      stagePadding: 8,
      stageRadius: 16,
      // 手机端锚点大多在 .pro-studio-body 这个内部滚动容器里，必须滚进视口
      smoothScroll: true,
      popoverClass: "pro-tour-popover",
      onDestroyed: () => {
        unbindKeyboard();
        unbindViewport();
        window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
        // 引导结束把手机端送回「创作」面，不要让用户停在最后一步的产出面上
        if (isMobile) {
          setMobilePanel("create");
          setLeftPanelTab("prompt");
        }
      },
      steps: [
        {
          // 手机端左栏 tab 条是 display:none（用底部导航代替），锚到底部导航
          element: firstVisibleAnchor(isMobile ? ".pro-mobile-nav" : "#pro-tour-left-tabs", "#pro-tour-model"),
          popover: {
            title: "三步生成",
            description: isMobile
              ? "手机版用底部这排切换工作面：创作写描述、参数调尺寸、画布看结果、产出看队列。"
              : `先写画面描述，再加参考图，最后设置尺寸和数量。${showKeyboardHint ? `\n\n${DESKTOP_TOUR_KEY_HINT}` : ""}`,
            side: tourSide("right", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("prompt");
            enterMobilePanel("create", "prompt");
          },
        },
        {
          element: firstVisibleAnchor("#pro-tour-prompt", "#pro-left-panel-prompt"),
          popover: {
            title: "画面描述",
            description: isMobile ? "描述你想要的画面，越具体越好。" : "描述你想要的画面。按 Ctrl/⌘ + Enter 生成。",
            side: tourSide("right", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("prompt");
            enterMobilePanel("create", "prompt");
            scrollAnchorIntoView("#pro-tour-prompt");
          },
        },
        {
          // 锚点原本写的是 #pro-tour-scenarios —— 这个 id 在整个代码库里不存在，
          // driver.js 找不到元素就退化成屏幕中央的无锚点弹层，用户被告知「选择场景」
          // 却没有任何东西被高亮。真实 id 是创作模板那一节。
          element: firstVisibleAnchor("#pro-tour-resources", "#pro-left-panel-prompt"),
          popover: {
            title: "场景与模板",
            description: "选择常见广告场景，快速补齐项目信息、避免内容、风格和尺寸。",
            side: tourSide("right", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("prompt");
            enterMobilePanel("create", "prompt");
            // 这一节默认收起，不展开的话高亮框只圈到一行标题
            toggleSection("resources", true);
            scrollAnchorIntoView("#pro-tour-resources");
          },
        },
        {
          // 手机端没有 tab 条：直接锚到参考图面板本体
          element: firstVisibleAnchor(
            isMobile ? "#pro-left-panel-assets" : "#pro-tour-left-tabs",
            "#pro-left-panel-assets",
            ".pro-mobile-nav",
          ),
          popover: {
            title: "参考图",
            description: "上传产品、人像或风格图，并设置用途和强度。",
            side: tourSide("right", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("assets");
            enterMobilePanel("create", "assets");
            scrollAnchorIntoView("#pro-left-panel-assets");
          },
        },
        {
          element: firstVisibleAnchor(
            isMobile ? "#pro-tour-model" : "#pro-tour-left-tabs",
            "#pro-left-panel-settings",
            ".pro-mobile-nav",
          ),
          popover: {
            title: "参数",
            description: isMobile
              ? "底部「参数」里选模型、尺寸、数量和品牌信息。"
              : "选择尺寸、数量和品牌信息。",
            side: tourSide("right", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("settings");
            enterMobilePanel("settings", "settings");
          },
        },
        {
          /*
            桌面端的 #pro-tour-run 在顶栏，手机端那颗按钮 `isDesktop && (...)` 根本没渲染，
            真实的生成按钮是底部 .pro-mobile-generate-btn（且只在有提示词时出现）。
            锚点按可见性回退，避免落到不存在的 id 上。
          */
          element: firstVisibleAnchor(
            isMobile ? ".pro-mobile-generate-btn" : "#pro-tour-run",
            "#pro-tour-run",
            ".pro-mobile-nav",
          ),
          popover: {
            title: "生成",
            description: isMobile
              ? "写完画面描述后，底部会出现蓝色生成按钮；进度显示在导航下方一条。"
              : "运行当前任务。进度会显示在右侧。",
            side: isMobile ? "top" : "bottom",
            align: isMobile ? "center" : "end",
          },
        },
        {
          element: firstVisibleAnchor("#pro-tour-canvas-tools", ".pro-canvas-stage", ".pro-mobile-nav"),
          popover: {
            title: "标注",
            description: "在图上圈出区域，再设为参考图。",
            side: "top",
            align: "center",
          },
          onHighlightStarted: () => {
            activateWorkspace("canvas");
            enterMobilePanel("canvas");
            scrollAnchorIntoView("#pro-tour-canvas-tools");
          },
        },
        {
          // .pro-mode-segment 在手机端 display:none，改锚底部导航
          element: firstVisibleAnchor(isMobile ? ".pro-mobile-nav" : "#pro-tour-segment", "#pro-tour-segment"),
          popover: {
            title: "画布和成片墙",
            description: isMobile
              ? "底部导航切换四个工作面：创作、参数、画布、产出。画布看单张，产出浏览整批。"
              : "画布看单张结果，成片墙浏览整批结果。",
            side: isMobile ? "top" : "bottom",
            align: "center",
          },
        },
        {
          element: firstVisibleAnchor("#pro-tour-inspector", ".pro-mobile-nav"),
          popover: {
            title: "队列、图库、历史",
            description: "查看进度，管理成片，恢复历史配置。",
            side: tourSide("left", isMobile),
            align: "start",
          },
          onHighlightStarted: () => {
            setInspectorTab("queue");
            enterMobilePanel("output");
            scrollAnchorIntoView("#pro-tour-inspector");
          },
        },
      ],
    });
    tourRef.current = tour;
    unbindKeyboard = bindDesktopTourKeyboard(tour);
    unbindViewport = bindTourViewportSync(tour);
    tour.drive();
  };

  /** 「前往专业模式」后的 LoRA 教学：选 PixAI 模型 → 选卡 → 探索搜索/排序。 */
  const startLoraTour = async () => {
    if (typeof window === "undefined") return;
    const { driver } = await import("driver.js");
    loraTourRef.current?.destroy();
    // LoRA 面板先展开：否则 <details> 收合时锚点 rect 为 0，高亮会错乱（跑到模型/张数区域）
    setLoraPanelOpen(true);
    setLeftPanelTab("settings");
    // 手机版：底部导航切到「参数」，左面板才可见
    const isMobile = isMobileTourViewport();
    if (isMobile) setMobilePanel("settings");
    // 等「参数」tab 渲染出 #pro-tour-model，再等两帧保证面板稳定
    await waitForSelectorDOM("#pro-tour-model", 2000);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    /*
      锚点兜底：目标元素（如 LoRA 网格）尚未渲染时退回父级/模型行。
      这里必须按「可见性」而不是「存在性」回退 —— 手机端非当前工作面整块是
      display:none，命中一个隐藏元素会拿到 0×0 的 rect，比退回父级更糟：
      driver.js 会把高亮钉在左上角、弹层退化成贴底无箭头浮层。
    */
    const loraTourAnchor = (...selectors: string[]) => firstVisibleAnchor(...selectors);
    /** 手机端每步都要确保「参数」面还在前台，否则锚点会被隐藏。 */
    const keepMobileSettingsPanel = () => {
      if (!isMobile) return;
      setMobilePanel("settings");
      setLeftPanelTab("settings");
      refreshTourAfterLayout(() => loraTourRef.current);
    };
    let unbindKeyboard = () => {};
    let unbindViewport = () => {};
    const tour = driver({
      showProgress: true,
      progressText: "第 {{current}} / {{total}} 步",
      nextBtnText: "下一步",
      prevBtnText: "上一步",
      doneBtnText: "完成",
      overlayOpacity: 0.4,
      stagePadding: 8,
      stageRadius: 16,
      smoothScroll: true,
      /*
       * Esc 必须能退出。
       *
       * 旧版 allowClose:false 的动机是「防止误点把引导关掉」，但代价是引导变成
       * 一个抓住用户不放的模态：不想看的人没有任何键盘出路，只能用鼠标去找那颗
       * 「跳过引导」。任何盖住整个界面的浮层都必须能用 Esc 关掉。
       */
      allowClose: true,
      // 点遮罩既不退出也不前进 —— 让「下一步」只由那颗按钮负责。
      overlayClickBehavior: () => {},
      allowKeyboardControl: true,
      popoverClass: "pro-tour-popover",
      showButtons: ["next", "previous"],
      onNextClick: (element, step, opts) => {
        const index = opts.driver.getActiveIndex();
        if (index === LORA_TOUR_STEP_COUNT - 2 && !document.querySelector("#pro-tour-lora-grid")) {
          if (loraGridWaitingRef.current) return;
          loraGridWaitingRef.current = true;
          const popover = opts.state.popover;
          if (popover) popover.description.textContent = "LoRA 列表还在加载，马上就好…";
          const startedAt = Date.now();
          const poll = () => {
            if (document.querySelector("#pro-tour-lora-grid") || Date.now() - startedAt > 9000) {
              loraGridWaitingRef.current = false;
              opts.driver.moveNext();
            } else {
              window.setTimeout(poll, 150);
            }
          };
          poll();
          return;
        }
        opts.driver.moveNext();
      },
      onDestroyed: () => {
        unbindKeyboard();
        unbindViewport();
        window.localStorage.setItem(LORA_TOUR_STORAGE_KEY, "1");
        loraTourRef.current = null;
        loraTourAdvancingRef.current = false;
        setModelMenuOpen(false);
      },
      onPopoverRender: (popover) => {
        if (popover.footerButtons.querySelector(".pro-tour-skip")) return;
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "pro-tour-skip";
        skip.textContent = "跳过引导";
        skip.style.cssText = "border:0;background:none;color:hsl(var(--foreground) / 0.45);font-size:0.68rem;font-weight:700;cursor:pointer;margin-left:auto;padding:0.2rem 0.5rem;";
        skip.onclick = () => {
          window.localStorage.setItem(LORA_TOUR_STORAGE_KEY, "1");
          loraTourRef.current?.destroy();
        };
        popover.footerButtons.appendChild(skip);
      },
      steps: [
        {
          element: () => (document.querySelector("#pro-tour-model [data-model-picker-trigger]") as HTMLElement | null) ?? document.body,
          popover: {
            title: "选择 PixAI 模型",
            description: `模型列表已经帮你打开，悬停 PixAI，随便选一个 PixAI 开头的模型（如 Moonbeam）。LoRA 只对 PixAI 系列模型生效。${isMobile ? "" : `\n\n${DESKTOP_TOUR_KEY_HINT}`}`,
            side: isMobile ? "bottom" : "right",
            align: "start",
          },
          onHighlightStarted: () => {
            setLeftPanelTab("settings");
            if (isMobile) setMobilePanel("settings");
            const pixaiChoice = () => document.querySelector(isMobile
              ? '[data-model-picker-mobile] [data-model-picker-model-vendor="PixAI"]'
              : '[data-model-picker-vendor="PixAI"]');
            setModelMenuOpen(true);
            window.setTimeout(() => {
              const menu = document.querySelector('[role="menu"]');
              if (!menu) return;
              const pixai = pixaiChoice() as HTMLElement | null;
              pixai?.scrollIntoView({ block: "center", inline: "nearest" });
              pixai?.focus({ preventScroll: true });
              if (!isMobile) pixai?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
            }, 150);
            window.setTimeout(() => {
              if (isPixaiModelRef.current) return;
              runCursorDemo([
                { kind: "move", el: () => document.querySelector("#pro-tour-model [data-model-picker-trigger]") },
                { kind: "pause", ms: 700 },
                { kind: "move", el: pixaiChoice },
                { kind: "pause", ms: 400 },
                { kind: "click", el: pixaiChoice },
                { kind: "leave" },
              ]);
            }, 600);
            if (isPixaiModelRef.current) {
              window.setTimeout(() => {
                const activeTour = loraTourRef.current;
                if (activeTour) void advanceLoraTourFromModelSelection(activeTour);
              }, 250);
            }
          },
        },
        {
          element: loraTourAnchor("#pro-tour-lora", "#pro-tour-model"),
          popover: {
            title: "LoRA 风格库",
            description: "选好 PixAI 模型后，这里就是 LoRA 库：给画面叠加社区训练的画风或角色。",
            side: isMobile ? "top" : "right",
            align: "start",
          },
          onHighlightStarted: () => {
            keepMobileSettingsPanel();
            if (!document.querySelector("#pro-tour-lora")) {
              const popover = loraTourRef.current?.getState("popover");
              if (popover) popover.description.textContent = "先在上面选一个 PixAI 模型，LoRA 库就会出现在这里。";
            }
            scrollAnchorIntoView("#pro-tour-lora");
            window.setTimeout(() => loraTourRef.current?.refresh(), 200);
          },
        },
        {
          element: loraTourAnchor("#pro-tour-lora-search", "#pro-tour-lora", "#pro-tour-model"),
          popover: {
            title: "搜索",
            description: "输入关键词就能过滤 LoRA 卡片，试试下面的示例：",
            side: "bottom",
            align: "start",
            onPopoverRender: (popover) => {
              const input = document.querySelector("#pro-tour-lora-search") as HTMLInputElement | null;
              const row = document.createElement("div");
              row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;";
              const status = document.createElement("div");
              status.className = "pro-input-guide-status";
              status.textContent = "输入后按回车即可搜索";
              status.style.cssText = "margin-top:8px;font-size:12px;color:hsl(var(--accent) / 0.9);font-weight:700;";
              const applyExample = (example: string) => {
                if (!input) return;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, example);
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
                status.textContent = "已输入，看看卡片变化，然后点「下一步」";
              };
              for (const example of ["genshin", "flat", "anime"]) {
                const chip = document.createElement("button");
                chip.type = "button";
                chip.textContent = example;
                chip.style.cssText = "border:0;border-radius:999px;background:hsl(var(--accent) / 0.1);color:hsl(var(--accent));font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer;transition:background 180ms;";
                chip.onmouseenter = () => { chip.style.background = "hsl(var(--accent) / 0.2)"; };
                chip.onmouseleave = () => { chip.style.background = "hsl(var(--accent) / 0.1)"; };
                chip.onclick = () => applyExample(example);
                row.appendChild(chip);
              }
              popover.description.appendChild(row);
              popover.description.appendChild(status);
              input?.addEventListener("input", () => {
                status.textContent = input.value.trim()
                  ? "已输入，按回车搜索，然后点「下一步」"
                  : "输入后按回车即可搜索";
              });
            },
          },
          onHighlightStarted: () => {
            keepMobileSettingsPanel();
            const input = document.querySelector("#pro-tour-lora-search") as HTMLInputElement | null;
            if (!isMobile) input?.focus();
            window.setTimeout(() => loraTourRef.current?.refresh(), 200);
            if (input && !input.value.trim()) {
              window.setTimeout(() => {
                if (input.value.trim()) return;
                runCursorDemo(
                  [
                    { kind: "type", input: () => input, text: "anime" },
                    { kind: "leave" },
                  ],
                  () => {
                    const status = document.querySelector(".pro-input-guide-status") as HTMLElement | null;
                    if (status) status.textContent = "已输入 anime，按回车试试";
                  },
                );
              }, 500);
            }
          },
        },
        {
          element: loraTourAnchor("#pro-tour-lora-sort", "#pro-tour-lora", "#pro-tour-model"),
          popover: {
            title: "排序与分类",
            description: "按热度、最新或喜欢数排序；上面一排标签可按分类浏览。",
            side: "bottom",
            align: "end",
          },
          onHighlightStarted: () => {
            keepMobileSettingsPanel();
            window.setTimeout(() => loraTourRef.current?.refresh(), 200);
          },
        },
        {
          element: loraTourAnchor("#pro-tour-lora-grid", "#pro-tour-lora", "#pro-tour-model"),
          popover: {
            title: "选择一张卡",
            description: "点卡片即选中，一次选一个。选中后引导会自动完成，生成结果会自动带上它的风格。",
            side: "top",
            align: "center",
          },
          onHighlightStarted: () => {
            if (!document.querySelector("#pro-tour-lora-grid")) {
              const popover = loraTourRef.current?.getState("popover");
              if (popover) popover.description.textContent = "LoRA 列表暂时没加载出来，稍后可以直接在「LoRA 风格」面板里挑选卡片。";
            }
            window.setTimeout(() => loraTourRef.current?.refresh(), 250);
            window.setTimeout(() => loraTourRef.current?.refresh(), 900);
          },
        },
      ],
    });
    loraTourRef.current = tour;
    unbindKeyboard = bindDesktopTourKeyboard(tour);
    unbindViewport = bindTourViewportSync(tour);
    tour.drive();
  };

  return { startTour, startLoraTour };
}

/** waitForSelector inline (no component closure needed) */
function waitForSelectorDOM(selector: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) { resolve(); return; }
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
  });
}
