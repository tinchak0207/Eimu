"use client";

// 赏阅 · 文档适配器。只渲染浏览器能如实渲染的两类：
//   pdf  → 先 fetch → 校验魔数 `%PDF-` → Blob(application/pdf) → <iframe src=blob#page=n>（页码 locator：用户填页码；浏览器内置阅读器不向页面回报当前页，故以输入框为准并如实标注）
//          不把外部 URL 直接交给 iframe：同源伪装成 .pdf 的 HTML 会拿到站点权限、站外页面会被嵌进壳里（2026-11-04 验收 P1）。
//          fetch 失败/跨域无 CORS/非 2xx → 诚实卡片（不嵌入）；魔数不符 → 「不是有效 PDF」（不嵌入）。
//   种类分流：扩展名 + asset.mime；二者冲突按更保守处理（诚实卡片，不预览）。
//   html → <iframe sandbox="allow-scripts">（刻意不加 allow-same-origin：成品 HTML 读不到站点 cookie/localStorage）
//   其余（pptx/docx/xlsx…）→ 诚实卡片：文件名/类型 + 下载，明说暂不支持在线预览；不做假缩略图、不拿假内容充数。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";
import { cn } from "@/lib/utils";

type DocFlavor = "pdf" | "html" | "other" | "conflict";

type PdfState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; blobUrl: string }
  | { phase: "blocked" }
  | { phase: "invalid" };

const TYPE_LABELS: Record<string, string> = {
  pptx: "PowerPoint 演示文稿",
  ppt: "PowerPoint 演示文稿",
  docx: "Word 文档",
  doc: "Word 文档",
  xlsx: "Excel 表格",
  xls: "Excel 表格",
  csv: "CSV 表格",
  odt: "OpenDocument 文档",
  rtf: "富文本文档",
  zip: "压缩包",
  epub: "电子书",
  key: "Keynote 演示文稿",
  pages: "Pages 文档",
  numbers: "Numbers 表格",
};

function extOf(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? "";
  const base = clean.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function fileNameOf(url: string | undefined, title: string | undefined): string {
  if (url) {
    const base = (url.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
    try {
      if (base) return decodeURIComponent(base);
    } catch {
      return base;
    }
  }
  return title?.trim() || "未命名文档";
}

/** 规范化 mime（去参数、小写）；空或 application/octet-stream（无信息量）视为未提供。 */
function normMime(mime: string | undefined): string {
  const m = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return m === "application/octet-stream" ? "" : m;
}

function flavorOf(ext: string, mime: string | undefined): DocFlavor {
  const byExt: DocFlavor = ext === "pdf" ? "pdf" : ext === "html" || ext === "htm" ? "html" : "other";
  const m = normMime(mime);
  if (!m) return byExt;
  const byMime: DocFlavor = m === "application/pdf" ? "pdf" : m === "text/html" || m === "application/xhtml+xml" ? "html" : "other";
  if (byMime === byExt) return byExt;
  // 一方明说是 pdf/html、另一方说别的 → 冲突，更保守：不预览。
  // 仅当扩展名未知（other 且无 pdf/html 扩展）且 mime 明说 pdf/html 时，以 mime 为准。
  if (byExt === "other" && byMime !== "other") return byMime;
  return "conflict";
}

function HonestCard({
  full,
  fileName,
  label,
  message,
  downloadUrl,
  newTabUrl,
  onRequestMark,
  onRetry,
}: {
  full: boolean;
  fileName: string;
  label?: string;
  message: string;
  downloadUrl: string;
  /** 为 null 则不提供「新标签打开」（疑似伪装文件，打开等于在站点来源下执行）。 */
  newTabUrl: string | null;
  onRequestMark: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 bg-[#0b0f14] px-6 py-8 text-center",
        full ? "h-full min-h-[320px]" : "min-h-[200px]",
      )}
    >
      <FileText className="h-12 w-12 text-white/40" aria-hidden="true" />
      <div className="max-w-full space-y-1">
        <div className="break-all text-[15px] font-medium text-white">{fileName}</div>
        {label && <div className="text-[13px] text-white/60">{label}</div>}
      </div>
      <p className="text-[13px] text-white/70">{message}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href={downloadUrl}
          download={fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-5 text-[14px] font-medium text-black hover:bg-white/90"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          下载
        </a>
        {newTabUrl && (
          <a
            href={newTabUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white/15 px-4 text-[14px] text-white hover:bg-white/25"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            新标签打开
          </a>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white/15 px-4 text-[14px] text-white hover:bg-white/25"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            重试
          </button>
        )}
        <button
          type="button"
          onClick={onRequestMark}
          className="inline-flex min-h-[44px] items-center rounded-full bg-white/15 px-4 text-[14px] text-white hover:bg-white/25"
        >
          标记整份文档
        </button>
      </div>
    </div>
  );
}

export default function DocumentSurface({
  asset,
  density,
  annotations,
  controllerRef,
  onRequestMark,
  active,
}: ViewerSurfaceProps) {
  const full = density === "full";
  const url = asset.url;
  const ext = useMemo(() => extOf(url ?? "") || extOf(asset.title ?? ""), [url, asset.title]);
  const flavor: DocFlavor = useMemo(() => flavorOf(ext, asset.mime), [ext, asset.mime]);
  const fileName = fileNameOf(url, asset.title);

  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState("1");
  const [reloadKey, setReloadKey] = useState(0);
  const [pdf, setPdf] = useState<PdfState>({ phase: "idle" });
  const pageRef = useRef(1);
  pageRef.current = page;

  // PDF：fetch → 魔数校验 → Blob URL。永不把外部 URL 直接交给 iframe。换件/卸载/失活时 revoke。
  useEffect(() => {
    if (flavor !== "pdf" || !url || !active) {
      setPdf({ phase: "idle" });
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    const ac = new AbortController();
    setPdf({ phase: "loading" });
    void (async () => {
      try {
        const resp = await fetch(url, { signal: ac.signal, referrerPolicy: "no-referrer", cache: "no-store" });
        if (!resp.ok) {
          if (!cancelled) setPdf({ phase: "blocked" });
          return;
        }
        const buf = await resp.arrayBuffer();
        if (cancelled) return;
        const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength)));
        if (head !== "%PDF-") {
          setPdf({ phase: "invalid" });
          return;
        }
        created = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
        setPdf({ phase: "ready", blobUrl: created });
      } catch {
        // 网络不通 / 跨域无 CORS / 被中止：浏览器不细分，按「该来源不允许在线预览」如实呈现
        if (!cancelled) setPdf({ phase: "blocked" });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [flavor, url, active, reloadKey]);

  const goPage = useCallback((n: number) => {
    const v = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
    setPage(v);
    setPageText(String(v));
  }, []);

  useEffect(() => {
    const controller: ViewerController = {
      capture() {
        if (flavor === "pdf") return { locator: { t: "page", n: pageRef.current } satisfies Locator };
        return { locator: { t: "whole" } satisfies Locator };
      },
      reveal(locator) {
        if (locator.t === "page") goPage(locator.n);
      },
    };
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, flavor, goPage]);

  const pageMarks = annotations.filter((a) => a.locator.t === "page");

  if (!url) {
    return (
      <div className="flex min-h-[200px] w-full items-center justify-center rounded-[12px] bg-black/20 p-6 text-[14px] text-white/70">
        该文档没有可用的文件地址
      </div>
    );
  }

  if (flavor === "other") {
    const label = TYPE_LABELS[ext] ?? (ext ? `.${ext.toUpperCase()} 文件` : "未知格式文件");
    return (
      <HonestCard
        full={full}
        fileName={fileName}
        label={label}
        message="该格式暂不支持在线预览，请下载后用本地软件打开。"
        downloadUrl={url}
        newTabUrl={null}
        onRequestMark={onRequestMark}
      />
    );
  }

  if (flavor === "conflict") {
    return (
      <HonestCard
        full={full}
        fileName={fileName}
        label="文件类型信息不一致"
        message="文件扩展名与声明的类型不一致，为安全起见不在线预览，请下载后查看。"
        downloadUrl={url}
        newTabUrl={null}
        onRequestMark={onRequestMark}
      />
    );
  }

  if (flavor === "pdf" && active && pdf.phase === "blocked") {
    return (
      <HonestCard
        full={full}
        fileName={fileName}
        label="PDF 文档"
        message="该来源不允许在线预览（无法访问或未开放跨域），请下载或在新标签打开查看。"
        downloadUrl={url}
        newTabUrl={url}
        onRequestMark={onRequestMark}
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    );
  }

  if (flavor === "pdf" && active && pdf.phase === "invalid") {
    return (
      <HonestCard
        full={full}
        fileName={fileName}
        label="PDF 文档"
        message="该文件不是有效的 PDF（文件头校验未通过），已拒绝嵌入。"
        downloadUrl={url}
        newTabUrl={null}
        onRequestMark={onRequestMark}
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    );
  }

  const blobUrl = pdf.phase === "ready" ? pdf.blobUrl : null;
  const src = blobUrl ? `${blobUrl}#page=${page}` : null;
  // pdf 验证通过后，新窗口/下载都用已校验的 blob，避免再次打开原 URL（可能被替换成别的内容）
  const openHref = flavor === "pdf" ? (blobUrl ?? url) : url;

  return (
    <div className={cn("flex w-full flex-col bg-[#0b0f14]", full ? "h-full min-h-[320px]" : "h-[360px]")}>
      <div className="relative min-h-0 flex-1 bg-white">
        {active ? (
          flavor === "html" ? (
            <iframe
              key={reloadKey}
              title={asset.title ?? fileName}
              src={url}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full border-0"
            />
          ) : src ? (
            <iframe
              key={reloadKey}
              title={asset.title ?? fileName}
              src={src}
              className="absolute inset-0 h-full w-full border-0"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0b0f14] text-[13px] text-white/50">正在加载 PDF…</div>
          )
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0f14] text-[13px] text-white/50">已暂停</div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/30 px-3 py-1.5 text-[13px] text-white/80">
        {flavor === "pdf" && (
          <>
            <button
              type="button"
              onClick={() => goPage(page - 1)}
              disabled={page <= 1}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40"
              aria-label="上一页"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <label className="inline-flex items-center gap-1.5">
              第
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={pageText}
                onChange={(e) => setPageText(e.target.value)}
                onBlur={() => goPage(Number(pageText))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goPage(Number(pageText));
                }}
                className="h-[44px] w-[72px] rounded-lg border border-white/20 bg-white/10 px-2 text-center text-[14px] text-white outline-none focus:border-white/50"
                aria-label="页码"
              />
              页
            </label>
            <button
              type="button"
              onClick={() => goPage(page + 1)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:bg-white/10"
              aria-label="下一页"
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onRequestMark}
          className="inline-flex min-h-[44px] items-center rounded-full bg-white/15 px-4 text-[14px] text-white hover:bg-white/25"
        >
          {flavor === "pdf" ? `标记第 ${page} 页` : "标记整份文档"}
        </button>
        {full && flavor === "pdf" && pageMarks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-white/60">已标记</span>
            {pageMarks.map((a) => {
              const n = a.locator.t === "page" ? a.locator.n : 1;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => goPage(n)}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 px-3 hover:bg-white/20"
                >
                  {n} 页
                </button>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 hover:bg-white/10"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {full ? "显示不出来？重新加载" : "重载"}
          </button>
          <a
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-3 hover:bg-white/10"
            aria-label="在新窗口打开"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {full && "新窗口"}
          </a>
          <a
            href={openHref}
            download={fileName}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-3 hover:bg-white/10"
            aria-label="下载"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {full && "下载"}
          </a>
        </div>
      </div>
    </div>
  );
}
