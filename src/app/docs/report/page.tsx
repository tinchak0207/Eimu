import { Download, ExternalLink, FileText } from "lucide-react";

const PDF_HREF = "/docs/eimu-competition-report.pdf";

const REPORT_TITLE = "Eimu 作品報告 | 文檔中心 | Eimu";
const REPORT_DESCRIPTION =
  "Eimu（Emu）多智能體高審美影音設計平台作品報告：產品定位、核心技術、創新點與工程驗證全記錄。";

export const metadata = {
  title: REPORT_TITLE,
  description: REPORT_DESCRIPTION,
  openGraph: {
    title: REPORT_TITLE,
    description: REPORT_DESCRIPTION,
    url: "https://eimu.dev/docs/report",
  },
  twitter: {
    card: "summary_large_image",
    title: REPORT_TITLE,
    description: REPORT_DESCRIPTION,
  },
};

export default function DocsReportPage() {
  return (
    <div className="flex flex-col gap-5">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">作品報告</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          Eimu 作品報告
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          由模型編寫工作流、由引擎掌握控制流：Eimu 多智能體高審美影音設計平台的完整作品報告，涵蓋產品定位、總體架構、核心技術、創新點與工程驗證。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={PDF_HREF}
            download="Eimu-作品報告.pdf"
            className="inline-flex items-center gap-2 rounded-ios-xl bg-[#007AFF] px-4 py-2 text-ios-footnote font-medium text-white transition hover:bg-[#0071E3]"
          >
            <Download className="h-4 w-4" />
            下載 PDF
          </a>
          <a
            href={PDF_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-ios-xl border border-[rgba(0,0,0,0.12)] px-4 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.72)] transition hover:bg-[rgba(0,122,255,0.06)]"
          >
            <ExternalLink className="h-4 w-4" />
            新窗口打開
          </a>
        </div>
      </section>

      <div className="lg-card overflow-hidden rounded-ios-3xl p-2 sm:p-3">
        <div className="flex items-center gap-2 px-2 py-1.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.48)]">
          <FileText className="h-3.5 w-3.5" />
          Eimu-作品報告.pdf · 32 頁 · 內嵌預覽若未顯示，請用上方按鈕下載或新窗口打開
        </div>
        <iframe
          src={PDF_HREF}
          title="Eimu 作品報告 PDF 預覽"
          className="h-[78vh] min-h-[560px] w-full rounded-ios-2xl border border-[rgba(0,0,0,0.08)] bg-white"
          loading="lazy"
        />
      </div>
    </div>
  );
}
