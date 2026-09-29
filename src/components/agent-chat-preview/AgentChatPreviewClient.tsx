"use client";

/**
 * Grok 风格极简 AI 助理聊天 UI —— 独立预览（静态假数据，不连后端）。
 *
 * 设计原则：正文至上、工具降级、色彩收敛。
 * 色彩纪律：全页只有 foreground 灰阶 + ios-blue accent + 红（仅错误/停止）
 * + 币数金（coin-badge 既有金色 #b8860b，tailwind.config 无 ios-gold token）。
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
  Brain,
  ChevronDown,
  Coins,
  Crop,
  Download,
  History,
  Image as ImageIcon,
  ImagePlus,
  Images,
  LayoutGrid,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Palette,
  PenLine,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
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

const EXAMPLE_PROMPTS = ["橘猫水彩", "香水落日海滩", "秦始皇骑北极熊"];

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
      className="flex h-11 w-11 items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-[rgba(0,122,255,0.12)] hover:text-foreground/75 active:scale-95"
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

/** 思维链（新形态）：默认收合的一行「已思考 · N 秒」，点开灰底圆角块。 */
function ReasoningDisclosure({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-1.5 text-left text-ios-footnote font-medium text-muted-foreground select-none [-webkit-tap-highlight-color:transparent]"
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
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
            <span className="shrink-0 text-ios-footnote text-ios-blue">运行中</span>
          </>
        ) : null}
        {tool.status === "done" ? (
          <>
            {/* 源圖只有 3 張表情：done → emo-1（張嘴大笑），沿用原 Check 的 14px 位。 */}
            {/* eslint-disable-next-line @next/next/no-img-element -- 本地看板娘素材，固定尺寸 */}
            <img
              src="/mascot/eimu-emo-1.png"
              alt=""
              aria-hidden="true"
              width={14}
              height={14}
              className="h-3.5 w-3.5 shrink-0 object-contain"
            />
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
                    <span className="shrink-0 text-ios-footnote text-ios-blue">运行中</span>
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-ios-blue" />
                  </>
                ) : null}
                {sa.status === "done" ? (
                  <>
                    <span className="shrink-0 text-ios-footnote text-foreground/45">完成</span>
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-foreground/60" />
                  </>
                ) : null}
                {sa.status === "waiting" ? (
                  <>
                    <span className="shrink-0 text-ios-footnote text-foreground/45">等待</span>
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-black/20" />
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

/** 思考指示（极弱形态）：三点 + 灰字。 */
function ThinkingRow() {
  return (
    <div className="flex items-center gap-1.5 py-1" role="status" aria-label="正在思考">
      {/* 思考態 → emo-2（睜眼微笑）；源圖只有 3 張表情，emo-3 留著不用。 */}
      {/* eslint-disable-next-line @next/next/no-img-element -- 本地看板娘素材，固定尺寸 */}
      <img
        src="/mascot/eimu-emo-2.png"
        alt=""
        aria-hidden="true"
        width={18}
        height={18}
        className="h-[18px] w-[18px] shrink-0 object-contain"
      />
      <span className="h-1 w-1 animate-pulse rounded-full bg-foreground/35 [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-foreground/35 [animation-delay:200ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-foreground/35 [animation-delay:400ms]" />
      <span className="ml-1 text-ios-footnote text-muted-foreground">正在思考…</span>
    </div>
  );
}

/* ──────────────────────────── 输入框 ──────────────────────────── */

const TEXTAREA_MAX_HEIGHT = 140; // 5 行 × 22px 行高 + 上下内边距。

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
    <div
      className={cn(
        "lg-float relative flex items-end gap-1 rounded-[22px] p-1.5",
        "outline-none focus-within:ring-[1.5px] focus-within:ring-ring/60",
        large ? "py-2 shadow-[0_16px_48px_rgba(0,0,0,0.10)]" : null,
      )}
    >
      <SpecularLine />
      <button
        type="button"
        aria-label="添加参考图"
        title="添加参考图"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-[rgba(0,122,255,0.12)] hover:text-foreground/70 active:scale-95"
      >
        <ImagePlus className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="消息输入框"
        className="min-h-[52px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1 py-[15px] text-[15px] leading-[22px] text-foreground outline-none placeholder:text-foreground/35"
      />
      <button
        type="button"
        aria-label="发送"
        title="发送"
        onClick={handleSend}
        disabled={!canSend}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2d3142] text-white outline-none transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] hover:shadow-[0_8px_20px_rgba(45,49,66,0.22)] active:scale-95 disabled:bg-[#bcc2ca] disabled:cursor-not-allowed disabled:shadow-none"
      >
        {busy ? (
          <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
        ) : (
          <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/* ──────────────────────────── 主组件 ──────────────────────────── */

function AgentChatPreviewClientComponent() {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
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
    [simulateReply, startChat],
  );

  /** 新会话：整体复位回空态。 */
  const resetAll = useCallback(() => {
    clearTimers();
    setStarted(false);
    setMessages([]);
    setThinking(false);
    setInput("");
    setMenuOpen(false);
    setReasoningOpen(false);
    setBatchStopped(false);
    setPlanIndex(0);
    setDecisionState("pending");
  }, [clearTimers]);

  const plan = DEMO_PLANS[planIndex];
  const decisionPending = decisionState === "pending";

  return (
    <div className="lg-card relative z-10 mt-2 flex h-[calc(100dvh-3.25rem)] w-full max-w-[430px] flex-col overflow-hidden rounded-[2.4rem]">
      <SpecularLine />
      {/* 顶栏（减负版）：logo + 标题 + 极弱状态；右侧新会话 / 关闭 / ⋯ 收纳 */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-black/[0.04] px-3 py-1.5">
        {/* 看板娘头像：容器尺寸沿用原 logo 位（h-8 w-8）＝零位移；头像本体 28px 圆形。
            去掉 lg-tint-blue 底色，避免 UI 蓝与角色自带配色混用。 */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- 本地看板娘素材，固定尺寸 */}
          <img
            src="/mascot/eimu-avatar.png"
            alt="AI 助理头像"
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full object-cover"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-ios-headline text-foreground">AI 助理</h1>
          <p className="truncate text-ios-caption1 text-foreground/35">随时待命</p>
        </div>
        <GhostIconButton label="新会话" onClick={resetAll}>
          <SquarePen className="h-[18px] w-[18px]" aria-hidden="true" />
        </GhostIconButton>
        <GhostIconButton label="关闭" onClick={() => setMenuOpen(false)}>
          <X className="h-[18px] w-[18px]" aria-hidden="true" />
        </GhostIconButton>
        <div className="relative">
          <GhostIconButton
            label="更多选项"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
          </GhostIconButton>
          {menuOpen ? (
            <div className="lg-sheet animate-lg-appear absolute right-0 top-[calc(100%+6px)] z-20 w-36 overflow-hidden rounded-[16px] p-1.5">
              <SpecularLine />
              {(
                [
                  { icon: History, label: "历史" },
                  { icon: Images, label: "资产" },
                  { icon: Settings, label: "设置" },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[15px] text-foreground/70 transition-colors hover:bg-[rgba(0,122,255,0.12)]"
                  >
                    <Icon className="h-4 w-4 text-foreground/40" aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </header>

      {!started ? (
        /* 空态：输入框居中放大为主角，下方三个幽灵文字链示例。 */
        <div className="relative flex flex-1 flex-col items-center overflow-y-auto px-5">
          {/* 空态主角：看板娘只在玻璃容器内出现（不与界面配色混用）。
              绝对定位在既有 30vh 顶部留白内，标题与输入框位置不动（零位移）。
              容器与图片均为固定尺寸，素材未落地前也不会撑出滚动条。 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[30vh] items-center justify-center">
            <div className="lg-float flex h-[min(24vh,168px)] w-[min(24vh,168px)] items-center justify-center overflow-hidden rounded-[28px] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- 本地看板娘素材，固定尺寸 */}
              <img
                src="/mascot/eimu-hero.png"
                alt="Eimu 助理形象"
                width={256}
                height={256}
                className="h-full w-full object-contain"
              />
            </div>
          </div>
          <div className="flex w-full flex-col items-center" style={{ paddingTop: "30vh" }}>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">想做点什么？</h2>
            <div className="mt-8 w-full">
              <Composer
                value={input}
                onChange={setInput}
                onSend={handleSend}
                busy={thinking}
                placeholder="描述你想做的…"
                large
              />
            </div>
            <div className="mt-5 flex flex-col items-center gap-1 pb-12">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => startChat(prompt)}
                  className="min-h-11 rounded-lg px-3 text-[15px] text-foreground/55 underline-offset-4 transition-colors hover:text-foreground/80 hover:underline hover:decoration-foreground/30"
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
                              className="flex min-h-11 items-center rounded-full px-4 text-ios-footnote text-muted-foreground transition-colors hover:bg-[rgba(0,122,255,0.12)] hover:text-foreground/75"
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
                decisionPending ? "先选上方方案，或直接补充要求…" : "给 AI 助理发消息…"
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

export const AgentChatPreviewClient = AgentChatPreviewClientComponent;
