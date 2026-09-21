"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CircleDollarSign,
  Coins,
  Gauge,
  History,
  KeyRound,
  ListChecks,
  Plug,
  Repeat,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wand2,
  Wallet,
  Workflow,
  Zap,
} from "lucide-react";
import { toSimplified } from "@/lib/traditional-to-simplified";

interface OpenApiSchema {
  openapi: string;
  servers: Array<{ url: string; description?: string }>;
  info: { title: string; version: string; description?: string };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        summary?: string;
        description?: string;
        parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
        requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
        responses?: Record<string, { description?: string }>;
      }
    >
  >;
}

const METHOD_COLORS: Record<string, string> = {
  get: "bg-[#007AFF]/10 text-[#007AFF]",
  post: "bg-[#34C759]/[0.12] text-[#1E9E4F]",
  put: "bg-[#FF9500]/[0.12] text-[#C76A00]",
  delete: "bg-[#FF3B30]/[0.12] text-[#D92A20]",
  patch: "bg-[#AF52DE]/[0.12] text-[#9B3FBF]",
};

function schemaName(ref: string | undefined): string {
  if (!ref) return "";
  const name = ref.split("/").pop();
  return name ?? "";
}

// ---- 开发进阶（附录）代码块：路径一律以 $BASE 模板串拼，杜绝内联手写的端点字面量 ----

const SETUP = `KEY="sk-biz-…"            # 你的 B 端密钥
BASE="https://eimu.dev/v1"`;

const STEP1 = `# ① 列出可用模型（含私有单价字段 x_coins_per_image）
curl -s "$BASE/models" \\
  -H "Authorization: Bearer $KEY"`;

const STEP2 = `# ② 提交任务 → 202 + task_id，不在同一响应里给图
curl -s -X POST "$BASE/images/generations" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"pixai-haruka-v2","prompt":"1girl, silver hair, cinematic lighting","n":1,"size":"1024x1024"}'
# → { "task_id": "3988af81-…", "status": "queued", "task_url": "/v1/images/3988af81-…" }`;

const STEP3 = `# ③ 轮询：3~5 秒一次，直到 status 变为 succeeded；轮询不消耗限流额度
TASK="3988af81-…"        # 换成上一步返回的 task_id
curl -s "$BASE/images/$TASK" \\
  -H "Authorization: Bearer $KEY"
# succeeded 的回应已内嵌 data[]，直接读 data[0].url 即成品 URL；/result 只是便捷入口`;

// ---- 教学文案数据（现场逐字：与助理设定弹层 AgentSettingsPopover 同文案）----

const NAV_CHIPS: Array<{ href: string; label: string }> = [
  { href: "#start", label: "怎么开始对话" },
  { href: "#flow", label: "一轮会发生什么" },
  { href: "#workflow", label: "工作流与画布" },
  { href: "#history", label: "历史素材复用" },
  { href: "#settings", label: "助理设定" },
  { href: "#billing", label: "充值与计费" },
  { href: "#portable", label: "把助理带走" },
  { href: "#dev", label: "开发进阶" },
];

const EXAMPLE_PROMPTS: Array<{ text: string; note: string }> = [
  { text: "画一只戴帽子的橘猫，水彩风格", note: "一句话生图，最常见的起点" },
  { text: "让这瓶香水出现在落日海滩，自然光", note: "给参考图，再给感觉" },
  { text: "生成秦始皇骑北极熊的大电影", note: "认真的能力展示：重型流水线，不是玩笑" },
];

const SETTING_ROWS: Array<{ name: string; plain: string; options: Array<{ k: string; v: string }> }> = [
  {
    name: "中途输入",
    plain: "助理正在干活时你又发了消息，怎么处理。",
    options: [
      { k: "打断", v: "打断：新消息立即接管当前回合" },
      { k: "排队", v: "排队：新消息在本轮结束后执行" },
    ],
  },
  {
    name: "模型性格",
    plain: "助理说话和做事的节奏。",
    options: [
      { k: "高效（默认）", v: "高效：快速行动，先给结果" },
      { k: "沉稳", v: "沉稳：先充分思考再行动，回复更慢更全面" },
    ],
  },
  {
    name: "成本需求",
    plain: "同一句话，愿意花多少钱办。",
    options: [
      { k: "经济", v: "经济：单图低成本，不自动放大" },
      { k: "均衡", v: "均衡：常规质量，速度与成本兼顾" },
      { k: "高质", v: "高质：允许多候选与高清放大" },
    ],
  },
  {
    name: "互动模式",
    plain: "干活路上它多久问你一次。",
    options: [
      { k: "协作", v: "协作：每步都和你确认，扣费与关键决策逐项询问" },
      { k: "预设", v: "预设：更自主，整包计划一次授权，扣费与关键决策仍找你" },
      { k: "自动", v: "自动：完全自主，不再询问与扣费确认，一键发送直出结果" },
    ],
  },
];

// ---- 第 3 章：模板转盘卡面（现场逐字：与首页模板轮盘 8 张卡面一致，domain/name/note 不可改写）----

const TEMPLATE_GALLERY: Array<{ domain: string; name: string; note: string }> = [
  {
    domain: "小说",
    name: "小说影视化",
    note: "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
  },
  {
    domain: "小说",
    name: "IP视觉包",
    note: "网文 IP 全案视觉：世界观锚定→主角色卡→名场面组图→封面主视觉一条链出齐",
  },
  {
    domain: "电商",
    name: "新品上市包",
    note: "新品素材流水线：产品锁→场景图→模特图→主视觉→多画幅批量，一次锁定全线一致",
  },
  {
    domain: "电商",
    name: "模特种草线",
    note: "平铺图到种草图流水线：服装提取→虚拟试穿→一致性网格→详情页排版",
  },
  {
    domain: "短剧",
    name: "剧本视觉化",
    note: "剧本到视觉资产工业链：拆场→分镜→主演角色卡→CP剧照→竖屏海报，门禁层层放行",
  },
  {
    domain: "短剧",
    name: "投放海报线",
    note: "短剧投放物料流水线：剧设锚定→主演海报→CP对戏图→信息流切片封面批量",
  },
  {
    domain: "艺术",
    name: "策展式创作",
    note: "主题到个展全链：情绪板→风格锚→成组作品→展陈主视觉，一致性当一等公民",
  },
  {
    domain: "艺术",
    name: "风格深研线",
    note: "艺术家风格深度内化流水线：解构→临摹对拍→变体矩阵→原创成组",
  },
];

const RECIPE_CHIPS: string[] = [
  "3D手办",
  "黏土手作",
  "Q版可爱",
  "胶片质感",
  "水墨插画",
  "水彩插画",
  "赛博朋克",
  "极简主义",
  "电影感",
  "日系动漫",
];

// ---- 第 6 章：充值方案（现场逐字：与 /pricing 四档文案一致）----

const PLAN_ROWS: Array<{ name: string; price: string; coins: string }> = [
  { name: "梦芽 · 轻度尝鲜包", price: "¥9.9", coins: "100 金币" },
  { name: "梦影 · 主力月度会员", price: "¥29.9", coins: "500 金币" },
  { name: "梦虹 · 季度高频创作包", price: "¥69", coins: "1500 金币" },
  { name: "自定义 · 自由额度", price: "2,000～100 万金币滑杆", coins: "按 0.045 元/金币计价" },
];

// ---- 第 7 章：把助理带走（MCP 接入干货，工具描述逐字取自原 MCP 接入页）----

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

// ---- 共用小组件 ----

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-[#007AFF]" />
      <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">{children}</h2>
    </div>
  );
}

function Specular() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
  );
}

function Step({
  n,
  title,
  note,
  code,
}: {
  n: string;
  title: string;
  note: React.ReactNode;
  code?: string;
}) {
  return (
    <div className="p-5 sm:p-7">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-ios-caption1 font-bold text-white">
          {n}
        </span>
        <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</h3>
      </div>
      <p className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{note}</p>
      {code ? (
        <div className="mt-3">
          <CodeBlock>{code}</CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

function KeyCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lg-card flex flex-col rounded-ios-3xl p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
        <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</p>
      </div>
      <div className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{children}</div>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">{children}</code>
  );
}

export default function DocsPage() {
  const [spec, setSpec] = useState<OpenApiSchema | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/openapi.json")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => setSpec(data as OpenApiSchema))
      .catch((err) => setError(err instanceof Error ? err.message : "载入失败"));
  }, []);

  const entries = useMemo(() => {
    if (!spec) return [];
    return Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b));
  }, [spec]);

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
        <nav aria-label="页面章节" className="mt-4 flex flex-wrap gap-1.5">
          {NAV_CHIPS.map((chip) => (
            <a
              key={chip.href}
              href={chip.href}
              className="inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-3.5 py-1.5 text-ios-footnote font-medium text-[#007AFF] lg-transition hover:bg-[rgba(0,122,255,0.14)]"
            >
              {chip.label}
            </a>
          ))}
        </nav>
      </section>

      {/* ================= 第 1 章 怎么开始对话 ================= */}
      <section id="start" className="scroll-mt-28">
        <SectionTitle icon={Wand2}>第一章 · 怎么开始对话</SectionTitle>
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

      {/* ================= 第 2 章 一轮对话里会发生什么 ================= */}
      <section id="flow" className="scroll-mt-28">
        <SectionTitle icon={Repeat}>第二章 · 一轮对话里会发生什么</SectionTitle>
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
                  里；然后按你设定的互动模式请求授权或直接开工（见第五章）。
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

      {/* ================= 第 3 章 工作流：模板库与画布 ================= */}
      <section id="workflow" className="scroll-mt-28">
        <SectionTitle icon={Workflow}>第三章 · 工作流：模板库与画布</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          一句话太小，它自己拆；工程太大，别自己拆——模板库里有现成的流水线。
        </p>
        <div className="mt-4 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="模板转盘：四条成熟产线摆在那"
              note={
                <>
                  首轮对话前，右侧是一台 3D 卡片转盘，4 个领域 8 条产线都摆在那。点整张卡会弹确认窗，按「使用完整模板」全部环节开跑；也可以只点卡面下缘的环节 chip 挑着跑——
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">勾选 = 全部执行 · 单击环节开/关 · 按住拖过 = 只跑扫过的</strong>
                  ，再按「按所选环节开工」。选定后右侧画布立刻铺出工序骨架，助理照单施工。
                </>
              }
            />
            <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-7 sm:pb-7">
              {TEMPLATE_GALLERY.map((template) => (
                <div key={template.name} className="rounded-ios-2xl bg-[rgba(0,122,255,0.06)] p-4">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex shrink-0 items-center rounded-full bg-[#007AFF] px-2.5 py-0.5 text-ios-caption1 font-semibold text-white">
                      {template.domain}
                    </span>
                    <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.85)]">{template.name}</p>
                  </div>
                  <p className="mt-1.5 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{template.note}</p>
                </div>
              ))}
            </div>
            <Step
              n="2"
              title="画布是工作台，不是画廊"
              note={
                <>
                  每张节点卡悬浮就有一排动作：<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「编辑提示词」「重新生成」</strong>
                  （只重跑这一个环节，不整链重来）、<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「连线到其他节点」</strong>、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「高清放大」「设为主图」「编辑图片（裁剪/切图/抠除/旋转）」「存入素材库」「下载」</strong>
                  ；右键另有<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「存为卡并锁定」</strong>（角色卡/场景卡/风格卡）、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「转为参考图节点」「对齐与排列」「下载全部子图 (zip)」</strong>
                  。手势：拖空白平移、Shift/Ctrl+拖框选、Delete 删除、拖节点边缘圆点连线，图片文件直接拖进画布即上传。
                </>
              }
            />
            <Step
              n="3"
              title="续写靠嘴，不靠学按钮"
              note={
                <>
                  成品落进历史与画布之后，接着打一句「再来一组」「微调一下」就行；重型多环节需求，把助理设定（第五章）里的野兽模式打开，它会自动套成熟模板的工序结构当导演派活（详见第五章）。
                </>
              }
            />
            <Step
              n="4"
              title="配方模板：现成的风格起点"
              note={
                <>
                  画布右键 →「提示词库 / 素材」→「配方模板」分页，10 个内建风格一键起稿：{" "}
                  {RECIPE_CHIPS.map((chip) => (
                    <span
                      key={chip}
                      className="mr-1.5 mt-1.5 inline-block rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-0.5 text-ios-caption1 font-semibold text-[#007AFF]"
                    >
                      {chip}
                    </span>
                  ))}
                  <span className="mt-2 block">
                    官方口径：
                    <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「点击即把六槽配方摊开进表单，可改可撤销，不会直接生成。」</strong>
                  </span>
                </>
              }
            />
          </div>
        </div>
      </section>

      {/* ================= 第 4 章 历史素材复用 ================= */}
      <section id="history" className="scroll-mt-28">
        <SectionTitle icon={History}>第四章 · 历史素材复用</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          生成过的每样东西都有账——历史就是你的素材库，复用不用从头再来。
        </p>
        <div className="mt-4 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="生成历史：找得到"
              note={
                <>
                  顶栏「历史」图标进 <InlineCode>/history</InlineCode>；可按关键词搜索，按「图片」「视频」「工作流」类型筛选，工作流记录自带工序结构图缩图。点开大图可看模型、时间、消耗金币；重跑衍生的记录带「衍生自任务」徽章，可溯源。
                </>
              }
            />
            <Step
              n="2"
              title="每张卡悬浮就是一排复用动作"
              note={
                <>
                  「收藏」「下载」
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「用这套参数继续做图」</strong>
                  （把这一单的配方整套载回工作站接着做）、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「再来 N 组」「微调变体」</strong>、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「交给 AI 助理继续做」</strong>
                  （把提示词与原参数带回助理对话续写）、「存为资产」「删除」。
                </>
              }
            />
            <Step
              n="3"
              title="两种复用姿势"
              note={
                <>
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「再来 N 组」</strong>＝按这条记录的原配方原样重跑，参数不改动；
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「微调变体」</strong>
                  ＝改提示词、模型或尺寸后，按新配方批量重跑。组数可选 1/2/3/5/8（默认 3），弹窗逐单显示「上次实付 X 币」与本次预估（「本次预估 N 张 × P 币 ≈ T 币」），按「提交 N 个任务」下单；原配方带参考图的会「由任务系统原样带上」。
                </>
              }
            />
          </div>
        </div>
        <p className="mt-4 max-w-3xl rounded-ios-2xl bg-[rgba(255,149,0,0.1)] p-3.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
          <strong className="font-semibold text-[#C76A00]">提示：</strong>
          重跑前会预检余额，不足时提示「余额不足，请先充值再重跑」——充值见第六章。
        </p>
      </section>

      {/* ================= 第 5 章 助理设定 ================= */}
      <section id="settings" className="scroll-mt-28">
        <SectionTitle icon={Settings2}>第五章 · 助理设定（右上角齿轮）</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          聊天界面右上角的齿轮里一共五行，逐行讲清楚每行在管什么：
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {SETTING_ROWS.map((row) => (
            <div key={row.name} className="lg-card flex flex-col rounded-ios-3xl p-5">
              <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{row.name}</p>
              <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{row.plain}</p>
              <ul className="mt-3 space-y-2">
                {row.options.map((option) => (
                  <li key={option.k} className="text-ios-footnote leading-relaxed">
                    <span className="mr-2 inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-0.5 font-semibold text-[#007AFF]">
                      {option.k}
                    </span>
                    <span className="text-[rgba(0,0,0,0.58)]">{option.v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* 野兽模式：独立小节，醒目卡 */}
        <div className="mt-6" id="beast-mode">
          <div className="lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
            <Specular />
            <div className="border-l-4 border-[#AF52DE] p-5 sm:p-7">
              <div className="flex flex-wrap items-center gap-2.5">
                <Zap className="h-4 w-4 text-[#9B3FBF]" />
                <h3 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">野兽模式</h3>
                <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-0.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.62)]">
                  状态字：常规 / 极限
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <p className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[rgba(0,0,0,0.44)]">关着的它，只是轻声建议：</span>
                  「大部分场合不需要开启，留给真正硬核的点子」
                </p>
                <p className="rounded-ios-2xl bg-[rgba(175,82,222,0.08)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[#9B3FBF]">开了以后：</span>
                  「模型使用所有工具协助，拼尽全力达到最完美的效果，满足追求极限的你」
                </p>
              </div>
              <p className="mt-5 text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">它到底干了什么</p>
              <ol className="mt-2.5 space-y-2.5">
                <li className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mr-1.5 font-semibold text-[rgba(0,0,0,0.72)]">关着（常规）：</span>
                  一位全能工匠独立干活——选模型、写提示词、生成、交付都它自己来，快、便宜，适合一张图、一段视频、微调。
                </li>
                <li className="rounded-ios-2xl bg-[rgba(175,82,222,0.06)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                  <span className="mr-1.5 font-semibold text-[#9B3FBF]">开了（极限）：</span>
                  助理放下工具改当<strong className="font-semibold text-[rgba(0,0,0,0.78)]">导演</strong>——先把愿望拆成工序并写成任务书，派给编剧、视觉、音乐、剪辑等
                  <strong className="font-semibold text-[rgba(0,0,0,0.78)]">专家子助理</strong>
                  并行施工，回收每件产出逐件验收，不达标返工；右侧画布从聊天气泡长成一条
                  <strong className="font-semibold text-[rgba(0,0,0,0.78)]">生产泳道</strong>
                  （计划卡→工具卡→成品，每环可点开看）。
                </li>
                <li className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mr-1.5 font-semibold text-[rgba(0,0,0,0.72)]">自动配流水线：</span>
                  硬核需求（电商上新、短片短剧、长片、角色设定这类大工程）会自动套上成熟生产模板的工序结构，不用你懂分镜术语。
                </li>
              </ol>
              <p className="mt-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                <strong className="font-semibold text-[rgba(0,0,0,0.72)]">
                  代价是更慢、更贵，产出是「一整套」而不是「一张图」
                </strong>
                。
              </p>
              <p className="mt-3 rounded-ios-2xl bg-[rgba(255,149,0,0.1)] p-3.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                <strong className="font-semibold text-[#C76A00]">建议：</strong>
                先拿示例句「生成秦始皇骑北极熊的大电影」试一次极限档，看看它全力干活的样子。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= 第 6 章 充值与计费 ================= */}
      <section id="billing" className="scroll-mt-28">
        <SectionTitle icon={CircleDollarSign}>第六章 · 充值与计费</SectionTitle>
        <div className="mt-4 flex items-center gap-2">
          <Wallet className="h-4 w-4 shrink-0 text-[#007AFF]" />
          <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">充值三步</p>
        </div>
        <div className="mt-3 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="入口就在顶栏"
              note={
                <>
                  余额胶囊实时显示金币余额，点「＋」就有两项：
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「充值」</strong>
                  进入方案页（<InlineCode>/pricing</InlineCode>），
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「每日签到」</strong>
                  就地领币——签过之后显示「已签到 · 明日再来」。
                </>
              }
            />
            <Step
              n="2"
              title="四档方案，微信/支付宝"
              note={
                <>
                  支付方式支持「微信支付」「支付宝支付」：点「立即支付 ¥X」会新开窗口收银台，完成后回到本页点「已完成支付，刷新余额」。
                </>
              }
            />
            <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-7 sm:pb-7">
              {PLAN_ROWS.map((plan) => (
                <div key={plan.name} className="rounded-ios-2xl bg-[rgba(0,122,255,0.06)] p-4">
                  <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.85)]">{plan.name}</p>
                  <p className="mt-1 text-ios-caption1 font-semibold text-[#007AFF]">{plan.price}</p>
                  <p className="mt-1 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{plan.coins}</p>
                </div>
              ))}
            </div>
            <Step
              n="3"
              title="到账与兑换码"
              note={
                <>
                  正常即时到账；有兑换码在 <InlineCode>/pricing</InlineCode> 输入，「金币会立即到账」；若有延迟联系客服，通常 5 分钟内解决。邀请奖励：好友首次充值双方都得金币，「以金币发放、不能提现」。
                </>
              }
            />
          </div>
        </div>
        <p className="mt-4 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">钱进来了，怎么花得放心：</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <KeyCard icon={Coins} title="一本账，跨模型可比价">
            所有模型用统一币制计价，不同模型之间可以直接比价。单价看定价页{" "}
            <a href="/pricing" className="font-semibold text-[#007AFF] lg-transition hover:underline">
              /pricing
            </a>
            ，每一单的结算在历史里可查。
          </KeyCard>
          <KeyCard icon={ShieldCheck} title="失败自动退回">
            预扣 → 成功结算 → 失败退款是同一本账：开工前先把钱扣住，成功才结算，
            <strong className="font-semibold text-[rgba(0,0,0,0.72)]">失败自动退回</strong>
            ，不会白花钱、不重复扣费。
          </KeyCard>
          <KeyCard icon={AlertTriangle} title="不会静默扣到负">
            余额不足时会直接拒绝并提示，绝不会静默扣成负数。至于它什么时候开口问你钱，由互动模式决定：
            协作逐项问、自动不再问。
          </KeyCard>
        </div>
      </section>

      {/* ================= 第 7 章 把助理带走 ================= */}
      <section id="portable" className="scroll-mt-28">
        <SectionTitle icon={Plug}>第七章 · 把助理带走</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          助理不只会在这站网页里干活，也能装进你已有的 AI 工具——通过 MCP（Model Context Protocol），Claude、Codex、Cursor 里的
          agent 说一句话，就能出图、出视频并拿到成品 URL，背后走的是同一套计费与队列。
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
          想用本地 AI 框架（DeepSeek Harness）把本站当双手？接入教程见站内旧文档，已并入本页，其余细节去{" "}
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

      {/* ================= 开发进阶（附录）================= */}
      <section id="dev" className="scroll-mt-28 border-t border-dashed border-[rgba(0,0,0,0.1)] pt-8">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.66)]">开发进阶（附录）</h2>
        </div>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          给要把生成能力接进自己系统的开发者：B 端 API，与助理同一套生成核心、同一套计费与失败语义。
        </p>
        <p className="mt-2 text-ios-caption1 text-[rgba(0,0,0,0.46)]">
          {spec
            ? `${toSimplified(spec.info.title)} · v${spec.info.version} · OpenAPI ${spec.openapi}`
            : "以下端点目录从 OpenAPI spec 动态渲染，与线上行为保持一致。"}
        </p>

        <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="grid gap-6 p-5 sm:grid-cols-3 sm:gap-8 sm:p-7">
            <div>
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">Base URL</p>
              </div>
              <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
                https://eimu.dev/v1
              </code>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">认证</p>
              </div>
              <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
                Authorization: Bearer sk-biz-&lt;key&gt;
              </code>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#007AFF]" />
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">限流</p>
              </div>
              <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                60 requests/min，认证通过的回应带 x-ratelimit-* 头。
              </p>
            </div>
          </div>
        </section>

        <section className="mt-6">
          <SectionTitle icon={Gauge}>快速开始（异步三步）</SectionTitle>
          <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            先设两个变量，后续命令都复用它：
          </p>
          <div className="mt-3 max-w-2xl">
            <CodeBlock>{SETUP}</CodeBlock>
          </div>
        </section>

        <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="列出可用模型"
              note={
                <>
                  <InlineCode>GET {"$BASE"}/models</InlineCode>
                  返回全站支持的模型，每个带私有单价字段 <InlineCode>x_coins_per_image</InlineCode>
                  ；你调用的模型须在该 key 的白名单内，否则回 403。
                </>
              }
              code={STEP1}
            />
            <Step
              n="2"
              title="提交生成任务"
              note={
                <>
                  <InlineCode>POST {"$BASE"}/images/generations</InlineCode>{" "}
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">永远</strong>先回 202 与一个 task_id，
                  不在同一响应里给图。
                </>
              }
              code={STEP2}
            />
            <Step
              n="3"
              title="轮询到 succeeded"
              note={
                <>
                  用 task_id 轮询 <InlineCode>{"$BASE"}/images/{"{id}"}</InlineCode>，3~5 秒一次直到状态变为
                  succeeded——该回应已内嵌 <InlineCode>data[]</InlineCode>，直接读{" "}
                  <InlineCode>data[0].url</InlineCode> 即成品（<InlineCode>/result</InlineCode>{" "}
                  只是便捷入口）。轮询不消耗限流额度，实测 15~20 秒出图。
                </>
              }
              code={STEP3}
            />
          </div>
        </section>

        <p className="mt-4 max-w-3xl rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          <strong className="font-semibold text-[rgba(0,0,0,0.72)]">契约要点：</strong>
          所有生成端点都是异步提交＋轮询；错误体为 OpenAI 形状并带 <InlineCode>trace_id</InlineCode>（值同{" "}
          <InlineCode>X-Request-Id</InlineCode> 头）；支持 <InlineCode>Idempotency-Key</InlineCode>（同键同体放回同一
          task，可安全重试）与 <InlineCode>callback_url</InlineCode>（终态 webhook 回调，轮询仍是兜底）。
        </p>

        {error ? (
          <section className="rounded-ios-3xl bg-[rgba(0,0,0,0.04)] p-5 text-ios-body text-[rgba(0,0,0,0.58)]">
            无法载入 OpenAPI spec：{error}
          </section>
        ) : !spec ? (
          <div className="mt-6 space-y-3">
            <div className="skeleton h-5 w-40 rounded-full" />
            <div className="skeleton h-40 w-full rounded-ios-2xl" />
          </div>
        ) : (
          <>
            <nav id="endpoint-catalog" aria-label="API 端点目录" className="mt-8 scroll-mt-28">
              <p className="px-1 pb-2 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">端点目录</p>
              <ol className="flex flex-wrap gap-1.5">
                {entries.map(([path]) => (
                  <li key={path}>
                    <a
                      href={`#endpoint-${encodeURIComponent(path)}`}
                      className="inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-footnote font-medium text-[#007AFF] lg-transition hover:bg-[rgba(0,122,255,0.14)]"
                    >
                      <span className="font-mono">{path}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
              <Specular />
              <div className="divide-y divide-[rgba(0,0,0,0.06)]">
                {entries.map(([path, methods]) =>
                  Object.entries(methods).map(([method, operation]) => (
                    <section
                      key={`${method}-${path}`}
                      id={`endpoint-${encodeURIComponent(path)}`}
                      className="scroll-mt-28 p-5 sm:p-7"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-ios-caption1 font-bold uppercase tracking-wide ${METHOD_COLORS[method] ?? "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.66)]"}`}
                        >
                          {method}
                        </span>
                        <code className="font-mono text-ios-footnote font-semibold text-[#242830]">/v1{path}</code>
                        {operation.operationId ? (
                          <span className="text-ios-caption1 text-[rgba(0,0,0,0.46)]">{operation.operationId}</span>
                        ) : null}
                      </div>

                      {operation.summary ? (
                        <h3 className="mt-3 text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
                          {toSimplified(operation.summary)}
                        </h3>
                      ) : null}

                      {operation.description ? (
                        <p className="mt-2 whitespace-pre-line text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                          {toSimplified(operation.description)}
                        </p>
                      ) : null}

                      {(operation.parameters?.length ?? 0) > 0 ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">参数</p>
                          <ul className="mt-2 space-y-1">
                            {operation.parameters?.map((param) => (
                              <li key={param.name} className="flex flex-wrap items-baseline gap-2 text-ios-footnote">
                                <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">
                                  {param.name}
                                </code>
                                <span className="text-[rgba(0,0,0,0.52)]">{param.in}</span>
                                {param.required ? (
                                  <span className="font-semibold text-[#D92A20]">必填</span>
                                ) : (
                                  <span className="text-[rgba(0,0,0,0.46)]">可选</span>
                                )}
                                {param.description ? (
                                  <span className="text-[rgba(0,0,0,0.58)]">{toSimplified(param.description)}</span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {operation.requestBody?.content ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">请求体</p>
                          <code className="mt-1 inline-block rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-ios-footnote text-[#242830]">
                            {schemaName(operation.requestBody.content["application/json"]?.schema?.$ref)}
                          </code>
                        </div>
                      ) : null}

                      {operation.responses ? (
                        <div className="mt-4">
                          <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">响应</p>
                          <ul className="mt-2 flex flex-wrap gap-2">
                            {Object.entries(operation.responses).map(([status, response]) => (
                              <li
                                key={status}
                                className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.62)]"
                                title={toSimplified(response.description ?? "")}
                              >
                                <span className="font-mono font-semibold text-[#242830]">{status}</span>
                                {response.description ? (
                                  <span>{toSimplified(response.description)}</span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </section>
                  )),
                )}
              </div>
            </section>

            <section className="pt-1">
              <p className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">OpenAPI Spec</p>
              <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                完整机器可读 spec（含请求/响应 schema 定义）：
              </p>
              <a
                href="/api/v1/openapi.json"
                className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#007AFF] px-4 py-2.5 text-ios-body font-semibold text-white transition-colors hover:bg-[#0066DD]"
              >
                下载 /api/v1/openapi.json
              </a>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
