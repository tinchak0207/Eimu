"use client";

/** 骨架屏。高度刻意不一致，好让它看起来就是瀑布流本身，而不是一排等高的灰块。 */
const PLACEHOLDER_RATIOS = ["4 / 3", "1 / 1", "3 / 4", "1 / 1", "4 / 5", "3 / 4"];

export function HistorySkeleton({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="hist-card hist-masonry-item" aria-hidden="true">
          <div
            className="hist-skeleton w-full"
            style={{ aspectRatio: PLACEHOLDER_RATIOS[index % PLACEHOLDER_RATIOS.length] }}
          />
          <div className="space-y-1.5 px-3.5 pb-3 pt-2.5">
            <div className="hist-skeleton h-2.5 w-full rounded-full" />
            <div className="hist-skeleton h-2.5 w-3/5 rounded-full" />
          </div>
        </div>
      ))}
    </>
  );
}
