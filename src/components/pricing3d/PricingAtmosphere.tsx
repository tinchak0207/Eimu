"use client";

/* ╁━ /pricing 整頁氛圍：背景、光、滾動節奏跟著當前档的世界走 ╁━
   卡堆和頁面同屬一個空間：晨光窗台 → 暖奶油底 + 斜射晨光；夜燈書桌 → 靛藍暮色 + 燈暈；
   雨後工作台 → 清冷天光 + 一抹虹；無邊界工作室 → 破曉粉白、光帶走得最快。
   只鋪在 pricing 內容區（PricingClient 根節點）裡，不越 navbar / 頁尾；
   四層預先疊好，切档只換 opacity（漸層本身不可過渡）。滾動節奏 = 光帶層的視差倍率。
   正文對比：四個底色都是淺色（最暗的夜燈档只在環段附近加深），全頁文字色不需要改。 */

import { useEffect, useRef } from "react";
import { WORLD_IDS, WORLD_SCROLL_RATE, isWorldId, type WorldId } from "./worlds";

export function PricingAtmosphere({ world }: { world: string }) {
  const beamRef = useRef<HTMLDivElement | null>(null);
  const active: WorldId = isWorldId(world) ? world : "popular";
  const rateRef = useRef(WORLD_SCROLL_RATE[active]);
  rateRef.current = WORLD_SCROLL_RATE[active];

  useEffect(() => {
    const beam = beamRef.current;
    if (!beam) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const paint = () => {
      raf = 0;
      const offset = reduce.matches ? 0 : window.scrollY * rateRef.current;
      beam.style.transform = `translate3d(0, ${(-offset).toFixed(1)}px, 0)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const beam = beamRef.current;
    if (!beam) return;
    beam.style.transform = `translate3d(0, ${(-window.scrollY * WORLD_SCROLL_RATE[active]).toFixed(1)}px, 0)`;
  }, [active]);

  return (
    <div className="p3d-atmo" data-world={active} aria-hidden="true">
      {WORLD_IDS.map((id) => (
        <div key={id} className="p3d-atmo-layer" data-world={id} data-on={id === active ? "true" : "false"} />
      ))}
      <div ref={beamRef} className="p3d-atmo-beams" />
    </div>
  );
}
