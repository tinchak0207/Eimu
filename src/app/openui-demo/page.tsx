"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, Check, RotateCcw } from "lucide-react";
import { AgentMarkdown } from "@/components/agent-chat/AgentMarkdown";
import { AgentArtifactsProvider } from "@/components/agent-chat/agent-artifacts-context";
import { AgentChatSendProvider } from "@/components/agent-chat/agent-chat-send-context";
import type { AgentChatState } from "@/lib/agent-chat-types";
import { fillRichExample, RICH_EXAMPLES } from "@/lib/openui/rich-examples";

/**
 * OpenUI 成品展示层演示（2026-10-18 改造）：会话产物用演示条目模拟（真实公开素材 URL），
 * 组件只收 taskId，走与聊天完全相同的 AgentMarkdown → AgentOpenUIBlock → OpenUIArtifactSlot
 * → AgentImageCard / AgentVideoCard / AgentAudioCard 渲染链。
 */
const STORE = "https://store.tinchak0207.xyz/image-data/files/uploads";
const ALBUM_COVER = `${STORE}/media-1791379462314-gf50k0.png`;
// 演示会话数据（模拟 image/video/audio.done 已到达的条目）：模型/尺寸/扣费是演示夹具，
// 分辨率与时长由浏览器对真实素材实测。
const DEMO_ITEMS: AgentChatState["items"] = [
  { kind: "image", id: "demo-img-1", seq: 1, url: "/showcase/showcase1.webp", taskId: "task_demo_img_1", costCoins: 4, recipe: { model: "flux-pro", size: "1024x1536" } },
  { kind: "image", id: "demo-img-2", seq: 2, url: "/showcase/showcase2.webp", taskId: "task_demo_img_2", costCoins: 4, recipe: { model: "flux-pro", size: "1024x1536" } },
  { kind: "image", id: "demo-img-3", seq: 3, url: "/showcase/showcase3.webp", taskId: "task_demo_img_3", costCoins: 3, recipe: { model: "seedream", size: "1024x1536" } },
  { kind: "image", id: "demo-img-4", seq: 4, url: "/showcase/showcase4.webp", taskId: "task_demo_img_4", costCoins: 3, recipe: { model: "seedream", size: "1024x1536" } },
  { kind: "video", id: "demo-vid-1", seq: 1, url: "/showcase/agent-templates/drama-visual-2.mp4", taskId: "task_demo_vid_1", mediaKind: "film", costCoins: 60 },
  { kind: "video", id: "demo-vid-2", seq: 2, url: "/showcase/agent-templates/ecom-launch-2.mp4", taskId: "task_demo_vid_2" },
  { kind: "audio", id: "demo-aud-1", seq: 1, url: `${STORE}/media-1791378096227-27qm92.m4a`, taskId: "task_demo_aud_1", mediaKind: "music", title: "路灯下的行李", cover: ALBUM_COVER },
  { kind: "audio", id: "demo-aud-2", seq: 2, url: `${STORE}/media-1791378172616-fg77z2.m4a`, taskId: "task_demo_aud_2", mediaKind: "music", title: "六平米", cover: ALBUM_COVER },
  { kind: "audio", id: "demo-aud-3", seq: 3, url: `${STORE}/media-1791378246147-za04wv.m4a`, taskId: "task_demo_aud_3", mediaKind: "music", title: "像没发生过", cover: ALBUM_COVER },
];

const IMG_IDS = ["task_demo_img_1", "task_demo_img_2", "task_demo_img_3", "task_demo_img_4"];
const VID_IDS = ["task_demo_vid_1", "task_demo_vid_2"];
const AUD_IDS = ["task_demo_aud_1", "task_demo_aud_2", "task_demo_aud_3"];
const IDS_BY_KIND = { image: IMG_IDS, video: VID_IDS, audio: AUD_IDS } as const;

const WAVEFORM = `root = Card([hdr, song])
hdr = CardHeader("单曲", "波形预览")
song = AudioPlayer("task_demo_aud_2", "第二首", "waveform")`;

const MISSING = `root = Card([hdr, gallery])
hdr = CardHeader("缺失产物", "含一个不存在的 taskId")
gallery = ImageGallery(["task_demo_img_3", "task_fake_not_exist"], "不存在的那件应显示「产物未找到」", "grid")`;

// 模型手写数字/假数据回放：字面量徽章、排队 Callout、字面量表格与图表、未知工具 Query 全部被删。
const FAKE_NUMBERS = `root = Card([hdr, b1, c1, t1, q2, chart2, ok])
hdr = CardHeader("渲染完成", "假数字回放")
b1 = Badge("30 秒", "info")
c1 = Callout("info", "队列", "排队第 3 位，预计 2 分钟")
t1 = Table([Col("模型", ["A", "B"]), Col("耗时", [12, 30])])
q2 = Query("get_orders", {}, {rows: []})
vals = [1, 2, 3]
chart2 = BarChart(["a", "b", "c"], [Series("x", vals)])
ok = TextContent("只有这句说明应保留。")`;

// 旧版生产输出（控制台/表单）回放：新白名单下表单、表格、步骤、标签被整条删除，只剩标题与文本。
const LEGACY_CONSOLE = `root = Card([hdr, intro, tagA, statusCall, tbl, stepList, form, quick])
hdr = CardHeader("Eimu 创作控制台", "深色编辑风 · 完整交互面板")
intro = TextContent("一句话描述创意，选好风格与参数后提交，任务会自动回传。", "small")
tagA = Tag("高质模式", Icon("sparkles"), "sm", "info")
statusCall = Callout("success", "渲染队列正常", "3 个任务已完成，1 个排队中；提交新任务后可在下方追踪进度。")
tbl = Table([Col("模块", ["图像引擎", "视频引擎"], "string"), Col("计费", ["1 币 / 张", "按秒计价"], "string")])
stepList = Steps([StepsItem("① 定方向", "一句话描述创意与用途")])
form = Form("studio_form", formBtns, [fA])
formBtns = Buttons([Button("提交渲染", @ToAssistant("按当前参数开始渲染"), "primary")])
fA = FormControl("画面描述", inDesc)
inDesc = Input("desc", "霓虹雨夜的街角", "text")
quick = Buttons([Button("先给一句话方案", @ToAssistant("先给一句话方案"), "secondary")])`;

const SHORT_NAMES: Record<string, string> = {
  "delivery-gallery": "交付卡+画廊",
  album: "专辑",
  "ab-compare": "A/B 滑块",
  "process-timeline": "过程时间线",
  "series-masonry": "瀑布流+参数表",
  "blind-pick": "多图盲选",
};

const EXAMPLES = [
  ...RICH_EXAMPLES.map((ex) => ({ name: SHORT_NAMES[ex.key] ?? ex.title, source: fillRichExample(ex.code, IDS_BY_KIND[ex.kind]) })),
  { name: "单曲波形", source: WAVEFORM },
  { name: "缺失产物", source: MISSING },
  { name: "假数字回放（应被清理）", source: FAKE_NUMBERS },
  { name: "旧控制台回放（应被清理）", source: LEGACY_CONSOLE },
];

export default function OpenUIDemoPage() {
  const [selected, setSelected] = useState(0);
  const [payload, setPayload] = useState("");
  const [submissionCount, setSubmissionCount] = useState(0);
  const [revision, setRevision] = useState(0);
  const capture = useCallback((text: string) => {
    setPayload(text);
    setSubmissionCount((count) => count + 1);
  }, []);

  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground selection:bg-ios-blue/15 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft size={16} aria-hidden="true" />回到 Eimu
        </Link>
        <header className="mb-8 mt-5 max-w-3xl">
          <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">成品到手，界面自动长出来。</h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">OpenUI 只做成品展示层：画廊、盲选、视频交付、专辑、A/B 滑块、过程时间线。组件只认会话里的真实产物 taskId，查不到就显示「产物未找到」；徽章、表格、图表里的数字只来自 Query 读到的真实元数据。</p>
        </header>
        <div role="group" aria-label="选择演示内容" className="mb-6 flex flex-wrap gap-2">
          {EXAMPLES.map((example, index) => (
            <button type="button" key={example.name} aria-pressed={selected === index} onClick={() => { setSelected(index); setPayload(""); setSubmissionCount(0); }} className={`min-h-11 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === index ? "bg-primary text-primary-foreground" : "lg-float hover:bg-white"}`}>
              {example.name}
            </button>
          ))}
        </div>
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section aria-label={EXAMPLES[selected].name} className="min-w-0">
            <AgentChatSendProvider value={capture}>
              <AgentArtifactsProvider items={DEMO_ITEMS}>
                <AgentMarkdown key={`${selected}-${revision}`} text={["```openui", EXAMPLES[selected].source, "```"].join("\n")} onSend={capture} />
              </AgentArtifactsProvider>
            </AgentChatSendProvider>
          </section>
          <aside className="min-w-0 lg:sticky lg:top-6">
            <section className="lg-card relative overflow-hidden rounded-ios-xl p-5 sm:p-6" aria-labelledby="receipt-title">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              <h2 id="receipt-title" className="text-lg font-semibold">真实交互回执</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">这里只接收当前页面的点选回传（盲选、快选），不会启动制作或产生生成费用。</p>
              <div aria-live="polite" aria-atomic="true" className="mt-5">
                {payload ? <>
                  <p className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground"><Check size={16} aria-hidden="true" />已接收第 {submissionCount} 次回传</p>
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-ios-md bg-background p-4 font-mono text-sm leading-6 [overflow-wrap:anywhere]" data-openui-demo-payload="">{payload}</pre>
                </> : <p className="rounded-ios-md bg-background p-4 text-sm leading-6 text-muted-foreground">等待点选。在盲选或对比里点「选这个」。</p>}
              </div>
              <button type="button" onClick={() => { setRevision((value) => value + 1); setPayload(""); setSubmissionCount(0); }} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RotateCcw size={15} aria-hidden="true" />重置这份演示</button>
            </section>
            <details className="mt-5 rounded-ios-md border border-border px-4 py-2">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">查看正在渲染的声明</summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words pb-4 font-mono text-sm leading-6 [overflow-wrap:anywhere]">{EXAMPLES[selected].source}</pre>
            </details>
          </aside>
        </div>
      </div>
    </main>
  );
}
