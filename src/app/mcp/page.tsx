import type { Metadata } from "next";
import * as React from "react";
import { getSiteUrlFromEnv } from "@/lib/site-url";

// 与 src/app/docs/DocsShell.tsx 的 CodeBlock / InlineCode 逐字一致（同类样式、同 token）。
// 该档没有 import React，tsx 的 classic JSX 转译下无法被 renderToStaticMarkup 真渲染；
// 本页要能真渲染所以自带同款，两份样式改的时候一起改。
function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">{children}</code>;
}

const SITE_URL = getSiteUrlFromEnv();
const MCP_ENDPOINT = `${SITE_URL}/api/mcp`;
const WELL_KNOWN_URL = `${SITE_URL}/.well-known/oauth-protected-resource`;
const KEY_PLACEHOLDER = "sk-biz-你的密钥";

const TITLE = "MCP 接入：把 Eimu 接到你的 coding agent";
const DESCRIPTION =
  "Eimu Remote MCP 端点是 POST https://eimu.dev/api/mcp（JSON-RPC 2.0 / Streamable HTTP），认证用 Authorization: Bearer sk-biz-…。Codex、Claude Code、Cursor、OpenClaw 与通用 MCP 客户端的可复制配置片段，以及 tools/list 的工具清单。";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/mcp` },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/mcp` },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

type ClientSection = {
  id: string;
  label: string;
  title: string;
  note: string;
  blocks: string[];
};

// 各客户端示例配置。字段名以你所用版本的客户端文档为准；
// 三件不变的事：URL 指向 /api/mcp、认证走 Authorization: Bearer、密钥只放在你本机。
const CLIENT_SECTIONS: ClientSection[] = [
  {
    id: "codex",
    label: "Codex",
    title: "Codex",
    note: "写进 ~/.codex/config.toml；密钥放环境变量，不落配置文件。",
    blocks: [
      `[mcp_servers.eimu]
url = "${MCP_ENDPOINT}"
bearer_token_env_var = "EIMU_BIZ_KEY"`,
      `export EIMU_BIZ_KEY=${KEY_PLACEHOLDER}`,
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    title: "Claude Code",
    note: "一条命令注册 HTTP 传输的远端服务；用户级配置加 --scope user。",
    blocks: [
      `claude mcp add --transport http eimu ${MCP_ENDPOINT} \\
  --header "Authorization: Bearer $EIMU_BIZ_KEY"`,
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    title: "Cursor",
    note: "写进 ~/.cursor/mcp.json；只给这个项目用就放项目根的 .cursor/mcp.json。",
    blocks: [
      `{
  "mcpServers": {
    "eimu": {
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }
    }
  }
}`,
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    title: "OpenClaw",
    note: "OpenClaw 读标准 mcpServers 配置：在客户端的 MCP 设置里填同一组 URL 与 Authorization 头即可。",
    blocks: [
      `{
  "mcpServers": {
    "eimu": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }
    }
  }
}`,
    ],
  },
  {
    id: "generic",
    label: "通用客户端",
    title: "通用 MCP 客户端",
    note: "任何支持 Streamable HTTP 的客户端只要两点：URL 与 Authorization 头；协议是 JSON-RPC 2.0。传输是单发 POST（initialize / tools/list / tools/call / ping），本版不开放 SSE 串流，GET 回 405 并带 Allow: POST。",
    blocks: [
      `{
  "mcpServers": {
    "eimu": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }
    }
  }
}`,
      `curl -s ${MCP_ENDPOINT} \\
  -H "Authorization: Bearer $EIMU_BIZ_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ],
  },
];

// tools/list 的工具清单（名称＋一句话＋所需 scope）。
// 名称与行为以 src/lib/mcp/tools.ts 的定义为单一真源（本页只做发现面摘要）；
// 本页测试有一道漂移探针：tools.ts 新增或改名工具而本页没跟上会红。
const MCP_TOOLS: Array<{ name: string; scope: string; description: string }> = [
  {
    name: "list_skills",
    scope: "eimu:skills:read",
    description: "列出公开技能库（内建 / 配方 / 模板三个来源），可按关键词与题材家族筛选；私有技能永不出现。",
  },
  {
    name: "get_skill",
    scope: "eimu:skills:read",
    description: "按 id 读一条公开技能的完整条目：适用场景、输入面、交付物、可调用工具与主责专家。",
  },
  {
    name: "list_models",
    scope: "eimu:models:read",
    description: "列出当前密钥可用的图像 / 视频模型、端点归属与计价；生成前先用它取 model id。",
  },
  {
    name: "generate_image",
    scope: "eimu:image:write",
    description: "按提示词生成图像（默认回成品链接），与 /v1/images/generations 是同一条扣费路径。",
  },
  {
    name: "edit_image",
    scope: "eimu:image:write",
    description: "对一张输入图按提示词做编辑，与 /v1/images/edits 同一条路径。",
  },
  {
    name: "generate_video",
    scope: "eimu:video:write",
    description: "提交视频生成任务（异步，返回 id），再用 get_result 轮询。",
  },
  {
    name: "tts",
    scope: "eimu:audio:write",
    description: "提交文本转语音任务（异步，返回 id），再用 get_result 轮询。",
  },
  {
    name: "upscale",
    scope: "eimu:image:write",
    description: "放大一张图像；含幂等预留与失败退款。",
  },
  {
    name: "get_quota",
    scope: "eimu:quota:read",
    description: "查当前密钥绑定账户的余额与币种，与 /v1/quota 同源账本。",
  },
  {
    name: "get_result",
    scope: "eimu:tasks:read",
    description: "按任务 id 取异步结果：kind = image / video / tts。",
  },
];

const STEPS: Array<{ n: string; title: string; body: React.ReactNode }> = [
  {
    n: "1",
    title: "拿密钥",
    body: (
      <>
        登录{" "}
        <a href="/settings/api-keys" className="font-semibold text-[#007AFF] lg-transition hover:underline">
          设置 → API 密钥
        </a>{" "}
        自助签发一把 <InlineCode>sk-biz-…</InlineCode>（只显示一次，妥善保存），网页、REST API 与 MCP 共用这一把。
      </>
    ),
  },
  {
    n: "2",
    title: "填配置",
    body: (
      <>
        把对应客户端的片段加进配置：URL 一律是 <InlineCode>{MCP_ENDPOINT}</InlineCode>，认证走{" "}
        <InlineCode>Authorization: Bearer</InlineCode>。密钥只存在你本机的配置或环境变量里，不会上传给我们。
      </>
    ),
  },
  {
    n: "3",
    title: "看能力",
    body: (
      <>
        重启客户端，让 agent 调一次 <InlineCode>tools/list</InlineCode>；未带密钥的请求会拿到{" "}
        <InlineCode>401</InlineCode> 与 <InlineCode>WWW-Authenticate: Bearer</InlineCode>，照着上面的两步补上即可。
      </>
    ),
  },
];

export default function McpPage() {
  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">MCP</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            把 Eimu 接到你的 coding agent
          </h1>
          <p className="mt-3 max-w-3xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            一个远端 MCP 端点：<InlineCode>{MCP_ENDPOINT}</InlineCode>
            。Codex、Claude Code、Cursor、OpenClaw 或任何会说 MCP 的客户端，配置一次就能让 agent
            直接生图、生视频、配音，查任务与余额；背后和网页共用同一本账——提交预扣、成功结算、失败自动退回。
          </p>
          <nav aria-label="快速跳转" className="mt-4 flex flex-wrap gap-2">
            {[...CLIENT_SECTIONS.map((section) => ({ id: section.id, label: section.label })), { id: "tools", label: "工具清单" }].map(
              (item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="lg-float inline-flex items-center rounded-full px-3.5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.68)] lg-transition hover:text-[#007AFF]"
                >
                  {item.label}
                </a>
              ),
            )}
          </nav>
        </header>

        <section className="lg-card rounded-ios-3xl p-5 sm:p-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">三步接上</h2>
          <ol className="mt-3 grid gap-4 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n}>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-ios-caption1 font-bold text-white">
                    {step.n}
                  </span>
                  <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{step.title}</p>
                </div>
                <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-8">
          <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">接入你的客户端</h2>
          <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            下面是各客户端的示例配置，字段名以你所用版本的客户端文档为准；不变的是 URL、认证头与「密钥只在本机」这三件事。
          </p>

          <div className="mt-4 flex flex-col gap-4">
            {CLIENT_SECTIONS.map((section) => (
              <div key={section.id} id={section.id} className="lg-card scroll-mt-28 rounded-ios-3xl p-5 sm:p-6">
                <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{section.title}</h3>
                <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{section.note}</p>
                <div className="mt-3 flex flex-col gap-3">
                  {section.blocks.map((block) => (
                    <CodeBlock key={block.slice(0, 24)}>{block}</CodeBlock>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="tools" className="mt-8 scroll-mt-28">
          <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">先看能做什么</h2>
          <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            <InlineCode>tools/list</InlineCode>{" "}
            返回下面这些工具：名字是意图，不是模型名，agent 不用记住任何供应商细节。生成类工具会真实扣费，规矩是先{" "}
            <InlineCode>get_quota</InlineCode> 看余额、再 <InlineCode>list_models</InlineCode> 取 model id；异步任务用{" "}
            <InlineCode>get_result</InlineCode> 轮询。每个工具各自要一个 scope。
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {MCP_TOOLS.map((tool) => (
              <li key={tool.name} className="lg-card rounded-ios-3xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-ios-footnote font-semibold text-[#007AFF]">{tool.name}</code>
                  <code className="font-mono text-ios-caption1 text-[rgba(0,0,0,0.45)]">{tool.scope}</code>
                </div>
                <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{tool.description}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">发现文档与延伸阅读</h2>
          <ul className="mt-3 flex flex-col gap-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            <li>
              受保护资源元数据（免授权可读）：{" "}
              <a href={WELL_KNOWN_URL} className="font-semibold text-[#007AFF] lg-transition hover:underline">
                {WELL_KNOWN_URL}
              </a>
            </li>
            <li>
              REST API 参考：{" "}
              <a href="/docs/api" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /docs/api
              </a>
              ；文档中心：{" "}
              <a href="/docs" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /docs
              </a>
            </li>
            <li>
              生成链路实时健康度：{" "}
              <a href="/status" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /status
              </a>
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
