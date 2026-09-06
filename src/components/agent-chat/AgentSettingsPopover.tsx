"use client";

// 助理设定弹层（罪状 6）：中途输入 / 模型性格 / 成本需求 / 互动模式 四行。
//
// 状态管理三层：
// 1. localStorage 缓存（agent-settings-v1）是 send() 的即时数据源——改设定先写
//    缓存，下一拍发送就读得到，不等网络；
// 2. 挂载时 GET 回读合并（网关为准，缺项用默认），失败静默——设定不可用不挡聊天；
// 3. 改值走 saveAgentSettings：写缓存 + 异步持久化到网关，网络失败不打扰对话。
//
// 样式：lg-sheet 小卡，定位写法与历史记录 dropdown 一致（absolute top-full right-0
// z-50），点外面收起；开关是圆角胶囊小轮子，不引第三方库。

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getAgentSettings,
  readCachedAgentSettings,
  saveAgentSettings,
  writeCachedAgentSettings,
  type AgentSettings,
} from "@/lib/agent-chat-client";

/** 成本三档：slider 刻度顺序与网关枚举一一对应（index 0/1/2）。 */
const COST_MODES = ["economy", "balanced", "premium"] as const;
const COST_TIERS = ["经济", "均衡", "高质"] as const;
const COST_HINTS: Record<(typeof COST_MODES)[number], string> = {
  economy: "经济：单图低成本，不自动放大",
  balanced: "均衡：常规质量，速度与成本兼顾",
  premium: "高质：允许多候选与高清放大",
};

/** 互动三档：slider 刻度顺序与网关枚举一一对应（index 0/1/2）。 */
const INTERACTION_MODES = ["collaborate", "preset", "auto"] as const;
const INTERACTION_TIERS = ["协作", "预设", "自动"] as const;
const INTERACTION_HINTS: Record<(typeof INTERACTION_MODES)[number], string> = {
  collaborate: "协作：每步都和你確認，扣費與關鍵決策逐項詢問",
  preset: "预设：更自主：整包計畫一次授權，扣費與關鍵決策仍找你",
  auto: "自动：完全自主：不再詢問與扣費確認，一鍵發送直出結果",
};

/** iOS 风开关：h-6 w-10 胶囊 + 白色圆钮，选中态 ios-blue。 */
function IosSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-ios-spring focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/40",
        checked ? "bg-ios-blue" : "bg-black/[0.16]",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-200 ease-ios-spring",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function AgentSettingsPopover() {
  const [open, setOpen] = useState(false);
  // 初值直接吃本地缓存：弹层打开立即是用户上次的值，不等网络。
  const [settings, setSettings] = useState<AgentSettings>(() => readCachedAgentSettings());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 挂载时 GET 回读合并：网关为准，缺项用默认；失败 getAgentSettings 静默回
  // 默认值——设定不可用不能挡聊天。回读结果落缓存，send() 下一拍就读得到。
  useEffect(() => {
    let alive = true;
    void getAgentSettings().then((remote) => {
      if (!alive) return;
      setSettings(remote);
      writeCachedAgentSettings(remote);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 开着时点外面就收——与历史记录 dropdown 同一条规矩（pointerdown + contains）。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  /** 改一项：本地立即生效（saveAgentSettings 内部先写缓存）+ 异步持久化到网关。 */
  const update = useCallback((p: Partial<AgentSettings>): void => {
    void saveAgentSettings(p);
    setSettings((prev) => ({ ...prev, ...p }));
  }, []);

  const interruptIsSteer = settings.interrupt_mode === "steer";
  const thoughtful = settings.persona === "thoughtful";
  const costIndex = Math.max(0, COST_MODES.indexOf(settings.cost_mode));
  const interactionIndex = Math.max(0, INTERACTION_MODES.indexOf(settings.interaction_mode));

  return (
    <div ref={rootRef} className="relative">
      {/* 触发钮：与历史/开新对话/收起同一套 h-8 w-8 rounded-lg 图标语法。 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="助理设定"
        title="助理设定"
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation"
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div className="lg-sheet fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-64 -translate-x-1/2 rounded-ios-2xl p-1">
          {/* MASTER.md：每张 sheet 都要有一条顶缘高光线。 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          <div className="divide-y divide-black/[0.06]">
            {/* a) 中途输入：turn 中发消息是打断还是排队（控制 send() 的行为）。 */}
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">中途输入</span>
                <span className="flex items-center gap-2">
                  <span className="text-ios-caption1 text-muted-foreground">{interruptIsSteer ? "打断" : "排队"}</span>
                  <IosSwitch
                    checked={interruptIsSteer}
                    onChange={(next) => update({ interrupt_mode: next ? "steer" : "queue" })}
                    label="中途输入：打断或排队"
                  />
                </span>
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">
                {interruptIsSteer ? "打断：新消息立即接管当前回合" : "排队：新消息在本轮结束后执行"}
              </p>
            </div>
            {/* b) 模型性格：高效（默认）或沉稳。 */}
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">模型性格</span>
                <span className="flex items-center gap-2">
                  <span className="text-ios-caption1 text-muted-foreground">{thoughtful ? "沉稳" : "高效"}</span>
                  <IosSwitch
                    checked={thoughtful}
                    onChange={(next) => update({ persona: next ? "thoughtful" : "efficient" })}
                    label="模型性格：高效或沉稳"
                  />
                </span>
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">
                {thoughtful ? "沉稳：先充分思考再行动，回复更慢更全面" : "高效：快速行动，先给结果"}
              </p>
            </div>
            {/* c) 成本需求：三档 slider（原生 range min=0 max=2 step=1），当前档位点亮刻度点。 */}
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">成本需求</span>
                <span className="text-ios-caption1 font-medium text-ios-blue">{COST_TIERS[costIndex]}</span>
              </div>
              <div className="relative mt-2 flex h-5 items-center">
                <div className="h-1.5 w-full rounded-full bg-black/[0.12]" />
                <div
                  className="absolute h-1.5 rounded-full bg-ios-blue"
                  style={{ width: `${(costIndex / (COST_MODES.length - 1)) * 100}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={costIndex}
                  aria-label="成本需求"
                  aria-valuetext={COST_TIERS[costIndex]}
                  onChange={(e) => update({ cost_mode: COST_MODES[Number(e.target.value)] ?? "balanced" })}
                  className="absolute inset-0 h-5 w-full cursor-pointer appearance-none bg-transparent focus:outline-none [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)] [&::-moz-range-track]:h-5 [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
                />
              </div>
              {/* 三个刻度点：当前档位点亮。 */}
              <div className="mt-1 flex justify-between px-1">
                {COST_TIERS.map((tier, i) => (
                  <span
                    key={tier}
                    className={cn("h-1 w-1 rounded-full", i === costIndex ? "bg-ios-blue" : "bg-black/20")}
                  />
                ))}
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">{COST_HINTS[COST_MODES[costIndex]]}</p>
            </div>
            {/* d) 互动模式：三档 slider（原生 range min=0 max=2 step=1），当前档位点亮刻度点。 */}
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">互动模式</span>
                <span className="text-ios-caption1 font-medium text-ios-blue">{INTERACTION_TIERS[interactionIndex]}</span>
              </div>
              <div className="relative mt-2 flex h-5 items-center">
                <div className="h-1.5 w-full rounded-full bg-black/[0.12]" />
                <div
                  className="absolute h-1.5 rounded-full bg-ios-blue"
                  style={{ width: `${(interactionIndex / (INTERACTION_MODES.length - 1)) * 100}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={interactionIndex}
                  aria-label="互动模式"
                  aria-valuetext={INTERACTION_TIERS[interactionIndex]}
                  onChange={(e) => update({ interaction_mode: INTERACTION_MODES[Number(e.target.value)] ?? "preset" })}
                  className="absolute inset-0 h-5 w-full cursor-pointer appearance-none bg-transparent focus:outline-none [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)] [&::-moz-range-track]:h-5 [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
                />
              </div>
              {/* 三个刻度点：当前档位点亮。 */}
              <div className="mt-1 flex justify-between px-1">
                {INTERACTION_TIERS.map((tier, i) => (
                  <span
                    key={tier}
                    className={cn("h-1 w-1 rounded-full", i === interactionIndex ? "bg-ios-blue" : "bg-black/20")}
                  />
                ))}
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">{INTERACTION_HINTS[INTERACTION_MODES[interactionIndex]]}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
