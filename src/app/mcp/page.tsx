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
const PLUGIN_URL = `${SITE_URL}/plugin/`;
const PLUGIN_README_URL = `${SITE_URL}/plugin/eimu/README.md`;
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
    note: "一条命令注册 HTTP 传输的远端服务；用户级配置加 --scope user。--header 的值用单引号：单引号让字面的 ${EIMU_BIZ_KEY} 写进配置文件、由客户端加载时插值；用双引号会在 shell 里当场把你的真密钥展开、烘进配置文件。",
    blocks: [
      `export EIMU_BIZ_KEY=${KEY_PLACEHOLDER}`,
      `claude mcp add --transport http eimu ${MCP_ENDPOINT} \\
  --header 'Authorization: Bearer \${EIMU_BIZ_KEY}'`,
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
  {
    name: "list_canvas_projects",
    scope: "eimu:canvas:read",
    description: "列出本密钥账号自己的畫布项目摘要（id / 名称 / 时间 / 节点数）；拿到 project_id 才能写画布产线。",
  },
  {
    name: "canvas_get_state",
    scope: "eimu:canvas:read",
    description: "读取某个 agent 会话当前的画布快照（节点 / 连线 / 选中 / 视口，含可逆声明 dsl 与节点版本索引）。",
  },
  {
    name: "workflow_read",
    scope: "eimu:canvas:read",
    description: "只投影某会话画布的可逆声明 dsl 与节点版本索引（像读代码一样读产线）；要完整节点坐标用 canvas_get_state。",
  },
  {
    name: "workflow_history",
    scope: "eimu:canvas:read",
    description: "读取画布节点的版本史（每节点的 version / 时间 / 原因 / 标题）；给 node_id 只回该节点。",
  },
  {
    name: "workflow_write",
    scope: "eimu:canvas:write",
    description: "把整份工作流声明（dsl）编译成画布操作；给了属于本账号的 project_id 才真的落图，否则只编译回 ops。",
  },
  {
    name: "workflow_rollback",
    scope: "eimu:canvas:write",
    description: "把某节点的内容回滚到指定版本（省略 version = 上一版）；只还原 title 与 metadata，不动坐标。",
  },
  {
    name: "list_agent_sessions",
    scope: "eimu:agent:read",
    description: "列出你在 Eimu 的 AI 助理（agent）会话：标题、时间与状态，用来找回之前做过的工作。",
  },
  {
    name: "get_agent_session",
    scope: "eimu:agent:read",
    description: "读某个 agent 会话的对话与产物（生成的图片／影片 URL 就在回复文字里）；view 可选 summary / transcript / raw。",
  },
  {
    name: "get_agent_settings",
    scope: "eimu:agent:read",
    description: "读该账号的 agent 设定，包含 beast_mode 野兽模式开关；它和网页版 AI 助理共用同一份设定。",
  },
  {
    name: "run_agent",
    scope: "eimu:agent:write",
    description: "把整件工作交给 Eimu 的 agent orchestrator 执行并取回回复（它自己建会话、轮询到出结果）；会真实消耗账号额度、可能触发扣费生成。",
  },
  {
    name: "abort_agent_session",
    scope: "eimu:agent:write",
    description: "中止一个正在跑的 agent 会话，已经产出的部分不浪费。",
  },
  {
    name: "check_delivery_contract",
    scope: "eimu:harness:read",
    description:
      "按 Expert 域对交付物做契约栏位层的确定性校验：必填栏位是否齐全、qc 签名是否与内容对得上；它不是品质评分——ok:true 只代表栏位层合格，不代表成品可用（成品好不好请看 evaluate_media_quality）。",
  },
  {
    name: "evaluate_media_quality",
    scope: "eimu:harness:read",
    description:
      "对已生成完成的影片／图片／音频做确定性量测硬检（分辨率／时长／文件大小／音轨等，套用我方政策阈值），不调用任何模型；服务器端量测不可用时诚实回 probe_unavailable——那不等于通过。呼叫方也可自带 ffprobe 结果，我们只负责套政策。",
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

// 插件包（public/plugin/ 就是静态根，一份真源，部署后即可访问）。
// 这里只做发现面摘要：包内文件清单与一段可直接喂给 agent 的安装指令。
// 诚实边界：Eimu 目前没有公开的插件市集仓，`plugin marketplace add` 这一步跑不通，
// 文案必须标明「待发布」，不得宣称今天就能一键装。
const PLUGIN_TREE = `plugin/
├── marketplace.json                    # 市集索引：只声明 eimu 这一个插件
└── eimu/
    ├── .codex-plugin/plugin.json       # 插件元数据：名称、描述、logo、默认提问
    ├── .mcp.json                       # MCP 端点 + Authorization 头（引用 \${EIMU_BIZ_KEY} 环境变量，不含任何密钥）
    ├── assets/eimu-icon.svg            # 图标
    ├── README.md                       # 安装说明
    └── skills/                         # 三个随包技能
        ├── film-production/SKILL.md            # 一句话到成片
        ├── character-consistency/SKILL.md      # 角色一致性
        └── camera-motion/SKILL.md              # 运镜与镜头运动`;

// 一键安装指令：整段复制给使用者本机的 coding agent。
// 这是 template literal，三处转义是刻意的、不能动：
//   1) 5 处端点 URL 一律用 ${MCP_ENDPOINT} 真插值（现在渲染＝https://eimu.dev/api/mcp，换域名不会说谎）；
//   2) 文本里所有字面 ${EIMU_BIZ_KEY…} 必须写成 \${…}，否则会被模板当成插值吞掉、渲染成空；
//   3) curl 每行结尾的续行反斜杠写成 \\，否则会被当成 LineContinuation 吃掉换行。
// 渲染 oracle 在 page.test.ts 的「承载体」用例：转义错了就红。
const AGENT_INSTALL_PROMPT = `帮我把 Eimu 的 MCP 接进你（就是你这个 coding agent），装完要能真的用。

Eimu 提供生图／改图、生视频、配音、放大，以及公开技能库与画布产线工具。远端 MCP 端点：
· URL：${MCP_ENDPOINT}（JSON-RPC 2.0，Streamable HTTP，只收 POST）
· 认证：请求头 Authorization: Bearer sk-biz-…

密钥：我手上那把 sk-biz- 开头的密钥放在环境变量 EIMU_BIZ_KEY。你看不到这个变量的值也不要卡住整个流程——配置文件里只需要变量名（\${EIMU_BIZ_KEY}），不需要密钥值，所以照常把第 2、3、4 步做完；只有第 5 步的验证要等密钥可用。全程不要自己编密钥、不要猜、不要去翻我的文件找密钥。

请照这个顺序做，每一步都真的动手，不要只是教我怎么做：

1. 先确认 EIMU_BIZ_KEY 有没有值（[ -n "$EIMU_BIZ_KEY" ] && echo ok），记下「有／没有」，照上面说的继续做——「没有」只影响第 5 步。

2. 判断我用的客户端：CLI 是否存在优先于目录是否存在——command -v codex / command -v claude / command -v cursor-agent 有输出才算那个客户端；只有 ~/.codex 目录存在不算（很多人装过又移除）。真分不出来就问我。然后用它正确的写法写进配置（密钥一律用环境变量引用，不写明文）：
   · Claude Code（--header 用单引号；--scope user 表示写进用户层、所有项目都能用，不加只绑当前目录；它会写进 ~/.claude.json）：
       claude mcp add --transport http --scope user eimu ${MCP_ENDPOINT} --header 'Authorization: Bearer \${EIMU_BIZ_KEY}'
   · Codex：在 ~/.codex/config.toml 加 [mcp_servers.eimu]，url = "${MCP_ENDPOINT}"，密钥用 bearer_token_env_var = "EIMU_BIZ_KEY"。
   · Cursor / OpenClaw / 通用：在配置里加
       "mcpServers": { "eimu": { "type": "http", "url": "${MCP_ENDPOINT}", "headers": { "Authorization": "Bearer \${EIMU_BIZ_KEY}" } } }
   单引号是关键：它让字面的 \${EIMU_BIZ_KEY} 写进配置文件、由客户端加载时插值；用双引号会在 shell 里当场把我的真密钥展开、烘进配置文件，那等于泄露。写完自查：配置文件里不得出现 sk-biz- 开头的字符串。

3. 让密钥「持久」——这步最容易漏，也最容易装成假成功：配置文件里存的是字面 \${EIMU_BIZ_KEY}，客户端每次启动都要在它的环境里看到这个变量才会插值，否则送出去的是空 Bearer（401），而我以为已经装好。
   3a. 先确认我的 shell 启动文件是哪个（echo $SHELL；bash 用 ~/.bashrc，zsh 用 ~/.zshrc，登录 shell 还会读 ~/.bash_profile 或 ~/.profile），并且把「你选了哪个文件、为什么」讲出来。
   3b. 如果你手上没有密钥值，这一步你没法代做——把下面这段交给我，由我自己跑（只改第一行的占位符；zsh 把第二行换成 ~/.zshrc）：
       KEY=sk-biz-你的密钥                 # ← 只改这一行：换成你的真密钥
       RC=~/.bashrc                        # ← zsh 用 ~/.zshrc
       grep -v '^export EIMU_BIZ_KEY=' "$RC" > "$RC.new" 2>/dev/null; mv "$RC.new" "$RC"
       printf 'export EIMU_BIZ_KEY=%s\\n' "$KEY" >> "$RC"
       export EIMU_BIZ_KEY="$KEY"
       这四行做四件事：先删掉 rc 里旧的（包括你之前误贴的占位符行——只比名称的守卫救不了那种情况）／只留唯一一行／当前终端立即生效／变量名正好是 EIMU_BIZ_KEY（客户端引用的就是这个名字）。可重复执行。
       ⚠️ 占位符 sk-biz-你的密钥 必须先换成真密钥再贴。原样贴比不贴更糟：「变量没设」时健康检查会直接告诉你 Missing environment variables: EIMU_BIZ_KEY；贴了占位符反而只剩 401 invalid_api_key，更难查。
       （如果你手上的密钥本来放在别的变量名里，客户端也只认 EIMU_BIZ_KEY 这个名字，记得用它重新 export。）
   3c. 我跑完之后你自查两项——第一项证明「真的写进了启动文件」，第二项证明「当前终端拿得到值」：
       grep -c '^export EIMU_BIZ_KEY=' "$RC"      # 必须是 1；RC 指错文件（例如 zsh 却写了 ~/.bashrc）时这里是 0
       [ "\${#EIMU_BIZ_KEY}" -gt 20 ] && echo "长度 \${#EIMU_BIZ_KEY}，像真密钥" || echo "太短，还是占位符或没生效"
       别只看前 7 位就下结论（占位符的前 7 位也是 sk-biz-）。把两项结果报给我，只输出长度，别把整把密钥打出来。
       注意：这两项只证明「写进文件了」＋「当前终端有值」，**不证明持久**——RC 指错文件时当前终端照样是绿的。持久要等你**新开一个终端**再跑一次第二项、或直接做第 5 步的 curl 才算数。
   如果你的客户端是从 GUI／IDE 图标启动（macOS 点图标启动的 App 基本都不继承终端环境），shell 启动文件对它没用：最省事是把密钥直接写进该客户端自己配置文件的 Authorization 头（本机文件，别提交进版控、别贴给别人）——本页上方各客户端分区就是把 Bearer \${EIMU_BIZ_KEY} 换成 Bearer sk-biz-真密钥。做完告诉我密钥最终放在哪里。

4. 重新载入并看健康状态（Claude Code 用 claude mcp list）。判健康要看你输出里的 ✔ Connected／✘ Failed——不要看退出码，这个指令失败时退出码仍然是 0。若显示待批准／Pending approval（只会发生在读项目 .mcp.json 时），跟我说一声，那要我批准。

5. 验证——不能省，而且要有密钥才能做。「显示 Connected」不算成功：健康检查常常只做握手，握手过了工具照样可能叫不动。多数客户端没有非交互直呼工具的 CLI，所以直接 curl 打端点（端点无状态，不必先 initialize）：
     curl -sS -X POST ${MCP_ENDPOINT} \\
       -H "Authorization: Bearer $EIMU_BIZ_KEY" \\
       -H "Content-Type: application/json" \\
       -H "Accept: application/json, text/event-stream" \\
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_quota","arguments":{}}}'
   判准是硬条件：回包里必须出现 balance_coins 才算成功（它在 result.content[0].text 里的 JSON 字符串中）；拿到 401／403／HTML（例如 Cloudflare 的 "Just a moment"）、或没有 balance_coins，一律算失败——把原始回应原样贴出来，不要美化、不要宣称成功。
   如果第 1 步发现我还没有密钥，就把第 3b 那行交给我跑，我跑完你再用上面的 curl 验证（同一个终端）；通过后提醒我新开一个终端再确认一次。

6. 通过之后，列出 tools/list 的工具数与名称（同一个 curl 把 method 换成 tools/list），并用一句话说「我接下来可以用它做什么」。

红线：除了 get_quota 这类只读工具，先不要调用任何会花钱的工具（generate_image / edit_image / generate_video / tts / upscale），要用之前先问我。不要安装任何额外套件，也不要改我没要你改的东西。做不到就明说卡在哪，不要编。`;

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
            {[...CLIENT_SECTIONS.map((section) => ({ id: section.id, label: section.label })), { id: "agent-prompt", label: "一键安装指令" }, { id: "tools", label: "工具清单" }, { id: "plugin", label: "插件包" }].map(
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

        <section id="agent-prompt" className="mt-8 scroll-mt-28">
          <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">
            一键：把这段发给你的 agent
          </h2>
          <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            下面是一段可直接复制进本机 coding agent 的安装指令：agent 会自己判断你用的是哪个客户端、按正确写法写配置（密钥只以环境变量引用，不写明文），再把密钥写进 shell
            启动文件让它持久，最后用一次真调用验证端点真的叫得动。它会在「需要你自己跑的那一行」停下来等你——那一步要用真密钥，agent 替不了你。
          </p>
          <div className="mt-4">
            <CodeBlock>{AGENT_INSTALL_PROMPT}</CodeBlock>
          </div>
          <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            密钥在{" "}
            <a href="/settings/api-keys" className="font-semibold text-[#007AFF] lg-transition hover:underline">
              {SITE_URL}/settings/api-keys
            </a>{" "}
            自助签发（只显示一次）；
            <span className="font-semibold text-[rgba(0,0,0,0.68)]">
              先把占位符 <InlineCode>sk-biz-你的密钥</InlineCode> 换成真密钥再贴
            </span>
            。
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">接入你的客户端</h2>
          <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            下面是各客户端的示例配置，字段名以你所用版本的客户端文档为准；不变的是 URL、认证头与「密钥只在本机」这三件事。各分区里{" "}
            <InlineCode>export EIMU_BIZ_KEY</InlineCode> 那行只对当前终端生效；要重开终端仍然有效，请照上方「一键：把这段发给你的 agent」的第 3
            步把它写进 shell 启动文件。
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
            装了 MCP 的 agent 不只能调生成工具，还能把整件工作交给 Eimu 的 agent（orchestrator）去做，拿回带成品
            URL 的回复；它和网页版 AI 助理共用同一个 orchestrator 与同一份账号设置（包括 beast_mode
            野兽模式：确定性 prompt／契约注入＋Expert 派遣＋critic）。入口是{" "}
            <InlineCode>run_agent</InlineCode>，会话与产物可用 <InlineCode>list_agent_sessions</InlineCode>／
            <InlineCode>get_agent_session</InlineCode> 回读。
          </p>
          <p className="mt-3 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            <InlineCode>tools/list</InlineCode>{" "}
            返回下面这些工具：名字是意图，不是模型名，agent 不用记住任何供应商细节。生成类工具会真实扣费，规矩是先{" "}
            <InlineCode>get_quota</InlineCode> 看余额、再 <InlineCode>list_models</InlineCode> 取 model id；异步任务用{" "}
            <InlineCode>get_result</InlineCode> 轮询。每个工具各自要一个 scope。
          </p>
          <p className="mt-3 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            装好 MCP 的 agent 还能取用站内的生成品质 harness：交付契约与验收纪律——八域必填栏位、媒体硬检政策、critic 只在独立量测时才 enforce 的 7 分门槛。入口有三条：工具{" "}
            <InlineCode>check_delivery_contract</InlineCode>（契约栏位层校验）与{" "}
            <InlineCode>evaluate_media_quality</InlineCode>（确定性媒体硬检）、资源{" "}
            <InlineCode>eimu://harness/guide</InlineCode>／<InlineCode>eimu://harness/delivery-contracts</InlineCode>、提示模板{" "}
            <InlineCode>eimu-harness</InlineCode>。边界要说清楚：资源与提示模板是使用者／客户端主动取用的，不会像站内那样每轮自动注入系统提示；平台侧那套自动强制机制（子代理派遣执行面、强制交付闸与自动重派、会话记忆注入）外部没有，契约要靠外部自己的循环遵守。
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

        <section id="plugin" className="mt-8 scroll-mt-28">
          <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">插件包</h2>
          <p className="mt-1.5 max-w-3xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
            不想手写配置的话，Eimu 还提供一个 coding agent 插件包：一份{" "}
            <InlineCode>plugin.json</InlineCode> 声明能力与图标，一份 <InlineCode>.mcp.json</InlineCode>{" "}
            指向本文的 MCP 端点，外加三个随包技能。目前没有打包好的 zip／tar.gz，文件都是静态的，逐个文件取回即可，不需要装任何东西：
            <a href={PLUGIN_URL} className="font-semibold text-[#007AFF] lg-transition hover:underline">
              {PLUGIN_URL}
            </a>
            （入口说明：
            <a
              href={PLUGIN_README_URL}
              className="font-semibold text-[#007AFF] lg-transition hover:underline"
            >
              README.md
            </a>
            ）。
          </p>

          <div className="mt-4 flex flex-col gap-4">
            <div className="lg-card scroll-mt-28 rounded-ios-3xl p-5 sm:p-6">
              <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">包内文件</h3>
              <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                三个技能的正文只引用本页列出的工具，没有我们做不到的能力宣言；包内不含任何密钥，只有端点
                URL。
              </p>
              <div className="mt-3">
                <CodeBlock>{PLUGIN_TREE}</CodeBlock>
              </div>
            </div>

            <div className="lg-card rounded-ios-3xl p-5 sm:p-6">
              <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">
                给 agent 的安装指令
              </h3>
              <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                完整安装指令已移到上方「
                <a
                  href="#agent-prompt"
                  className="font-semibold text-[#007AFF] lg-transition hover:underline"
                >
                  一键：把这段发给你的 agent
                </a>
                」一节，整段复制给你本机的 agent 即可。若要走市集一键装，它依赖一个 Eimu 公开的插件市集仓，
                <span className="font-semibold text-[rgba(0,0,0,0.68)]">该仓尚未发布，这一步现在跑不通</span>
                ；今天要用插件包请照该节里 agent 的提示走。
              </p>
            </div>
          </div>
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
