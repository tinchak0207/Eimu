"use client";

/* ╁━ /pricing 整页梦境：虹彩液态玻璃的梦幻空间（2026-09-26 暴君参考图）╁━
   - 底图 = 参考图本身（next/image priority + 内嵌模糊占位）：HTML 一到，首帧就是这个世界，
     没有「先出卡片再换画面」；四档是同一座梦境的四种天光（晨 → 夜 → 雨后虹 → 天亮），
     切档硬剪接（调色层瞬切 + 一记白闪）。
   - 活的部分全是 CSS（星闪 / 流星 / 气泡 / 水面虹光），hydration 前就在动；
     JS 只做两件事：滑鼠视差（近快远慢，站在桌边的纵深）与量环段位置（梦境铺到哪里为止）。
   只铺在 pricing 内容区（PricingClient 根节点）里，不越 navbar / 页尾。 */

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import dreamWorld from "./dream-world.jpg";
import "./dream-world.css";
import { WORLD_IDS, isWorldId, type WorldId } from "./worlds";

/** 星星：决定性座标（SSR 与 hydration 一致），画成两张点阵底图（两层错相闪烁）——
 *  34 颗各自一个合成层时，2560 宽 iGPU 掉 5–8fps。 */
function starField(offset: number): string {
  return Array.from({ length: 18 }, (_, k) => {
    const i = k * 2 + offset;
    const x = ((i * 61.8 + 7) % 100).toFixed(1);
    const y = (((i * 37.3) % 94) + 3).toFixed(1);
    const r = 1 + ((i * 13) % 3) * 0.6;
    const halo = i % 3 === 0 ? "255,170,215" : "140,180,255";
    return `radial-gradient(${(r * 2.2).toFixed(1)}px ${(r * 2.2).toFixed(1)}px at ${x}% ${y}%, #fff 0 26%, rgba(${halo},0.75) 44%, rgba(${halo},0) 100%)`;
  }).join(",");
}

const STAR_LAYERS = [starField(0), starField(1)];

const METEORS = [
  { x: 12, y: 6, d: 0 },
  { x: 58, y: 3, d: 3.4 },
  { x: 80, y: 12, d: 6.9 },
  { x: 34, y: 16, d: 9.6 },
];

const BUBBLES = Array.from({ length: 8 }, (_, i) => ({
  x: (i * 83.1 + 11) % 100,
  s: 10 + ((i * 17) % 26),
  d: ((i * 1.7) % 14).toFixed(2),
  t: 14 + ((i * 5) % 9),
}));

export function PricingAtmosphere({ world }: { world: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active: WorldId = isWorldId(world) ? world : "popular";
  /* 剪接白闪只在「切档」时出现，首屏不闪。 */
  const [cuts, setCuts] = useState(0);
  const firstWorld = useRef(active);
  useEffect(() => {
    if (active === firstWorld.current && cuts === 0) return;
    setCuts((value) => value + 1);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 滑鼠视差：底图慢、气泡快，写 --mx/--my（-1..1），rAF 节流。触控装置不做。
     效能（2026-10-01）：原本写在页面根（.p3d-page）上＝每次滑鼠移动整页约 980 个元素重算样式
     （实测每秒 450ms style recalc）。只写给真正用到的元素：底图／气泡两层＋每张票面（虹彩细边与全息镀膜的
     ::before/::after 从 .ppc-glass 继承）。量化到 0.01（视差最大 38px×0.01＜0.4px，外加 CSS 过渡平滑），
     慢移时不重写。 */
  useEffect(() => {
    const atmo = rootRef.current;
    const root = atmo?.parentElement;
    if (!atmo || !root || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let mx = 0;
    let my = 0;
    let lastX = "";
    let lastY = "";
    const onMove = (event: PointerEvent) => {
      mx = (event.clientX / window.innerWidth) * 2 - 1;
      my = (event.clientY / window.innerHeight) * 2 - 1;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const x = mx.toFixed(2);
          const y = my.toFixed(2);
          if (x === lastX && y === lastY) return;
          lastX = x;
          lastY = y;
          const targets = [
            ...atmo.querySelectorAll<HTMLElement>(".dw-plate, .dw-bubbles"),
            ...root.querySelectorAll<HTMLElement>(".ppc-glass"),
          ];
          for (const el of targets) {
            el.style.setProperty("--mx", x);
            el.style.setProperty("--my", y);
          }
        });
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* 梦境的下缘 = 环段（含选片条与圆点）的底：量出来写进 --p3d-dark-end，
     以下的单价表／兑换码／FAQ 白玻璃卡落回站内浅底。
     --p3d-fold-top = 环段在文件中的顶（环段 min-height 撑到首屏底）。 */
  useEffect(() => {
    const atmo = rootRef.current;
    const page = atmo?.parentElement;
    const ring = page?.querySelector<HTMLElement>(".pricing-plan-carousel");
    if (!atmo || !page || !ring) return;
    const stage = ring.querySelector<HTMLElement>(".case-stage");
    const header = document.querySelector<HTMLElement>("header");
    const sync = () => {
      const ringRect = ring.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      atmo.style.setProperty("--p3d-dark-end", `${Math.round(ringRect.bottom - pageRect.top)}px`);
      ring.style.setProperty("--p3d-fold-top", `${Math.round(ringRect.top + window.scrollY)}px`);
      /* 喷泉可往上冲到 navbar 底为止（--df-clip-top = 舞台顶到 navbar 底的距离）。 */
      if (stage) {
        const ceiling = Math.max(pageRect.top, header ? header.getBoundingClientRect().bottom : pageRect.top);
        stage.style.setProperty("--df-clip-top", `${Math.max(0, Math.round(stage.getBoundingClientRect().top - ceiling - 4))}px`);
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(ring);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="dw" data-world={active} aria-hidden="true">
      <div className="dw-plate">
        <Image src={dreamWorld} alt="" fill priority placeholder="blur" sizes="100vw" className="dw-img" />
      </div>
      <div className="dw-shimmer" />
      {WORLD_IDS.map((id) => (
        <div key={id} className="dw-grade" data-world={id} data-on={id === active ? "true" : "false"} />
      ))}
      <div className="dw-sky">
        {STAR_LAYERS.map((layer, i) => (
          <span key={i} className="dw-stars" style={{ backgroundImage: layer, animationDelay: `-${i * 1.7}s` }} />
        ))}
        {METEORS.map((meteor, i) => (
          <span key={i} className="dw-meteor" style={{ left: `${meteor.x}%`, top: `${meteor.y}%`, animationDelay: `${meteor.d}s` }} />
        ))}
      </div>
      <div className="dw-bubbles">
        {BUBBLES.map((bubble, i) => (
          <span key={i} className="dw-bubble" style={{ left: `${bubble.x}%`, width: bubble.s, height: bubble.s, animationDelay: `-${bubble.d}s`, animationDuration: `${bubble.t}s` }} />
        ))}
      </div>
      {cuts > 0 && <div key={cuts} className="dw-cut" />}
    </div>
  );
}
