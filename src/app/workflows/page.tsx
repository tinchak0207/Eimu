import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { AGENT_TEMPLATE_DOMAIN_LABELS, type AgentTemplateDomain } from "@/lib/agent-templates";
import { WORKFLOW_PAGES, getWorkflowCard } from "@/lib/workflow-pages";
import { getSiteUrl } from "@/lib/site-url";

const TITLE = "AI 创作产线：小说、电商、短剧、艺术 8 条流水线";
const DESCRIPTION =
  "8 条可直接开跑的 AI 创作产线：小说转视频、网文 IP 视觉包、电商新品素材、AI 模特试穿、短剧分镜与投放海报、系列作品策展、艺术家风格研究。每条都拆成可见环节，关键处停下等你确认。";

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await getSiteUrl();
  const canonicalUrl = `${siteUrl}/workflows`;
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: canonicalUrl },
    openGraph: { title: TITLE, description: DESCRIPTION, url: canonicalUrl },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  };
}

const DOMAIN_ORDER: AgentTemplateDomain[] = ["novel", "ecommerce", "shortdrama", "art"];

const DOMAIN_INTRO: Record<AgentTemplateDomain, string> = {
  novel: "从文字出发：把章节变成镜头，或把一部网文的世界观变成整套可用的视觉物料。",
  ecommerce: "从商品出发：先把商品本身锁住，再往外铺场景、模特和各平台尺寸。",
  shortdrama: "从剧本出发：一条管到开拍前的视觉对齐，一条管上线后的投放封面。",
  art: "从主题或艺术家出发：解决系列作品越画越散，以及学风格只学到表面的问题。",
};

export default async function WorkflowsIndexPage() {
  const siteUrl = await getSiteUrl();
  const items = WORKFLOW_PAGES.map((page) => ({ page, card: getWorkflowCard(page.slug)! }));

  const collectionData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: TITLE,
    description: DESCRIPTION,
    url: `${siteUrl}/workflows`,
    inLanguage: "zh-CN",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: item.card.name,
        url: `${siteUrl}/workflows/${item.page.slug}`,
      })),
    },
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "首页", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "创作产线", item: `${siteUrl}/workflows` },
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
              创作产线
            </li>
          </ol>
        </nav>

        <header className="mb-6">
          <p className="text-ios-footnote font-semibold text-[#007AFF]">创作产线</p>
          <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            8 条 AI 创作产线：从一句话到整套成品
          </h1>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            单张图说一句话就够了；但小说改成片、一套上市素材、一部短剧的投放封面，都是十几二十步的活，中间任何一步走样，后面全部白做。
            下面每条产线把这类工程拆成固定环节：先锁住角色、商品或风格这些「不能变的东西」，再批量往下铺，关键节点停下来等你点头。
          </p>
          <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
            在首页点一张产线卡，画布会直接铺出整张工序图，助理按图推进；你也可以只勾其中几个环节来跑。点进每条产线看它每一步具体交付什么、哪里需要你确认、目前有哪些做不到。
          </p>
        </header>

        {DOMAIN_ORDER.map((domain) => {
          const group = items.filter((item) => item.card.domain === domain);
          if (group.length === 0) return null;
          return (
            <section key={domain} className="mt-6">
              <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
                {AGENT_TEMPLATE_DOMAIN_LABELS[domain]}
              </h2>
              <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.52)]">{DOMAIN_INTRO[domain]}</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {group.map(({ page, card }) => (
                  <Link
                    key={page.slug}
                    href={`/workflows/${page.slug}`}
                    className="group lg-card flex flex-col overflow-hidden rounded-ios-3xl transition hover:shadow-[0_8px_30px_rgba(0,122,255,0.14)]"
                  >
                    {card.showcaseImage && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={card.showcaseImage}
                        alt={page.media.alt}
                        loading="lazy"
                        className="aspect-video w-full object-cover"
                      />
                    )}
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-ios-headline font-semibold text-[rgba(0,0,0,0.85)] group-hover:text-[#007AFF]">
                          {card.name}
                        </span>
                        <ArrowUpRight className="h-4 w-4 shrink-0 text-[rgba(0,0,0,0.4)] group-hover:text-[#007AFF]" aria-hidden="true" />
                      </span>
                      <span className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.62)]">{card.note}</span>
                      <span className="mt-auto pt-1 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.45)]">
                        {card.pipeline.steps.map((step) => step.shortName).join(" → ")}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
