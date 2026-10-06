"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { MessageCircle } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { cn } from "@/lib/utils";
import { CHAT_PANEL_MAX_WIDTH, CHAT_PANEL_MIN_WIDTH, useChatPanel } from "./use-chat-panel";

// CanvasEmbed 维持 dynamic 懒载入：它是画布工作站的天然 chunk 边界，
// 只有 inCanvasWorkstation 为真（overlay 真的渲染）时才拉 chunk。
const CanvasEmbed = dynamic(() => import("@/components/canvas/CanvasEmbed").then((m) => m.CanvasEmbed), { ssr: false });

export interface CanvasChatWorkstationProps {
  /** ImagePlayground 的派生值：displayMode === "agent"。 */
  inCanvasWorkstation: boolean;
  isLoading: boolean;
  /** useCanvasChat 的回传值（SSE 事件喂回画布的 host）。 */
  canvasHost: UseCanvasChatReturn;
  /**
   * 画布初始态内容（2026-08-25 助理模板库）：canvas 空且无对话时，
   * overlay 内容换成它（模板库）而不是空画布。有值时 CanvasEmbed 不渲染。
   */
  overlayContent?: ReactNode;
  /**
   * 面板内容（D-12 撤销条 + PromptInput）。收合按钮（chatHeaderExtra）由面板
   * 两态决定，经 render prop 回传给内容接线——面板状态是本组件的私有域。
   */
  children: (chatHeaderExtra: ReactNode) => ReactNode;
}

/**
 * 画布工作站的壳：inline <style>（含跨档作用于 AgentChatPanel 的
 * .agent-composer-anchor——style 块必须跟 overlay 同一生命周期）+ 全场画布
 * overlay + 聊天面板壳/拖宽手柄。面板两态与宽度记忆在 use-chat-panel。
 * 本组件常驻挂载（非工作站态只是换 class），聊天卡 DOM 不搬家——
 * SSE 会话与输入状态零丢失。
 */
export function CanvasChatWorkstation({
  inCanvasWorkstation,
  isLoading,
  canvasHost,
  overlayContent,
  children,
}: CanvasChatWorkstationProps) {
  const { chatPanelState, setChatPanelState, chatPanelWidth, setChatPanelWidth, chatPanelDragRef, chatPanelRef } = useChatPanel();

  // 2026-09-24 暴君裁定「header 往右退缩，让 AI 助理占上来，吃满天花板」＋
  // 同刀「首秒零回缩」根治：expanded 态的退缩量不再由 JS 回写像素——
  // Navbar 的 --ws-navbar-inset fallback 已直接消费 calc(var(--ws-panel-w)+12px)
  // （单一真相源，拖宽即时跟随、SSR 首帧即退缩终态）。本 effect 只负责
  // 「不该退缩的态显式写 0px」：rail 态 / 手机（<768px 全屏抽屉）/ pro 面。
  // useLayoutEffect 在首帧 paint 前写入，且此刻 transition 闸（data-ws-settled）
  // 未开＝瞬变零动画；旧 useEffect+像素值写法正是「navbar 从全宽 320ms
  // 动画退缩」回缩病灶的元凶，作废。
  useLayoutEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => {
      const shrink = inCanvasWorkstation && chatPanelState === "expanded" && mq.matches;
      if (shrink) {
        document.documentElement.style.removeProperty("--ws-navbar-inset");
      } else {
        document.documentElement.style.setProperty("--ws-navbar-inset", "0px");
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.documentElement.style.setProperty("--ws-navbar-inset", "0px");
    };
  }, [inCanvasWorkstation, chatPanelState]);

  // ─── settled 闸（2026-09-24 首秒零回缩）───
  // 挂载并让首帧（含 useLayoutEffect 的值写入）完成绘制后（双 rAF）才开启
  // 过度动画：首次载入零动画直出终态；之后 rail↔expanded 切换、拖宽、
  // pro↔agent 翻面照样有过度。CSS 侧所有 width/left transition 与入场
  // @keyframes 都只挂在 .canvas-ws-settled / html[data-ws-settled] 下。
  const [wsSettled, setWsSettled] = useState(false);
  // settled 开启当下面板是否已是 rail（localStorage 旧持久值载入）——那是
  // 首帧终态不是用户动作，fab-in 入场动画不得补播（现行 UI 已无收合出口，
  // rail 仅可能来自旧持久值，此帧纯防回魂）。
  const chatPanelStateRef = useRef(chatPanelState);
  chatPanelStateRef.current = chatPanelState;
  const railAtSettleRef = useRef(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        railAtSettleRef.current = chatPanelStateRef.current === "rail";
        setWsSettled(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  // html[data-ws-settled]：Navbar 退缩 transition 的唯一闸（规则在本组件
  // style 块）。pro 态与 unmount 移除——非首页根本没有这层，header 恒全宽。
  useEffect(() => {
    if (wsSettled && inCanvasWorkstation) {
      document.documentElement.dataset.wsSettled = "1";
    } else {
      delete document.documentElement.dataset.wsSettled;
    }
    return () => {
      delete document.documentElement.dataset.wsSettled;
    };
  }, [wsSettled, inCanvasWorkstation]);

  return (
    <>
      {/* 画布工作站样式：面板 fixed 浮于画布上、两态宽度过渡、行动端改底部抽屉。
          2026-09-20 拆覆盖层（暴君批准的 agent-chat-preview 视觉）：面板壳不再
          压纯白实底——壳退为形状宿主（圆角＋阴影），让内层 PromptInput 的
          section.lg-card 自己的玻璃材质（0.72 白玻璃＋blur＋顶缘 specular 亮线）
          透出来，画布在背后可折射。08-25「白壳唯一卡」裁定由 09-20 预览裁定取代。

          以下规则的理由（原以 CSS 注释写在样板字串内，会随 SSR/JS 对外下发，
          2026-10-05 移进本 JS 注释，样式本身一字未改）：
          · --ws-panel-w 是面板宽度单一真相源：纯 CSS 默认＝SSR 首帧终态；
            JS 只在 localStorage 有存值或拖宽进行中覆写成显式 px（写入端在
            use-chat-panel 的 useLayoutEffect）。消费端＝.canvas-chat-panel width、
            overlay 的 --ce-dock-left、Navbar 的 --ws-navbar-inset fallback。
          · @keyframes canvas-ws-panel-in 未接线（全站无规则引用），入场动画只有
            canvas-ws-fade 与 canvas-ws-fab-in，两者已全收进 settled 闸。
          · backdrop 高度由 #global-navbar 写进 --site-header-offset；其渐层与
            body::after 同配方（暴君裁定 09-20：进助理应看见同款渐层）。
          · 入场渐显/dock 偏移过度/面板宽度过度/FAB 入场弹现 一律只在 settled 后
            生效（html[data-ws-settled]，工作站 settled 后写）＝首秒零回缩。
          · Navbar 退缩过度原挂在 <nav> 的 tailwind 类别上＝每次载入都播「全宽
            320ms 退缩」回缩动画（病灶①），移进本档并只在 data-ws-settled 下生效。
          · 面板吃满天花板（暴君裁定 2026-09-24）；navbar 改由 --ws-navbar-inset
            右退让位（见组件顶部 useEffect 与 Navbar.tsx）。2026-10-03 暴君
            「桌面端两个大组件顶部没对齐，以右边为基准」：面板顶 0.75rem → 0.5rem，
            max-height 同步改 1.25rem。
          · 壳退为形状宿主：底色/边框交给内层 section.lg-card 的玻璃材质，画布在
            背后可折射；--agent-pop-top 吃 Navbar 实测的 --site-header-offset。
          · 收起态 FAB（暴君裁定 2026-08-25；2026-08-27 尺寸锁死修复：面板基础规则
            的拉伸定位 + width/height:auto 会让 FAB 在移动端撑满整屏）；此态壳自身
            给玻璃外观（无 lg-card 内层可依赖）；canvas-ws-was-rail 由工作站于
            settled 当帧侦测（见 tsx）。
          · 面板态聊天区滚动收进 transcript 内部（暴君终裁 2026-09-24：一律吃满
            全高，旧 :has() 分流作废）。
          · 卡片减法阴影（用户版面方案 2026-09-24）；卡面 0.72 实白 → 0.56
            （暴君 2026-10-01「背景像水泥砖」，让首页环境光透进来）。
          · 2026-10-03 暴君「桌面端按钮 y 座标没对齐，以右边为基准」：≥768px 卡片顶
            内距收回 4px、消掉 Tailwind space-y-4 的幽灵外距，图示列顶对齐基准线 39px。
          · prefers-reduced-motion 选择器权重要盖得过 settled 闸规则。
          · 手机端（≤767px）agent 态 = 全萤幕聊天（暴君裁定 2026-09-05）；2026-10-01
            暴君「AI 助理背景没覆满全屏」：面板从视口 0 铺到底；展开态内容全 fixed，
            故锁死整页滚动只留 transcript 自己滚；FAB 态靠左上角。 */}
      <style>{`
            :root {
              --ws-panel-w: clamp(22.5rem, 40vw, 45rem);
            }
            @keyframes canvas-ws-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes canvas-ws-panel-in {
              from { opacity: 0; transform: translateX(-18px) scale(0.985); }
              to { opacity: 1; transform: none; }
            }
            .canvas-ws-backdrop {
              position: fixed;
              top: var(--site-header-offset, 4.25rem);
              right: 0;
              bottom: 0;
              left: 0;
              z-index: 40;
              background:
                radial-gradient(ellipse 130% 90% at 15% 5%,
                  rgba(85, 205, 252, 0.10) 0%,
                  transparent 60%
                ),
                radial-gradient(ellipse 110% 75% at 85% 95%,
                  rgba(247, 168, 184, 0.10) 0%,
                  transparent 60%
                ),
                radial-gradient(ellipse 90% 65% at 80% 10%,
                  rgba(85, 205, 252, 0.07) 0%,
                  transparent 55%
                ),
                linear-gradient(160deg,
                  #f5fbff 0%,
                  #fef5f7 50%,
                  #f5fbff 100%
                );
            }
            .canvas-ws-backdrop.canvas-ws-settled {
              animation: canvas-ws-fade 0.32s ease-out;
            }
            .canvas-ws-overlay {
              position: fixed;
              top: var(--site-header-offset, 4.25rem);
              bottom: 0;
              right: var(--site-shell-right, 0px);
              z-index: 50;
              height: auto;
              background: transparent;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            }
            .canvas-ws-overlay.canvas-ws-settled {
              transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            html[data-ws-settled] #global-navbar nav {
              transition: margin-left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
                width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-panel {
              position: fixed;
              z-index: 60;
              top: 0.5rem;
              bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
              left: var(--site-shell-left, 0.75rem);
              width: var(--ws-panel-w);
              display: flex;
              flex-direction: column;
              min-height: 0;
              max-height: calc(100dvh - 1.25rem - env(safe-area-inset-bottom, 0px));
              max-width: calc(100vw - 1.5rem);
              background: transparent;
              border-radius: 1.875rem;
              overflow: hidden;
              --agent-pop-top: calc(env(safe-area-inset-top, 0px) + var(--site-header-offset, 4.25rem) + 0.75rem);
            }
            .canvas-chat-panel.canvas-ws-settled {
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-rail {
              top: calc(var(--site-header-offset, 4.25rem) + 0.75rem);
              bottom: auto !important;
              right: auto !important;
              left: var(--site-shell-left, 0.75rem);
              width: 2.75rem !important;
              height: 2.75rem !important;
              min-width: 0 !important;
              max-width: none !important;
              overflow: hidden;
              background: rgba(255, 255, 255, 0.72);
              border: 1px solid rgba(0, 0, 0, 0.08);
              border-radius: 999px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.10);
              -webkit-backdrop-filter: blur(40px) saturate(180%);
              backdrop-filter: blur(40px) saturate(180%);
            }
            .canvas-chat-rail.canvas-ws-settled:not(.canvas-ws-was-rail) {
              animation: canvas-ws-fab-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
            }
            @keyframes canvas-ws-fab-in {
              from { opacity: 0; transform: scale(0.6); }
              to { opacity: 1; transform: scale(1); }
            }
            .canvas-chat-rail .canvas-chat-scroll { display: none; }
            .canvas-chat-scroll {
              flex: 1;
              min-height: 0;
              overflow-y: auto;
              padding: 0;
              overscroll-behavior: contain;
              background: transparent;
            }
            .canvas-chat-scroll.canvas-chat-scroll-fill {
              display: flex;
              flex-direction: column;
              justify-content: center;
              overflow: hidden;
              overflow-y: hidden;
              padding: 0;
            }
            .canvas-chat-scroll-fill > * { min-height: 0; }
            .canvas-chat-scroll-fill > section.lg-card {
              flex: 1 1 0%;
              min-height: 0;
              overflow: hidden;
              margin: 0;
              border-radius: 1.875rem;
              box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
              border: 1px solid oklch(0% 0 0 / 6%);
              background: rgba(255, 255, 255, 0.56);
            }
            .canvas-chat-scroll-fill > :not(section.lg-card) { flex-shrink: 0; }
            @media (min-width: 768px) {
              .canvas-chat-scroll-fill > section.lg-card {
                padding-top: 0.25rem;
              }
              .canvas-chat-scroll-fill > section.lg-card > div > div.dust-transition {
                margin-top: 0;
              }
            }
            .agent-composer-anchor { flex-shrink: 0; }
            .canvas-chat-resize {
              position: absolute;
              top: 0;
              bottom: 0;
              right: -2px;
              width: 10px;
              cursor: col-resize;
              z-index: 5;
              touch-action: none;
            }
            .canvas-chat-resize:hover { background: linear-gradient(to right, transparent, rgba(0, 122, 255, 0.25)); }
            @media (prefers-reduced-motion: reduce) {
              .canvas-ws-overlay,
              .canvas-ws-overlay.canvas-ws-settled { animation: none; transition: none; }
              .canvas-ws-backdrop,
              .canvas-ws-backdrop.canvas-ws-settled { animation: none; }
              .canvas-chat-panel,
              .canvas-chat-panel.canvas-ws-settled { transition: none; }
              .canvas-chat-rail,
              .canvas-chat-rail.canvas-ws-settled:not(.canvas-ws-was-rail) { animation: none; }
              html[data-ws-settled] #global-navbar nav { transition: none; }
            }
            @media (max-width: 767px) {
              .canvas-ws-overlay { display: none; }
              .canvas-ws-backdrop { display: none; }
              .canvas-chat-panel {
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                height: auto;
                width: auto !important;
                max-width: none;
                max-height: none;
                border-radius: 0;
                background: transparent;
                padding: 0;
                --agent-pop-top: calc(var(--site-header-offset, 4.25rem) + 3.5rem);
              }
              .canvas-chat-scroll-fill > section.lg-card {
                border-radius: 0;
                border: 0;
                box-shadow: none;
                padding-top: calc(var(--site-header-offset, 4.25rem) + 0.25rem);
                padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
                padding-left: 0.75rem;
                padding-right: 0.75rem;
              }
              html:has(.canvas-chat-panel:not(.canvas-chat-rail)),
              html:has(.canvas-chat-panel:not(.canvas-chat-rail)) body {
                overflow: hidden;
                overscroll-behavior: none;
              }
              .canvas-chat-rail {
                top: calc(var(--site-header-offset, 4.25rem) + 0.75rem);
                left: 0.5rem;
                border-radius: 0;
              }
              .canvas-chat-rail::before { display: none; }
              .canvas-chat-resize { display: none; }
            }
      `}</style>
      {/* 画布工作站：画布吃满全场（辽阔是预设，不再塞右栏缝里），聊天卡原地
          换装成左侧固定面板——DOM 不搬家，SSE 会话与输入状态零丢失。
          面板不能盖住画布左缘的节点：整个 overlay 向右 dock，left = 0.75rem
          + 面板宽 + 12px 间隙（--ce-dock-left 跟随面板宽度过渡，动画同步）。
          2026-08-25 canvas 常驻化：agent 模式右侧永远是这个 overlay，
          初始态（canvas 空）以 overlayContent（模板库）代替空画布。 */}
      {inCanvasWorkstation && (
        <>
          {/* 2026-09-29 跨萤幕不变量：工作站是应用式满屏，面板／overlay 左右缘都由
              Navbar 量出的 --site-shell-left/right 推导；页壳 max-w-[1440px] 在
              >1440 视口会把整个工作站夹成置中窄壳、两侧大片留白。工作站态解除
              导览列页壳上限（pro 态仍 1440，与其内容栏对齐）。SSR 首帧即生效。
              同刀·等比缩放：设计基准视口＝暴君本机 1274×664 CSS px。工作站全部
              尺寸走 rem（面板宽/间隙/圆角/FAB 已改 rem），根字级按 min(宽比,高比)
              放大 → 大萤幕上间距、呼吸感、字级与视口的比例和基准机一致；下限
              16px（基准机及更小视口零变化），上限 26px（≈1.6 倍）。 */}
          <style>{`
            #global-navbar.page-shell { max-width: none; }
            html { font-size: clamp(16px, min(100vw * 16 / 1274, 100vh * 16 / 664), 26px); }
          `}</style>
          <div className={cn("canvas-ws-backdrop", wsSettled && "canvas-ws-settled")} aria-hidden="true" />
          <div
            className={cn("canvas-ws-overlay", wsSettled && "canvas-ws-settled")}
            style={
              {
                /* dock 偏移读单一真相源：expanded = 面板宽+0.75rem 间隙（CSS 变数
                   即时跟随拖宽，JS 不经回写）；rail 态 = 4rem（FAB 2.75rem＋间隙）
                   保持既有分支。字符串常量化＝SSR 首帧即终态、零 hydration 跳动。 */
                "--ce-dock-left": chatPanelState === "rail" ? "4rem" : "calc(var(--ws-panel-w) + 0.75rem)",
                left: "calc(var(--site-shell-left, 0.75rem) + var(--ce-dock-left, 0px))",
              } as CSSProperties
            }
          >
            {overlayContent ?? <CanvasEmbed canvas={canvasHost} expanded />}
          </div>
        </>
      )}
      {/* min-w-0 is load-bearing: an auto-sized grid column takes its
          minimum from the item's min-content, so a single nowrap
          control inside the card would widen the column past the
          viewport and push the whole page sideways on phones. */}
      <div
        ref={chatPanelRef}
        className={cn(
          inCanvasWorkstation ? "canvas-chat-panel" : "min-w-0",
          // settled 闸：width 过度与入场动画只在首帧稳定后开启（见 style 块）。
          inCanvasWorkstation && wsSettled && "canvas-ws-settled",
          inCanvasWorkstation && chatPanelState === "rail" && "canvas-chat-rail",
          // 旧持久值 rail＝首帧终态，不补播 fab-in（settled 当帧侦测，见上）。
          inCanvasWorkstation &&
            wsSettled &&
            chatPanelState === "rail" &&
            railAtSettleRef.current &&
            "canvas-ws-was-rail",
        )}
      >
        {/* FAB 态（2026-08-25 暴君裁定：收起形态 = 左上角聊天气泡，不是长条 rail）：
            一颗 44px 圆形聊天气泡按钮，图标即语义（MessageCircle=打开对话）。
            载入中蓝色 pulse 提示「助理在跑」。expanded 态不渲染：收合按钮
            并入聊天 header（chatHeaderExtra），触发前后同一个 UI。 */}
        {inCanvasWorkstation && chatPanelState === "rail" && (
          <button
            type="button"
            onClick={() => setChatPanelState("expanded")}
            title="展开对话面板"
            aria-label="展开对话面板"
            className={cn(
              "flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full",
              "bg-[rgba(0,122,255,0.10)] text-[#007AFF] transition-all duration-200",
              "hover:bg-[rgba(0,122,255,0.16)] active:scale-[0.94]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              "[-webkit-tap-highlight-color:transparent]",
              isLoading && "animate-pulse",
            )}
          >
            <MessageCircle className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        <div className={inCanvasWorkstation ? cn("canvas-chat-scroll min-w-0 flex-1 space-y-3", chatPanelState === "expanded" && "canvas-chat-scroll-fill") : "min-w-0 space-y-3"}>
          {/* 2026-09-05 暴君裁定：header 的「收起对话面板」钮删掉，退出只走右边 X；
              chatHeaderExtra 不再产出（render prop 签名保留，传 undefined）。 */}
          {children(undefined)}
        </div>
        {/* 面板右缘拖宽手柄（320–720px，2026-09-24 用户版面方案放宽上限） */}
        <div
          className={inCanvasWorkstation && chatPanelState === "expanded" ? "canvas-chat-resize" : "hidden"}
          onPointerDown={(e) => {
            // 拖宽起始值：无显式宽（null，CSS clamp 默认在场）时实测渲染宽——
            // JS 不再假设 420 这类魔法数。
            const startW = chatPanelWidth ?? chatPanelRef.current?.getBoundingClientRect().width ?? CHAT_PANEL_MIN_WIDTH;
            chatPanelDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startW };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            const d = chatPanelDragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            setChatPanelWidth(Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, d.startW + (e.clientX - d.startX))));
          }}
          onPointerUp={(e) => {
            if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
          }}
          onPointerCancel={(e) => {
            if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
          }}
          aria-hidden="true"
        />
      </div>
    </>
  );
}
