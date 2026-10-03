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

// 远端 MCP 端点：真正「今天就能用」的那条路，作为本页一等公民。
const REMOTE_MCP_ENDPOINT = `${SITE_URL}/api/mcp`;

const REMOTE_MCP_CONFIG = `{
  "mcpServers": {
    "eimu": {
      "type": "http",
      "url": "${REMOTE_MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer \${EIMU_BIZ_KEY}" }
    }
  }
}`;

const MCP_CONFIG = `  "mcpServers": {
    "image-studio": {
      "command": "node",
      "args": ["/absolute/path/to/你的仓库副本/mcp-server/dist/index.js"],
      "env": {
        "IMAGE_STUDIO_API_BASE": "https://eimu.dev/api/v1",
        "IMAGE_STUDIO_BIZ_KEY": "sk-biz-你的密钥"
      }
    }
  }`;

// 本机自架路线：本仓库未公开发布，外部使用者拿不到克隆地址，
// 因此这里不写任何照抄会失败的仓库 URL，只说明「从你有权限的副本取 mcp-server/」。
const MCP_BUILD = `# 本机自架需要本仓库的存取权限（仓库未公开发布）。
# 从你有权限的仓库副本中取出 mcp-server/ 目录，然后：
cd mcp-server
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
        {/* ---- 远端接入：一等公民，今天就能用 ---- */}
        <div className="mt-4">
          <KeyCard icon={Plug} title="远程接入（推荐，今天就能用）">
            <p>
              不用克隆仓库、不用构建：直接连 eimu.dev 的远端 MCP 端点{" "}
              <InlineCode>POST {REMOTE_MCP_ENDPOINT}</InlineCode>，认证走{" "}
              <InlineCode>Authorization: Bearer sk-biz-…</InlineCode>。工具比本机 server 更全，Codex、
              Claude Code、Cursor、OpenClaw 与任意 MCP 客户端逐份可复制的配置都在{" "}
              <a href="/mcp" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /mcp 接入页
              </a>
              。
            </p>
            <p className="mt-3">
              先在{" "}
              <a
                href="/settings/api-keys"
                className="font-semibold text-[#007AFF] lg-transition hover:underline"
              >
                登录 eimu.dev → 设置 → API 密钥
              </a>{" "}
              自助签发一把 <InlineCode>sk-biz-…</InlineCode> 密钥（只显示一次，妥善保存），再把下面这段并进你客户端的 MCP
              配置：
            </p>
            <div className="mt-3">
              <CodeBlock>{REMOTE_MCP_CONFIG}</CodeBlock>
            </div>
            <p className="mt-3">
              片段里的 <InlineCode>{"${EIMU_BIZ_KEY}"}</InlineCode> 是
              <span className="font-semibold text-[rgba(0,0,0,0.68)]">字面引用</span>，不是要你填的值：客户端需支持{" "}
              <InlineCode>{"${VAR}"}</InlineCode> 插值，并且这个环境变量要持久化在 shell 启动文件里（只 export
              一次的话，重开终端客户端就读不到，会送出空 `Bearer ` 并拿到 401）。完整步骤见{" "}
              <a href="/mcp" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /mcp 接入页
              </a>
              {" "}的「一键安装指令」第 3 步。
            </p>
            <p className="mt-3">
              下面「本机自架」配置里的 <InlineCode>IMAGE_STUDIO_BIZ_KEY</InlineCode>{" "}
              看起来是明文密钥，那是给本机子进程读的字面值（客户端启动该子进程时注入），与这里的远端引用写法不同，两者不矛盾。
            </p>
            <p className="mt-3">
              密钥只存在你本机的配置或环境变量里，不会上传给我们；网页、REST API 与 MCP 共用同一本账，生成走真实计费，失败自动退回。
            </p>
          </KeyCard>
        </div>

        {/* ---- 本机自架：保留但诚实降级 ---- */}
        <h3 className="mt-6 text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">
          进阶：本机自架 MCP server（需仓库权限）
        </h3>
        <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
          本机路线要自己跑一个 stdio MCP server：
          <span className="font-semibold text-[rgba(0,0,0,0.68)]">需要本仓库的存取权限（仓库未公开发布）</span>
          ，外部使用者拿不到克隆地址，所以下面只说明做法，不提供可直接照抄的仓库 URL。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <KeyCard icon={TerminalSquare} title="本机自架：构建与配置">
            <p>
              拿到密钥后，从你有权限的仓库副本取出 <InlineCode>mcp-server/</InlineCode> 并本地构建：
            </p>
            <div className="mt-3">
              <CodeBlock>{MCP_BUILD}</CodeBlock>
            </div>
            <p className="mt-3">
              把下面这段并入你常用的 MCP 配置（路径与密钥换成你的；常见位置：Claude 的{" "}
              <InlineCode>claude_desktop_config.json</InlineCode>、项目根目录的 <InlineCode>.mcp.json</InlineCode>），重启客户端后
              agent 就能发现本机 server 的这 4 个工具：
            </p>
            <div className="mt-3">
              <CodeBlock>{MCP_CONFIG}</CodeBlock>
            </div>
            <p className="mt-3">
              密钥只存在你本机的 MCP 配置里，不会上传给我们；生成走真实计费，每次调用按模型单价扣金币，失败自动退回。
            </p>
          </KeyCard>
          <KeyCard icon={ListChecks} title="本机 server 提供的 4 个工具">
            <p className="mb-3">
              远端 MCP 的工具清单（23 个）见{" "}
              <a href="/mcp" className="font-semibold text-[#007AFF] lg-transition hover:underline">
                /mcp 接入页
              </a>
              ；本机 server 只提供下面这 4 个。
            </p>
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
