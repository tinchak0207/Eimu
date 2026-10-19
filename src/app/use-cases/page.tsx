import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { USE_CASES } from "@/lib/use-cases";
import { USE_CASE_CATEGORIES, getUseCaseCategory } from "@/lib/use-case-categories";
import { WORKFLOW_PAGES, getWorkflowCard } from "@/lib/workflow-pages";
import { getSiteUrl } from "@/lib/site-url";

const TITLE = "AI 影像场景指南：17 个行业的做法与提示词";
const DESCRIPTION =
  "按行业整理 AI 影像的做法：17 个行业，每个行业拆成 6 个子场景，写清构图、光线、比例与材质标准，给出可直接复制的提示词，也列出常见翻车点与对策。要跑整套多步工序，去创作产线看。";

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await getSiteUrl();
  const canonicalUrl = `${siteUrl}/use-cases`;
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: canonicalUrl },
    openGraph: { title: TITLE, description: DESCRIPTION, url: canonicalUrl },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  };
}

export default async function UseCaseIndexPage() {
  const siteUrl = await getSiteUrl();

  const categories = USE_CASE_CATEGORIES;
  const workflows = WORKFLOW_PAGES.map((page) => ({
    page,
    card: getWorkflowCard(page.slug),
  })).filter((item) => Boolean(item.card));

  // 渲染前先滤掉 categorySlug 指向不存在行业的指南。
  const guides = USE_CASES.filter(
    (guide) => !guide.categorySlug || Boolean(getUseCaseCategory(guide.categorySlug)),
  );

  const guideGroups = categories
    .map((category) => ({
      key: category.slug,
      title: category.name,
      items: guides.filter((guide) => guide.categorySlug === category.slug),
    }))
    .filter((group) => group.items.length > 0);

  const uncategorized = guides.filter((guide) => !guide.categorySlug);
  if (uncategorized.length > 0) {
    guideGroups.push({ key: "other", title: "其他", items: uncategorized });
  }

  const collectionData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: TITLE,
    description: DESCRIPTION,
    url: `${siteUrl}/use-cases`,
    inLanguage: "zh-CN",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: categories.map((category, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: category.name,
        url: `${siteUrl}/use-cases/${category.slug}`,
      })),
    },
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "首页", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "场景指南", item: `${siteUrl}/use-cases` },
    ],
  };

  return (
    <main className="min-h-screen bg-transparent px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionData) }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <div className="mx-auto w-full max-w-5xl">
        <nav aria-label="面包屑" className="mb-5">
          <ol className="lg-float inline-flex items-center gap-1 rounded-full px-3.5 py-2 text-ios-footnote text-[rgba(0,0,0,0.56)]">
            <li>
              <Link href="/" className="font-medium lg-transition hover:text-[rgba(0,0,0,0.82)]">
                首页
              </Link>
            </li>
            <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
            <li aria-current="page" className="text-[rgba(0,0,0,0.78)]">
              场景指南
            </li>
          </ol>
        </nav>

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">场景指南</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            17 个行业的 AI 影像场景指南
          </h1>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            这里按行业整理 AI 影像的做法。每个行业一页，页内拆成 6 个子场景——比如电商商品图下的主图、白底图、场景图、细节图、多平台尺寸、新品预热图。每个子场景写清判断标准（构图、光线、比例、材质），给可以直接复制的提示词，也把常见的翻车点和对应的处理办法列出来。
          </p>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            单张图和一套工序是两件事。这里解决的是「这一类图到底该怎么做」；如果你要把小说改成片、把一套上市素材铺齐，或者给一部短剧做完投放封面，这些十几步的活去
            <Link href="/workflows" className="mx-1 font-medium text-[#007AFF] hover:underline">
              创作产线
            </Link>
            看，那里按环节拆好了。
          </p>
        </header>

        <section aria-labelledby="industry-hub-title" className="mt-8">
          <h2 id="industry-hub-title" className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
            按行业进入
          </h2>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.52)]">
            每个行业一页，6 个子场景，各有提示词与翻车点。
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((category) => (
              <Link
                key={category.slug}
                href={`/use-cases/${category.slug}`}
                className="group lg-card flex flex-col justify-between rounded-ios-3xl p-5 lg-transition hover:-translate-y-0.5"
              >
                <div>
                  <p className="text-ios-caption1 font-semibold text-[#007AFF]">{category.keyword}</p>
                  <h3 className="mt-2 text-ios-headline font-semibold leading-snug text-[rgba(0,0,0,0.85)] group-hover:text-[#007AFF]">
                    {category.name}
                  </h3>
                </div>
                <span className="mt-4 inline-flex items-center gap-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.5)] group-hover:text-[#007AFF]">
                  {category.scenarios.length} 个子场景
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section aria-labelledby="guide-list-title" className="mt-10">
          <h2 id="guide-list-title" className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
            深度指南
          </h2>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.52)]">
            单点问题的长文：一个提示词、一个坑，写透。
          </p>
          {guideGroups.map((group) => (
            <div key={group.key} className="mt-6">
              <h3 className="text-ios-headline font-semibold text-[rgba(0,0,0,0.78)]">{group.title}</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {group.items.map((guide) => (
                  <Link
                    key={guide.slug}
                    href={`/use-cases/${guide.slug}`}
                    className="group lg-card flex items-start justify-between gap-3 rounded-ios-2xl p-4 lg-transition hover:-translate-y-0.5"
                  >
                    <span className="flex flex-col gap-1">
                      <span className="text-ios-callout font-semibold leading-snug text-[rgba(0,0,0,0.85)] group-hover:text-[#007AFF]">
                        {guide.keyword}
                      </span>
                      <span className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.55)]">
                        {guide.tagline}
                      </span>
                    </span>
                    <ArrowUpRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(0,0,0,0.4)] group-hover:text-[#007AFF]"
                      aria-hidden="true"
                    />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section aria-labelledby="workflow-list-title" className="mt-10">
          <h2 id="workflow-list-title" className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
            创作产线
          </h2>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.52)]">
            十几步的活按环节拆好，关键处停下等你确认。
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {workflows.map(({ page, card }) => (
              <Link
                key={page.slug}
                href={`/workflows/${page.slug}`}
                className="group lg-card flex flex-col justify-between rounded-ios-3xl p-5 lg-transition hover:-translate-y-0.5"
              >
                <div>
                  <h3 className="text-ios-headline font-semibold text-[rgba(0,0,0,0.85)] group-hover:text-[#007AFF]">
                    {card!.name}
                  </h3>
                  <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                    {card!.note}
                  </p>
                </div>
                <span className="mt-4 inline-flex items-center gap-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.5)] group-hover:text-[#007AFF]">
                  查看产线
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
