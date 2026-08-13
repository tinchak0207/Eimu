import Link from "next/link";
import { Bot, KeyRound, ListChecks, Plug, ShieldCheck, TerminalSquare } from "lucide-react";

const TOOLS = [
  {
    name: "list_models",
    description: "列出当前密钥可用的模型（图像 + 视频），含端点到单价的完整信息。",
  },
  {
    name: "generate_image",
    description: "以 prompt 生成图片。内部会自动轮询任务直到完成，直接返回成品 URL。",
  },
  {
    name: "generate_video",
    description: "以 prompt 生成视频。内部自动轮询直到完成，直接返回成品 URL。",
  },
  {
    name: "get_image_task",
    description: "查询一个图像任务的当前状态（不等待完成）。",
  },
];

const CLIENT_PATHS = [
  "~/Library/Application Support/Claude/claude_desktop_config.json",
  "项目根目录 .mcp.json",
];

const MCP_SOURCE = `  "mcpServers": {
    "image-studio": {
      "command": "node",
      "args": ["/absolute/path/to/github-image-json-new-api-https/mcp-server/dist/index.js"],
      "env": {
        "IMAGE_STUDIO_API_BASE": "https://image.tinchak0207.xyz/api/v1",
        "IMAGE_STUDIO_BIZ_KEY": "sk-biz-你的密钥"
      }
    }
  }`;

const BUILD_STEPS = `git clone <仓库地址> github-image-json-new-api-https
cd github-image-json-new-api-https/mcp-server
npm install
npm run build`;

const VERIFY_CURL = `# 用密钥验证连通性（也适用于直接 REST 调用）
curl https://image.tinchak0207.xyz/v1/models \\
  -H "Authorization: Bearer sk-biz-你的密钥"`;

const MCP_TITLE = "MCP 接入 | 文档中心 | Emu";
const MCP_DESCRIPTION =
  "把Emu（image.tinchak0207.xyz）接入 Claude / Codex / Cursor 等 MCP 客户端：安装、配置、可用工具。";

export const metadata = {
  title: MCP_TITLE,
  description: MCP_DESCRIPTION,
  openGraph: {
    title: MCP_TITLE,
    description: MCP_DESCRIPTION,
    url: "https://image.tinchak0207.xyz/docs/mcp",
  },
  twitter: {
    card: "summary_large_image",
    title: MCP_TITLE,
    description: MCP_DESCRIPTION,
  },
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-[#007AFF]" />
      <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">{children}</h2>
    </div>
  );
}

export default function McpDocsPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">Agent 集成</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          把Emu接入你的 AI Agent
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          通过 MCP（Model Context Protocol），Claude、Codex、Cursor 等 agent 可以调用我们的生成能力——你说一句话，
          agent 帮你出图、出视频，并拿到成品 URL。
        </p>
      </section>

      <section className="lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
        <div className="divide-y divide-[rgba(0,0,0,0.06)]">
          <div className="p-5 sm:p-7">
            <SectionTitle icon={Plug}>一、原理</SectionTitle>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              MCP server 跑在你的电脑上（stdio 模式），用你的 B 端密钥
              <code className="mx-1 rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">sk-biz-…</code>
              调我们的 OpenAI 兼容 API。agent 看到的是 4 个工具，背后走的是同一套计费与队列。
            </p>
          </div>

          <div className="p-5 sm:p-7">
            <SectionTitle icon={KeyRound}>二、准备密钥</SectionTitle>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              密钥走{" "}
              <Link href="/pricing" className="font-medium text-[#007AFF] hover:underline">
                充值页
              </Link>{" "}
              或联系站方签发。签发后只显示一次，请妥善保存。
            </p>
            <div className="mt-3">
              <CodeBlock>{VERIFY_CURL}</CodeBlock>
            </div>
          </div>

          <div className="p-5 sm:p-7">
            <SectionTitle icon={TerminalSquare}>三、安装 MCP server</SectionTitle>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              克隆仓库后构建：
            </p>
            <div className="mt-3">
              <CodeBlock>{BUILD_STEPS}</CodeBlock>
            </div>
          </div>

          <div className="p-5 sm:p-7">
            <SectionTitle icon={Bot}>四、配置 MCP 客户端</SectionTitle>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              在下列任一客户端的 MCP 配置里加入（把路径与密钥换成你的）：
            </p>
            <div className="mt-3">
              <CodeBlock>{MCP_SOURCE}</CodeBlock>
            </div>
            <p className="mt-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              常用配置文件位置：
            </p>
            <ul className="mt-2 space-y-1.5">
              {CLIENT_PATHS.map((path) => (
                <li key={path} className="flex items-baseline gap-2 text-ios-footnote text-[rgba(0,0,0,0.62)]">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#007AFF]" />
                  <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">{path}</code>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              配置后重启客户端，agent 就能发现这 4 个工具。如果客户端要求绝对路径，请把
              <code className="mx-1 rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">args</code>
              里的路径换成
              <code className="mx-1 rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">mcp-server/dist/index.js</code>
              的绝对路径。
            </p>
          </div>

          <div className="p-5 sm:p-7">
            <SectionTitle icon={ListChecks}>五、可用工具</SectionTitle>
            <ul className="mt-4 space-y-2.5">
              {TOOLS.map((tool) => (
                <li key={tool.name} className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] px-4 py-3.5">
                  <code className="font-mono text-ios-footnote font-semibold text-[#007AFF]">{tool.name}</code>
                  <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{tool.description}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="p-5 sm:p-7">
            <SectionTitle icon={ShieldCheck}>六、安全说明</SectionTitle>
            <ul className="mt-4 space-y-2.5">
              {[
                "密钥只存在你本机的 MCP 配置里，不会上传给我们。",
                "生成走真实计费：agent 每次调用都按模型单价扣金币。",
                "密钥丢失只能重新签发，无法找回原文。",
              ].map((item) => (
                <li key={item} className="flex gap-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#007AFF]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}