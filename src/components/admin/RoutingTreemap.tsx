"use client";

// /admin 首屏矩形樹狀圖：外層矩形 = 模型佔比，內層矩形 = 該模型內分辨率檔位佔比。
// 幾何完全來自 squarify（src/lib/treemap.ts）——每個矩形的面積嚴格等於其請求數佔比，
// 不是視覺近似，可以直接讀色塊大小當百分比。

import { useMemo } from "react";
import { squarify } from "@/lib/treemap";
import { modelBaseName } from "@/lib/provider-config";
import type { ModelBreakdown } from "@/lib/routing-telemetry";

const MODEL_COLORS = [
  "#2878d0", "#20a65a", "#d99024", "#a82d24", "#7c5cbf",
  "#0f9b8e", "#c2478c", "#5b6b7a", "#b98900", "#3f7ad9",
];

const RESOLUTION_ORDER = ["1k", "2k", "4k", "360p", "480p", "540p", "720p", "1080p", "未知"];
/** 失败结果固定灰色、排在同一模型内所有成功档位之后——失败不是"更高档"的分辨率，不该混进亮度梯度。 */
const FAILED_BUCKET = "失败";
const FAILED_COLOR = "#8a8f98";

function resolutionRank(resolution: string): number {
  if (resolution === FAILED_BUCKET) return RESOLUTION_ORDER.length;
  const index = RESOLUTION_ORDER.indexOf(resolution);
  return index === -1 ? RESOLUTION_ORDER.length - 1 : index;
}

/** 同一模型內不同分辨率用亮度梯度區分——一眼能看出「這幾塊同屬一個模型」。失败桶固定灰色，不参与梯度。 */
function shadeForIndex(baseColor: string, index: number, total: number, resolution: string): string {
  if (resolution === FAILED_BUCKET) return FAILED_COLOR;
  const gradientTotal = total - (total > 1 ? 1 : 0);
  if (gradientTotal <= 1) return baseColor;
  const ratio = 0.12 + (index / Math.max(1, gradientTotal - 1)) * 0.5;
  const value = baseColor.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const VBOX_W = 1000;
const VBOX_H = 460;

export function RoutingTreemap({ data }: { data: ModelBreakdown[] }) {
  const grandTotal = data.reduce((sum, model) => sum + model.total, 0);

  const layout = useMemo(() => {
    const outerRects = squarify(
      data.map((model) => ({ id: model.modelId, value: model.total })),
      0, 0, VBOX_W, VBOX_H,
    );
    return outerRects.map((outerRect) => {
      const model = data.find((item) => item.modelId === outerRect.id)!;
      const modelIndex = data.indexOf(model);
      const sortedResolutions = [...model.resolutions].sort(
        (a, b) => resolutionRank(a.resolution) - resolutionRank(b.resolution),
      );
      const innerRects = squarify(
        sortedResolutions.map((entry) => ({ id: entry.resolution, value: entry.count })),
        outerRect.x, outerRect.y, outerRect.w, outerRect.h,
      );
      return { outerRect, modelIndex, model, innerRects };
    });
  }, [data]);

  if (grandTotal === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-md border border-black/10 bg-white text-sm text-black/45">
        暂无路由事件，矩形树状图将在有生成请求后出现
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-white">
      <div className="border-b border-black/10 px-5 py-4">
        <h2 className="font-semibold">模型 × 分辨率路由占比</h2>
        <p className="mt-1 text-xs text-black/40">
          矩形面积 = 请求占比；每个色块是一个模型，内部按 1k/2k/4k 等分辨率细分深浅——共 {grandTotal} 条事件。
        </p>
      </div>
      <div className="p-4">
        <div className="relative w-full" style={{ paddingBottom: `${(VBOX_H / VBOX_W) * 100}%` }}>
          <div className="absolute inset-0">
            {layout.map(({ outerRect, modelIndex, model, innerRects }) => {
              const baseColor = MODEL_COLORS[modelIndex % MODEL_COLORS.length];
              const pct = (model.total / grandTotal) * 100;
              return (
                <div
                  key={outerRect.id}
                  className="absolute overflow-hidden rounded-[3px] ring-1 ring-white"
                  style={{
                    left: `${(outerRect.x / VBOX_W) * 100}%`,
                    top: `${(outerRect.y / VBOX_H) * 100}%`,
                    width: `${(outerRect.w / VBOX_W) * 100}%`,
                    height: `${(outerRect.h / VBOX_H) * 100}%`,
                  }}
                  title={`${modelBaseName(model.modelId)} · ${model.total} 条 · ${pct.toFixed(1)}%`}
                >
                  {innerRects.map((innerRect, resIndex) => (
                    <div
                      key={innerRect.id}
                      className="absolute flex items-center justify-center overflow-hidden border border-white/70 text-center"
                      style={{
                        left: `${((innerRect.x - outerRect.x) / outerRect.w) * 100}%`,
                        top: `${((innerRect.y - outerRect.y) / outerRect.h) * 100}%`,
                        width: `${(innerRect.w / outerRect.w) * 100}%`,
                        height: `${(innerRect.h / outerRect.h) * 100}%`,
                        backgroundColor: shadeForIndex(baseColor, resIndex, innerRects.length, innerRect.id),
                      }}
                      title={`${modelBaseName(model.modelId)} · ${innerRect.id} · ${innerRect.value} 条`}
                    >
                      {innerRect.w > 70 && innerRect.h > 28 && (
                        <span className="px-1 text-ios-caption2 font-semibold leading-tight text-white drop-shadow-sm">
                          {innerRect.id}
                          <br />
                          {innerRect.value}
                        </span>
                      )}
                    </div>
                  ))}
                  {outerRect.w > 60 && (
                    <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      {modelBaseName(model.modelId)} · {pct.toFixed(0)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 border-t border-black/10 px-5 py-3">
        {data.map((model, index) => (
          <span key={model.modelId} className="flex items-center gap-1.5 text-xs text-black/55">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: MODEL_COLORS[index % MODEL_COLORS.length] }} />
            {modelBaseName(model.modelId)}（{model.total}）
          </span>
        ))}
      </div>
    </div>
  );
}
