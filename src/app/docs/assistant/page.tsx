import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { Settings2, Zap } from "lucide-react";
import { SectionTitle, Specular } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "助理设定与野兽模式 | 文档中心",
  alternates: { canonical: `${SITE_URL}/docs/assistant` },
};

// ---- 教学文案数据（现场逐字：与助理设定弹层 / 输入区思考级别菜单同文案）----

const SETTING_ROWS: Array<{ name: string; plain: string; options: Array<{ k: string; v: string }> }> = [
  {
    name: "思考级别",
    plain: "在输入框左下角「+」的右上角切换：一句话要多想、多省、是否开启野兽模式。",
    options: [
      { k: "低", v: "更快、更省，适合简单需求" },
      { k: "中（默认）", v: "速度与质量兼顾" },
      { k: "高", v: "先充分思考再动手，更全面" },
      { k: "极限", v: "最高质量、开启野兽模式（见下）" },
    ],
  },
  {
    name: "互动模式",
    plain: "干活路上它多久问你一次。",
    options: [
      { k: "协作", v: "协作：剧本/资产/分镜三步停下等你确认，确认后自动续跑，其余环节自动" },
      { k: "预设", v: "预设：一次整包授权，一路跑完，只有扣费与关键决策拦你" },
      { k: "自动", v: "自动：一键发送直出结果，连扣费确认都自动放行，全程不问你" },
    ],
  },
];

export default function DocsAssistantPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>

      {/* ================= 助理设定 ================= */}
      <section id="settings" className="scroll-mt-28">
        <SectionTitle icon={Settings2}>助理设定与思考级别</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          设定分两处：右上角齿轮里有「我的技能」和「互动模式」；输入框左下角「+」的右上角是「思考级别」。逐项讲清楚各在管什么：
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
                  思考级别选到「极限」时开启
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <p className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[rgba(0,0,0,0.44)]">常规档（低/中/高）的它，只是轻声建议：</span>
                  「大部分场合不需要开启，留给真正硬核的点子」
                </p>
                <p className="rounded-ios-2xl bg-[rgba(175,82,222,0.08)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                  <span className="mb-1 block text-ios-caption1 font-semibold text-[#9B3FBF]">选到极限档以后：</span>
                  「模型使用所有工具协助，拼尽全力达到最完美的效果，满足追求极限的你」
                </p>
              </div>
              <p className="mt-5 text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">它到底干了什么</p>
              <ol className="mt-2.5 space-y-2.5">
                <li className="rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                  <span className="mr-1.5 font-semibold text-[rgba(0,0,0,0.72)]">常规档（低/中/高）：</span>
                  一位全能工匠独立干活——选模型、写提示词、生成、交付都它自己来，快、便宜，适合一张图、一段视频、微调。
                </li>
                <li className="rounded-ios-2xl bg-[rgba(175,82,222,0.06)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.66)]">
                  <span className="mr-1.5 font-semibold text-[#9B3FBF]">极限档：</span>
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
                先在思考级别里选到「极限」，拿示例句「生成秦始皇骑北极熊的大电影」试一次，看看它全力干活的样子。
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
