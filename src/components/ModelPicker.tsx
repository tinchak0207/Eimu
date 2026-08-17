"use client";

import { useRef } from "react";
import {
  modelBaseName,
  modelPromotionTag,
} from "@/lib/provider-config";
import {
  generationModel,
  modelPriceLabel,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { Check, ImageIcon, Video } from "lucide-react";
import { VendorIcon } from "./brand-icons";
import { buildLoraTourDescription, LORA_TOUR_CONTENT, LORA_TOUR_STORAGE_KEY, PRO_LORA_TOUR_ARMED_KEY } from "@/lib/lora-tour-content";
import { bindDesktopTourKeyboard, DESKTOP_TOUR_KEY_HINT } from "@/lib/tour-keyboard";
import { bindTourViewportSync, firstVisibleAnchor } from "@/lib/tour-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { usePricingRevision } from "@/hooks/use-pricing-revision";

interface ModelPickerProps {
  models: string[];
  value: string;
  onChange: (modelId: string) => void;
  resolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  /** 传入时，模型菜单会额外渲染一个「进入专业模式」的入口 */
  onOpenProfessionalMode?: () => void;
  /** 去掉厂商前缀显示，例如将 Google Veo 3.1 显示为 Veo 3.1 */
  stripVendorPrefix?: boolean;
  /** 受控模式：由外部控制菜单的开合，供引导等场景使用 */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}

interface VendorGroup {
  vendor: string;
  models: string[];
}

/** 模型按厂商分组展示：OpenAI / Google / PixAI */
const VENDOR_ORDER = ["OpenAI", "Google", "PixAI"];

const VENDOR_TAGS: Record<string, string> = {
  PixAI: "二次元",
};

/** 匹配厂商前缀，例如 Google Veo 3.1 只显示 Veo 3.1 */
const VENDOR_PREFIX_RE = /^(Google|Adobe|PixAI|Dreamina|Runway|Luma AI|OpenAI)\s+/;

function modelPickerName(modelId: string, stripVendor: boolean): string {
  const name = modelBaseName(modelId);
  return stripVendor ? name.replace(VENDOR_PREFIX_RE, "") : name;
}

/** Desktop keeps the compact two-level chooser; mobile uses one bounded flat list. */
export function ModelPicker({ models, value, onChange, resolution, durationSeconds, generateAudio, onOpenProfessionalMode, stripVendorPrefix, menuOpen, onMenuOpenChange }: ModelPickerProps) {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  const promotionTag = modelPromotionTag(value);
  const loraTourBusyRef = useRef(false);

  const maybeStartLoraTour = () => {
    if (typeof window === "undefined" || !onOpenProfessionalMode) return;
    if (window.localStorage.getItem(LORA_TOUR_STORAGE_KEY)) return;
    if (loraTourBusyRef.current) return;
    loraTourBusyRef.current = true;
    void Promise.all([
      import("driver.js"),
      import("driver.js/dist/driver.css"),
    ]).then(([{ driver }]) => {
      let tour: ReturnType<typeof driver> | null = null;
      let unbindKeyboard = () => {};
      let unbindViewport = () => {};
      const showKeyboardHint = window.matchMedia("(min-width: 1024px)").matches;
      const finish = () => {
        window.localStorage.setItem(LORA_TOUR_STORAGE_KEY, "1");
        tour?.destroy();
      };
      tour = driver({
        showProgress: true,
        progressText: "正在处理第 {{current}} / {{total}} 步",
        nextBtnText: "下一步",
        prevBtnText: "上一步",
        doneBtnText: "完成",
        overlayOpacity: 0.4,
        stagePadding: 8,
        stageRadius: 16,
        smoothScroll: false,
        // 引导过程中不允许按 ESC / X 关闭，避免用户中途退出引导
        allowClose: false,
        // 复用 loraTourBusyRef 防抖：菜单刚打开的一瞬间不会重复触发引导。
        overlayClickBehavior: (element, step, opts) => {
          const total = opts.config.steps?.length ?? 0;
          if ((opts.state.activeIndex ?? 0) === 0) return;
          if ((opts.state.activeIndex ?? 0) >= total - 1) return;
          opts.driver.moveNext();
        },
        allowKeyboardControl: true,
        popoverClass: "lora-tour-popover",
        onDestroyed: () => {
          unbindKeyboard();
          unbindViewport();
          loraTourBusyRef.current = false;
          window.localStorage.setItem(LORA_TOUR_STORAGE_KEY, "1");
        },
        steps: LORA_TOUR_CONTENT.map((content, index) => {
          const isLast = index === LORA_TOUR_CONTENT.length - 1;
          return {
            /*
              第一步：悬停 PixAI 厂商项，等待菜单展开后再开始引导。

              锚点按「可见」而不是「存在」回退：手机版和桌面版的 PixAI 行同时
              存在于 DOM 里（一份 `lg:hidden`、一份 `hidden lg:block`），
              命中隐藏的那一份会拿到 0×0 rect —— driver.js 会把高亮钉在左上角、
              弹层退化成贴屏幕底部且没有箭头。
            */
            element: firstVisibleAnchor(
              '[data-model-picker-mobile-vendor="PixAI"]',
              '[data-model-picker-vendor="PixAI"]',
              "[data-model-picker-trigger]",
            ),
            popover: {
              title: content.title,
              description: `${content.lines.join("\n")}${index === 0 && showKeyboardHint ? `\n\n${DESKTOP_TOUR_KEY_HINT}` : ""}`,
              side: "bottom",
              align: "start",
              showButtons: isLast ? ["previous"] : ["next", "previous"],
              onPopoverRender: (popover) => {
                buildLoraTourDescription(popover, content);
                if (index === 0 && showKeyboardHint) {
                  const keyboardHint = document.createElement("p");
                  keyboardHint.textContent = DESKTOP_TOUR_KEY_HINT;
                  keyboardHint.style.cssText = "margin:8px 0 0;font-size:12px;line-height:1.5;color:rgba(0,122,255,0.9);font-weight:700;";
                  popover.description.appendChild(keyboardHint);
                }
                if (!isLast) return;
                const footer = popover.footerButtons;
                footer.innerHTML = "";
                const stay = document.createElement("button");
                stay.textContent = "先看看再说";
                stay.style.cssText = "border:0;border-radius:999px;background:rgba(0,0,0,0.06);padding:0.4rem 0.9rem;color:rgba(0,0,0,0.6);font-size:0.72rem;font-weight:700;cursor:pointer;";
                stay.onclick = finish;
                const go = document.createElement("button");
                go.textContent = "前往专业控制";
                go.style.cssText = "border:0;border-radius:999px;background:rgba(0,122,255,0.14);padding:0.4rem 0.9rem;color:#0066dd;font-size:0.72rem;font-weight:700;cursor:pointer;";
                go.onclick = () => {
                  finish();
                  window.localStorage.setItem(PRO_LORA_TOUR_ARMED_KEY, "1");
                  onOpenProfessionalMode();
                };
                footer.appendChild(stay);
                footer.appendChild(go);
              },
            },
          };
        }),
      });
      unbindKeyboard = bindDesktopTourKeyboard(tour);
      // 菜单是 Radix portal 内的滚动容器：容器内滚动 / 软键盘都不会触发 window
      // 事件，不同步就会看到高亮框留在原地、和 PixAI 那一行错开。
      unbindViewport = bindTourViewportSync(tour);
      tour.drive();
    });
  };

  const vendorGroups: VendorGroup[] = [];
  for (const model of models) {
    const vendor = generationModel(model)?.vendor;
    if (!vendor) continue;
    const group = vendorGroups.find((entry) => entry.vendor === vendor);
    if (group) group.models.push(model);
    else vendorGroups.push({ vendor, models: [model] });
  }
  vendorGroups.sort((a, b) => {
    const aOrder = VENDOR_ORDER.indexOf(a.vendor);
    const bOrder = VENDOR_ORDER.indexOf(b.vendor);
    const aRank = aOrder === -1 ? VENDOR_ORDER.length : aOrder;
    const bRank = bOrder === -1 ? VENDOR_ORDER.length : bOrder;
    if (aRank !== bRank) return aRank - bRank;
    const aPopularity = Math.max(...a.models.map((model) => generationModel(model)?.popularity ?? 0));
    const bPopularity = Math.max(...b.models.map((model) => generationModel(model)?.popularity ?? 0));
    return bPopularity - aPopularity;
  });

  const renderModel = (model: string, mobile = false) => {
    const definition = generationModel(model);
    const tag = modelPromotionTag(model);
    const vendor = definition?.vendor ?? "";
    const priceOptions = model === value ? { resolution, durationSeconds, generateAudio } : {};
    const selected = model === value;
    return (
      <DropdownMenuItem
        key={model}
        onSelect={() => onChange(model)}
        data-model-picker-model
        data-model-picker-model-vendor={vendor}
        className={`${mobile ? "py-2 pl-2.5 pr-8" : "py-2 pl-3 pr-9"} min-w-0 max-w-full text-ios-footnote focus:bg-[rgba(0,122,255,0.10)]`}
      >
        <span className={`flex w-full min-w-0 max-w-full items-center gap-2 ${mobile ? "" : "lg:min-w-[17rem]"}`}>
          <VendorIcon vendor={vendor} className="h-5 w-5 rounded-[0.4rem]" innerClassName="h-3.5 w-3.5" />
          <span className={`min-w-0 flex-1 truncate font-medium ${selected ? "text-[rgba(0,122,255,0.9)]" : "text-[rgba(0,0,0,0.85)]"}`}>
            {modelPickerName(model, stripVendorPrefix ?? false)}
          </span>
          {!stripVendorPrefix && tag ? (
            <span className="rounded-full bg-[rgba(52,199,89,0.14)] px-1.5 py-0.5 text-ios-caption2 font-semibold text-[#248A3D]">
              {tag}
            </span>
          ) : null}
          <span className="shrink-0 pl-1 text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.58)]">
            {modelPriceLabel(model, priceOptions)}
          </span>
          {selected ? (
            <Check className="absolute right-2 h-3.5 w-3.5 text-[rgba(0,122,255,0.9)]" />
          ) : null}
        </span>
      </DropdownMenuItem>
    );
  };

  const renderVendor = (group: VendorGroup) => {
    const imageModels = group.models.filter((model) => generationModel(model)?.kind !== "video");
    const videoModels = group.models.filter((model) => generationModel(model)?.kind === "video");
    return (
      <DropdownMenuSub key={group.vendor}>
        <DropdownMenuSubTrigger
          className="text-ios-footnote"
          data-model-picker-vendor={group.vendor}
          onPointerEnter={group.vendor === "PixAI" ? () => {
            window.setTimeout(maybeStartLoraTour, 450);
          } : undefined}
        >
          <span className="flex w-full min-w-[10rem] items-center gap-2.5">
            <VendorIcon vendor={group.vendor} />
            <span className="font-medium text-[rgba(0,0,0,0.85)]">{group.vendor}</span>
            {!stripVendorPrefix && VENDOR_TAGS[group.vendor] ? (
              <span className="shrink-0 rounded-full bg-[rgba(52,199,89,0.14)] px-1.5 py-0.5 text-ios-caption2 font-semibold text-[#248A3D]">
                {VENDOR_TAGS[group.vendor]}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 pl-3 text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.48)]">
              {group.models.length}
            </span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent>
            {imageModels.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-1 text-ios-caption2 font-semibold text-[rgba(0,0,0,0.44)]">
                <ImageIcon className="h-3 w-3" />
                图片
              </div>
            )}
            {imageModels.map((model) => renderModel(model))}
            {videoModels.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-2 text-ios-caption2 font-semibold text-[rgba(0,0,0,0.44)]">
                <Video className="h-3 w-3" />
                视频
              </div>
            )}
            {videoModels.map((model) => renderModel(model))}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    );
  };

  const renderMobileVendor = (group: VendorGroup) => {
    const imageModels = group.models.filter((model) => generationModel(model)?.kind !== "video");
    const videoModels = group.models.filter((model) => generationModel(model)?.kind === "video");
    const maybeStartPixaiTour = group.vendor === "PixAI" ? maybeStartLoraTour : undefined;
    return (
      <section key={group.vendor} className="min-w-0 max-w-full py-1 first:pt-0 last:pb-0">
        <div
          className="sticky top-0 z-10 flex min-w-0 items-center gap-2 bg-[rgba(255,255,255,0.92)] px-2.5 py-1.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.54)] backdrop-blur-xl"
          data-model-picker-mobile-vendor={group.vendor}
          onPointerEnter={maybeStartPixaiTour}
          onPointerDown={maybeStartPixaiTour}
        >
          <VendorIcon vendor={group.vendor} className="h-5 w-5 rounded-[0.4rem]" innerClassName="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate">{group.vendor}</span>
          <span className="shrink-0 tabular-nums text-[rgba(0,0,0,0.48)]">{group.models.length}</span>
        </div>
        {imageModels.length > 0 && (
          <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-1 text-ios-caption2 font-semibold text-[rgba(0,0,0,0.48)]">
            <ImageIcon className="h-3 w-3" />
            图片
          </div>
        )}
        {imageModels.map((model) => renderModel(model, true))}
        {videoModels.length > 0 && (
          <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-1.5 text-ios-caption2 font-semibold text-[rgba(0,0,0,0.48)]">
            <Video className="h-3 w-3" />
            视频
          </div>
        )}
        {videoModels.map((model) => renderModel(model, true))}
      </section>
    );
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger
        aria-label="选择模型"
        data-model-picker-trigger
        onPointerDown={(event) => {
          // 引导进行中禁止打开菜单，避免菜单 portal 遮罩干扰引导
          if (loraTourBusyRef.current) event.preventDefault();
        }}
        className={`style-chip min-h-0 min-w-0 ${stripVendorPrefix ? "w-full max-w-full" : "w-fit max-w-full"} justify-start gap-1.5 py-0 pl-3 pr-2.5 font-medium outline-none focus:outline-none focus-visible:outline-none [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:opacity-40`}
      >
        <span className="min-w-0 truncate">{modelPickerName(value, stripVendorPrefix ?? false)}</span>
        {!stripVendorPrefix && promotionTag ? (
          <span className="shrink-0 rounded-full bg-[rgba(52,199,89,0.14)] px-1.5 py-0.5 text-ios-caption2 font-semibold text-[#248A3D]">
            {promotionTag}
          </span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-[calc(100vw-1.5rem)] max-w-[22rem] overflow-x-hidden rounded-ios-2xl border-0 lg-sheet p-1.5 lg:w-auto lg:max-w-none"
        onInteractOutside={(event) => {
          // 引导进行中拦截菜单关闭，避免 PixAI 菜单 portal 遮罩干扰引导
          // 进入专业模式经由 onMenuOpenChange 回到受控状态
          if (loraTourBusyRef.current) event.preventDefault();
        }}
      >
        <div data-model-picker-mobile className="min-w-0 max-w-full lg:hidden">
          {vendorGroups.map(renderMobileVendor)}
        </div>
        <div className="hidden lg:block">
          {vendorGroups.map(renderVendor)}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
