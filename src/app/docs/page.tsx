import Link from "next/link";
import { BookOpen, Bot, FileText, Plug, ArrowUpRight } from "lucide-react";

const DOCS_TITLE = "文档中心 | Eimu";
const DOCS_DESCRIPTION =
  "Eimu文档中心：OpenAI 兼容生成 API 文档、MCP 接入指南、模型与计费说明。";

export const metadata = {
  title: DOCS_TITLE,
  description: DOCS_DESCRIPTION,
  openGraph: {
    title: DOCS_TITLE,
    description: DOCS_DESCRIPTION,
    url: "https://eimu.dev/docs",
  },
  twitter: {
    card: "summary_large_image",
    title: DOCS_TITLE,
    description: DOCS_DESCRIPTION,
  },
};

const SECTIONS = [
  {
    href: "/docs/api",
    icon: BookOpen,
    label: "API 文档",
    description: "OpenAI 兼容的生图 / 生视频接口。认证、限流、端点到计费，全部由线上 OpenAPI spec 渲染，不手写不漂移。",
    tags: ["REST", "OpenAI 兼容", "异步任务", "Webhook"],
  },
  {
    href: "/docs/mcp",
    icon: Plug,
    label: "MCP 接入",
    description: "把Eimu接入 Claude / Codex / Cursor。agent 说一句话，直接出图出视频，返回成品 URL。",
    tags: ["Claude", "Codex", "Cursor", "stdio"],
  },
  {
    href: "/docs/harness",
    icon: Bot,
    label: "DeepSeek Harness",
    description: "零基础教程：下载、安装、使用 DeepSeek 官方开源智能体框架，照着做 10 分钟跑起来。",
    tags: ["Node.js", "npx", "AI Agent", "教程"],
  },
  {
    href: "/docs/report",
    icon: FileText,
    label: "Eimu 作品報告",
    description: "多智能体高审美影音设计平台完整作品报告：产品定位、总体架构、核心技术、创新点与工程验证，在线预览或下载 PDF。",
    tags: ["作品报告", "多智能体", "PDF"],
  },
];

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-5">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">文档中心</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          让 AI 帮你完成每一个生成任务
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          面向开发者与 AI Agent 的接入指南：REST API 与 MCP 两条路径，共用同一套计费与队列。
        </p>
      </section>

      <div className="flex flex-col gap-4">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Link
              key={section.href}
              href={section.href}
              className="group lg-card relative overflow-hidden rounded-ios-3xl p-5 sm:rounded-ios-4xl sm:p-7"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-ios-2xl bg-[rgba(0,122,255,0.10)]">
                    <Icon className="h-5 w-5 text-[#007AFF]" />
                  </span>
                  <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">{section.label}</h2>
                </div>
                <ArrowUpRight className="h-5 w-5 shrink-0 text-[rgba(0,0,0,0.46)] lg-transition group-hover:text-[#007AFF]" />
              </div>
              <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                {section.description}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {section.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-1 text-ios-caption1 font-medium text-[#007AFF]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}