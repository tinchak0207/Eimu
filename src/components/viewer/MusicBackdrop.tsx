// 听歌舞台的背景：封面的色彩糊成一整面（Apple Music 的做法）；没封面就按曲名取一组墨绿×靛蓝渐变，
// 不拿别的成品的图占位。壳（全屏）与内嵌卡共用。

import { cn } from "@/lib/utils";

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 70; // 在 Eimu 的墨绿(158)到靛蓝(228)之间取色
}

export function MusicBackdrop({ cover, seed, className }: { cover?: string; seed: string; className?: string }) {
  const h = 158 + hueOf(seed);
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 overflow-hidden bg-[#0b0d12]", className)}>
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover}
          alt=""
          className="absolute left-1/2 top-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2 object-cover opacity-70 blur-[72px] saturate-[1.6]"
        />
      ) : (
        <>
          <div className="absolute -left-1/4 -top-1/4 h-[90%] w-[90%] rounded-full opacity-60 blur-[90px]" style={{ background: `hsl(${h} 42% 34%)` }} />
          <div className="absolute -bottom-1/4 -right-1/4 h-[85%] w-[85%] rounded-full opacity-55 blur-[100px]" style={{ background: `hsl(${h + 62} 38% 30%)` }} />
        </>
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/55" />
    </div>
  );
}
