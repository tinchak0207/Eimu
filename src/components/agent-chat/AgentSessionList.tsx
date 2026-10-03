"use client";

// 歷史會話列表（2026-10-03 對標 Grok 側欄）：寬屏下拉與窄屏底部抽屜共用同一份
// 列表內容——分節以下的列本身只有一種長相：標題（最多兩行截斷）＋相對日期，
// 當前會話淺灰圓角高亮，整列可點。
//
// 容器（寬屏 agent-pop 下拉 / 窄屏 agent-param-drawer 抽屜）與搜尋框由
// AgentChatSurface 持有；這裡只管「載入中 / 空態 / 列」三態與過濾。
//
// 無 hooks（query 由外層受控傳入），所以測試可以直接呼叫元件取得元素樹、
// 對列按鈕的 onClick 做行為斷言（見 agent-history-list.test.ts）。

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
 * Grok 側欄式相對日期（不用 ICU 的 relative 格式，逐档手写保證任何環境輸出一致）：
 *   今天   → HH:mm（24h）
 *   昨天   → 「昨天」
 *   7 天內 → 星期幾
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
  // 今天起往前數 7 個自然日（含今天）都給星期幾；再早才落絕對日期。
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const d = new Date(timestamp);
  if (timestamp >= weekStart) return WEEKDAYS_ZH[d.getDay()];
  const nowDate = new Date(now);
  if (d.getFullYear() === nowDate.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 搜尋過濾：對「顯示出來的那行標題」（含降級時間標籤）做大小寫不敏感的
 * 包含匹配。空串／全空白不過濾。client-side，歷史目錄量級用不著伺服器。
 *
 * formatLabel 受注入（唯一實作在 AgentChatSurface——既有測試對它的源碼錨點
 * 鎖在那個檔，這裡不複製第二份邏輯防漂移）。
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
  /** null = 本輪還沒送出過、會話尚未建立（lazy 建號），此時沒有任何一列算「當前」。 */
  currentSessionId: string | null;
  switchingTo: string | null;
  startingNew: boolean;
  /** 搜尋詞（受控，外層持有輸入框）；缺席＝不過濾。 */
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
  currentSessionId,
  switchingTo,
  startingNew,
  query,
  formatLabel,
  onPick,
  onStartNew,
}: AgentSessionListProps) {
  if (sessions === null) {
    return (
      <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
        正在加载历史会话…
      </p>
    );
  }

  const visible = query !== undefined ? filterAgentSessions(sessions, query, formatLabel) : sessions;

  if (visible.length === 0) {
    // 搜尋無命中與「本來就沒有歷史」是兩種空：前者給一句了事，後者沿用既有
    // 引導文案＋ inline 開新對話 CTA（2026-08-22 完美主義審視的文案不動）。
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
                {/* 行首状态点缩进日期行：列首寬度恆定不抖动，aria-hidden 视觉点
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
