import type { Metadata } from "next";
import Link from "next/link";
// tsx（仓库测试运行器）走 classic JSX 转译，renderToStaticMarkup 真渲染必须有 React 在作用域内
// （同 src/app/mcp/page.tsx 的既有做法；Next 构建走自动 runtime，多的这行无害）。
import * as React from "react";
import {
  AGENT_SKILLS,
  AGENT_SKILL_FAMILIES,
  AGENT_SKILL_FAMILY_LABELS,
  countAgentSkillsByFamily,
  listAgentSkills,
} from "@/lib/agent-skills";
import type { AgentSkillFamily } from "@/lib/agent-skills/types";
import { OUTPUT_KIND_LABELS } from "@/lib/agent-skills/output-kinds";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const SITE_URL = getSiteUrlFromEnv();
const TITLE = "技能库：浏览 Eimu 的全部内建创作技能";
const DESCRIPTION = `把 Eimu 的 ${AGENT_SKILLS.length} 条内建创作技能摊开成目录：按 ${AGENT_SKILL_FAMILIES.length} 个题材家族筛选，每条技能写清适用场景、输入面、交付物与可调用工具。只读内建技能，没有用户发布内容。`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/skills` },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/skills` },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};


/** 只接受权威家族枚举里的值；未知 / 重复的 query 一律当「全部」。 */
function readFamily(value: string | string[] | undefined): AgentSkillFamily | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  return (AGENT_SKILL_FAMILIES as readonly string[]).includes(raw) ? (raw as AgentSkillFamily) : undefined;
}

function pillClass(active: boolean): string {
  return [
    "lg-float inline-flex items-center gap-1 rounded-full px-3.5 py-2 text-ios-footnote font-medium lg-transition",
    active ? "text-[#007AFF]" : "text-[rgba(0,0,0,0.68)] hover:text-[#007AFF]",
  ].join(" ");
}

interface SkillsIndexProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SkillsIndexPage({ searchParams }: SkillsIndexProps) {
  const params = (await searchParams) ?? {};
  const activeFamily = readFamily(params.family);
  const skills = listAgentSkills(activeFamily ? { family: activeFamily } : {});
  const counts = countAgentSkillsByFamily();

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">技能库</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            把 Eimu 会做的事，一条条摊开
          </h1>
          <p className="mt-3 max-w-3xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            这里是 Eimu 的全部内建创作技能：{AGENT_SKILLS.length} 条，分 {AGENT_SKILL_FAMILIES.length} 个题材家族。
            每条都写清「什么场景、要你给什么、交付什么、能调用哪些工具」。这是只读目录——所有字段都来自同一份内建定义，
            站内不提供用户发布，所以这里不会出现别人的技能。
          </p>
        </header>

        <nav aria-label="按题材家族筛选" className="mb-4 flex flex-wrap gap-2">
          <Link href="/skills" className={pillClass(activeFamily === undefined)}>
            全部 {AGENT_SKILLS.length}
          </Link>
          {AGENT_SKILL_FAMILIES.map((family) => (
            <Link
              key={family}
              href={`/skills?family=${family}`}
              className={pillClass(activeFamily === family)}
            >
              {AGENT_SKILL_FAMILY_LABELS[family]} {counts[family]}
            </Link>
          ))}
        </nav>

        <p className="mb-4 text-ios-caption1 text-[rgba(0,0,0,0.5)]">
          当前显示 {skills.length} 条
          {activeFamily ? ` · 题材家族「${AGENT_SKILL_FAMILY_LABELS[activeFamily]}」` : ""}
        </p>

        {skills.length === 0 ? (
          <p className="lg-card rounded-ios-3xl p-5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            这个家族暂时还没有技能。
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => (
              <li key={skill.id}>
                <Link
                  href={`/skills/${skill.id}`}
                  data-skill-id={skill.id}
                  className="lg-card flex h-full flex-col rounded-ios-3xl p-4 lg-transition"
                >
                  <span className="flex flex-wrap items-center gap-1.5 text-ios-caption1">
                    <span className="rounded-full bg-[rgba(0,122,255,0.10)] px-2 py-0.5 font-semibold text-[#007AFF]">
                      {AGENT_SKILL_FAMILY_LABELS[skill.family]}
                    </span>
                    <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2 py-0.5 text-[rgba(0,0,0,0.5)]">
                      {OUTPUT_KIND_LABELS[skill.outputKind]}
                    </span>
                  </span>
                  <span className="mt-2 text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">
                    {skill.name}
                  </span>
                  <span className="mt-1.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                    {skill.oneLiner}
                  </span>
                  <span className="mt-3 flex flex-wrap gap-1.5">
                    {skill.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-[rgba(0,0,0,0.04)] px-2 py-0.5 text-ios-caption1 text-[rgba(0,0,0,0.5)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                  <span className="mt-auto pt-3 text-ios-caption1 font-semibold text-[#007AFF]">查看详情</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
