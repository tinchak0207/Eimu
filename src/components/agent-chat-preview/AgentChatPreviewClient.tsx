"use client";

/**
 * Grok 风格极简 AI 助理聊天 UI —— 独立预览（静态假数据，不连后端）。
 *
 * 设计原则：正文至上、工具降级、色彩收敛。
 * 色彩纪律：全页只有 foreground 灰阶 + ios-blue accent + 红（仅错误/停止）
 * + 币数金（coin-badge 既有金色 #b8860b，tailwind.config 无 ios-gold token）。
 *
 * Eimu 味（2026-10-01）：版面常驻零装饰（顶栏纯图标）；品牌只靠 Navbar 同款
 * 玻璃 E 图标（/icon.png）在两处出场——空态迎接、助理回合抬头/思考中。
 * 红线：助理界面禁用人物形象（public/mascot/* 看板娘一律不用，暴君已否决）。
 *
 * 红线：不 import 任何现有 agent-chat 组件；IME Enter 守卫逐字复刻
 * AgentComposer.tsx 的既有契约（isComposing / keyCode 229，且在
 * preventDefault 之前返回）。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  Coins,
  Crop,
  Download,
  History,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Maximize2,
  Palette,
  Plus,
  PenLine,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
} from "lucide-react";
import { AGENT_EXAMPLE_PROMPTS } from "@/lib/agent-example-prompts";
import { cn } from "@/lib/utils";

/* ──────────────────────────── 假数据 ──────────────────────────── */

interface DemoTool {
  id: string;
  icon: typeof Search;
  name: string;
  status: "running" | "done" | "failed";
  detail: Array<[string, string]>;
}

const DEMO_TOOLS: DemoTool[] = [
  {
    id: "search",
    icon: Search,
    name: "搜索水彩橘猫参考",
    status: "running",
    detail: [
      ["关键词", "水彩 橘猫 温暖"],
      ["来源", "聚合搜索 · 8 条结果"],
    ],
  },
  {
    id: "quote",
    icon: Coins,
    name: "查询生成报价",
    status: "done",
    detail: [
      ["模型", "seedream-5.0-lite"],
      ["规格", "1024×1024 · 0.05 币/张"],
    ],
  },
  {
    id: "generate",
    icon: ImageIcon,
    name: "生成首张样图",
    status: "done",
    detail: [
      ["seed", "emu1"],
      ["耗时", "6.4 秒"],
    ],
  },
  {
    id: "canvas",
    icon: LayoutGrid,
    name: "写入画布节点",
    status: "failed",
    detail: [
      ["错误", "上游超时（10s）"],
      ["恢复", "已自动换渠道重试 · 第 2 次"],
    ],
  },
];

interface DemoSubagent {
  id: string;
  icon: typeof PenLine;
  name: string;
  status: "done" | "running" | "waiting";
}

const DEMO_SUBAGENTS: DemoSubagent[] = [
  { id: "sa-1", icon: PenLine, name: "分镜师", status: "done" },
  { id: "sa-2", icon: Palette, name: "色彩参考", status: "running" },
  { id: "sa-3", icon: Crop, name: "构图润色", status: "waiting" },
];

const DEMO_PLANS = [
  { summary: "水彩橘猫 · 4 张 1024×1024 · 暖调构图", coins: 8 },
  { summary: "水彩橘猫 · 4 张 1536×1024 · 横幅电影感", coins: 10 },
];

const DEMO_REASONING = [
  "用户想要水彩风格的橘猫，用途未说明，按通用出图处理。",
  "先搜参考确认视觉方向，再核报价；单张 0.05 币，4 张在预算内。",
  "首张样图先出给用户看效果，确认后再批量，避免浪费币。",
  "画布写入失败是上游超时，换渠道重试即可，不用打断用户。",
].join("\n");

const FIXED_REPLY =
  "收到。这里是预览环境的固定回复——真实环境会接入工具与子代理，继续执行你的要求。";

/* ──────────────────────────── 消息类型 ──────────────────────────── */

interface PreviewMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

/* ──────────────────────────── 小组件 ──────────────────────────── */

/** 幽灵图标按钮：视觉小、触控区 ≥44px。hover 态＝lg-fill-active 的底色值。 */
function GhostIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95"
    >
      {children}
    </button>
  );
}

/**
 * 顶缘 specular 亮线（MASTER.md §5 / DESIGN.md §5 权威配方）：
 * 每个 card / sheet / float 都要这条渐变白线，玻璃才有「上缘受光」的质感。
 */
function SpecularLine() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
    />
  );
}

/**
 * Eimu 品牌标：Navbar 同款玻璃 E 图标（lg-float 圆角方块 + /icon.png），
 * 与首页左上角 logo 同一件东西——助理界面的品牌只从这里来，不用人物形象。
 * breathing＝思考中，整枚图标轻呼吸（motion-safe，减弱动效偏好下静止）。
 */
function BrandMark({ size, breathing = false }: { size: number; breathing?: boolean }) {
  return (
    <span
      className={cn(
        "lg-float relative inline-flex shrink-0 overflow-hidden",
        breathing && "motion-safe:animate-pulse",
      )}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 站点 app icon，固定尺寸 */}
      <img src="/icon.png" alt="" aria-hidden="true" width={size} height={size} className="h-full w-full object-cover" />
    </span>
  );
}

/**
 * 思维链（新形态）：默认收合的一行「已思考 · N 秒」，点开灰底圆角块。
 * 行首＝Eimu 玻璃 E 图标（取代 Brain）：助理回合的抬头，与思考中那行同位同尺寸，
 * 思考结束只是图标停止呼吸、文案换掉——位置不动。
 */
function ReasoningDisclosure({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 text-left text-ios-footnote font-medium text-muted-foreground select-none [-webkit-tap-highlight-color:transparent]"
      >
        <BrandMark size={20} />
        已思考 · 12 秒
        <ChevronDown
          className={cn(
            "lg-transition h-3.5 w-3.5 shrink-0 text-foreground/35",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="lg-float mt-1 whitespace-pre-wrap break-words rounded-[14px] px-3 py-2.5 text-ios-footnote leading-[1.6] text-muted-foreground [overflow-wrap:anywhere]">
          {DEMO_REASONING}
        </div>
      ) : null}
    </div>
  );
}

/** 工具行（新形态）：无底色无边框无彩色 tag 的一行；点行展开参数细节。 */
function ToolRow({ tool }: { tool: DemoTool }) {
  const [open, setOpen] = useState(false);
  const Icon = tool.icon;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2 -mx-2 text-left transition-colors hover:bg-white/55 select-none [-webkit-tap-highlight-color:transparent]"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ios-footnote text-foreground/60">
          {tool.name}
        </span>
        {tool.status === "running" ? (
          <>
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin text-ios-blue/70"
              aria-hidden="true"
            />
            <span className="shrink-0 text-ios-footnote text-ios-blue">运行中…</span>
          </>
        ) : null}
        {tool.status === "done" ? (
          <>
            <Check className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
            <span className="shrink-0 text-ios-footnote text-foreground/45">完成</span>
          </>
        ) : null}
        {tool.status === "failed" ? (
          <span className="shrink-0 text-ios-footnote text-ios-red">失败</span>
        ) : null}
      </button>
      {open ? (
        <div className="lg-float mb-1 ml-[22px] space-y-1 rounded-[10px] px-2.5 py-2">
          {tool.detail.map(([key, value]) => (
            <p key={key} className="text-ios-footnote leading-[1.5] text-muted-foreground">
              <span className="text-foreground/45">{key}：</span>
              {value}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 子任务组（新形态）：收成一行可展开；展开后是极简工具行 + 右端圆点状态。 */
function SubagentGroup() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-1.5 text-left text-ios-footnote font-medium text-muted-foreground select-none [-webkit-tap-highlight-color:transparent]"
      >
        <span className="text-foreground/60">派出 3 个子代理</span>
        <ChevronDown
          className={cn(
            "lg-transition h-3.5 w-3.5 shrink-0 text-foreground/35",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="space-y-0.5">
          {DEMO_SUBAGENTS.map((sa) => {
            const Icon = sa.icon;
            return (
              <div
                key={sa.id}
                className="flex min-h-11 items-center gap-2 rounded-[12px] px-2 -mx-2 transition-colors hover:bg-white/55"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ios-footnote text-foreground/60">
                  {sa.name}
                </span>
                {sa.status === "running" ? (
                  <>
                    <span className="shrink-0 text-ios-footnote text-ios-blue">运行中…</span>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ios-blue" />
                  </>
                ) : null}
                {sa.status === "done" ? (
                  <>
                    <span className="shrink-0 text-ios-footnote text-foreground/45">完成</span>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/60" />
                  </>
                ) : null}
                {sa.status === "waiting" ? (
                  <>
                    <span className="shrink-0 text-ios-footnote text-foreground/45">等待</span>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-black/20" />
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 生成结果：图卡 + 灰字小动作条。 */
function ImageResultCard() {
  return (
    <div>
      <div className="overflow-hidden rounded-[18px] bg-black/[0.03]">
        {/* eslint-disable-next-line @next/next/no-img-element -- 外链占位图，预览页不接 next/image 域名配置 */}
        <img
          src="https://picsum.photos/seed/emu1/512/512"
          alt="生成结果示例"
          width={512}
          height={512}
          className="w-full"
        />
      </div>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors hover:bg-white/60 hover:text-foreground/70"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          下载
        </button>
        <button
          type="button"
          className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors hover:bg-white/60 hover:text-foreground/70"
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          放大
        </button>
        <button
          type="button"
          className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors hover:bg-white/60 hover:text-foreground/70"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          再来一组
        </button>
      </div>
    </div>
  );
}

/** 批次进度（新形态）：一行细进度条 + 灰字 + 幽灵红字停止。 */
function BatchProgressRow({
  stopped,
  onStop,
}: {
  stopped: boolean;
  onStop: () => void;
}) {
  return (
    <div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]">
        <div
          className={cn(
            "lg-transition h-full rounded-full",
            stopped ? "w-full bg-black/[0.12]" : "w-[64%] bg-ios-blue",
          )}
        />
      </div>
      <div className="mt-1.5 flex min-h-11 items-center justify-between gap-2">
        <span className="text-ios-footnote text-muted-foreground">
          {stopped ? "已停止 · 未用部分已退回" : "正在生成 4 张 · 已用 12 币"}
        </span>
        {stopped ? null : (
          <button
            type="button"
            onClick={onStop}
            className="flex min-h-11 items-center rounded-lg px-2.5 text-ios-footnote text-ios-red/85 transition-colors hover:bg-ios-red/[0.07] active:scale-95"
          >
            停止
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 思考指示：与「已思考」行同位同尺寸（min-h-11 + 20px 品牌标），品牌标呼吸。
 * 呼吸本身就是「在动」的信号，三个跳点拿掉——一个动效就够。
 */
function ThinkingRow() {
  return (
    <div className="flex min-h-11 items-center gap-2" role="status" aria-label="Eimu 正在思考">
      <BrandMark size={20} breathing />
      <span className="text-ios-footnote font-medium text-muted-foreground">Eimu 正在想…</span>
    </div>
  );
}

/* ──────────────────────────── Eimu 虹彩 ──────────────────────────── */

/**
 * Eimu 虹彩＝玻璃 E 图标自带的蓝 → 薰衣草 → 粉（取色自 /icon.png）。
 * 只给三件品牌签名件用：输入框描边、发送钮、空态光晕——都是小面积/软边，
 * 不做卡片底色、不做渐变文字。
 */
const IRIS = "#5B8DEF, #8C7BF0, #E58DBA";
const IRIS_SOFT = "rgba(91,141,239,0.55), rgba(140,123,240,0.45), rgba(229,141,186,0.55)";

/* ──────────────────────────── 输入框 ──────────────────────────── */

const TEXTAREA_MAX_HEIGHT = 137; // 6 行 × 22px 行高 + 上下内边距（文字区通栏后可多给一行）。

function Composer({
  value,
  onChange,
  onSend,
  busy,
  placeholder,
  large,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  placeholder: string;
  /** 空态主角形态：整体略放大。 */
  large?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 自动增高（上限 5 行）：值变化时重算高度。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  }, [value]);

  const canSend = !busy && value.trim().length > 0;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend(value.trim());
  }, [canSend, onSend, value]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter 发送，Shift+Enter 换行。
      if (event.key === "Enter" && !event.shiftKey) {
        // 输入法组字中的 Enter 属于输入法（确认候选词），不是送出指令。
        // 必须在 preventDefault 之前返回：对组字中的 Enter 调用 preventDefault
        // 会让部分浏览器吃不到候选词确认，变成「按了 Enter 字不见」。
        // keyCode 229 是旧式 IME 的残留判定（Android/部分输入法不补 isComposing）。
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!canSend) return;
        handleSend();
      }
    },
    [canSend, handleSend],
  );

  return (
    /*
     * 上下两层（ChatGPT / Claude 同款结构）：上＝通栏文字区，下＝工具行（上传｜发送）。
     * 旧版三者同排：多行时上传钮孤零零坠在左下、左侧空出一整列，文字区被挤窄，
     * 上下 padding 叠成一大块留白——结构问题，调间距救不回来。
     * 上传与发送同为 36px 圆、同一条基线：左边描边空心、右边虹彩实心，重量对称。
     */
    <div
      onClick={(e) => {
        // 点外壳/工具行空白处也能聚焦输入（整块都像输入框，而不是只有文字那一条）。
        if (e.target === e.currentTarget) taRef.current?.focus();
      }}
      className={cn(
        // 外壳：lg-float 的模糊折射保留，底色与描边由 style 接管——1px 虹彩描边
        // （padding-box 白玻璃 + border-box 虹彩渐变）＝玻璃 E 的边缘光，Eimu 味的主承载。
        // 聚焦只加深投影，不再外套一圈 4px 光环（与描边叠成双框）。
        "lg-float relative flex cursor-text flex-col rounded-[24px] px-2 pb-1.5 pt-2",
        "shadow-[0_10px_32px_rgba(140,123,240,0.14)] transition-shadow duration-200",
        "focus-within:shadow-[0_14px_40px_rgba(140,123,240,0.24)]",
        large ? "pt-2.5" : null,
      )}
      style={{
        background: `linear-gradient(rgba(255,255,255,0.86), rgba(255,255,255,0.86)) padding-box, linear-gradient(120deg, ${IRIS_SOFT}) border-box`,
        border: "1px solid transparent",
      }}
    >
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="消息输入框"
        className="block min-h-[30px] w-full resize-none overflow-y-auto bg-transparent px-2.5 pb-1 pt-1 text-[15px] leading-[22px] text-foreground outline-none placeholder:text-foreground/35"
      />
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) taRef.current?.focus();
        }}
        className="flex items-center justify-between"
      >
        {/* 上传：36px 描边空心圆＋居中对称的 Plus（ImagePlus 的加号挂在右上角，
            字形重心偏移，放进圆里永远看着歪）。44px 触控区由外层 button 保底。 */}
        <button
          type="button"
          aria-label="添加参考图"
          title="添加参考图"
          className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none active:scale-95"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.09] text-foreground/55 transition-colors duration-200 group-hover:border-[rgba(140,123,240,0.35)] group-hover:bg-[rgba(140,123,240,0.08)] group-hover:text-[#6f5fd6]">
            <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
          </span>
        </button>
        {/* 发送：虹彩实心圆（玻璃 E 同色）。不可发送时不是死灰——同一颗球褪色待命，
            有字就亮起来。 */}
        <button
          type="button"
          aria-label="发送"
          title="发送"
          onClick={handleSend}
          disabled={!canSend}
          className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none active:scale-95 disabled:cursor-not-allowed"
        >
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full text-white transition-all duration-200",
              canSend || busy
                ? "shadow-[0_6px_16px_rgba(140,123,240,0.40),inset_0_1px_0_rgba(255,255,255,0.45)] group-hover:-translate-y-[1px] group-hover:shadow-[0_10px_22px_rgba(140,123,240,0.48),inset_0_1px_0_rgba(255,255,255,0.45)]"
                : "opacity-35 saturate-[0.6]",
            )}
            style={{ background: `linear-gradient(135deg, ${IRIS})` }}
          >
            {busy ? (
              <Loader2 className="h-[17px] w-[17px] animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp className="h-[17px] w-[17px]" strokeWidth={2.4} aria-hidden="true" />
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────── 主组件 ──────────────────────────── */

function AgentChatPreviewClientComponent() {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [batchStopped, setBatchStopped] = useState(false);
  const [planIndex, setPlanIndex] = useState(0);
  const [decisionState, setDecisionState] = useState<"pending" | "confirmed">("pending");

  const scrollRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(1);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // 新消息 / 思考态出现时滚到底。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking, started]);

  /** 进入对话态：插入首条用户消息，并展示整套静态演示内容；片刻后收起思考指示。 */
  const startChat = useCallback((prompt: string) => {
    setStarted(true);
    setMessages([{ id: nextIdRef.current++, role: "user", text: prompt }]);
    setThinking(true);
    const t = window.setTimeout(() => setThinking(false), 3000);
    timersRef.current.push(t);
  }, []);

  /** 对话态内发送：插入用户消息 → 1.5s 出现思考 → 再 1.5s 出固定回复。 */
  const simulateReply = useCallback((text: string) => {
    setThinking(false);
    setMessages((prev) => [...prev, { id: nextIdRef.current++, role: "user", text }]);
    const t1 = window.setTimeout(() => setThinking(true), 1500);
    const t2 = window.setTimeout(() => {
      setThinking(false);
      setMessages((prev) => [
        ...prev,
        { id: nextIdRef.current++, role: "assistant", text: FIXED_REPLY },
      ]);
    }, 3000);
    timersRef.current.push(t1, t2);
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      if (started) {
        simulateReply(text);
      } else {
        startChat(text);
      }
    },
    [simulateReply, startChat, started],
  );

  /** 新会话：整体复位回空态。 */
  const resetAll = useCallback(() => {
    clearTimers();
    setStarted(false);
    setMessages([]);
    setThinking(false);
    setInput("");
    setReasoningOpen(false);
    setBatchStopped(false);
    setPlanIndex(0);
    setDecisionState("pending");
  }, [clearTimers]);

  const plan = DEMO_PLANS[planIndex];
  const decisionPending = decisionState === "pending";

  return (
    <div
      className="lg-card relative z-10 mt-2 flex h-[calc(100dvh-3.25rem)] w-full max-w-[430px] flex-col overflow-hidden rounded-[2.4rem]"
      // 卡面由 0.72 实白降到 0.56：首页环境光要能透进来，玻璃才不是水泥墙；
      // 对话正文的对比度靠 blur40 + saturate 托底，仍远高于 4.5:1。
      style={{ background: "rgba(255,255,255,0.56)" }}
    >
      <SpecularLine />
      {/* 顶栏＝正式版 09-27 定版：纯图标、零文字、不放头像（角色不做常驻装饰）。
          左：资产 / 历史；右：新会话 / 直接生成 / 设置。 */}
      <header className="flex shrink-0 items-center px-3 pt-2">
        <GhostIconButton label="资产">
          <Boxes className="h-[18px] w-[18px]" aria-hidden="true" />
        </GhostIconButton>
        <GhostIconButton label="历史">
          <History className="h-[18px] w-[18px]" aria-hidden="true" />
        </GhostIconButton>
        <div className="ml-auto flex items-center">
          <GhostIconButton label="新会话" onClick={resetAll}>
            <SquarePen className="h-[18px] w-[18px]" aria-hidden="true" />
          </GhostIconButton>
          <GhostIconButton label="直接生成">
            <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
          </GhostIconButton>
          <GhostIconButton label="设置">
            <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
          </GhostIconButton>
        </div>
      </header>

      {!started ? (
        /* 空态：品牌标 → 标题 → 输入框 → 示例，一组垂直居中。
           品牌标＝Navbar 同款玻璃 E（48px），入场走 lg-appear 弹簧，只在进空态时动一次。 */
        <div
          className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-6"
          // 卡底环境光：与首页 body::after 同构（蓝在左、粉在右），只从卡的下缘升起，
          // 在到达顶栏前衰减为 0——上缘不露接缝；左右下三边就是卡本身的圆角边，自然裁切。
          style={{
            background:
              "radial-gradient(ellipse 70% 55% at 8% 100%, rgba(91,141,239,0.13), transparent 70%), radial-gradient(ellipse 70% 55% at 92% 100%, rgba(229,141,186,0.14), transparent 70%)",
          }}
        >
          {/* 空态光晕：玻璃 E 的虹彩从品牌标后方散开。软边径向渐变、在卡缘之前就衰减到 0
              ——不是 inset-0 满版色块（09-20 教训：满版装饰必露硬边）；有消息即消失。 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-[62%]"
            style={{
              background:
                "radial-gradient(closest-side at 50% 42%, rgba(140,123,240,0.22), transparent 70%), radial-gradient(closest-side at 26% 58%, rgba(91,141,239,0.18), transparent 72%), radial-gradient(closest-side at 74% 60%, rgba(229,141,186,0.18), transparent 72%)",
            }}
          />
          <div className="relative flex w-full flex-col items-center">
            <div className="animate-lg-appear rounded-[14px] shadow-[0_10px_28px_rgba(140,123,240,0.30)]">
              <BrandMark size={52} />
            </div>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">想做点什么？</h2>
            <div className="mt-7 w-full">
              <Composer
                value={input}
                onChange={setInput}
                onSend={handleSend}
                busy={thinking}
                placeholder="跟 Eimu 说说你想做的…"
                large
              />
            </div>
            {/* 示例＝正式版同源（agent-example-prompts 唯一真源）＋同款玻璃胶囊。 */}
            <div className="mt-5 flex w-full flex-wrap items-center justify-center gap-2">
              {AGENT_EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => startChat(prompt)}
                  className="min-h-11 cursor-pointer rounded-full border border-white/80 bg-white/45 px-4 py-2 text-ios-footnote font-medium text-foreground/70 shadow-[0_2px_10px_rgba(140,123,240,0.08)] backdrop-blur-md transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/75 hover:text-foreground hover:shadow-[0_6px_18px_rgba(140,123,240,0.16)]"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* 对话态：消息流 + 底部 sticky 输入框。 */
        <>
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                {message.role === "user" ? (
                  <div className="flex w-full justify-end">
                    <p className="lg-float max-w-[80%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-[6px] px-3.5 py-2.5 text-[15px] leading-[1.5] text-foreground">
                      {message.text}
                    </p>
                  </div>
                ) : (
                  <div className="w-full text-[15px] leading-relaxed text-foreground">
                    {message.text}
                  </div>
                )}

                {/* 首条用户消息之后挂整套静态演示内容（新形态组件全展示）。 */}
                {index === 0 ? (
                  <div className="space-y-3">
                    <ReasoningDisclosure
                      open={reasoningOpen}
                      onToggle={() => setReasoningOpen((v) => !v)}
                    />
                    <p className="text-[15px] leading-relaxed text-foreground">
                      好的，先找参考、核报价，然后拆给子代理并行出图。
                    </p>
                    <div className="space-y-0.5">
                      {DEMO_TOOLS.map((tool) => (
                        <ToolRow key={tool.id} tool={tool} />
                      ))}
                    </div>
                    <SubagentGroup />
                    <p className="text-[15px] leading-relaxed text-foreground">
                      第一张样图出来了，先看效果。
                    </p>
                    <ImageResultCard />
                    <BatchProgressRow
                      stopped={batchStopped}
                      onStop={() => setBatchStopped(true)}
                    />
                    {/* 决策卡（新形态）：只有用户决策才配卡片。lg-sheet + specular 亮线。 */}
                    <div className="lg-sheet relative overflow-hidden rounded-[20px] p-4">
                      <SpecularLine />
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 text-[15px] leading-snug text-foreground">
                          {plan.summary}
                        </p>
                        <span className="shrink-0 text-ios-footnote font-medium text-[#b8860b]">
                          {plan.coins} 币
                        </span>
                      </div>
                      {decisionPending ? (
                        <>
                          <p className="mt-1 text-ios-footnote text-muted-foreground">
                            确认后开始生成，可随时补充要求。
                          </p>
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setDecisionState("confirmed")}
                              className="flex min-h-11 items-center rounded-full bg-[#2d3142] px-5 text-ios-footnote font-medium text-white shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-95"
                            >
                              确认 · {plan.coins} 币
                            </button>
                            <button
                              type="button"
                              onClick={() => setPlanIndex((i) => 1 - i)}
                              className="flex min-h-11 items-center rounded-full px-4 text-ios-footnote text-muted-foreground transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75"
                            >
                              换个方案
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="mt-1 text-ios-footnote text-muted-foreground">
                          已确认 · 已扣 {plan.coins} 币
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
              </Fragment>
            ))}
            {thinking ? <ThinkingRow /> : null}
          </div>

          {/* 底部 sticky 输入框：决策卡在场时不锁死，仅出蓝色细提示条 + 换占位文案。 */}
          <div className="shrink-0 px-3 pb-3 pt-1">
            {decisionPending ? (
              <div className="mx-3 mb-2 h-[2px] rounded-full bg-ios-blue/70" />
            ) : null}
            <Composer
              value={input}
              onChange={setInput}
              onSend={handleSend}
              busy={thinking}
              placeholder={
                decisionPending ? "先选上方方案，或直接补充要求…" : "给 Eimu 发消息…"
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

export const AgentChatPreviewClient = AgentChatPreviewClientComponent;
