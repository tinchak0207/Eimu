import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { ListChecks, Plug, TerminalSquare } from "lucide-react";
import { CodeBlock, InlineCode, KeyCard, SectionTitle } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "把助理带走（MCP 接入） | 文档中心",
  alternates: { canonical: `${SITE_URL}/docs/mcp` },
};

// ---- 把助理带走（MCP 接入干货，工具描述逐字取自原 MCP 接入页）----

const MCP_TOOLS: Array<{ name: string; description: string }> = [
  {
    name: "list_models",
    description: "列出当前密钥可用的模型（图像 + 视频），含端点到单价的完整信息。",
  },
  {
    name: "generate_image",
    description: "以 prompt 生成图片。内部会自动轮询任务直到完成，直接返回成品 URL。",
  },
  {
    name: "get_image_task",
    description: "查询一个图像任务的当前状态（不等待完成）。",
  },
  {
    name: "generate_video",
    description: "以 prompt 生成视频。内部自动轮询直到完成，直接返回成品 URL。",
  },
];

const MCP_CONFIG = `  "mcpServers": {
    "image-studio": {
      "command": "node",
      "args": ["/absolute/path/to/github-image-json-new-api-https/mcp-server/dist/index.js"],
      "env": {
        "IMAGE_STUDIO_API_BASE": "https://eimu.dev/api/v1",
        "IMAGE_STUDIO_BIZ_KEY": "sk-biz-你的密钥"
      }
    }
  }`;

const MCP_BUILD = `git clone <仓库地址> github-image-json-new-api-https
cd github-image-json-new-api-https/mcp-server
npm install
npm run build`;

export default function DocsMcpPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>

      {/* ================= 把助理带走 ================= */}
      <section id="portable" className="scroll-mt-28">
        <SectionTitle icon={Plug}>把助理带走</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          助理不只会在这站网页里干活，也能装进你已有的 AI 工具——通过 MCP（Model Context Protocol），Claude、Codex、Cursor 里的
          agent 说一句话，就能出图、出视频并拿到成品 URL，背后走的是同一套计费与队列。
        </p>
        <p className="mt-2 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          最省事的是远程 MCP：不用克隆仓库，一段配置直接连 eimu.dev，工具更全——
          <a href="/mcp" className="font-semibold text-[#007AFF] lg-transition hover:underline">
            查看各客户端的一键安装写法
          </a>
          。下面是自建本地 server 的做法。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <KeyCard icon={TerminalSquare} title="接入你的 AI 工具（MCP）">
            <p>
              先在{" "}
              <a
                href="/settings/api-keys"
                className="font-semibold text-[#007AFF] lg-transition hover:underline"
              >
                登录 eimu.dev → 设置 → API 密钥
              </a>{" "}
              自助签发一把 <InlineCode>sk-biz-…</InlineCode> 密钥（只显示一次，妥善保存），再克隆仓库构建 MCP server：
            </p>
            <div className="mt-3">
              <CodeBlock>{MCP_BUILD}</CodeBlock>
            </div>
            <p className="mt-3">
              把下面这段并入你常用的 MCP 配置（路径与密钥换成你的；常见位置：Claude 的{" "}
              <InlineCode>claude_desktop_config.json</InlineCode>、项目根目录的 <InlineCode>.mcp.json</InlineCode>），重启客户端后
              agent 就能发现这四个工具：
            </p>
            <div className="mt-3">
              <CodeBlock>{MCP_CONFIG}</CodeBlock>
            </div>
            <p className="mt-3">
              密钥只存在你本机的 MCP 配置里，不会上传给我们；生成走真实计费，每次调用按模型单价扣金币，失败自动退回。
            </p>
          </KeyCard>
          <KeyCard icon={ListChecks} title="四个可用工具">
            <ul className="space-y-2.5">
              {MCP_TOOLS.map((tool) => (
                <li key={tool.name} className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] px-4 py-3">
                  <code className="font-mono text-ios-footnote font-semibold text-[#007AFF]">{tool.name}</code>
                  <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{tool.description}</p>
                </li>
              ))}
            </ul>
          </KeyCard>
        </div>
        <p className="mt-4 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          想用本地 AI 框架（DeepSeek Harness）把本站当双手？端点参考见〈
          <a
            href="/docs/api"
            className="font-semibold text-[#007AFF] lg-transition hover:underline"
          >
            开发进阶
          </a>
          〉分篇，其余细节去{" "}
          <a
            href="https://github.com/deepseek-ai/deepseek-harness"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[#007AFF] lg-transition hover:underline"
          >
            GitHub
          </a>
          。另有一份{" "}
          <a
            href="/docs/eimu-competition-report.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[#007AFF] lg-transition hover:underline"
          >
            作品报告 PDF
          </a>{" "}
          供下载，各条生成链路的实时健康度见{" "}
          <a href="/status" className="font-semibold text-[#007AFF] lg-transition hover:underline">
            状态页
          </a>
          。
        </p>
      </section>
    </div>
  );
}
