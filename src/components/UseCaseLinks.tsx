import Link from "next/link";
import { ArrowUpRight, FileText } from "lucide-react";
import { USE_CASE_CATEGORIES } from "@/lib/use-case-categories";

export function UseCaseLinks() {
  return (
    <section className="page-shell pb-24" aria-labelledby="use-case-links-title">
      <div className="mb-8 max-w-[40rem]">
        <div className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.09)] px-3.5 text-ios-caption1 font-semibold text-[#007AFF]">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          场景指南
        </div>
        <h2 id="use-case-links-title" className="max-w-[36rem] text-ios-title1 font-semibold text-[rgba(0,0,0,0.88)] sm:text-ios-largetitle">
          按行业找做法：17 个行业，各自 6 个场景
        </h2>
        <p className="mt-3 max-w-[34rem] text-ios-callout text-[rgba(0,0,0,0.54)]">
          这里按行业整理，每个行业一页，页内拆成 6 个子场景，写清构图、光线与比例标准，给出可直接复制的提示词，也把常见翻车点列出来。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {USE_CASE_CATEGORIES.map((category) => (
          <Link
            key={category.slug}
            href={`/use-cases/${category.slug}`}
            className="group lg-card flex flex-col justify-between rounded-ios-3xl p-5 lg-transition hover:-translate-y-0.5"
          >
            <div>
              <p className="text-ios-caption1 font-semibold text-[#007AFF]">{category.keyword}</p>
              <h3 className="mt-2 text-ios-callout font-semibold leading-snug text-[rgba(0,0,0,0.85)]">
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

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link
          href="/use-cases"
          className="inline-flex items-center gap-1.5 text-ios-callout font-medium text-[#007AFF] hover:underline"
        >
          查看全部场景指南
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        <Link
          href="/workflows"
          className="inline-flex items-center gap-1.5 text-ios-callout font-medium text-[#007AFF] hover:underline"
        >
          看创作产线
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
