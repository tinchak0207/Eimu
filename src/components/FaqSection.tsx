import { FAQ_ITEMS, FAQ_SOURCE_CITATION } from "@/lib/long-tail-faq";

const FAQ_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
};

export function FaqSection() {
  return (
    <section className="page-shell pb-24" aria-labelledby="faq-section-title">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_STRUCTURED_DATA) }}
      />
      <div className="mb-8 max-w-[40rem]">
        <div className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.09)] px-3.5 text-ios-caption1 font-semibold text-[#007AFF]">
          常见问题
        </div>
        <h2 id="faq-section-title" className="max-w-[32rem] text-ios-title1 font-semibold text-[rgba(0,0,0,0.88)] sm:text-ios-largetitle">
          关于中转站、API Key 和在线生图的问题
        </h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className="group/details lg-card rounded-ios-3xl px-5 py-4">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-3 text-ios-callout font-semibold text-[rgba(0,0,0,0.82)]">
              <span>{item.question}</span>
              <span className="shrink-0 text-[rgba(0,0,0,0.34)] transition group-open/details:rotate-45">+</span>
            </summary>
            <p className="mt-3 text-ios-footnote text-[rgba(0,0,0,0.58)]">{item.answer}</p>
          </details>
        ))}
      </div>

      <p className="mt-6 text-ios-caption2 text-[rgba(0,0,0,0.4)]">
        {FAQ_SOURCE_CITATION.label}：{" "}
        <a href={FAQ_SOURCE_CITATION.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
          原文链接
        </a>
      </p>
    </section>
  );
}
