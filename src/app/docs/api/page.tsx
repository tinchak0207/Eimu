"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Coins,
  Gauge,
  KeyRound,
  MessageSquare,
  Plug,
  Repeat,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { toSimplified } from "@/lib/traditional-to-simplified";

interface OpenApiSchema {
  openapi: string;
  servers: Array<{ url: string; description?: string }>;
  info: { title: string; version: string; description?: string };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        summary?: string;
        description?: string;
        parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
        requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
        responses?: Record<string, { description?: string }>;
      }
    >
  >;
}

const METHOD_COLORS: Record<string, string> = {
  get: "bg-[#007AFF]/10 text-[#007AFF]",
  post: "bg-[#34C759]/[0.12] text-[#1E9E4F]",
  put: "bg-[#FF9500]/[0.12] text-[#C76A00]",
  delete: "bg-[#FF3B30]/[0.12] text-[#D92A20]",
  patch: "bg-[#AF52DE]/[0.12] text-[#9B3FBF]",
};

function schemaName(ref: string | undefined): string {
  if (!ref) return "";
  const name = ref.split("/").pop();
  return name ?? "";
}

// ---- 开发进阶（附录）代码块：路径一律以 $BASE 模板串拼，杜绝内联手写的端点字面量 ----

const SETUP = `KEY="sk-biz-…"            # 你的 B 端密钥
BASE="https://eimu.dev/v1"`;

const STEP1 = `# ① 列出可用模型（含私有单价字段 x_coins_per_image）
curl -s "$BASE/models" \\
  -H "Authorization: Bearer $KEY"`;

const STEP2 = `# ② 提交任务 → 202 + task_id，不在同一响应里给图
curl -s -X POST "$BASE/images/generations" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"pixai-haruka-v2","prompt":"1girl, silver hair, cinematic lighting","n":1,"size":"1024x1024"}'
# → { "task_id": "3988af81-…", "status": "queued", "task_url": "/v1/images/3988af81-…" }`;

const STEP3 = `# ③ 轮询：3~5 秒一次，直到 status 变为 succeeded；轮询不消耗限流额度
TASK="3988af81-…"        # 换成上一步返回的 task_id
curl -s "$BASE/images/$TASK" \\
  -H "Authorization: Bearer $KEY"
# succeeded 的回应已内嵌 data[]，直接读 data[0].url 即成品 URL；/result 只是便捷入口`;

// ---- 教学文案数据（现场逐字：与助理设定弹层 AgentSettingsPopover 同文案）----

const NAV_CHIPS: Array<{ href: string; label: string }> = [
  { href: "#start", label: "怎么开始对话" },
  { href: "#flow", label: "一轮会发生什么" },
  { href: "#settings", label: "助理设定" },
  { href: "#billing", label: "计费" },
  { href: "#portable", label: "把助理带走" },
  { href: "#dev", label: "开发进阶" },
];

const EXAMPLE_PROMPTS: Array<{ text: string; note: string }> = [
  { text: "画一只戴帽子的橘猫，水彩风格", note: "一句话生图，最常见的起点" },
  { text: "让这瓶香水出现在落日海滩，自然光", note: "给参考图，再给感觉" },
  { text: "生成秦始皇骑北极熊的大电影", note: "认真的能力展示：重型流水线，不是玩笑" },
];

const SETTING_ROWS: Array<{ name: string; plain: string; options: Array<{ k: string; v: string }> }> = [
  {
    name: "中途输入",
    plain: "助理正在干活时你又发了消息，怎么处理。",
    options: [
      { k: "打断", v: "打断：新消息立即接管当前回合" },
      { k: "排队", v: "排队：新消息在本轮结束后执行" },
    ],
  },
  {
    name: "模型性格",
    plain: "助理说话和做事的节奏。",
    options: [
      { k: "高效（默认）", v: "高效：快速行动，先给结果" },
      { k: "沉稳", v: "沉稳：先充分思考再行动，回复更慢更全面" },
    ],
  },
  {
    name: "成本需求",
    plain: "同一句话，愿意花多少钱办。",
    options: [
      { k: "经济", v: "经济：单图低成本，不自动放大" },
      { k: "均衡", v: "均衡：常规质量，速度与成本兼顾" },
      { k: "高质", v: "高质：允许多候选与高清放大" },
    ],
  },
  {
    name: "互动模式",
    plain: "干活路上它多久问你一次。",
    options: [
      { k: "协作", v: "协作：每步都和你确认，扣费与关键决策逐项询问" },
      { k: "预设", v: "预设：更自主，整包计划一次授权，扣费与关键决策仍找你" },
      { k: "自动", v: "自动：完全自主，不再询问与扣费确认，一键发送直出结果" },
    ],
  },
];

// ---- 共用小组件 ----

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-[#007AFF]" />
      <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">{children}</h2>
    </div>
  );
}

function Specular() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
  );
}

function Step({
  n,
  title,
  note,
  code,
}: {
  n: string;
  title: string;
  note: React.ReactNode;
  code?: string;
}) {
  return (
    <div className="p-5 sm:p-7">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-ios-caption1 font-bold text-white">
          {n}
        </span>
        <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</h3>
      </div>
      <p className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{note}</p>
      {code ? (
        <div className="mt-3">
          <CodeBlock>{code}</CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

function KeyCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lg-card flex flex-col rounded-ios-3xl p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
        <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</p>
      </div>
      <div className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{children}</div>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">{children}</code>
  );
}

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<OpenApiSchema | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/openapi.json")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => setSpec(data as OpenApiSchema))
      .catch((err) => setError(err instanceof Error ? err.message : "载入失败"));
  }, []);

  const entries = useMemo(() => {
    if (!spec) return [];
    return Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b));
  }, [spec]);

  return (
    <div className="flex flex-col gap-6">
      {/* ================= Hero ================= */}
      <section className="pt-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#007AFF]" />
          <p className="text-ios-footnote font-semibold text-[#007AFF]">教程与参考</p>
        </div>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          AI 助理快速上手
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          不懂 API 也能立刻开始创作——一句话愿望，助理负责拆解、生成、交付。
        </p>
        <nav aria-label="页面章节" className="mt-4 flex flex-wrap gap-1.5">
          {NAV_CHIPS.map((chip) => (
            <a
              key={chip.href}
              href={chip.href}
              className="inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-3.5 py-1.5 text-ios-footnote font-medium text-[#007AFF] lg-transition hover:bg-[rgba(0,122,255,0.14)]"
            >
              {chip.label}
            </a>
          ))}
        </nav>
      </section>

      {/* ================= 第 1 章 怎么开始对话 ================= */}
      <section id="start" className="scroll-mt-28">
        <SectionTitle icon={Wand2}>第一章 · 怎么开始对话</SectionTitle>
        <div className="mt-4 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="打开首页就是 AI 助理"
              note={
                <>
                  左边是对话框，右边是模板库与画布。发出第一句话后，模板库自动收起，画布开始长东西——你不需要先学任何界面。
                </>
              }
            />
            <Step
              n="2"
              title="直接说出愿望，或点助理给出的示例"
              note={
                <>
                  不确定说什么？照抄这三句试试，每句都是一类玩法：
                </>
              }
            />
            <div className="grid gap-3 px-5 pb-5 sm:grid-cols-3 sm:px-7 sm:pb-7">
              {EXAMPLE_PROMPTS.map((example) => (
                <div
                  key={example.text}
                  className="rounded-ios-2xl bg-[rgba(0,122,255,0.06)] p-4"
                >
                  <p className="text-ios-footnote font-semibold text-[#007AFF]">“{example.text}”</p>
                  <p className="mt-1.5 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{example.note}</p>
                </div>
              ))}
            </div>
            <Step
              n="3"
              title="描述越像说话越好"
              note={
                <>
                  给对象、给感觉、给用途，例如
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「磨砂黑保温杯，电商主图，干净背景」</strong>
                  。专业参数不用懂，助理替你选。
                </>
              }
            />
          </div>
        </div>
      </section>

      {/* ================= 第 2 章 一轮对话里会发生什么 ================= */}
      <section id="flow" className="scroll-mt-28">
        <SectionTitle icon={Repeat}>第二章 · 一轮对话里会发生什么</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          发出第一句话后，这一轮里你会依次看到这些东西，全程透明：
        </p>
        <div className="mt-4 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="你说一句"
              note="一句人话就行，格式不限。"
            />
            <Step
              n="2"
              title="助理先回一张计划卡"
              note={
                <>
                  它打算怎么做、大概花多少，都写在<strong className="font-semibold text-[rgba(0,0,0,0.72)]">计划卡</strong>
                  里；然后按你设定的互动模式请求授权或直接开工（见第三章）。
                </>
              }
            />
            <Step
              n="3"
              title="过程全程可见：思考链与工具卡"
              note={
                <>
                  展开的是<strong className="font-semibold text-[rgba(0,0,0,0.72)]">思考链</strong>
                  （默认展开，可收起）和一张张逐个推进的工具卡（生图／视频／配音等，各自从
                  <InlineCode>pending</InlineCode> 走到完成）。它现在在干什么，你永远看得到。
                </>
              }
            />
            <Step
              n="4"
              title="成品自动落到画布与历史"
              note={
                <>
                  产出会出现在右侧<strong className="font-semibold text-[rgba(0,0,0,0.72)]">画布</strong>
                  与历史记录里：可预览、可复用，也可以继续说一句「微调一下」「再来一组」，不用从头再来。
                </>
              }
            />
            <Step
              n="5"
              title="随时可停"
              note="任何时候按停止按钮中止本轮，已生成的部分不浪费、账单照实结算。"
            />
          </div>
        </div>
      </section>

      {/* ================= 第 3 章 助理设定 ================= */}
      <section id="settings" className="scroll-mt-28">
        <SectionTitle icon={Settings2}>第三章 · 助理设定（右上角齿轮）</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          聊天界面右上角的齿轮里一共五行，逐行讲清楚每行在管什么：
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {SETTING_ROWS.map((row) => (
            <div key={row.name} className="lg-card flex flex-col rounded-ios-3xl p-5">
              <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{row.name}</p>
              <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{row.plain}</p>
              <ul className="mt-3 space-y-2">
                {row.options.map((option) => (
                  <li key={option.k} className="text-ios-footnote leading-relaxed">
                    <span className="mr-2 inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-0.5 font-semibold text-[#007AFF]">
                      {option.k}
                    </span>
                    <span className="text-[rgba(0,0,0,0.58)]">{option.v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* 野兽模式：独立小节，醒目卡 */}
        <div className="mt-6" id="beast-mode">
          <div className="lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
            <Specular />
            <div className="border-l-4 border-[#AF52DE] p-5 sm:p-7">
              <div className="flex flex-wrap items-center gap-2.5">
                <Zap className="h-4 w-4 text-[#9B3FBF]" />
                <h3 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">野兽模式</h3>
                <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-0.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.62)]">
                  状态字：常规 / 极限
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <p className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[rgba(0,0,0,0.44)]">关着的它，只是轻声建议：</span>
                  「大部分场合不需要开启，留给真正硬核的点子」
                </p>
                <p className="rounded-ios-2xl bg-[rgba(175,82,222,0.08)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[#9B3FBF]">开了以后：</span>
                  「模型使用所有工具协助，拼尽全力达到最完美的效果，满足追求极限的你」
                </p>
              </div>
              <p className="mt-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                用大白话说：开启后助理换一种工作方式——自动匹配成熟的生产模板（电商上新、短片短剧、长片、角色设定等整条流水线），
                多个专家角色分工（编剧、视觉、音乐、剪辑），右侧画布长成完整的生产泳道图。
                <strong className="font-semibold text-[rgba(0,0,0,0.72)]">
                  代价是更慢、更贵，产出是「一整套」而不是「一张图」
                </strong>
                。
              </p>
              <p className="mt-3 rounded-ios-2xl bg-[rgba(255,149,0,0.1)] p-3.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                <strong className="font-semibold text-[#C76A00]">建议：</strong>
                先拿示例句「生成秦始皇骑北极熊的大电影」试一次极限档，看看它全力干活的样子。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= 第 4 章 计费怎么放心 ================= */}
      <section id="billing" className="scroll-mt-28">
        <SectionTitle icon={CircleDollarSign}>第四章 · 计费怎么放心</SectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <KeyCard icon={Coins} title="一本账，跨模型可比价">
            所有模型用统一币制计价，不同模型之间可以直接比价。单价看定价页{" "}
            <a href="/pricing" className="font-semibold text-[#007AFF] lg-transition hover:underline">
              /pricing
            </a>
            ，每一单的结算在历史里可查。
          </KeyCard>
          <KeyCard icon={ShieldCheck} title="失败自动退回">
            预扣 → 成功结算 → 失败退款是同一本账：开工前先把钱扣住，成功才结算，
            <strong className="font-semibold text-[rgba(0,0,0,0.72)]">失败自动退回</strong>
            ，不会白花钱、不重复扣费。
          </KeyCard>
          <KeyCard icon={AlertTriangle} title="不会静默扣到负">
            余额不足时会直接拒绝并提示，绝不会静默扣成负数。至于它什么时候开口问你钱，由互动模式决定：
            协作逐项问、自动不再问。
          </KeyCard>
        </div>
      </section>

      {/* ================= 第 5 章 把助理带走 ================= */}
      <section id="portable" className="scroll-mt-28">
        <SectionTitle icon={Plug}>第五章 · 把助理带走</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          助理不只会在这站网页里干活，也能装进你已有的工具链：
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            {
              href: "/docs/mcp",
              icon: Plug,
              title: "MCP 接入",
              desc: "把 Eimu 接进 Claude / Codex / Cursor，在你常用的 AI 工具里一句话出图出视频。",
            },
            {
              href: "/docs/harness",
              icon: MessageSquare,
              title: "DeepSeek Harness 教程",
              desc: "用 DeepSeek 当大脑、本站当双手，搭一套自己的助理管线。",
            },
            {
              href: "/status",
              icon: Server,
              title: "状态页",
              desc: "各条生成链路实时是否健康，出发前先看一眼。",
            },
          ].map((card) => (
            <a
              key={card.href}
              href={card.href}
              className="lg-card group flex flex-col rounded-ios-3xl p-5 lg-transition hover:bg-[rgba(0,122,255,0.04)]"
            >
              <div className="flex items-center gap-2">
                <card.icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
                <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{card.title}</p>
              </div>
              <p className="mt-2.5 flex-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{card.desc}</p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-ios-footnote font-semibold text-[#007AFF]">
                去看看
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* ================= 开发进阶（附录）================= */}
      <section id="dev" className="scroll-mt-28 border-t border-dashed border-[rgba(0,0,0,0.1)] pt-8">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.66)]">开发进阶（附录）</h2>
        </div>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          给要把生成能力接进自己系统的开发者：B 端 API，与助理同一套生成核心、同一套计费与失败语义。
        </p>
        <p className="mt-2 text-ios-caption1 text-[rgba(0,0,0,0.46)]">
          {spec
            ? `${toSimplified(spec.info.title)} · v${spec.info.version} · OpenAPI ${spec.openapi}`
            : "以下端点目录从 OpenAPI spec 动态渲染，与线上行为保持一致。"}
        </p>

        <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="grid gap-6 p-5 sm:grid-cols-3 sm:gap-8 sm:p-7">
            <div>
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">Base URL</p>
              </div>
              <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
                https://eimu.dev/v1
              </code>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">认证</p>
              </div>
              <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
                Authorization: Bearer sk-biz-&lt;key&gt;
              </code>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">限流</p>
              </div>
              <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                60 requests/min，认证通过的回应带 x-ratelimit-* 头。
              </p>
            </div>
          </div>
        </section>

        <section className="mt-6">
          <SectionTitle icon={Gauge}>快速开始（异步三步）</SectionTitle>
          <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            先设两个变量，后续命令都复用它：
          </p>
          <div className="mt-3 max-w-2xl">
            <CodeBlock>{SETUP}</CodeBlock>
          </div>
        </section>

        <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="列出可用模型"
              note={
                <>
                  <InlineCode>GET {"$BASE"}/models</InlineCode>
                  返回全站支持的模型，每个带私有单价字段 <InlineCode>x_coins_per_image</InlineCode>
                  ；你调用的模型须在该 key 的白名单内，否则回 403。
                </>
              }
              code={STEP1}
            />
            <Step
              n="2"
              title="提交生成任务"
              note={
                <>
                  <InlineCode>POST {"$BASE"}/images/generations</InlineCode>{" "}
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">永远</strong>先回 202 与一个 task_id，
                  不在同一响应里给图。
                </>
              }
              code={STEP2}
            />
            <Step
              n="3"
              title="轮询到 succeeded"
              note={
                <>
                  用 task_id 轮询 <InlineCode>{"$BASE"}/images/{"{id}"}</InlineCode>，3~5 秒一次直到状态变为
                  succeeded——该回应已内嵌 <InlineCode>data[]</InlineCode>，直接读{" "}
                  <InlineCode>data[0].url</InlineCode> 即成品（<InlineCode>/result</InlineCode>{" "}
                  只是便捷入口）。轮询不消耗限流额度，实测 15~20 秒出图。
                </>
              }
              code={STEP3}
            />
          </div>
        </section>

        <p className="mt-4 max-w-3xl rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          <strong className="font-semibold text-[rgba(0,0,0,0.72)]">契约要点：</strong>
          所有生成端点都是异步提交＋轮询；错误体为 OpenAI 形状并带 <InlineCode>trace_id</InlineCode>（值同{" "}
          <InlineCode>X-Request-Id</InlineCode> 头）；支持 <InlineCode>Idempotency-Key</InlineCode>（同键同体放回同一
          task，可安全重试）与 <InlineCode>callback_url</InlineCode>（终态 webhook 回调，轮询仍是兜底）。
        </p>

        {error ? (
          <section className="rounded-ios-3xl bg-[rgba(0,0,0,0.04)] p-5 text-ios-body text-[rgba(0,0,0,0.58)]">
            无法载入 OpenAPI spec：{error}
          </section>
        ) : !spec ? (
          <div className="mt-6 space-y-3">
            <div className="skeleton h-5 w-40 rounded-full" />
            <div className="skeleton h-40 w-full rounded-ios-2xl" />
          </div>
        ) : (
          <>
            <nav id="endpoint-catalog" aria-label="API 端点目录" className="mt-8 scroll-mt-28">
              <p className="px-1 pb-2 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">端点目录</p>
              <ol className="flex flex-wrap gap-1.5">
                {entries.map(([path]) => (
                  <li key={path}>
                    <a
                      href={`#endpoint-${encodeURIComponent(path)}`}
                      className="inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-footnote font-medium text-[#007AFF] lg-transition hover:bg-[rgba(0,122,255,0.14)]"
                    >
                      <span className="font-mono">{path}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
              <Specular />
              <div className="divide-y divide-[rgba(0,0,0,0.06)]">
                {entries.map(([path, methods]) =>
                  Object.entries(methods).map(([method, operation]) => (
                    <section
                      key={`${method}-${path}`}
                      id={`endpoint-${encodeURIComponent(path)}`}
                      className="scroll-mt-28 p-5 sm:p-7"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-ios-caption1 font-bold uppercase tracking-wide ${METHOD_COLORS[method] ?? "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.66)]"}`}
                        >
                          {method}
                        </span>
                        <code className="font-mono text-ios-footnote font-semibold text-[#242830]">/v1{path}</code>
                        {operation.operationId ? (
                          <span className="text-ios-caption1 text-[rgba(0,0,0,0.46)]">{operation.operationId}</span>
                        ) : null}
                      </div>

                      {operation.summary ? (
                        <h3 className="mt-3 text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
                          {toSimplified(operation.summary)}
                        </h3>
                      ) : null}

                      {operation.description ? (
                        <p className="mt-2 whitespace-pre-line text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                          {toSimplified(operation.description)}
                        </p>
                      ) : null}

                      {(operation.parameters?.length ?? 0) > 0 ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">参数</p>
                          <ul className="mt-2 space-y-1">
                            {operation.parameters?.map((param) => (
                              <li key={param.name} className="flex flex-wrap items-baseline gap-2 text-ios-footnote">
                                <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">
                                  {param.name}
                                </code>
                                <span className="text-[rgba(0,0,0,0.52)]">{param.in}</span>
                                {param.required ? (
                                  <span className="font-semibold text-[#D92A20]">必填</span>
                                ) : (
                                  <span className="text-[rgba(0,0,0,0.46)]">可选</span>
                                )}
                                {param.description ? (
                                  <span className="text-[rgba(0,0,0,0.58)]">{toSimplified(param.description)}</span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {operation.requestBody?.content ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">请求体</p>
                          <code className="mt-1 inline-block rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-ios-footnote text-[#242830]">
                            {schemaName(operation.requestBody.content["application/json"]?.schema?.$ref)}
                          </code>
                        </div>
                      ) : null}

                      {operation.responses ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">响应</p>
                          <ul className="mt-2 flex flex-wrap gap-2">
                            {Object.entries(operation.responses).map(([status, response]) => (
                              <li
                                key={status}
                                className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.62)]"
                                title={toSimplified(response.description ?? "")}
                              >
                                <span className="font-mono font-semibold text-[#242830]">{status}</span>
                                {response.description ? (
                                  <span>{toSimplified(response.description)}</span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </section>
                  )),
                )}
              </div>
            </section>

            <section className="pt-1">
              <p className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">OpenAPI Spec</p>
              <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                完整机器可读 spec（含请求/响应 schema 定义）：
              </p>
              <a
                href="/api/v1/openapi.json"
                className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#007AFF] px-4 py-2.5 text-ios-body font-semibold text-white transition-colors hover:bg-[#0066DD]"
              >
                下载 /api/v1/openapi.json
              </a>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
