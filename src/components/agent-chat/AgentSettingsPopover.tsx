"use client";

// 助理设定弹层：只留两行——「我的技能」（自建 Skill 管理入口）与「互动模式」。
//
// 2026-10-03 暴君定案：中途输入 / 模型性格 / 成本需求 / 野兽模式 四列的 UI 全部撤出
// 这个弹层，收拢成输入框「+」右上角的「思考级别」菜单（AgentComposer 的
// ThinkingLevelMenu）。AgentSettings 的五栏与送往网关的 payload 形状**不变**，
// 只是不再各自暴露 UI；本层对 persona / cost_mode / beast_mode 不再读写——
// 唯一真源是 agent-chat-client.ts 的 AGENT_THINKING_LEVEL_SETTINGS。
//
// 状态管理三层（保留）：
// 1. localStorage 缓存（agent-settings-v1）是 send() 的即时数据源——改设定先写
//    缓存，下一拍发送就读得到，不等网络；
// 2. 挂载时 GET 回读合并（网关为准，缺项用默认），失败静默——设定不可用不挡聊天；
// 3. 改值走 saveAgentSettings：写缓存 + 异步持久化到网关，网络失败不打扰对话。
//
// 样式：lg-sheet 小卡，定位写法与历史记录 dropdown 一致（absolute top-full right-0
// z-50），点外面收起。

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { MySkillsDialog } from "./MySkillsDialog";
import { setHideAgentReasoning, useHideAgentReasoning } from "@/lib/agent-display-preferences";
import {
  getAgentSettings,
  readCachedAgentSettings,
  saveAgentSettings,
  writeCachedAgentSettings,
  type AgentSettings,
} from "@/lib/agent-chat-client";

/** 互动三档：slider 刻度顺序与网关枚举一一对应（index 0/1/2）。
 *  文案＝机制真话（2026-09-24）：协作档的三个停点（剧本批准／资产确认／分镜确认）
 *  由网关注册 pending confirm 真的停下等你批准，批准后从断点续跑；预设＝跟着计划
 *  一次整包授权，一路跑到尾（只有扣费闸拦）；自动＝连扣费确认都自动放行，一条消息
 *  跑完。旧文案「协作：每步都和你确认」曾是**空承诺**（机制不存在），已按实况改写。 */
const INTERACTION_MODES = ["collaborate", "preset", "auto"] as const;
const INTERACTION_TIERS = ["协作", "预设", "自动"] as const;
const INTERACTION_HINTS: Record<(typeof INTERACTION_MODES)[number], string> = {
  collaborate: "协作：剧本/资产/分镜三步停下等你确认，确认后自动续跑，其余环节自动",
  preset: "预设：一次整包授权，一路跑完，只有扣费与关键决策拦你",
  auto: "自动：一键发送直出结果，连扣费确认都自动放行，全程不问你",
};

export function AgentSettingsPopover() {
  const hideReasoning = useHideAgentReasoning();
  const [open, setOpen] = useState(false);
  /** 「我的技能」管理面：在同一个设定弹层里再开一张 lg-sheet（不造第二个入口）。 */
  const [skillsOpen, setSkillsOpen] = useState(false);
  // 初值直接吃本地缓存：弹层打开立即是用户上次的值，不等网络。
  const [settings, setSettings] = useState<AgentSettings>(() => readCachedAgentSettings());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 挂载时 GET 回读合并：网关为准，缺项用默认；失败 getAgentSettings 静默回
  // 默认值——设定不可用不能挡聊天。回读结果落缓存，send() 下一拍就读得到
  // （persona / cost_mode / beast_mode 由思考级别菜单消费，本层不再显示它们）。
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
  // 例外：「我的技能」对话框已 portal 到 document.body（2026-10-04），不再是 rootRef 子树，
  // 点它内部会被 contains 误判为「点外面」；沿用同一套 contains 语义，以 data-my-skills-dialog
  // 作等效的内部判定，命中即放行、不收弹层。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      const el = ev.target instanceof Element ? ev.target : null;
      if (el?.closest("[data-my-skills-dialog]")) return;
      if (rootRef.current && !rootRef.current.contains(el)) {
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
        <div className="agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-64 -translate-x-1/2 rounded-[18px] p-1.5">
          {/* MASTER.md：每张 sheet 都要有一条顶缘高光线。 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          <div className="divide-y divide-black/[0.06]">
            {/* a0) 我的技能：使用者自建 Skill 的管理入口（列举／新增／编辑／删除）。
                站内没有公开发布／市集，自己存的技能打「/」就能直呼；入口只此一处。 */}
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">我的技能</span>
                <button
                  type="button"
                  onClick={() => setSkillsOpen(true)}
                  className="cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue transition-colors hover:bg-ios-blue/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
                >
                  管理
                </button>
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">
                把你自己的做法存成技能，输入框打「/」就能直呼
              </p>
            </div>
            <div className="px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ios-footnote font-medium text-foreground">隐藏思维链</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hideReasoning}
                  aria-label="隐藏思维链"
                  onClick={() => setHideAgentReasoning(!hideReasoning)}
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
                >
                  {/* 沿用 AdminRoutingPanel 的开关尺寸与滑块结构。 */}
                  <span className={cn("relative h-6 w-11 rounded-full transition-colors", hideReasoning ? "bg-ios-blue" : "bg-black/15")}>
                    <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform", hideReasoning ? "left-6" : "left-1")} />
                  </span>
                </button>
              </div>
              <p className="mt-1 text-ios-caption2 leading-relaxed text-foreground/45">只显示回答和任务进度</p>
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
      {/* 管理面：无公开市集，只有「我自己的技能」。对话框自行 portal 到 document.body，
          点它内部由上面的 outside-click 以 data-my-skills-dialog 放行、不收设定弹层。 */}
      {skillsOpen && <MySkillsDialog onClose={() => setSkillsOpen(false)} />}
    </div>
  );
}
