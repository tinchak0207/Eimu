import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { History } from "lucide-react";
import { InlineCode, SectionTitle, Specular, Step } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "历史素材复用 | 文档中心 | Eimu",
  alternates: { canonical: `${SITE_URL}/docs/history` },
};

export default function DocsHistoryPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>

      {/* ================= 历史素材复用 ================= */}
      <section id="history" className="scroll-mt-28">
        <SectionTitle icon={History}>历史素材复用</SectionTitle>
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
          重跑前会预检余额，不足时提示「余额不足，请先充值再重跑」——充值见〈
          <a
            href="/docs/billing"
            className="font-semibold text-[#007AFF] lg-transition hover:underline"
          >
            充值与计费
          </a>
          〉。
        </p>
      </section>
    </div>
  );
}
