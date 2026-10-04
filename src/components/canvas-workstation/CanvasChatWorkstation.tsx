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
          透出来，画布在背后可折射。08-25「白壳唯一卡」裁定由 09-20 预览裁定取代。 */}
      <style>{`
            /* ─── 面板宽度单一真相源（2026-09-24 首秒零回缩）───
               纯 CSS 默认＝SSR 首帧即新用户终态（无任何 JS 追写）；JS 只在
               localStorage 有存值或拖宽进行中把 --ws-panel-w 覆写成显式 px
               （写入端在 use-chat-panel 的 useLayoutEffect，<html> 内联样式
               压过本 :root 规则）。消费端：.canvas-chat-panel 的 width、
               overlay 的 --ce-dock-left、Navbar 的 --ws-navbar-inset fallback。 */
            :root {
              --ws-panel-w: clamp(22.5rem, 40vw, 45rem);
            }
            @keyframes canvas-ws-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes canvas-ws-panel-in {
              /* 未接线（2026-09-24 首秒零回缩考古）：全站无任何规则引用本
                 keyframes，入场动画实际只有 canvas-ws-fade 与 canvas-ws-fab-in，
                 两者已全部收进 settled 闸。保留宣告仅作历史记录，不会播放。 */
              from { opacity: 0; transform: translateX(-18px) scale(0.985); }
              to { opacity: 1; transform: none; }
            }
            .canvas-ws-backdrop {
              position: fixed;
              /* 站点 header 留在上面。助理是进站预设面，这层从视口顶盖下来时
                 充值／帐号入口就没了。高度由 #global-navbar 写进 --site-header-offset。 */
              top: var(--site-header-offset, 4.25rem);
              right: 0;
              bottom: 0;
              left: 0;
              z-index: 40;
              /* 环境光渐层与 body::after 同一配方（Trans 蓝/粉光晕＋160deg 底色）。
                 此层的职责是遮盖首页文档流内容；旧版 #F2F2F7 实底把首页的彩色
                 环境光一并抹平（暴君裁定 09-20：进助理应看见同款渐层），
                 改铺同款渐层后遮盖不变、底色不再消失。 */
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
            /* 入场渐显只在 settled 后生效（2026-09-24 首秒零回缩）：首次载入
               backdrop 直出终态（其渐层与 body::after 逐字同配方，延迟触发亦
               不可见）；pro→agent 翻面时本元素是新挂载的，class 在场即照常渐显。 */
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
            /* dock 偏移的过度只在 settled 后开启：拖宽/rail 切换跟手，
               载入首帧（left 已是终值）零动画。 */
            .canvas-ws-overlay.canvas-ws-settled {
              transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            /* Navbar 退缩过度（2026-09-24 首秒零回缩）：原先挂在 <nav> 的
               tailwind 类别上＝每次载入都播「全宽 320ms 退缩」回缩动画（病灶①），
               移进本档并只在 html[data-ws-settled]（工作站 settled 后写）下生效。
               非首页无本 style 块＝header 在任何态都零过度，天然正确。 */
            html[data-ws-settled] #global-navbar nav {
              transition: margin-left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
                width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-panel {
              position: fixed;
              z-index: 60;
              /* 2026-09-24 暴君裁定：面板吃满天花板——不再从导览列下缘起算；
                 navbar 改由 --ws-navbar-inset 右退让位（见组件顶部 useEffect 与
                 Navbar.tsx）。bottom 留 0.75rem，max-height 是 bottom 定界外的双保险。
                 2026-10-03 暴君「桌面端两个大组件顶部没对齐，以右边为基准」：
                 右侧导览岛顶 = 8px（header 的 pt-2），故面板顶 0.75rem → 0.5rem，
                 max-height 同步改 1.25rem——两面同高起跑，且面板仍吃满天花板。 */
              top: 0.5rem;
              bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
              left: var(--site-shell-left, 0.75rem);
              /* 宽度读单一真相源：:root 默认 clamp 或 JS（use-chat-panel）在
                 有存值/拖宽时覆写的显式 px。首帧即终态，无 inline style、
                 无 hydration 追写。 */
              width: var(--ws-panel-w);
              display: flex;
              flex-direction: column;
              min-height: 0;
              max-height: calc(100dvh - 1.25rem - env(safe-area-inset-bottom, 0px));
              max-width: calc(100vw - 1.5rem);
              /* 壳退为形状宿主：底色/边框交给内层 section.lg-card 的玻璃材质
                 （0.72 白玻璃＋blur＋specular 亮线），画布在背后可折射。 */
              background: transparent;
              border-radius: 1.875rem;
              overflow: hidden;
              /* header 弹窗（历史/资产/设定）水平置中用的顶部偏移。
                 2026-09-24 收敛：这些弹层是 fixed 于视口水平置中（left-1/2），
                 navbar 右退后胶囊仍横跨视口中段（z-80 压 z-50 弹层），所以顶部
                 仍须落在导览列下缘＋0.75rem——但不再用 3.25rem 魔法数，改吃
                 Navbar 实测的 --site-header-offset，与面板吃顶后的新基准一致。 */
              --agent-pop-top: calc(env(safe-area-inset-top, 0px) + var(--site-header-offset, 4.25rem) + 0.75rem);
            }
            /* 面板宽度过度只在 settled 后开启（首秒零回缩）：载入首帧宽度已是
               终值零动画；rail↔expanded 切换与拖宽（含 navbar/overlay 同拍）
               在闸开后照常过度。 */
            .canvas-chat-panel.canvas-ws-settled {
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-rail {
              /* 收起态 = 聊天气泡 FAB（2026-08-25 暴君裁定；2026-08-27 尺寸锁死修复：
                 面板基础规则的 top/bottom/right 拉伸定位 + width/height:auto 会让
                 FAB 在移动端撑满整屏成一个大白椭圆，完全不可用——四边与尺寸全部显式固定）。 */
              top: calc(var(--site-header-offset, 4.25rem) + 0.75rem);
              bottom: auto !important;
              right: auto !important;
              left: var(--site-shell-left, 0.75rem);
              width: 2.75rem !important;
              height: 2.75rem !important;
              min-width: 0 !important;
              max-width: none !important;
              overflow: hidden;
              /* FAB 态壳自身给玻璃外观（此态无 lg-card 内层可依赖）。 */
              background: rgba(255, 255, 255, 0.72);
              border: 1px solid rgba(0, 0, 0, 0.08);
              border-radius: 999px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.10);
              -webkit-backdrop-filter: blur(40px) saturate(180%);
              backdrop-filter: blur(40px) saturate(180%);
            }
            /* FAB 入场弹现（首秒零回缩闸）：只在 settled 后、且不是「旧持久值
               rail 直接首帧载入」时播——用户动作收合是过度，载入直出是终态。
               canvas-ws-was-rail 由工作站于 settled 当帧侦测（见 tsx）。 */
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
            /* 面板态聊天区：scroll 容器变纵向 flex、不再自己滚，滚动收进
               transcript 内部（agent 面的固定高在 46dvh 抽屉里会溢出被裁）。
               2026-09-24 暴君终裁：聊天态与空态一律吃满全高，空态内容置中由
               transcript 内部 justify-center 负责（旧 :has() 分流作废）。
               justify-content: center 保留：满高时无感，置中卡靠它。 */
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
              /* 2026-09-24 用户版面方案（卡片减法阴影）：压掉全域 lg-card 的
                 重阴影与四边渐变边框——「深阴影会让它显得过时，边框撑浮感就够」；
                 只覆写 box-shadow/border，lg-card 的玻璃材质（backdrop-filter）
                 原样保留。 */
              box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
              border: 1px solid oklch(0% 0 0 / 6%);
              /* 2026-10-01 暴君「背景像水泥砖」：卡面 0.72 实白 → 0.56，让首页环境光透进来；
                 对话正文对比度由 lg-card 的 blur40 + saturate 托底。 */
              background: rgba(255, 255, 255, 0.56);
            }
            .canvas-chat-scroll-fill > :not(section.lg-card) { flex-shrink: 0; }
            /* 2026-10-03 暴君「桌面端按钮 y 座标没对齐，以右边为基准」：
               右侧导览岛（顶 8px、高 62px）上按钮列的中心 = 39px 就是基准线。
               卡片 sm:p-6 的 24px 顶内距之外，描述框在 agent 态是用 class="hidden"
               （display:none）而非 [hidden] 属性，Tailwind space-y-4 的
               "> :not([hidden]) ~ :not([hidden])" 照样把 16px 外距套给下一列
               ——两者合计把 AgentChatSurface 的图示列推到 y=57（中心 79），比基准低 40。
               这里把卡片顶内距收回 4px、消掉那段幽灵外距，图示列顶 =
               8(卡顶) + 1(卡框) + 4 + 4(AgentChatSurface 自带 pt-1) = 17px（中心 39）。
               只在 ≥768px（= 工作站展开面板的桌面态）与 ≥xl 首页生效；≤767px 由下方
               媒体查询全萤幕接管，手机版布局一字不动。 */
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
              /* 选择器权重要盖得过 settled 闸规则（.x.canvas-ws-settled = 0,2,0）。 */
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
              /* 2026-09-05 暴君裁定：手机端 agent 态 = 全萤幕聊天，
                 手机用户没有操作画布的需求——画布 overlay/模板库直接不渲染。 */
              .canvas-ws-overlay { display: none; }
              .canvas-ws-backdrop { display: none; }
              /* 2026-10-01 暴君「AI 助理背景没覆满全屏、主页莫名能滚」：
                 面板从视口 0 铺到底（导览胶囊 z-80 浮在玻璃卡上），卡片去圆角/
                 边框/阴影成全出血底；导览列高度与安全区改由卡片内距吸收，
                 图示列紧贴胶囊下缘。弹层顶＝导览列下缘＋图示列高。 */
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
              /* 助理展开态全部内容都是 fixed，文档流没有可看的东西——锁死整页滚动，
                 只留 transcript 自己滚（overscroll-contain 已在组件上）。 */
              html:has(.canvas-chat-panel:not(.canvas-chat-rail)),
              html:has(.canvas-chat-panel:not(.canvas-chat-rail)) body {
                overflow: hidden;
                overscroll-behavior: none;
              }
              /* FAB 态手机位置：靠左上角（导航栏下方）。 */
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
