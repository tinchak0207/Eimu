import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CheckCircle2 } from "lucide-react";
import { USE_CASES, getUseCase, relatedUseCases } from "@/lib/use-cases";
import { getSiteUrl } from "@/lib/site-url";

type RouteParams = { params: Promise<{ slug: string }> };

// 動態渲染以支援雙域名 runtime 檢測（不走靜態生成）
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return USE_CASES.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const useCase = getUseCase(slug);
  if (!useCase) return {};

  const siteUrl = await getSiteUrl();
  const title = `${useCase.title} | Eimu`;
  const description = useCase.heroDescription.slice(0, 120);

  const canonicalUrl = `${siteUrl}/use-cases/${useCase.slug}`;

  return {
    title,
    description,
    keywords: [
      useCase.keyword,
      ...(useCase.searchVariants ?? []),
      "AI生图",
      "GPT Image 2",
      "Nano Banana Pro",
    ],
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
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

export default async function UseCasePage({ params }: RouteParams) {
  const { slug } = await params;
  const useCase = getUseCase(slug);
  if (!useCase) notFound();

  const siteUrl = await getSiteUrl();
  const related = relatedUseCases(useCase);

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
    dateModified: "2026-08-15",
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

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <div className="mx-auto w-full max-w-4xl">
        <Link
          href="/"
          className="lg-float mb-5 inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] lg-transition hover:text-[rgba(0,0,0,0.82)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
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
            className="mt-5 inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-3 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.30)] transition-colors hover:bg-[#0066DD] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2"
          >
            开始生成
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </header>

        <section className="lg-card relative overflow-hidden rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">这个场景卡在哪里</h2>
          <div className="mt-4 grid gap-3">
            {useCase.painPoints.map((point) => (
              <p key={point} className="flex gap-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#34C759]" />
                {point}
              </p>
            ))}
          </div>
        </section>

        <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">数据说话</h2>
          <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">{useCase.statInsight}</p>
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
          <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">Reddit 用户怎么描述这个问题</h2>
            <p className="mt-2 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.46)]">
              以下是公开社区讨论的定性样本，不是搜索量统计，也不代表所有用户都能得到相同结果。
            </p>
            <div className="mt-4 grid gap-3">
              {useCase.redditEvidence.map((evidence) => (
                <article key={evidence.url} className="rounded-ios-2xl bg-[rgba(255,255,255,0.42)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]">
                  <a href={evidence.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ios-footnote font-semibold text-[#007AFF] underline-offset-2 hover:underline">
                    {evidence.title}
                  </a>
                  <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">{evidence.quote}</p>
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
          <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">按这个顺序做</h2>
            <ol className="mt-4 grid gap-3">
              {useCase.workflowSteps.map((step, index) => (
                <li key={step} className="flex gap-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-ios-caption1 font-semibold text-[#007AFF]">{index + 1}</span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {useCase.fitBoundary && (
          <section className="mt-4 rounded-ios-3xl border border-[rgba(255,149,0,0.20)] bg-[rgba(255,149,0,0.07)] p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">适用边界</h2>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">{useCase.fitBoundary}</p>
          </section>
        )}

        {useCase.searchVariants && useCase.searchVariants.length > 0 && (
          <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">相关搜索表达</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {useCase.searchVariants.map((variant) => (
                <span key={variant} className="rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-caption1 text-[rgba(0,0,0,0.62)]">{variant}</span>
              ))}
            </div>
          </section>
        )}

        <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">可以直接抄的提示词</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {useCase.promptExamples.map((example) => (
              <div key={example.title} className="rounded-ios-2xl bg-[rgba(255,255,255,0.42)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]">
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">{example.title}</p>
                <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{example.prompt}</p>
              </div>
            ))}
          </div>
        </section>

        {useCase.faqs.length > 0 && (
          <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">常见问题</h2>
            <div className="mt-4 grid gap-3">
              {useCase.faqs.map((faq) => (
                <details
                  key={faq.question}
                  className="group rounded-ios-2xl bg-[rgba(255,255,255,0.42)] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]"
                >
                  <summary className="cursor-pointer list-none text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
                    {faq.question}
                  </summary>
                  <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">关于 Eimu</h2>
          <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">
            {useCase.author.name} 是一站式 AI 图片与视频创作工作台，直接接入 GPT Image 2、Nano Banana Pro
            等主流模型。内容由 Eimu 团队基于模型能力与行业实践整理，引用来源已标注，供创作者参考。
          </p>
        </section>

        {related.length > 0 && (
          <section className="mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
            <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">相关场景</h2>
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
