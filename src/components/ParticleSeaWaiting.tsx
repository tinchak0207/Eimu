"use client";

import { useEffect, useRef, useState } from "react";
import {
  NORMAL_PROGRESS_DURATION_MS,
  calculateGenerationProgress,
} from "@/components/GenerationProgressBar";

interface ParticleSeaWaitingProps {
  visible: boolean;
  startedAt?: number;
  durationMs?: number;
}

/**
 * 生成中继态：Eimu 蓝粉灰粒子海浪（会呼吸的多谐波粒子场）铺满结果卡，
 * 中央大号百分比 + 底部蓝粉进度条。进度真源复用 calculateGenerationProgress
 * （与旧 GenerationProgressBar 同一条 easeOut 曲线，50s 常规 / 80s 兜底），
 * 视觉层按 /tmp/aigc-ref 预览页逐参数移植：粒子网格 16/16.8、波幅 22+8、
 * 三色粒子（亮蓝浪尖 / 蓝灰雾体 / 粉点缀）。
 */
export function ParticleSeaWaiting({
  visible,
  startedAt,
  durationMs = NORMAL_PROGRESS_DURATION_MS,
}: ParticleSeaWaitingProps) {
  const [now, setNow] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const TAU = Math.PI * 2;
    const RS = 16.8;
    const CS = 16;
    let W = 0;
    let H = 0;
    let particles: { x: number; row: number; r: number; p: number; ox: number; oy: number; ex: number }[] = [];

    const build = () => {
      const box = canvas.parentElement;
      W = box?.clientWidth ?? 420;
      H = box?.clientHeight ?? 420;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = [];
      const rows = Math.ceil(H / RS) + 2;
      const cols = Math.ceil(W / CS) + 4;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          particles.push({
            x: col * CS - 24 + (row % 2) * 6,
            row,
            r: 0.8 + Math.random() * 1.3,
            p: Math.random() * TAU,
            ox: 0,
            oy: 0,
            ex: 0,
          });
        }
      }
    };
    build();
    const observer = new ResizeObserver(build);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const waveY = (x0: number, row: number, t: number) => {
      const p = x0 * 0.018 + row * 0.17;
      return (
        4 +
        row * RS +
        Math.sin(p + t * 0.72) * 22 +
        Math.sin(p * 1.8 - t * 0.48) * 8 +
        Math.sin(t * 0.32) * row * 0.5
      );
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* 指针互动：斥力推开 + 弹簧合拢 + 扰动发亮 + 快划轻水花 */
    const pointer = { x: -9999, y: -9999, lastX: 0, lastY: 0, speed: 0, has: false };
    const splashes: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = e.clientX - rect.left;
      const ny = e.clientY - rect.top;
      if (!pointer.has) {
        pointer.lastX = nx;
        pointer.lastY = ny;
        pointer.has = true;
      }
      const dx = nx - pointer.lastX;
      const dy = ny - pointer.lastY;
      pointer.speed = Math.min(60, Math.hypot(dx, dy));
      pointer.x = nx;
      pointer.y = ny;
      pointer.lastX = nx;
      pointer.lastY = ny;
      if (pointer.speed > 13 && splashes.length < 60) {
        const n = Math.min(2, 60 - splashes.length);
        for (let i = 0; i < n; i++) {
          splashes.push({
            x: nx + (Math.random() - 0.5) * 14,
            y: ny + (Math.random() - 0.5) * 8,
            vx: dx * 0.22 + (Math.random() - 0.5) * 1.6,
            vy: -(1.2 + Math.random() * 2.4),
            life: 1,
          });
        }
      }
    };
    const onPointerLeave = () => {
      pointer.has = false;
      pointer.x = -9999;
      pointer.y = -9999;
      pointer.speed = 0;
    };
    const host = canvas.parentElement;
    if (host && !reduced) {
      host.addEventListener("pointermove", onPointerMove);
      host.addEventListener("pointerleave", onPointerLeave);
    }

    let raf = 0;
    const t0 = performance.now();
    const draw = (n: number) => {
      const t = (n - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W / 2, 35, 10, W / 2, H * 0.5, Math.max(W, H) * 0.7);
      glow.addColorStop(0, "rgba(0,122,255,.09)");
      glow.addColorStop(0.5, "rgba(92,143,180,.06)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      const span = W + 100;
      const R = 90;
      const R2 = R * R;
      for (const q of particles) {
        const px = q.x + t * 10 * (q.row % 3 === 0 ? 1 : 0.65);
        const xx = ((px + span) % span) - 50;
        const yy = waveY(xx, q.row, t);
        // 斥力注入：影响半径内沿径向推开，力度随指针速度
        if (pointer.has) {
          const pdx = xx - pointer.x;
          const pdy = yy - pointer.y;
          const d2 = pdx * pdx + pdy * pdy;
          if (d2 < R2) {
            const d = Math.sqrt(d2) || 1;
            const f = 1 - d / R;
            const push = f * f * (2.2 + pointer.speed * 0.4);
            q.ox += (pdx / d) * push;
            q.oy += (pdy / d) * push * 0.65;
            q.ex = Math.min(1, q.ex + f * 0.45);
          }
        }
        // 弹簧回位 + 扰动衰减：划过后 ~0.4s 带微过冲合拢
        q.ox *= 0.92;
        q.oy *= 0.92;
        q.ex *= 0.955;
        const drawX = xx + q.ox;
        const drawY = yy + q.oy;
        const breathe = 0.5 + 0.5 * Math.sin(t * 0.9 + q.row * 0.16);
        let alpha = 0.13 + 0.26 * breathe;
        let size = q.r * (0.7 + 1.05 * breathe);
        // 扰动发亮：被搅动的粒子短暂更亮更大、光晕更强
        alpha = Math.min(1, alpha * (1 + q.ex * 0.9));
        size *= 1 + q.ex * 0.35;
        ctx.beginPath();
        ctx.arc(drawX, drawY, size, 0, TAU);
        ctx.fillStyle =
          q.row % 7 === 0
            ? `rgba(0,122,255,${alpha * 0.65})`
            : q.row % 7 === 3
              ? `rgba(255,138,168,${alpha * 0.5})`
              : `rgba(122,148,186,${alpha * 0.42})`;
        ctx.shadowBlur = 5 + 6 * breathe + q.ex * 12;
        ctx.shadowColor = q.ex > 0.25 ? "rgba(0,122,255,.5)" : "rgba(0,122,255,.2)";
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // 轻水花：上抛微粒受重力落回浪里，0.5s 内消散
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        s.vy += 0.16;
        s.x += s.vx;
        s.y += s.vy;
        s.life -= 0.028;
        if (s.life <= 0) {
          splashes.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.4, 0, TAU);
        ctx.fillStyle = `rgba(90,170,255,${s.life * 0.8})`;
        ctx.shadowBlur = 6;
        ctx.shadowColor = "rgba(0,122,255,.5)";
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      pointer.speed *= 0.85;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      if (host) {
        host.removeEventListener("pointermove", onPointerMove);
        host.removeEventListener("pointerleave", onPointerLeave);
      }
    };
  }, [visible]);

  if (!visible || !startedAt) return null;

  const progress = calculateGenerationProgress(startedAt, now, durationMs);

  return (
    <div
      className="absolute inset-0 overflow-hidden bg-[#f4f8fc]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      aria-label="生成进度"
    >
      <div className="sea-waiting-aurora" aria-hidden="true" />
      <div className="sea-waiting-veil" aria-hidden="true" />
      <canvas ref={canvasRef} className="absolute inset-0 z-[3] h-full w-full" aria-hidden="true" />

      <div className="absolute inset-0 z-[6] flex flex-col items-center justify-center">
        <div className="sea-waiting-value bg-gradient-to-b from-[#223047] to-[#50718c] bg-clip-text text-[52px] font-bold leading-none tracking-[-0.05em] text-transparent">
          {/* tabular + 固定 2ch：位数变化（9→73→100）时数字组不左右挤动 */}
          <span className="inline-block min-w-[2ch] text-right tabular-nums">{progress}</span>
          <span className="ml-[12px] align-[18%] text-[24px] tracking-normal">%</span>
        </div>
        <div className="sea-waiting-sub mt-2 text-[13px] font-medium tracking-[0.04em]">
          把灵感变成画面
        </div>
      </div>

      <div className="sea-waiting-hint absolute bottom-[52px] left-1/2 z-[6] -translate-x-1/2 text-[11px] tracking-[0.06em] text-[rgba(45,49,66,0.62)]">
        正在雕刻光影与细节
      </div>

      <div
        className="absolute bottom-[34px] left-1/2 z-[6] h-[5px] w-[calc(100%-76px)] -translate-x-1/2 rounded-full bg-[rgba(45,49,66,0.12)] shadow-[inset_0_1px_2px_rgba(45,49,66,0.08)]"
        aria-hidden="true"
      >
        <div
          className="relative h-full rounded-full bg-gradient-to-r from-[#77a8ff] to-[#ff9ec2] shadow-[0_0_12px_#6cbfff66] transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        >
          <span className="absolute right-[-3px] top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[#f3fcff] shadow-[0_0_5px_#fff,0_0_15px_#7bd6ff]" />
        </div>
      </div>
    </div>
  );
}
