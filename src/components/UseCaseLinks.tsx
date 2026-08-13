import Link from "next/link";
import { ArrowUpRight, FileText } from "lucide-react";
import { USE_CASES } from "@/lib/use-cases";

export function UseCaseLinks() {
  return (
    <section className="page-shell pb-24" aria-labelledby="use-case-links-title">
      <div className="mb-8 max-w-[40rem]">
        <div className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.09)] px-3.5 text-ios-caption1 font-semibold text-[#007AFF]">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          场景指南
        </div>
        <h2 id="use-case-links-title" className="max-w-[32rem] text-ios-title1 font-semibold text-[rgba(0,0,0,0.88)] sm:text-ios-largetitle">
          按行业场景，看别人怎么用 AI生图
        </h2>
        <p className="mt-3 max-w-[34rem] text-ios-callout text-[rgba(0,0,0,0.54)]">
          每篇都带真实数据来源，不是空口说白话。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {USE_CASES.map((item) => (
          <Link
            key={item.slug}
            href={`/use-cases/${item.slug}`}
            className="group lg-card flex flex-col justify-between rounded-ios-3xl p-5 lg-transition hover:-translate-y-0.5"
          >
            <div>
              <p className="text-ios-caption1 font-semibold text-[#007AFF]">{item.keyword}</p>
              <h3 className="mt-2 text-ios-callout font-semibold leading-snug text-[rgba(0,0,0,0.85)]">
                {item.tagline}
              </h3>
            </div>
            <span className="mt-4 inline-flex items-center gap-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.5)] group-hover:text-[#007AFF]">
              查看详情
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
