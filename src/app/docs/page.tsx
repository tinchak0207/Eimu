import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import {
  BookOpen,
  CreditCard,
  History,
  Plug,
  Repeat,
  Rocket,
  Settings2,
  Sparkles,
  Wand2,
  Workflow,
} from "lucide-react";
import { InlineCode, SectionTitle, Specular, Step } from "./DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "AI 助理快速上手 | 文档中心",
  alternates: { canonical: `${SITE_URL}/docs` },
  openGraph: {
    title: "AI 助理快速上手 | 文档中心",
    description: "AI 助理快速上手 | 文档中心",
    url: "/docs",
  },
};

// ---- 教学文案数据（现场逐字：与助理聊天首页示例句同文案）----

const EXAMPLE_PROMPTS: Array<{ text: string; note: string }> = [
  { text: "画一只戴帽子的橘猫，水彩风格", note: "一句话生图，最常见的起点" },
  { text: "让这瓶香水出现在落日海滩，自然光", note: "给参考图，再给感觉" },
  // 2026-09-28（P0-1 剧本入口曝光）：与首页聊天空态第三颗 chip 同文案（本档约定
  // 逐字同步），换成剧本/长文改编口径——这一句会把助理带进「剧本→分镜→成片」
  // 那条重型产线，正是「这里可以丢剧本」的示范。
  { text: "把我这篇小说改成成片，先给我分镜表", note: "丢一段长文进来：自动拆剧本→分镜→成片的重型产线" },
];

// ---- 分篇导航卡：每篇一句话导语，链往各子页 ----

const DOC_CARDS: Array<{
  href: string;
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    href: "/docs/assistant",
    title: "助理设定",
    desc: "右上角齿轮与「+」右上角的思考级别各管什么，以及野兽模式什么时候开。",
    icon: Settings2,
  },
  {
    href: "/docs/workflow",
    title: "工作流与画布",
    desc: "模板转盘、画布手势与配方模板，大工程一条链跑完。",
    icon: Workflow,
  },
  {
    href: "/docs/history",
    title: "历史素材复用",
    desc: "生成过的每样东西都有账，复用不用从头再来。",
    icon: History,
  },
  {
    href: "/docs/billing",
    title: "充值与计费",
    desc: "充值三步与四档方案，预扣、结算、失败自动退回的一本账。",
    icon: CreditCard,
  },
  {
    href: "/docs/mcp",
    title: "本机自架 MCP（进阶）",
    desc: "在本地跑 stdio server，需仓库权限，面向进阶用户。要远程免克隆的一键安装（推荐），见 /mcp。",
    icon: Plug,
  },
  {
    href: "/docs/api",
    title: "开发进阶",
    desc: "B 端 API：异步提交＋轮询，端点目录随 OpenAPI 实时更新。",
    icon: Rocket,
  },
];

const RECIPE_CARDS: typeof DOC_CARDS = [
  {
    href: "/use-cases",
    title: "场景指南",
    desc: "17 个行业、各 6 个子场景，写清构图光线比例，提示词可直接复制。",
    icon: Sparkles,
  },
  {
    href: "/workflows",
    title: "创作产线",
    desc: "小说影视化、电商上新等 8 条多步产线，每一环做什么、交付什么。",
    icon: Workflow,
  },
  {
    href: "/skills",
    title: "技能目录",
    desc: "助理会的全部技能；在输入框打「/」也能直接调用。",
    icon: Repeat,
  },
];

export default function DocsPage() {
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
      </section>

      {/* ================= 怎么开始对话 ================= */}
      <section id="start" className="scroll-mt-28">
        <SectionTitle icon={Wand2}>怎么开始对话</SectionTitle>
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

      {/* ================= 一轮对话里会发生什么 ================= */}
      <section id="flow" className="scroll-mt-28">
        <SectionTitle icon={Repeat}>一轮对话里会发生什么</SectionTitle>
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
                  里；然后按你设定的互动模式请求授权或直接开工（见〈
                  <a
                    href="/docs/assistant"
                    className="font-semibold text-[#007AFF] lg-transition hover:underline"
                  >
                    助理设定
                  </a>
                  〉）。
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

      {/* ================= 全部篇章 ================= */}
      <section>
        <SectionTitle icon={BookOpen}>全部篇章</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          其余内容已分成六篇，各讲各的，按需取用：
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {DOC_CARDS.map((doc) => {
            const Icon = doc.icon;
            return (
              <a
                key={doc.href}
                href={doc.href}
                className="lg-card flex flex-col rounded-ios-3xl p-5 lg-transition hover:bg-[rgba(0,122,255,0.06)]"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
                  <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{doc.title}</p>
                </div>
                <p className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{doc.desc}</p>
              </a>
            );
          })}
        </div>
      </section>

      {/* ================= 找现成做法 =================
          /use-cases、/workflows 在首页只以视觉隐藏的 SEO 块存在，/skills 只能在
          输入框打「/」时撞见——三处对用户是零入口，从文档中心给出可见路径。 */}
      <section>
        <SectionTitle icon={Wand2}>找现成做法</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          不想从零写提示词，就从这三处挑一个照着做：
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {RECIPE_CARDS.map((doc) => {
            const Icon = doc.icon;
            return (
              <a
                key={doc.href}
                href={doc.href}
                className="lg-card flex flex-col rounded-ios-3xl p-5 lg-transition hover:bg-[rgba(0,122,255,0.06)]"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
                  <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{doc.title}</p>
                </div>
                <p className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{doc.desc}</p>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
