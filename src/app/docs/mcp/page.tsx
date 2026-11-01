import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { ListChecks, Plug, TerminalSquare } from "lucide-react";
import { CodeBlock, InlineCode, KeyCard, SectionTitle } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "把助理带走（MCP 接入） | 文档中心",
  alternates: { canonical: `${SITE_URL}/docs/mcp` },
  openGraph: {
    title: "把助理带走（MCP 接入） | 文档中心",
    description: "把助理带走（MCP 接入） | 文档中心",
    url: "/docs/mcp",
  },
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

// 公开源码中的本机 stdio server；与官方远端 MCP 的工具范围不同。
const MCP_BUILD = `git clone https://github.com/tinchak0207/Eimu.git
cd Eimu/mcp-server
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
          agent 把一句话交给 Eimu 导演，拿回成片与中间产物。产品是 Vibe Directing／Cursor of video：不用学提示词设计和分镜，现在你也是导演。
        </p>
        {/* ---- 远端接入：一等公民，今天就能用 ---- */}
        <div className="mt-4">
          <KeyCard icon={Plug} title="远程接入（推荐，今天就能用）">
            <p>
              不用克隆仓库、不用构建：直接连 eimu.dev 的远端 MCP 端点{" "}
              <InlineCode>POST {REMOTE_MCP_ENDPOINT}</InlineCode>（这是主路径），认证走{" "}
              <InlineCode>Authorization: Bearer sk-biz-…</InlineCode>。默认{" "}
              <InlineCode>tools/list</InlineCode> 只露导演工具；原子工具用{" "}
              <InlineCode>?toolset=expert</InlineCode>。Codex、Claude Code、Cursor、OpenClaw 与任意 MCP
              客户端逐份可复制的配置都在{" "}
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
          进阶：本机自架 MCP server（公开源码）
        </h3>
        <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
          本机 stdio（仓库 mcp-server/）不是对外主路径；远端 HTTP MCP 才是。本机路线要自己跑一个 stdio MCP server：
          <a href="https://github.com/tinchak0207/Eimu/tree/main/mcp-server" className="font-semibold text-[#007AFF] lg-transition hover:underline">源码已在 GitHub 公开</a>
          。这里只启动本机 MCP 客户端适配层，仍调用官方生成 API 并使用你的密钥计费；不等于自建完整生成服务。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <KeyCard icon={TerminalSquare} title="本机自架：构建与配置">
            <p>
              拿到密钥后，克隆公开源码并构建 <InlineCode>mcp-server/</InlineCode>：
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
              远端 MCP 默认导演面约 5 个工具，专家面（toolset=expert）展开原子工具，清单见{" "}
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
          。各条生成链路的实时健康度见{" "}
          <a href="/status" className="font-semibold text-[#007AFF] lg-transition hover:underline">
            状态页
          </a>
          。
        </p>
      </section>
    </div>
  );
}
