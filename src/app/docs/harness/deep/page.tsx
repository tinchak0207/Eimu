import { ArrowUpRight } from "lucide-react";

const DOCS_TITLE = "DeepSeek Harness 深度指南 | Eimu";
const DOCS_DESCRIPTION =
  "基于源码讲解 DeepSeek Harness：配置体系、CLI 命令、模型路由、权限沙箱、工具系统、插件开发与程序化接入。";

export const metadata = {
  title: DOCS_TITLE,
  description: DOCS_DESCRIPTION,
  openGraph: {
    title: DOCS_TITLE,
    description: DOCS_DESCRIPTION,
    url: "https://eimu.dev/docs/harness/deep",
  },
};

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="mx-1 rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">
      {children}
    </code>
  );
}

function Section({
  id,
  num,
  title,
  children,
}: {
  id: string;
  num: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ios-2xl bg-[rgba(0,122,255,0.10)] font-mono text-ios-footnote font-semibold text-[#007AFF]">
          {num}
        </span>
        <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">{title}</h2>
      </div>
      <div className="mt-4 flex flex-col gap-3 text-ios-body leading-relaxed text-[rgba(0,0,0,0.62)]">
        {children}
      </div>
    </section>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-2 text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">{children}</h3>;
}

const TOC = [
  { href: "#codebase", num: "01", title: "源码目录导览" },
  { href: "#config", num: "02", title: "配置体系：profile / bundle / patch" },
  { href: "#cli", num: "03", title: "CLI 命令全集" },
  { href: "#models", num: "04", title: "模型路由与提供商" },
  { href: "#permissions", num: "05", title: "权限与沙箱" },
  { href: "#tools", num: "06", title: "工具系统：Agent 的能力清单" },
  { href: "#env", num: "07", title: "环境变量速查表" },
  { href: "#plugins", num: "08", title: "插件与二次开发" },
  { href: "#programmatic", num: "09", title: "程序化接入（headless / Python SDK）" },
  { href: "#security", num: "10", title: "安全与隐私" },
  { href: "#troubleshoot", num: "11", title: "深度排错表" },
];

const TOOL_GROUPS = [
  {
    group: "文件读写",
    tools: ["read", "write", "edit", "str_replace_editor", "read_image"],
    note: "read-before-write/edit 强制先读后写策略；read_image 需要模型声明 image 模态。",
  },
  {
    group: "文件搜索",
    tools: ["glob", "grep"],
    note: "打包自带 ripgrep 二进制（@vscode/ripgrep），不需要宿主机装 rg。",
  },
  {
    group: "命令执行",
    tools: ["bash", "pwsh"],
    note: "Linux 组合下启用 bash、Windows 组合下启用 pwsh（由 harness 按平台自动切换）；bash 支持 run_in_background 后台运行。",
  },
  {
    group: "持久终端",
    tools: ["terminal_open", "terminal_send", "terminal_read", "terminal_list", "terminal_close", "terminal_signal"],
    note: "可选项，需要 PTY 后端；跨调用保留终端状态。",
  },
  {
    group: "后台任务",
    tools: ["job_list", "job_output", "job_kill"],
    note: "统一管理后台 bash 命令、PTY 发送与后台子代理。",
  },
  {
    group: "委派子代理",
    tools: ["subagent", "subagent_fork", "send_message", "interrupt_agent", "list_agents", "report"],
    note: "subagent 可后台续跑；subagent_fork 一次性前台运行；report 在子代理内部上报结论。",
  },
  {
    group: "计划与任务",
    tools: ["exit_plan_mode", "todo_write"],
    note: "计划模式内走用户审批（approve / 继续规划）；todo_write 渲染为界面里的清单。",
  },
  {
    group: "联网",
    tools: ["web_search", "web_fetch"],
    note: "web_search 默认启用（用 DEEPSEEK_API_KEY）；web_fetch 需要 patch 层插入提供方并启用。",
  },
  {
    group: "交互与扩展",
    tools: ["ask_user_question", "skill", "lsp", "ralph", "workflow", "create_goal", "schedule_create"],
    note: "skill 加载技能；lsp 需要语言服务器提供方；ralph/workflow 是结构化工作流引擎。",
  },
  {
    group: "会话查询",
    tools: ["session_search", "session_trace", "session_event_read", "session_event_search", "session_event_trace"],
    note: "只读工具，按调用 agent 的会话做权限校验。",
  },
];

const ENV_VARS = [
  { name: "DSH_HOME", purpose: "Harness home 目录，默认 ~/.dsh；存放 settings.yaml、.credentials.yaml、profiles/。" },
  { name: "DEEPSEEK_API_KEY", purpose: "DeepSeek 官方适配器与 web_search 的凭据。" },
  { name: "DEEPSEEK_BASE_URL", purpose: "改用 OpenAI 兼容代理时的端点（不含 /v1 后缀时由适配器拼接）。" },
  { name: "DEEPSEEK_SEARCH_BASE_URL", purpose: "自定义搜索端点。" },
  { name: "DSH_MODEL", purpose: "headless / SDK 默认模型名。" },
  { name: "DSH_SYSTEM_PROMPT", purpose: "覆盖系统提示词（SDK 与 headless 场景）。" },
  { name: "DSH_PERMISSION_MODE", purpose: "新会话权限预设的进程级后备值：read-only / workspace-write / danger-full-access。" },
  { name: "DSH_TOOLS_MODE", purpose: "native / code / both，选择工具呈现模式；非法值会导致启动失败。" },
  { name: "DSH_TELEMETRY_MODE", purpose: "FULL = OTLP/HTTP 流式上报会话事件；FEEDBACK_ONLY = 仅反馈时上传；默认关闭。" },
  { name: "DSH_TELEMETRY_OTLP_URL", purpose: "自定义遥测 collector 地址。" },
  { name: "DSH_TELEMETRY_DISABLED", purpose: "任何非空值都是遥测的最终关闭开关。" },
  { name: "NODE_USE_ENV_PROXY", purpose: "设为 1 后 Node 遵循 HTTP_PROXY / HTTPS_PROXY 环境代理。" },
];

const EXTENSION_POINTS = [
  { target: "添加模型提供商", mechanism: "在 ctx.llm 上注册适配器" },
  { target: "添加 Agent 能力（工具）", mechanism: "在 ctx.tools 注册，schema 自动加入提示词组装" },
  { target: "添加 Shell 执行", mechanism: "注册 ctx.shell 后端；本地通过 ctx.subprocess spawn" },
  { target: "添加持久终端", mechanism: "注册 ctx.terminals 后端 + dsh-tool-terminal" },
  { target: "添加文件系统策略", mechanism: "注册 ctx.fs 提供方，或监听 fs/* 事件" },
  { target: "限制进程权限", mechanism: "使用 ctx.sandbox 后端包装 argv" },
  { target: "拦截请求 / 工具 / 轮次", mechanism: "agent/* 或 tools/* 事件；agent/turn-stopping 停止轮次" },
  { target: "添加模型可见上下文", mechanism: "agent.inject()，落到下一次获准的请求" },
  { target: "添加持久会话状态", mechanism: "扩展 SessionEventMap，从日志渲染与回放" },
  { target: "添加 UI / 编辑器集成", mechanism: "驱动 ctx.agents 并从 session/event 渲染" },
];

const DEBUG_TABLE = [
  { symptom: "Node 版本过低 / node -v 报错", cause: "需要 v22.19+ 或 v24+", fix: "重装最新的 Node.js LTS，覆盖安装即可" },
  { symptom: "提示 SANDBOX_UNAVAILABLE", cause: "当前系统没有可用的沙箱后端（Windows 缺 ACL restricted-token runner、Linux 缺 landlock/bubblewrap）", fix: "升级/安装对应内核支持，或改用 danger-full-access 预设（注意风险）" },
  { symptom: "启动报错提示运行 pnpm run build", cause: "运行的是源码目录，前端 dist 或 Host 构建产物缺失", fix: "在仓库根目录执行 pnpm run build 后再运行" },
  { symptom: "dsh web 报 --host 0.0.0.0 用法错误", cause: "CLI 有意不支持绑定所有网卡", fix: "默认 127.0.0.1；如需局域网访问用 --trusted-host 声明可信主机" },
  { symptom: "MISSING_CREDENTIAL", cause: "模型页没有保存密钥", fix: "设置→模型，给 DeepSeek（或对应提供方）填入 API Key" },
  { symptom: "UNKNOWN_MODEL", cause: "选中的模型未配置", fix: "设置→模型选择一个已配置模型" },
  { symptom: "获取可用模型返回 401", cause: "密钥不对，或端点没有 GET /models 接口", fix: "检查密钥；没有该接口的服务就手动填模型" },
  { symptom: "图片在发送前被拒绝", cause: "该模型未声明 image 模态", fix: "自定义提供方模型加 input: [text, image]；DeepSeek 官方路由本身纯文本" },
  { symptom: "安装插件 add 失败提示 allowBuilds", cause: "pnpm ≥10 默认阻止 prepare 脚本", fix: "把提示的键复制进该 profile 的 pnpm-workspace.yaml 后重跑" },
  { symptom: "改了 cordis.patch.yml 没生效", cause: "patch 按 id 替换整行 config，不深度合并", fix: "确认行 id 与 dump-config 输出一致；改完自动热重载，可查 --dump-config" },
];

export default function HarnessDeepPage() {
  return (
    <div className="flex flex-col gap-5">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">DeepSeek Harness · 深度指南</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          DeepSeek Harness 深度指南
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          本篇基于 v0.1.0-rc.5 源码逐层讲解：你拿到的压缩包里面每一块是什么、系统按什么顺序组合配置、
          CLI 有哪些模式、权限沙箱怎么工作、Agent 能用哪些工具，以及如何不改源码就扩展它。
          适合已经把快速上手跑通、想真正理解和定制 Harness 的读者。
        </p>
        <nav className="mt-5 flex max-w-2xl flex-wrap gap-1.5" aria-label="本页目录">
          {TOC.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-1 text-ios-caption1 font-medium text-[#007AFF]"
            >
              {item.num} · {item.title}
            </a>
          ))}
        </nav>
      </section>

      <section className="lg-card overflow-hidden rounded-ios-3xl p-5 sm:rounded-ios-4xl sm:p-7">
        <div className="flex flex-col gap-8">
          <Section id="codebase" num="01" title="源码目录导览">
            <p>解压后根目录的关键部分：</p>
            <Code>{`deepseek-harness/
├─ apps/
│  ├─ cli/        dsh 命令入口（src/args.ts 命令语法，src/bin.ts 加载运行器）
│  └─ web/        浏览器 Web 前端源码（Vite 构建）
├─ packages/      核心包（全部是插件，见下）
│  ├─ bundle/     base / web-app / headless 三个组合包 = profile 模板
│  ├─ llm/        LLM 适配器（llm-deepseek、llm-pi-ai 等）
│  ├─ core/       会话日志、工具注册、agent 循环、作用域
│  ├─ sandbox/    进程沙箱（read-only / workspace-write / danger-full-access）
│  ├─ credentials/  凭据存储（.credentials.yaml，只写）
│  ├─ settings/   设置文档与解析
│  ├─ shell/      命令执行 seam
│  ├─ subagent/   子代理提供方
│  └─ tool-*/     面向模型的工具包（bash、fs、search、terminal、web…）
├─ native/        Landlock（Linux）沙箱原生实现
├─ examples/      acp-agent / headless-agent / jsonrpc-agent / mcp-memory 等示例
└─ docs/          官方文档（user/guide 有中文版）`}</Code>
            <p>
              最重要的设计事实：<strong>产品的每一部分都是插件</strong>——模型适配器、工具注册、会话日志、
              Agent 循环本身全部是插件，可以被配置替换，不存在需要打补丁的特权内核。这也是为什么
              <strong>改配置就能改行为</strong>，不一定需要改源码。命令语法在{" "}
              <InlineCode>apps/cli/src/args.ts</InlineCode>，运行器加载在 <InlineCode>apps/cli/src/bin.ts</InlineCode>；
              组合包模板在 <InlineCode>packages/bundle/</InlineCode>。
            </p>
            <p>
              三个组合包：<InlineCode>@deepseek-ai/dsh-base</InlineCode>
              （每个 profile 的第一层：模型、工具、持久化、沙箱、权限、设置、凭据、遥测）、
              <InlineCode>@deepseek-ai/dsh-web-app</InlineCode>（加浏览器应用）、
              <InlineCode>@deepseek-ai/dsh-headless</InlineCode>（一次性运行器，无服务器）。
            </p>
          </Section>

          <Section id="config" num="02" title="配置体系：profile / bundle / patch">
            <p>
              运行中的 <InlineCode>dsh</InlineCode> 是一棵插件树，由启动时按序叠加的配置层组成。理解这套
              层叠是定制 Harness 的钥匙：
            </p>
            <Code>{`配置树叠加顺序（后层优先，后者覆盖前者）：
1. dsh.profile.bundles 里列出的各组合包 patch
2. profile 自己的 cordis.patch.yml
3. home 级 $DSH_HOME/cordis.patch.yml（机器级偏好，所有 profile 共享）
4. 命令行 --patch <file> 覆盖层（按 argv 顺序）`}</Code>
            <p>
              关键规则：<strong>patch 按行 id 定位，替换整行的 config 值，而不是合并键</strong>；
              它也可以插入新行。所以查看你的机器实际生效的配置树，是定制前的第一步：
            </p>
            <Code>{`dsh --profile web --dump-config        # 看完整生效配置树（注释标注每行来自哪个文件）
dsh --profile web --dump-default-config  # 只看组合包自带层，不含用户 patch`}</Code>
            <p>
              dump 出来的任何一行，都可以由你自己的 patch 替换。想临时加一个覆盖层而不改任何文件：
            </p>
            <Code>{`dsh web --patch ./extra.cordis.yml`}</Code>
            <SubTitle>Harness home（$DSH_HOME）</SubTitle>
            <p>
              默认是 <InlineCode>~/.dsh</InlineCode>（可用 <InlineCode>DSH_HOME</InlineCode> 改路径），里面：
            </p>
            <Code>{`~/.dsh/
├─ settings.yaml           设置文档（模型模态、通用设置等）
├─ .credentials.yaml       凭据（只写：保存后只回脱敏描述符，永不返回明文）
├─ cordis.patch.yml        home 级 patch 层（所有 profile 共享）
└─ profiles/
   ├─ web/                  web profile（package.json + dsh.profile + cordis.patch.yml）
   ├─ headless/             headless profile
   └─ node_modules/         dsh 维护的符号链接后备目录`}</Code>
            <p>
              提供方凭据按顺序解析：继承的环境变量 → <InlineCode>$DSH_HOME/.credentials.yaml</InlineCode>
              → 调用目录的 <InlineCode>.env</InlineCode> → <InlineCode>$DSH_HOME/.env</InlineCode>。
              凭据由受管文档保存，不会物化进 <InlineCode>process.env</InlineCode>。
            </p>
          </Section>

          <Section id="cli" num="03" title="CLI 命令全集">
            <Code>{`dsh web                                   # 启动 Web UI（--profile web 的别名）
dsh web --port 8080                       # Web 应用参数：端口
dsh web --host 127.0.0.1  --trusted-host x --trusted-host y
dsh web --help                            # 显示 Web 应用的帮助（不启动）
dsh --profile headless "run the tests"    # 一次性任务：跑完打印结果退出
dsh --profile headless --dump-config      # 只查配置不启动
dsh plugin --profile tui add <package>    # 给 profile 装插件（转发给 pnpm）
dsh plugin --profile tui remove <package>
dsh --help                                # 启动器自己的帮助`}</Code>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>启动器 flag 必须写在最前面</strong>：启动器只解析自己的 flag，第一个无法识别的
                token 之后的内容原样交给应用。所以 <InlineCode>--port</InlineCode> 属于 web 应用。
              </li>
              <li>
                <strong>headless 一次性任务</strong>：创建全新持久化会话 → 提交任务 → 等待完全停稳并
                flush → 打印最终回答。原因为 <InlineCode>completed</InlineCode> 时退出码 0，否则 1。
                它不开服务器、不占用端口。
              </li>
              <li>
                <strong>--host 0.0.0.0 会被拒绝</strong>：CLI 有意不支持绑定所有网卡，防止局域网暴露。
                要开 LAN 访问请用可重复的 <InlineCode>--trusted-host</InlineCode> 声明可信主机名。
              </li>
              <li>
                <strong>关闭行为</strong>：SIGTERM 优雅退出（退出码 0）；第一次 Ctrl+C 报告 130；
                第二次立即强制退出。
              </li>
            </ul>
          </Section>

          <Section id="models" num="04" title="模型路由与提供商">
            <SubTitle>DeepSeek 官方</SubTitle>
            <p>
              设置 → 模型 → DeepSeek 卡片填入 API Key 保存即可，模型路由立即可用、无需重启。密钥只写：
              保存后界面永不回显，存储在 <InlineCode>$DSH_HOME/.credentials.yaml</InlineCode>。
            </p>
            <SubTitle>目录提供商（开箱即用的其他家）</SubTitle>
            <p>
              选择「添加提供方」，可选取 Anthropic、OpenAI 等，填入密钥即可。注意需要<strong>原生凭据</strong>
              的提供商：Bedrock（AWS 凭证+区域）、Vertex（ADC 项目）、Azure（api-version）、Codex（OAuth），
              只填 API Key 字段无法完成配置。
            </p>
            <SubTitle>自定义提供商（网关 / 自建 / 兼容端点）</SubTitle>
            <p>
              公司网关或任何 OpenAI 兼容端点选「添加自定义提供方」，填：Provider ID（小写，<strong>永久</strong>，
              请求、会话、凭据引用都用它，改不了只能删了重建）、基础 URL、API 协议、API Key，以及至少一个模型。
              在「模型目录」点「获取可用模型」会去查 <InlineCode>GET /models</InlineCode>；没有该接口的服务
              就手动输入模型 id。
            </p>
            <p>
              <strong>模型模态</strong>：手动录入的模型默认按纯文本对待。视觉模型需要在
              <InlineCode>$DSH_HOME/settings.yaml</InlineCode> 给该模型加
              <InlineCode>input: [text, image]</InlineCode>；整个路由都支持图片则用
              <InlineCode>defaultInput: [text, image]</InlineCode> 一次设置。
            </p>
            <Code>{`# settings.yaml 片段：给自定义网关的一个模型开图片输入
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: vision-preview
          input: [text, image]`}</Code>
          </Section>

          <Section id="permissions" num="05" title="权限与沙箱">
            <p>沙箱只有三个模式（都只限制文件操作）：</p>
            <Code>{`read-only             只读：不能改任何文件
workspace-write       默认预设：bash 和文件修改仅限当前工作区 + 平台临时目录
danger-full-access    不限制：可以改任何路径文件（高危）`}</Code>
            <p>默认的 <strong>workspace-write</strong> 下：读取、网络访问和进程可见性不受限制；写入被
              限制在工作区内。Agent 想越权时会走<strong>审批升权</strong>链：</p>
            <Code>{`read-only → workspace-write → danger-full-access`}</Code>
            <p>
              Web UI 里遇到需要批准的操作会先询问你，批准即按更宽策略重发一次调用。新会话默认
              workspace-write；<InlineCode>DSH_PERMISSION_MODE</InlineCode> 更换进程级后备值；
              设置中的「通用」里存的权限影响后续 Web 会话，不改变已打开的会话。
            </p>
            <p>
              沙箱后端按平台实现：Linux 用 Landlock（含 native/ 下的 landlock-run）或 bubblewrap、
              macOS 用 sandbox-exec、Windows 用 ACL restricted-token runner。后端不可用时会
              <strong>拒绝执行而不是放开限制</strong>（SANDBOX_UNAVAILABLE）。
            </p>
            <p>
              想知道会话实际处于什么模式，看 agent 的系统提示词以外的运行时上下文，或直接查
              <InlineCode>dsh --profile web --dump-config</InlineCode> 里的 sandbox 相关行。
            </p>
          </Section>

          <Section id="tools" num="06" title="工具系统：Agent 的能力清单">
            <p>
              默认组合挂载的模型可见工具（包 → 工具名 → 说明）：工具 schema 由系统提示词组装自动拼接，
              你给 Agent 的能力集合完全由配置决定。
            </p>
            <div className="flex flex-col gap-2">
              {TOOL_GROUPS.map((group) => (
                <div key={group.group} className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] px-4 py-3">
                  <p className="font-medium text-[rgba(0,0,0,0.85)]">{group.group}</p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {group.tools.map((t) => (
                      <code
                        key={t}
                        className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-ios-caption1 text-[#007AFF]"
                      >
                        {t}
                      </code>
                    ))}
                  </p>
                  <p className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{group.note}</p>
                </div>
              ))}
            </div>
            <p>
              还有两个特殊开关值得知道：<strong>极简模式</strong>（minimal preset）只组合持久
              <InlineCode>bash</InlineCode> 与 <InlineCode>str_replace_editor</InlineCode>，系统提示词固定为
              「You are a helpful software engineer assistant.」——盲盒最小、适合不信任的代码库；
              <InlineCode>DSH_TOOLS_MODE</InlineCode> 选择 native / code / both 三种工具呈现模式。
            </p>
          </Section>

          <Section id="env" num="07" title="环境变量速查表">
            <div className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.04)]">
              <table className="w-full min-w-[560px] text-left text-ios-footnote">
                <thead>
                  <tr className="border-b border-[rgba(0,0,0,0.08)]">
                    <th className="px-4 py-2.5 font-semibold text-[rgba(0,0,0,0.85)]">变量</th>
                    <th className="px-4 py-2.5 font-semibold text-[rgba(0,0,0,0.85)]">作用</th>
                  </tr>
                </thead>
                <tbody>
                  {ENV_VARS.map((v) => (
                    <tr key={v.name} className="border-b border-[rgba(0,0,0,0.05)] last:border-0">
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <code className="font-mono text-[#007AFF]">{v.name}</code>
                      </td>
                      <td className="px-4 py-2.5 text-[rgba(0,0,0,0.62)]">{v.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="plugins" num="08" title="插件与二次开发">
            <p><strong>不改源码的第一种扩展：patch 覆盖。</strong>前面说过，dump-config 输出的任何一行都可以
              用你的 <InlineCode>cordis.patch.yml</InlineCode> 替换，或者用
              <InlineCode>--patch extra.cordis.yml</InlineCode> 一次性叠加。两个 patch 文件在运行期间都会被
              监视，合法变更会事务式热重载。</p>
            <p><strong>安装第三方插件：</strong>通过 profile 的插件管理器（内部转发给 pnpm）：</p>
            <Code>{`dsh plugin --profile tui add github:deepseek-harness/turtle-ui
dsh plugin --profile tui remove turtle-ui
dsh --profile tui`}</Code>
            <p>
              每次成功安装后，系统会按当前依赖状态更新 manifest 的 <InlineCode>dsh.profile.bundles</InlineCode>，
              插件声明了组合包 patch 就会自动进入配置层栈。Git 托管的插件在安装时会跑 prepare 构建脚本，
              pnpm ≥10 默认阻止——首次 add 会给出 allowBuilds 提示，把提示的键复制进该 profile 的
              <InlineCode>pnpm-workspace.yaml</InlineCode> 再重跑即可。</p>
            <p><strong>想自己写插件：</strong>先读官方入门（仓库 docs/cordis-primer.zh.md），并对照下面的
              「新行为挂哪」表（来自架构文档）：</p>
            <div className="flex flex-col gap-2">
              {EXTENSION_POINTS.map((e) => (
                <div key={e.target} className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] px-4 py-3">
                  <p className="font-medium text-[rgba(0,0,0,0.85)]">{e.target}</p>
                  <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.62)]">{e.mechanism}</p>
                </div>
              ))}
            </div>
            <p>
              一套轮次（turn）的骨架也值得记住：一步 = 一次模型请求 + 它调用的工具；一回合 = 零到多步。
              事件是扩展点——会话事件（持久）、Agent 事件（活跃代理）、能力事件（seam 策略）。
              修改模型可见的内容必须同步加会话事件，这是运行时不变量（「模型可见即已记录」）。
            </p>
          </Section>

          <Section id="programmatic" num="09" title="程序化接入（headless / Python SDK）">
            <SubTitle>headless 一次性任务</SubTitle>
            <p>不依赖浏览器：</p>
            <Code>{`dsh --profile headless "run the tests"
dsh --profile headless --patch ./extra.cordis.yml "deploy to staging"`}</Code>
            <SubTitle>Python SDK</SubTitle>
            <p>要求 Python 3.10+，平台限 Linux x64 / Linux arm64 / macOS 14+ arm64；运行时由 pip 包自带，不需要系统装 Node.js：</p>
            <Code>{`git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv && . .venv/bin/activate
python -m pip install deepseek-harness-sdk

export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1   # 走 OpenAI 兼容代理时
# export DSH_MODEL=deepseek-v4-flash
python examples/jsonrpc-agent/minimal.py \
  --workspace /abs/path/to/workspace \
  --session-root /abs/path/to/sessions \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."`}</Code>
            <p>在自己的程序里用同一套 API：</p>
            <Code>{`from pathlib import Path
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd="/abs/path/to/workspace",
    session_root="/abs/path/to/sessions",
    cordis="examples/jsonrpc-agent/minimal.cordis.yml",
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )
print(result.final_response)`}</Code>
            <p>
              复用同一个 harness 与 session id 会保留该会话的 Bash 进程（工作目录、导出的变量、shell
              函数）；独立任务请用新 session id。会话目录会收到 JSONL 日志，包含组装后的模型请求与工具
              调用。
            </p>
          </Section>

          <Section id="security" num="10" title="安全与隐私">
            <ul className="list-disc space-y-1.5 pl-5">
              <li><strong>凭据只写</strong>：API Key 保存后只保留脱敏描述符，界面与环境变量都不会回显明文。</li>
              <li><strong>遥测默认关闭</strong>：会话数据留在本地。显式设置 DSH_TELEMETRY_MODE=FULL 才会上报，
                且随附配置没有脱敏规则——上报内容可能包含消息文本、工具参数和工作区路径，谨慎开启。</li>
              <li><strong>MCP 服务器默认不启用</strong>：每条 server 命令都是 Agent 沙箱之外的可信可执行代码，
                需要 patch 层显式启用。</li>
              <li><strong>会话日志是敏感的</strong>：日志里包含模型请求与工具调用，不要提交到公开仓库。</li>
              <li><strong>danger-full-access 只在可信环境用</strong>：沙箱不可用时会拒绝执行而不是放开限制，
                别为了省事关掉沙箱。</li>
            </ul>
          </Section>

          <Section id="troubleshoot" num="11" title="深度排错表">
            <div className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.04)]">
              <table className="w-full min-w-[640px] text-left text-ios-footnote">
                <thead>
                  <tr className="border-b border-[rgba(0,0,0,0.08)]">
                    <th className="px-4 py-2.5 font-semibold text-[rgba(0,0,0,0.85)]">现象</th>
                    <th className="px-4 py-2.5 font-semibold text-[rgba(0,0,0,0.85)]">原因</th>
                    <th className="px-4 py-2.5 font-semibold text-[rgba(0,0,0,0.85)]">解决</th>
                  </tr>
                </thead>
                <tbody>
                  {DEBUG_TABLE.map((row) => (
                    <tr key={row.symptom} className="border-b border-[rgba(0,0,0,0.05)] last:border-0 align-top">
                      <td className="px-4 py-2.5 font-medium text-[rgba(0,0,0,0.85)]">{row.symptom}</td>
                      <td className="px-4 py-2.5 text-[rgba(0,0,0,0.62)]">{row.cause}</td>
                      <td className="px-4 py-2.5 text-[rgba(0,0,0,0.62)]">{row.fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              最后提醒：本仓库处于<strong>开发者预览</strong>阶段，版本升级可能有破坏性变更。源码自行改动的
              部分，升级前记得备份 <InlineCode>~/.dsh</InlineCode> 与你的 patch 文件。官方文档与最新源码见{" "}
              <a
                className="inline-flex items-center gap-0.5 text-[#007AFF]"
                href="https://github.com/deepseek-ai/deepseek-harness"
                target="_blank"
                rel="noreferrer"
              >
                GitHub 仓库 <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
              。
            </p>
          </Section>
        </div>
      </section>
    </div>
  );
}