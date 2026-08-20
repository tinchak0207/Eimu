import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

const DOCS_TITLE = "DeepSeek Harness 入门教程 | Eimu";
const DOCS_DESCRIPTION =
  "面向零基础用户的 DeepSeek Harness 下载、安装与使用教学：每一步都告诉你点哪里、粘贴什么、会看到什么。";

export const metadata = {
  title: DOCS_TITLE,
  description: DOCS_DESCRIPTION,
  openGraph: {
    title: DOCS_TITLE,
    description: DOCS_DESCRIPTION,
    url: "https://eimu.dev/docs/harness",
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

const STEPS = [
  {
    num: "01",
    title: "安装 Node.js 和 pnpm（5 分钟）",
    body: (
      <>
        <p>
          打开官方下载页{" "}
          <a className="text-[#007AFF] underline" href="https://nodejs.org/" target="_blank" rel="noreferrer">
            nodejs.org
          </a>
          ，点页面中间绿色的 <strong>LTS</strong> 版本下载，双击安装包，一路点「下一步」直到完成。
        </p>
        <p>
          装好后打开终端（Windows：按 <strong>Win + R</strong>，输入 <InlineCode>cmd</InlineCode> 回车；Mac：
          打开「终端」App），粘贴下面这行并回车，看到版本号就说明装好了：
        </p>
        <Code>{`node -v`}</Code>
        <p>
          需要 <InlineCode>v22.19</InlineCode> 或更高的版本号。如果版本较旧，去 nodejs.org 重新下载最新的
          LTS 覆盖安装即可。
        </p>
        <p>再从源码运行还需要 pnpm。在终端粘贴并回车，看到版本号即成功：</p>
        <Code>{`npm install -g pnpm
pnpm -v`}</Code>
      </>
    ),
  },
  {
    num: "02",
    title: "从源码包启动（拿到 zip 用这个方式）",
    body: (
      <>
        <p>
          把你拿到的 <InlineCode>deepseek-harness-master.zip</InlineCode> 解压到一个好找的文件夹
          （路径不要有中文和空格，例如 <InlineCode>C:\dsh</InlineCode>）。然后在终端里依次执行：
        </p>
        <Code>{`cd C:\dsh\deepseek-harness-master
pnpm install
pnpm run build
pnpm dsh web`}</Code>
        <p>
          第一次安装会下载依赖，耐心等它跑完。<InlineCode>pnpm run build</InlineCode> 会构建全部包和前端
          （需要几分钟）。看到类似这样的输出，就成功了：
        </p>
        <Code>{`Local: http://127.0.0.1:3080`}</Code>
      </>
    ),
  },
  {
    num: "03",
    title: "不想碰源码？一行命令安装",
    body: (
      <>
        <p>
          如果你其实不需要源码、只想快速体验，就不用解压 zip——在终端粘贴下面这行并回车，它会自动下载
          并启动 Web 界面：
        </p>
        <Code>{`npx @deepseek-ai/dsh web`}</Code>
        <p>
          第一次运行会问你是否安装 <InlineCode>@deepseek-ai/dsh</InlineCode>，输入 <InlineCode>y</InlineCode>{" "}
          回车即可。看到 <InlineCode>Local: http://127.0.0.1:3080</InlineCode> 就算成功。
        </p>
      </>
    ),
  },
  {
    num: "04",
    title: "打开界面，填入 DeepSeek API 密钥",
    body: (
      <>
        <p>
          浏览器访问 <InlineCode>http://127.0.0.1:3080</InlineCode>（启动命令的终端窗口不要关闭，关闭它等于
          关掉服务）。
        </p>
        <p>
          打开{" "}
          <a
            className="text-[#007AFF] underline"
            href="https://platform.deepseek.com"
            target="_blank"
            rel="noreferrer"
          >
            platform.deepseek.com
          </a>{" "}
          注册并登录，在「API Keys」页面点「创建 API Key」，复制生成的密钥（形如{" "}
          <InlineCode>sk-xxxxxxxx</InlineCode>）。
        </p>
        <p>
          回到 Harness 界面，点 <strong>设置 → 模型</strong>，在 DeepSeek 卡片里粘贴密钥并保存。密钥是
          只写的：保存后网页不会再次显示它，这是正常的安全设计。到这里模型就配好了，不需要重启。
        </p>
      </>
    ),
  },
  {
    num: "05",
    title: "选择工作区",
    body: (
      <>
        <p>
          <strong>工作区</strong>就是你想让 AI 帮你干活的文件夹（比如你的项目目录）。点界面的{" "}
          <strong>选择工作区</strong>，找到并选中你的项目文件夹。选中之前，输入框是灰的不能打字，这是
          正常的。
        </p>
        <p>之后 AI 就能读取、修改这个文件夹里的文件，并在这个目录里运行命令。</p>
      </>
    ),
  },
  {
    num: "06",
    title: "发出你的第一个任务",
    body: (
      <>
        <p>在输入框里输入下面这句话，回车：</p>
        <Code>{`帮我总结这个项目的结构，并说明它有哪些主要模块。`}</Code>
        <p>
          AI 会开始思考、读文件、运行命令。当它想做需要你批准的操作（例如修改文件、执行命令）时，界面会
          先询问你，点确认就继续。右侧会逐条展示它的思考过程和结果。
        </p>
        <p>
          以后你可以让它写代码、修 bug、整理文档、批量处理文件，只要把需求说清楚就行。
        </p>
      </>
    ),
  },
];

const FAQ = [
  {
    q: "提示 node 版本太低 / 命令不认识？",
    a: "重新去 nodejs.org 下载最新的 LTS 版覆盖安装，然后关掉终端重新打开，再执行 node -v 确认版本高于 v22.19。",
  },
  {
    q: "pnpm install 卡住 / 下载很慢？",
    a: "国内网络访问 npm 可能较慢。可以换成国内镜像源再试：npm config set registry https://registry.npmmirror.com，然后重新执行 pnpm install。",
  },
  {
    q: "pnpm run build 报错？",
    a: "最常见原因是 Node.js 版本太旧或安装不完整。先确认 node -v ≥ v22.19，再删除 node_modules 和 pnpm-lock.yaml 重新 pnpm install && pnpm run build。",
  },
  {
    q: "提示 MISSING_CREDENTIAL？",
    a: "说明模型页里没有保存密钥。回到「设置 → 模型」，给 DeepSeek 填入 API Key 并保存。",
  },
  {
    q: "提示 UNKNOWN_MODEL？",
    a: "说明选中的模型还没配置。在「设置 → 模型」里选一个已配置的模型，再回来发任务。",
  },
  {
    q: "输入框一直不能打字？",
    a: "还没有选择工作区。点「选择工作区」选中你的项目文件夹后再试。",
  },
  {
    q: "关了终端再打开，网址打不开了？",
    a: "正常——服务随着终端关闭而停止。重新执行启动命令（源码方式 pnpm dsh web / 一行命令方式 npx @deepseek-ai/dsh web）即可再次启动。",
  },
];

export default function HarnessPage() {
  return (
    <div className="flex flex-col gap-5">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">DeepSeek Harness</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          DeepSeek Harness 零基础入门教程
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          DeepSeek Harness（简称 <strong>dsh</strong>）是 DeepSeek 开源的 AI 智能体框架：装上它之后，
          你可以用自然语言让 AI 帮你读代码、写代码、跑命令。本教程面向完全没接触过的用户，照着做就能跑起来。
          全程大约 15 分钟。
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Link
            href="/docs/harness/deep"
            className="inline-flex items-center gap-1 rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-caption1 font-medium text-[#007AFF]"
          >
            已经跑通了？去读深度指南 <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      <section className="lg-card overflow-hidden rounded-ios-3xl p-5 sm:rounded-ios-4xl sm:p-7">
        <div className="flex flex-col gap-6 divide-y divide-[rgba(0,0,0,0.06)]">
          {STEPS.map((step) => (
            <div key={step.num} className="flex flex-col gap-3 pt-6 first:pt-0">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ios-2xl bg-[rgba(0,122,255,0.10)] font-mono text-ios-footnote font-semibold text-[#007AFF]">
                  {step.num}
                </span>
                <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">{step.title}</h2>
              </div>
              <div className="flex flex-col gap-3 text-ios-body leading-relaxed text-[rgba(0,0,0,0.62)]">
                {step.body}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lg-card overflow-hidden rounded-ios-3xl p-5 sm:rounded-ios-4xl sm:p-7">
        <h2 className="text-ios-title2 font-semibold text-[rgba(0,0,0,0.85)]">常见问题</h2>
        <div className="mt-5 flex flex-col gap-4">
          {FAQ.map((item) => (
            <div key={item.q} className="flex flex-col gap-1.5">
              <p className="text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">{item.q}</p>
              <p className="text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="text-ios-caption1 text-[rgba(0,0,0,0.48)]">
        TIP：想了解每个文件夹是干什么的、怎么改配置、怎么装插件、怎么用代码调用——见{" "}
        <Link href="/docs/harness/deep" className="text-[#007AFF]">
          深度指南
        </Link>
        。本教程介绍的 Harness 是 DeepSeek 官方的开源本地工具，与本站的 API / MCP 服务相互独立。
      </p>
    </div>
  );
}