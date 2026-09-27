import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, CheckCircle2, ChevronRight, XCircle } from "lucide-react";
import { AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";
import { WORKFLOW_PAGES, getWorkflowCard, getWorkflowPage } from "@/lib/workflow-pages";
import { getSiteUrl } from "@/lib/site-url";

type RouteParams = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return WORKFLOW_PAGES.map((page) => ({ slug: page.slug }));
}

const PUBLISHED = "2026-09-27";

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const page = getWorkflowPage(slug);
  const card = getWorkflowCard(slug);
  if (!page || !card) return {};

  const siteUrl = await getSiteUrl();
  const canonicalUrl = `${siteUrl}/workflows/${page.slug}`;
  const images = card.showcaseImage
    ? [{ url: `${siteUrl}${card.showcaseImage}`, alt: page.media.alt }]
    : undefined;

  return {
    title: page.title,
    description: page.description,
    keywords: [page.keyword, ...page.searchVariants],
    alternates: { canonical: canonicalUrl },
    openGraph: {
      type: "article",
      title: page.title,
      description: page.description,
      url: canonicalUrl,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
      images: images?.map((image) => image.url),
    },
  };
}

const sectionClass = "mt-4 lg-card rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6";
const h2Class = "text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]";
const bodyClass = "text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]";
const tileClass =
  "rounded-ios-2xl bg-[rgba(255,255,255,0.42)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]";

function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export default async function WorkflowPage({ params }: RouteParams) {
  const { slug } = await params;
  const page = getWorkflowPage(slug);
  const card = getWorkflowCard(slug);
  if (!page || !card) notFound();

  const siteUrl = await getSiteUrl();
  const pageUrl = `${siteUrl}/workflows/${page.slug}`;
  const imageUrl = card.showcaseImage ? `${siteUrl}${card.showcaseImage}` : undefined;
  const steps = card.pipeline.steps.map((step, index) => ({ ...step, ...page.steps[index] }));
  const related = page.relatedWorkflows
    .map((relatedSlug) => ({ page: getWorkflowPage(relatedSlug), card: getWorkflowCard(relatedSlug) }))
    .filter((item): item is { page: NonNullable<typeof item.page>; card: NonNullable<typeof item.card> } =>
      Boolean(item.page && item.card),
    );

  const howToData = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: page.h1,
    description: page.description,
    inLanguage: "zh-CN",
    ...(imageUrl ? { image: imageUrl } : {}),
    step: steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: `${step.does} 交付：${step.output}`,
      url: `${pageUrl}#step-${index + 1}`,
    })),
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "首页", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "创作产线", item: `${siteUrl}/workflows` },
      { "@type": "ListItem", position: 3, name: card.name, item: pageUrl },
    ],
  };

  const faqData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };

  const videoData =
    card.showcaseVideo && imageUrl
      ? {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          name: `${card.name}产线方向参考片段`,
          description: page.media.caption,
          thumbnailUrl: imageUrl,
          contentUrl: `${siteUrl}${card.showcaseVideo}`,
          uploadDate: PUBLISHED,
          inLanguage: "zh-CN",
        }
      : null;

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <JsonLd data={howToData} />
      <JsonLd data={breadcrumbData} />
      <JsonLd data={faqData} />
      {videoData && <JsonLd data={videoData} />}

      <div className="mx-auto w-full max-w-4xl">
        <nav aria-label="面包屑" className="mb-5">
          <ol className="lg-float inline-flex flex-wrap items-center gap-1 rounded-full px-3.5 py-2 text-ios-footnote text-[rgba(0,0,0,0.56)]">
            <li>
              <Link href="/" className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                首页
              </Link>
            </li>
            <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
            <li>
              <Link href="/workflows" className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                创作产线
              </Link>
            </li>
            <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
            <li aria-current="page" className="text-[rgba(0,0,0,0.78)]">
              {card.name}
            </li>
          </ol>
        </nav>

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">
            {AGENT_TEMPLATE_DOMAIN_LABELS[card.domain]}产线 · {page.keyword}
          </p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            {page.h1}
          </h1>
          {page.intro.map((paragraph) => (
            <p key={paragraph} className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
              {paragraph}
            </p>
          ))}
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-3 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.30)] transition-colors hover:bg-[#0066DD] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2"
          >
            打开工作台，用「{card.name}」开工
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </header>

        {(card.showcaseVideo || card.showcaseImage) && (
          <figure className="lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
            {card.showcaseVideo ? (
              <video
                className="aspect-video w-full bg-black object-cover"
                muted
                loop
                playsInline
                autoPlay
                preload="metadata"
                poster={card.showcaseImage}
                aria-label={page.media.alt}
              >
                <source src={card.showcaseVideo} type="video/mp4" />
                {card.showcaseImage && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.showcaseImage} alt={page.media.alt} />
                )}
              </video>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.showcaseImage} alt={page.media.alt} className="aspect-video w-full object-cover" />
            )}
            <figcaption className="px-4 py-3 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.5)] sm:px-6">
              {page.media.caption}
            </figcaption>
          </figure>
        )}

        <section className={sectionClass}>
          <h2 className={h2Class}>这条产线做什么</h2>
          <p className={`mt-2 ${bodyClass}`}>
            {card.pipeline.summary}。共 {steps.length} 个环节：
            {steps.map((step) => step.shortName).join(" → ")}。
          </p>
          <ol className="mt-4 grid gap-3">
            {steps.map((step, index) => (
              <li key={step.name} id={`step-${index + 1}`} className={tileClass}>
                <h3 className="flex items-center gap-2 text-ios-headline font-semibold text-[rgba(0,0,0,0.8)]">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-ios-caption1 font-semibold text-[#007AFF]">
                    {index + 1}
                  </span>
                  {step.name}
                </h3>
                <p className={`mt-2 ${bodyClass}`}>{step.does}</p>
                <dl className="mt-3 grid gap-2 text-ios-footnote leading-relaxed sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-[rgba(0,0,0,0.7)]">输入</dt>
                    <dd className="text-[rgba(0,0,0,0.58)]">{step.input}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[rgba(0,0,0,0.7)]">交付</dt>
                    <dd className="text-[rgba(0,0,0,0.58)]">{step.output}</dd>
                  </div>
                  {step.checkpoint && (
                    <div className="sm:col-span-2">
                      <dt className="font-semibold text-[#007AFF]">人工确认点</dt>
                      <dd className="text-[rgba(0,0,0,0.58)]">{step.checkpoint}</dd>
                    </div>
                  )}
                  {step.pitfall && (
                    <div className="sm:col-span-2">
                      <dt className="font-semibold text-[#FF9500]">容易翻车的地方</dt>
                      <dd className="text-[rgba(0,0,0,0.58)]">{step.pitfall}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ol>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>适合谁 / 不适合谁</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-3">
              {page.fitFor.map((item) => (
                <p key={item} className={`flex gap-2 ${bodyClass}`}>
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#34C759]" aria-hidden="true" />
                  {item}
                </p>
              ))}
            </div>
            <div className="grid content-start gap-3">
              {page.notFitFor.map((item) => (
                <p key={item} className={`flex gap-2 ${bodyClass}`}>
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#FF3B30]" aria-hidden="true" />
                  {item}
                </p>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-ios-3xl border border-[rgba(255,149,0,0.20)] bg-[rgba(255,149,0,0.07)] p-4 sm:rounded-ios-4xl sm:p-6">
          <h2 className={h2Class}>目前做不到或要注意的</h2>
          <ul className="mt-3 grid gap-2">
            {page.limits.map((item) => (
              <li key={item} className={bodyClass}>
                · {item}
              </li>
            ))}
          </ul>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>怎么开始</h2>
          <ol className="mt-4 grid gap-3">
            {page.start.map((item, index) => (
              <li key={item} className={`flex gap-3 ${bodyClass}`}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-ios-caption1 font-semibold text-[#007AFF]">
                  {index + 1}
                </span>
                <span className="pt-0.5">{item}</span>
              </li>
            ))}
          </ol>
          <h3 className="mt-5 text-ios-headline font-semibold text-[rgba(0,0,0,0.78)]">可以直接说的愿望</h3>
          <div className="mt-3 grid gap-3">
            {page.sampleWishes.map((wish) => (
              <p key={wish} className={`${tileClass} ${bodyClass}`}>
                {wish}
              </p>
            ))}
          </div>
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-semibold text-white transition-colors hover:bg-[#0066DD]"
          >
            去首页点「{card.name}」
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>和手工流程比，省在哪里</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {page.savings.map((saving) => (
              <div key={saving.title} className={tileClass}>
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">{saving.title}</p>
                <p className={`mt-2 ${bodyClass}`}>{saving.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>常见问题</h2>
          <div className="mt-4 grid gap-3">
            {page.faqs.map((faq) => (
              <details key={faq.question} className={`group ${tileClass} px-3.5 py-3`}>
                <summary className="cursor-pointer list-none text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
                  {faq.question}
                </summary>
                <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>相关产线</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {related.map((item) => (
              <Link
                key={item.page.slug}
                href={`/workflows/${item.page.slug}`}
                className={`group flex flex-col gap-1 ${tileClass} transition hover:text-[#007AFF]`}
              >
                <span className="flex items-center justify-between gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] group-hover:text-[#007AFF]">
                  {item.card.name}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </span>
                <span className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{item.card.note}</span>
              </Link>
            ))}
          </div>
          <h3 className="mt-5 text-ios-headline font-semibold text-[rgba(0,0,0,0.78)]">相关行业</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {page.relatedHubs.map((hub) => (
              <Link
                key={hub.slug}
                href={`/use-cases/${hub.slug}`}
                className={`group flex flex-col gap-1 ${tileClass} transition`}
              >
                <span className="flex items-center justify-between gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)] group-hover:text-[#007AFF]">
                  {hub.label}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </span>
                <span className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{hub.reason}</span>
              </Link>
            ))}
          </div>
          <Link
            href="/workflows"
            className="mt-5 inline-flex items-center gap-1 text-ios-footnote font-medium text-[#007AFF] hover:underline"
          >
            查看全部 {WORKFLOW_PAGES.length} 条创作产线
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </section>
      </div>
    </main>
  );
}
