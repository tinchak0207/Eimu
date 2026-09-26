"use client";

/* ╁━ /pricing 整頁夢境：虹彩液態玻璃的夢幻空間（2026-09-26 暴君參考圖）╁━
   - 底圖 = 參考圖本身（next/image priority + 內嵌模糊佔位）：HTML 一到，首幀就是這個世界，
     沒有「先出卡片再換畫面」；四档是同一座夢境的四種天光（晨 → 夜 → 雨後虹 → 天亮），
     切档硬剪接（調色層瞬切 + 一記白閃）。
   - 活的部分全是 CSS（星閃 / 流星 / 氣泡 / 水面虹光），hydration 前就在動；
     JS 只做兩件事：滑鼠視差（近快遠慢，站在桌邊的縱深）與量環段位置（夢境鋪到哪裡為止）。
   只鋪在 pricing 內容區（PricingClient 根節點）裡，不越 navbar / 頁尾。 */

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import dreamWorld from "./dream-world.jpg";
import "./dream-world.css";
import { WORLD_IDS, isWorldId, type WorldId } from "./worlds";

/** 星星：決定性座標（SSR 與 hydration 一致），畫成兩張點陣底圖（兩層錯相閃爍）——
 *  34 顆各自一個合成層時，2560 寬 iGPU 掉 5–8fps。 */
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
  /* 剪接白閃只在「切档」時出現，首屏不閃。 */
  const [cuts, setCuts] = useState(0);
  const firstWorld = useRef(active);
  useEffect(() => {
    if (active === firstWorld.current && cuts === 0) return;
    setCuts((value) => value + 1);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 滑鼠視差：底圖慢、氣泡快，寫 --mx/--my（-1..1），rAF 節流。觸控裝置不做。
     寫在頁面根（.p3d-page）上：票面的虹彩鍍膜也跟著同一對變數轉。 */
  useEffect(() => {
    const root = rootRef.current?.parentElement;
    if (!root || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let mx = 0;
    let my = 0;
    const onMove = (event: PointerEvent) => {
      mx = (event.clientX / window.innerWidth) * 2 - 1;
      my = (event.clientY / window.innerHeight) * 2 - 1;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          root.style.setProperty("--mx", mx.toFixed(3));
          root.style.setProperty("--my", my.toFixed(3));
        });
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* 夢境的下緣 = 環段（含選片條與圓點）的底：量出來寫進 --p3d-dark-end，
     以下的單價表／兌換碼／FAQ 白玻璃卡落回站內淺底。
     --p3d-fold-top = 環段在文件中的頂（環段 min-height 撐到首屏底）。 */
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
      /* 噴泉可往上衝到 navbar 底為止（--df-clip-top = 舞台頂到 navbar 底的距離）。 */
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
