import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
// tsx（仓库测试运行器）走 classic JSX 转译，renderToStaticMarkup 真渲染必须有 React 在作用域内
// （同 src/app/mcp/page.tsx 的既有做法；Next 构建走自动 runtime，多的这行无害）。
import * as React from "react";
import { AGENT_SKILLS, AGENT_SKILL_FAMILY_LABELS, getAgentSkill } from "@/lib/agent-skills";
import type { AgentSkillView } from "@/lib/agent-skills/registry";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { OUTPUT_KIND_LABELS } from "../page";

const SITE_URL = getSiteUrlFromEnv();

type RouteParams = { params: Promise<{ id: string }> };

/** 全部内建技能 id 静态生成，利于抓取；未知 id 由页面内的 notFound() 兜底。 */
export function generateStaticParams() {
  return AGENT_SKILLS.map((skill) => ({ id: skill.id }));
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { id } = await params;
  const skill = getAgentSkill(id);
  if (!skill) return {};

  const canonicalUrl = `${SITE_URL}/skills/${skill.id}`;
  const title = `${skill.name}｜Eimu 技能库`;
  const description = `${skill.oneLiner}。适用场景：${skill.useScenario}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: { title, description, url: canonicalUrl },
    twitter: { card: "summary_large_image", title, description },
  };
}

const sectionClass = "mt-4 lg-card rounded-ios-3xl p-5 sm:p-6";
const h2Class = "text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]";
const bodyClass = "text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]";
const tileClass =
  "rounded-ios-2xl bg-[rgba(255,255,255,0.42)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]";

export default async function SkillDetailPage({ params }: RouteParams) {
  const { id } = await params;
  const skill = getAgentSkill(id);
  if (!skill) notFound();
  return <SkillDetailView skill={skill} />;
}

/** 同步的展示层：只呈现 spec 里真有的字段，不补任何示例图 / 次数 / 评分 / 作者。 */
function SkillDetailView({ skill }: { skill: AgentSkillView }) {
  const familyLabel = AGENT_SKILL_FAMILY_LABELS[skill.family];
  const outputKindLabel = OUTPUT_KIND_LABELS[skill.outputKind];
  const facts: Array<{ term: string; value: string }> = [
    { term: "适用场景", value: skill.useScenario },
    { term: "你需要提供", value: skill.inputType },
    { term: "交付", value: skill.outputContent },
    { term: "交付形态", value: outputKindLabel },
  ];

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <nav aria-label="面包屑" className="mb-5">
          <ol className="lg-float inline-flex flex-wrap items-center gap-1 rounded-full px-3.5 py-2 text-ios-footnote text-[rgba(0,0,0,0.56)]">
            <li>
              <Link href="/" className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                首页
              </Link>
            </li>
            <li aria-hidden="true" className="opacity-60">
              /
            </li>
            <li>
              <Link href="/skills" className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                技能库
              </Link>
            </li>
            <li aria-hidden="true" className="opacity-60">
              /
            </li>
            <li aria-current="page" className="text-[rgba(0,0,0,0.78)]">
              {skill.name}
            </li>
          </ol>
        </nav>

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">
            {familyLabel} · {outputKindLabel}
          </p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            {skill.name}
          </h1>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            {skill.oneLiner}
          </p>
        </header>

        <section className={sectionClass}>
          <h2 className={h2Class}>这条技能怎么用</h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.term} className={tileClass}>
                <dt className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.5)]">{fact.term}</dt>
                <dd className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.72)]">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {skill.aesthetic ? (
          <section className={sectionClass}>
            <h2 className={h2Class}>美学锚</h2>
            <p className={`mt-2 ${bodyClass}`}>{skill.aesthetic}</p>
          </section>
        ) : null}

        <section className={sectionClass}>
          <h2 className={h2Class}>可调用的工具</h2>
          {skill.toolIds.length > 0 ? (
            <>
              <p className={`mt-2 ${bodyClass}`}>
                这条技能在 harness 里可以调用下面这些工具；工具名是机制层 id，不是模型名。
              </p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {skill.toolIds.map((toolId) => (
                  <li key={toolId}>
                    <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-ios-footnote text-[#242830]">
                      {toolId}
                    </code>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={`mt-2 ${bodyClass}`}>这条技能没有声明可调用的工具。</p>
          )}
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>标签与家族</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {skill.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.6)]"
              >
                {tag}
              </li>
            ))}
          </ul>
          <p className={`mt-5 ${bodyClass}`}>
            所属家族：
            <Link
              href={`/skills?family=${skill.family}`}
              className="font-semibold text-[#007AFF] lg-transition hover:underline"
            >
              {familyLabel}
            </Link>
          </p>
        </section>

        <section className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/skills"
            className="inline-flex items-center rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.30)] transition-colors hover:bg-[#0066DD]"
          >
            返回技能库
          </Link>
          <Link
            href="/"
            className="lg-float inline-flex items-center rounded-ios-xl px-4 py-2.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] lg-transition hover:text-[#007AFF]"
          >
            去工作台
          </Link>
        </section>
      </div>
    </main>
  );
}
