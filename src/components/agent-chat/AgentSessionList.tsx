"use client";

// 历史会话列表（2026-10-03 对标 Grok 侧栏）：宽屏下拉与窄屏底部抽屉共用同一份
// 列表内容——分节以下的列本身只有一种长相：标题（最多两行截断）＋相对日期，
// 当前会话浅灰圆角高亮，整列可点。
//
// 容器（宽屏 agent-pop 下拉 / 窄屏 agent-param-drawer 抽屉）与搜寻框由
// AgentChatSurface 持有；这里只管「载入中 / 空态 / 列」三态与过滤。
//
// 无 hooks（query 由外层受控传入），所以测试可以直接呼叫元件取得元素树、
// 对列按钮的 onClick 做行为断言（见 agent-history-list.test.ts）。

import { Loader2, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";

/** 取本地时区当天 00:00 的时间戳（与 history-types 的自然日边界同款：
 *  「今天」是自然日，不是「距今 24 小时」）。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const WEEKDAYS_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;

/**
 * Grok 侧栏式相对日期（不用 ICU 的 relative 格式，逐档手写保证任何环境输出一致）：
 *   今天   → HH:mm（24h）
 *   昨天   → 「昨天」
 *   7 天内 → 星期几
 *   更早（同年）→ M月D日
 *   跨年   → YYYY/M/D
 * now 可注入，便于测试。
 */
export function formatSessionRelativeTime(timestamp: number, now: number = Date.now()): string {
  const todayStart = startOfLocalDay(now);
  if (timestamp >= todayStart) {
    const d = new Date(timestamp);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  if (timestamp >= yesterdayStart) return "昨天";
  // 今天起往前数 7 个自然日（含今天）都给星期几；再早才落绝对日期。
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const d = new Date(timestamp);
  if (timestamp >= weekStart) return WEEKDAYS_ZH[d.getDay()];
  const nowDate = new Date(now);
  if (d.getFullYear() === nowDate.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 搜寻过滤：对「显示出来的那行标题」（含降级时间标签）做大小写不敏感的
 * 包含匹配。空串／全空白不过滤。client-side，历史目录量级用不著伺服器。
 *
 * formatLabel 受注入（唯一实作在 AgentChatSurface——既有测试对它的源码锚点
 * 锁在那个档，这里不复制第二份逻辑防漂移）。
 */
export function filterAgentSessions(
  list: AgentSessionSummary[],
  query: string,
  formatLabel: (it: AgentSessionSummary) => string,
): AgentSessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((it) => formatLabel(it).toLowerCase().includes(q));
}

/**
 * 历史会话状态点（网关 sessions.status 契约：running | waiting | idle）。
 * 三态都渲染圆点（含 idle 淡灰），缺字段按 idle 处理。
 * 颜色只用 DESIGN.md 的 iOS 系统色 token。
 */
const SESSION_STATUS_META: Record<
  NonNullable<AgentSessionSummary["status"]>,
  { dotClass: string; label: string }
> = {
  running: { dotClass: "bg-ios-blue animate-pulse", label: "运转中" },
  waiting: { dotClass: "bg-ios-orange", label: "等待回答" },
  idle: { dotClass: "bg-foreground/15", label: "已静置" },
};

export interface AgentSessionListProps {
  /** null = 未加载；[] = 已加载但为空。 */
  sessions: AgentSessionSummary[] | null;
  loadError?: string | null;
  /** null = 本轮还没送出过、会话尚未建立（lazy 建号），此时没有任何一列算「当前」。 */
  currentSessionId: string | null;
  switchingTo: string | null;
  startingNew: boolean;
  /** 搜寻词（受控，外层持有输入框）；缺席＝不过滤。 */
  query?: string;
  /** 标题格式化（双轨：网关 title 优先，无标题降级时间标签）。唯一实现
      在 AgentChatSurface（既有测试的源码锚点锁在那），这里受注入。 */
  formatLabel: (it: AgentSessionSummary) => string;
  /** 点某一列＝切到该会话（外层负责成功后收起浮层）。 */
  onPick: (sessionId: string) => void;
  /** 空态 CTA：开新对话（外层负责收起浮层）。 */
  onStartNew: () => void;
}

export function AgentSessionList({
  sessions,
  loadError,
  currentSessionId,
  switchingTo,
  startingNew,
  query,
  formatLabel,
  onPick,
  onStartNew,
}: AgentSessionListProps) {
  if (sessions === null) {
    if (loadError) return <p role="alert" className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/65">{loadError}</p>;
    return (
      <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
        正在加载历史会话…
      </p>
    );
  }

  const visible = query !== undefined ? filterAgentSessions(sessions, query, formatLabel) : sessions;

  if (visible.length === 0) {
    // 搜寻无命中与「本来就没有历史」是两种空：前者给一句了事，后者沿用既有
    // 引导文案＋ inline 开新对话 CTA（2026-08-22 完美主义审视的文案不动）。
    if (sessions.length > 0) {
      return (
        <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
          没有匹配的对话
        </p>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1.5 px-2.5 py-3">
        <MessageSquarePlus className="h-4 w-4 text-foreground/45" aria-hidden="true" />
        <p className="text-left text-ios-caption1 leading-relaxed text-foreground/45">
          还没有历史对话
        </p>
        <button
          type="button"
          onClick={onStartNew}
          disabled={startingNew}
          className="cursor-pointer text-left text-ios-caption1 font-medium text-ios-blue transition-colors hover:text-ios-blue/80 disabled:cursor-wait"
        >
          {startingNew ? "正在开启…" : "开始新对话 →"}
        </button>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {visible.map((it) => {
        const active = it.session_id === currentSessionId;
        const statusMeta = SESSION_STATUS_META[it.status ?? "idle"];
        return (
          <li key={it.session_id}>
            <button
              type="button"
              data-session-id={it.session_id}
              aria-current={active ? "true" : undefined}
              disabled={switchingTo !== null}
              onClick={() => onPick(it.session_id)}
              className={cn(
                "flex min-h-[52px] w-full cursor-pointer touch-manipulation flex-col justify-center gap-0.5 rounded-[14px] px-3 py-2 text-left transition-colors",
                active ? "bg-black/[0.05]" : "hover:bg-black/[0.04] active:bg-black/[0.07]",
                switchingTo === it.session_id && "opacity-50",
              )}
            >
              <span className="line-clamp-2 text-ios-subhead font-medium leading-snug text-foreground/85">
                {formatLabel(it)}
              </span>
              <span className="flex items-center gap-1.5 text-ios-footnote text-foreground/45">
                {/* 行首状态点缩进日期行：列首宽度恒定不抖动，aria-hidden 视觉点
                    + sr-only 状态文字。 */}
                <span
                  aria-hidden="true"
                  title={statusMeta.label}
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusMeta.dotClass)}
                />
                <span className="sr-only">{statusMeta.label}</span>
                {formatSessionRelativeTime(it.last_activity_at)}
                {switchingTo === it.session_id && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
