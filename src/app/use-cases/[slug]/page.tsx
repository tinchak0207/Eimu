import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowUpRight, CheckCircle2, ChevronRight } from "lucide-react";
import { USE_CASES, getUseCase, relatedUseCases, type UseCase } from "@/lib/use-cases";
import {
  USE_CASE_CATEGORIES,
  getUseCaseCategory,
  type UseCaseCategory,
} from "@/lib/use-case-categories";
import { getWorkflowCard } from "@/lib/workflow-pages";
import type { AgentTemplate } from "@/lib/agent-templates";
import { getSiteUrl } from "@/lib/site-url";

type RouteParams = { params: Promise<{ slug: string }> };

// 静态生成：行业枢纽页 + Reddit 深度指南页；未列出的 slug 直接 404。
export const dynamicParams = false;

export function generateStaticParams() {
  return [
    ...USE_CASE_CATEGORIES.map((category) => ({ slug: category.slug })),
    ...USE_CASES.map((item) => ({ slug: item.slug })),
  ];
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const siteUrl = await getSiteUrl();

  const category = getUseCaseCategory(slug);
  if (category) {
    const canonicalUrl = `${siteUrl}/use-cases/${category.slug}`;
    return {
      title: category.title,
      description: category.description,
      keywords: [category.keyword, category.name, ...category.scenarios.map((item) => item.searchKeyword)],
      alternates: { canonical: canonicalUrl },
      openGraph: {
        type: "article",
        title: category.title,
        description: category.description,
        url: canonicalUrl,
      },
      twitter: {
        card: "summary_large_image",
        title: category.title,
        description: category.description,
      },
    };
  }

  const useCase = getUseCase(slug);
  if (!useCase) return {};

  const canonicalUrl = `${siteUrl}/use-cases/${useCase.slug}`;
  const title = useCase.title;
  const description = useCase.heroDescription.slice(0, 120);

  return {
    title,
    description,
    keywords: [useCase.keyword, ...(useCase.searchVariants ?? []), "AI生图"],
    alternates: { canonical: canonicalUrl },
    openGraph: {
      type: "article",
      title,
      description,
      url: canonicalUrl,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

const sectionClass = "mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6";
const h2Class = "text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]";
const bodyClass = "text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]";
const tileClass =
  "rounded-ios-2xl bg-[rgba(255,255,255,0.42)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]";
const alertClass =
  "rounded-ios-2xl border border-[rgba(255,149,0,0.20)] bg-[rgba(255,149,0,0.07)] p-3.5";

function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

function Breadcrumbs({ items }: { items: { name: string; href?: string }[] }) {
  return (
    <nav aria-label="面包屑" className="mb-5">
      <ol className="lg-float inline-flex flex-wrap items-center gap-1 rounded-full px-3.5 py-2 text-ios-footnote text-[rgba(0,0,0,0.56)]">
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />}
            {item.href ? (
              <Link href={item.href} className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                {item.name}
              </Link>
            ) : (
              <span aria-current="page" className="text-[rgba(0,0,0,0.78)]">
                {item.name}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export default async function UseCaseLandingPage({ params }: RouteParams) {
  const { slug } = await params;

  const category = getUseCaseCategory(slug);
  if (category) return <UseCaseCategoryHub category={category} />;

  const useCase = getUseCase(slug);
  if (!useCase) notFound();

  return <UseCaseGuide useCase={useCase} />;
}

async function UseCaseCategoryHub({ category }: { category: UseCaseCategory }) {
  const siteUrl = await getSiteUrl();
  const pageUrl = `${siteUrl}/use-cases/${category.slug}`;

  const workflowCards = category.workflowSlugs
    .map((slug) => getWorkflowCard(slug))
    .filter((card): card is AgentTemplate => Boolean(card));
  const guideCards = category.relatedGuideSlugs
    .map((slug) => getUseCase(slug))
    .filter((item): item is UseCase => Boolean(item));
  const relatedCategories = category.relatedCategorySlugs
    .map((slug) => getUseCaseCategory(slug))
    .filter((item): item is UseCaseCategory => Boolean(item));

  const collectionData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: category.title,
    description: category.description,
    url: pageUrl,
    inLanguage: "zh-CN",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: category.scenarios.map((scenario, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: scenario.title,
        url: `${pageUrl}#${scenario.id}`,
      })),
    },
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "首页", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "场景指南", item: `${siteUrl}/use-cases` },
      { "@type": "ListItem", position: 3, name: category.name, item: pageUrl },
    ],
  };

  const faqData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: category.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <JsonLd data={collectionData} />
      <JsonLd data={breadcrumbData} />
      <JsonLd data={faqData} />

      <div className="mx-auto w-full max-w-4xl">
        <Breadcrumbs
          items={[
            { name: "首页", href: "/" },
            { name: "场景指南", href: "/use-cases" },
            { name: category.name },
          ]}
        />

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">{category.keyword}</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            {category.title}
          </h1>
          {category.intro.map((paragraph) => (
            <p key={paragraph} className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
              {paragraph}
            </p>
          ))}
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-3 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.30)] transition-colors hover:bg-[#0066DD] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2"
          >
            开始生成
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </header>

        {category.scenarios.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>本页内容</h2>
            <ol className="mt-3 grid gap-2 sm:grid-cols-2">
              {category.scenarios.map((scenario, index) => (
                <li key={scenario.id} className="text-ios-footnote">
                  <a
                    href={`#${scenario.id}`}
                    className="text-[rgba(0,0,0,0.62)] transition-colors hover:text-[#007AFF]"
                  >
                    {index + 1}. {scenario.title}
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}

        {category.scenarios.map((scenario) => (
          <section key={scenario.id} id={scenario.id} className={`${sectionClass} scroll-mt-24`}>
            <h2 className={h2Class}>{scenario.title}</h2>
            <p className="mt-2 text-ios-footnote font-semibold text-[#007AFF]">{scenario.searchKeyword}</p>
            {scenario.body.map((paragraph) => (
              <p key={paragraph} className={`mt-3 ${bodyClass}`}>
                {paragraph}
              </p>
            ))}

            {scenario.prompts.length > 0 && (
              <>
                <h3 className="mt-5 text-ios-headline font-semibold text-[rgba(0,0,0,0.78)]">可以直接抄的提示词</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {scenario.prompts.map((prompt) => (
                    <div key={prompt.title} className={tileClass}>
                      <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">{prompt.title}</p>
                      <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                        {prompt.prompt}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {scenario.pitfalls && scenario.pitfalls.length > 0 && (
              <div className={`mt-4 ${alertClass}`}>
                <p className="flex items-center gap-2 text-ios-footnote font-semibold text-[#FF9500]">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  容易翻车的地方
                </p>
                <ul className="mt-2 grid gap-2">
                  {scenario.pitfalls.map((pitfall) => (
                    <li key={pitfall} className={bodyClass}>
                      · {pitfall}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}

        {category.checklist.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>在 Eimu 里怎么做</h2>
            <ol className="mt-4 grid gap-3">
              {category.checklist.map((step, index) => (
                <li key={step} className={`flex gap-3 ${bodyClass}`}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-ios-caption1 font-semibold text-[#007AFF]">
                    {index + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {workflowCards.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>相关产线</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {workflowCards.map((card) => (
                <Link
                  key={card.id}
                  href={`/workflows/${card.id.replace(/^agent-/, "")}`}
                  className={`group flex flex-col gap-1 ${tileClass} transition`}
                >
                  <span className="flex items-center justify-between gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] group-hover:text-[#007AFF]">
                    {card.name}
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </span>
                  <span className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{card.note}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {guideCards.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>深度指南</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {guideCards.map((item) => (
                <Link
                  key={item.slug}
                  href={`/use-cases/${item.slug}`}
                  className="group flex items-center justify-between gap-2 rounded-ios-2xl bg-[rgba(255,255,255,0.42)] px-3.5 py-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.68)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)] transition hover:text-[#007AFF]"
                >
                  {item.tagline || item.title}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        )}

        {category.faqs.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>常见问题</h2>
            <div className="mt-4 grid gap-3">
              {category.faqs.map((faq) => (
                <details key={faq.question} className={`group ${tileClass} px-3.5 py-3`}>
                  <summary className="cursor-pointer list-none text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
                    {faq.question}
                  </summary>
                  <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        {relatedCategories.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>相关行业</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {relatedCategories.map((item) => (
                <Link
                  key={item.slug}
                  href={`/use-cases/${item.slug}`}
                  className={`group flex flex-col gap-1 ${tileClass} transition`}
                >
                  <span className="flex items-center justify-between gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] group-hover:text-[#007AFF]">
                    {item.name}
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </span>
                  <span className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{item.keyword}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

async function UseCaseGuide({ useCase }: { useCase: UseCase }) {
  const siteUrl = await getSiteUrl();
  const canonicalUrl = `${siteUrl}/use-cases/${useCase.slug}`;
  const category = useCase.categorySlug ? getUseCaseCategory(useCase.categorySlug) : undefined;
  const related = relatedUseCases(useCase);

  const crumbs: { name: string; href?: string }[] = [
    { name: "首页", href: "/" },
    { name: "场景指南", href: "/use-cases" },
  ];
  if (useCase.categorySlug && category) {
    crumbs.push({ name: category.name, href: `/use-cases/${useCase.categorySlug}` });
  }
  crumbs.push({ name: useCase.title });

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: useCase.title,
    description: useCase.heroDescription,
    keywords: [useCase.keyword, ...(useCase.searchVariants ?? [])].join(", "),
    citation: useCase.redditEvidence?.length
      ? useCase.redditEvidence.map((evidence) => evidence.url)
      : useCase.citation.url,
    author: {
      "@type": "Organization",
      name: useCase.author.name,
      url: useCase.author.url,
    },
    publisher: {
      "@type": "Organization",
      name: "Eimu",
      url: siteUrl,
    },
    datePublished: "2026-08-15",
    dateModified: "2026-09-27",
  };

  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: useCase.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };

  const breadcrumbStructuredData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: index === crumbs.length - 1 ? canonicalUrl : `${siteUrl}${crumb.href}`,
    })),
  };

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <JsonLd data={structuredData} />
      <JsonLd data={faqStructuredData} />
      <JsonLd data={breadcrumbStructuredData} />

      <div className="mx-auto w-full max-w-4xl">
        <Breadcrumbs items={crumbs} />

        <Link
          href="/"
          className="lg-float mb-5 inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] lg-transition hover:text-[rgba(0,0,0,0.82)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回生成器
        </Link>

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">{useCase.keyword}</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            {useCase.title}
          </h1>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            {useCase.heroDescription}
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-3 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.30)] transition-colors hover:bg-[#0066DD] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2"
          >
            开始生成
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </header>

        {useCase.categorySlug && category && (
          <section className={sectionClass}>
            <h2 className={h2Class}>所属行业</h2>
            <Link
              href={`/use-cases/${useCase.categorySlug}`}
              className={`group mt-4 flex flex-col gap-1 ${tileClass} transition`}
            >
              <span className="flex items-center justify-between gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] group-hover:text-[#007AFF]">
                {category.name}
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </span>
              <span className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{category.keyword}</span>
            </Link>
          </section>
        )}

        <section className={sectionClass}>
          <h2 className={h2Class}>这个场景卡在哪里</h2>
          <div className="mt-4 grid gap-3">
            {useCase.painPoints.map((point) => (
              <p key={point} className={`flex gap-2 ${bodyClass}`}>
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#34C759]" />
                {point}
              </p>
            ))}
          </div>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>数据说话</h2>
          <p className={`mt-3 ${bodyClass}`}>{useCase.statInsight}</p>
          <p className="mt-4 text-ios-caption2 text-[rgba(0,0,0,0.4)]">
            {useCase.citation.label}：{" "}
            <a
              href={useCase.citation.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline"
            >
              原文链接
            </a>
          </p>
        </section>

        {useCase.redditEvidence && useCase.redditEvidence.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>Reddit 用户怎么描述这个问题</h2>
            <p className="mt-2 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.46)]">
              以下是公开社区讨论的定性样本，不是搜索量统计，也不代表所有用户都能得到相同结果。
            </p>
            <div className="mt-4 grid gap-3">
              {useCase.redditEvidence.map((evidence) => (
                <article key={evidence.url} className={tileClass}>
                  <a
                    href={evidence.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-ios-footnote font-semibold text-[#007AFF] underline-offset-2 hover:underline"
                  >
                    {evidence.title}
                  </a>
                  <p className={`mt-2 ${bodyClass}`}>{evidence.quote}</p>
                  {(evidence.score !== undefined || evidence.comments !== undefined) && (
                    <p className="mt-2 text-ios-caption2 text-[rgba(0,0,0,0.4)]">
                      存档快照：{evidence.score !== undefined ? `${evidence.score} 分` : "未记录分数"}
                      {evidence.comments !== undefined ? ` · ${evidence.comments} 条评论` : ""}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {useCase.workflowSteps && useCase.workflowSteps.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>按这个顺序做</h2>
            <ol className="mt-4 grid gap-3">
              {useCase.workflowSteps.map((step, index) => (
                <li key={step} className={`flex gap-3 ${bodyClass}`}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-ios-caption1 font-semibold text-[#007AFF]">
                    {index + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {useCase.fitBoundary && (
          <section className="mt-4 rounded-ios-3xl border border-[rgba(255,149,0,0.20)] bg-[rgba(255,149,0,0.07)] p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className={h2Class}>适用边界</h2>
            <p className={`mt-3 ${bodyClass}`}>{useCase.fitBoundary}</p>
          </section>
        )}

        {useCase.searchVariants && useCase.searchVariants.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>相关搜索表达</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {useCase.searchVariants.map((variant) => (
                <span
                  key={variant}
                  className="rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-caption1 text-[rgba(0,0,0,0.62)]"
                >
                  {variant}
                </span>
              ))}
            </div>
          </section>
        )}

        <section className={sectionClass}>
          <h2 className={h2Class}>可以直接抄的提示词</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {useCase.promptExamples.map((example) => (
              <div key={example.title} className={tileClass}>
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">{example.title}</p>
                <p className={`mt-2 ${bodyClass}`}>{example.prompt}</p>
              </div>
            ))}
          </div>
        </section>

        {useCase.faqs.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>常见问题</h2>
            <div className="mt-4 grid gap-3">
              {useCase.faqs.map((faq) => (
                <details key={faq.question} className={`group ${tileClass} px-3.5 py-3`}>
                  <summary className="cursor-pointer list-none text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
                    {faq.question}
                  </summary>
                  <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        <section className={sectionClass}>
          <h2 className={h2Class}>关于 Eimu</h2>
          <p className={`mt-3 ${bodyClass}`}>
            Eimu 是一个从一句话到成片的 AI 影像工作台：文生图、图生图、扩图、放大、生视频、配音与剪辑在同一个入口完成，过程可见、可随时停止；角色与场景可以做成实体卡，跨镜头保持同一张脸。本文由 Eimu 团队基于模型能力与行业实践整理，引用来源已标注，供创作者参考。
          </p>
        </section>

        {related.length > 0 && (
          <section className={sectionClass}>
            <h2 className={h2Class}>相关场景</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {related.map((item) => (
                <Link
                  key={item.slug}
                  href={`/use-cases/${item.slug}`}
                  className="group flex items-center justify-between gap-2 rounded-ios-2xl bg-[rgba(255,255,255,0.42)] px-3.5 py-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.68)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)] transition hover:text-[#007AFF]"
                >
                  {item.tagline}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
