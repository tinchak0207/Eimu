import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, EyeOff, Sparkles } from "lucide-react";
import { getPublicShare } from "@/lib/share-store";
import { buildSharePath } from "@/lib/share-remix";
import { getSiteUrl } from "@/lib/site-url";
import { formatModelLabel } from "@/lib/history-types";
import { RemixButton } from "@/components/share/RemixButton";

// 作品公开分享页。
//
// 这页是增长回路的落点：看到好图 → 一步复刻（做同款把提示词/模型/比例注入助理输入框）。
// 三条硬规矩：
//   ①预设不公开、可撤销：没有记录就 404（isShareId 只挡畸形，存在性由存储回答）。
//   ②noindex：分享页是给人看的，不进索引、不进 sitemap（等量起来再说）；canonical
//     仍指向不带归因参数的干净路径，避免 utm 自造重复页。
//   ③OG 图就是作品本身：社交平台预览直接显示那张图（imageUrl 沿用既有 blob owner）。
//
// 为什么 force-dynamic ＋ force-no-store：撤销后必须当场 404，任何一层快取（路由段快取、
// fetch Data Cache）都会让「我已经撤销了」变成谎话。

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type RouteParams = { params: Promise<{ shareId: string }> };

/** 提示词摘要：一行（社交预览与页面副标都吃同一份，两处不会各说各话）。 */
function summarise(prompt: string, max = 80): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { shareId } = await params;
  const share = await getPublicShare(shareId);

  if (!share) {
    // 不存在／已撤销：仍然给 noindex（不要让 404 的形状被拿去当索引页）。
    return {
      title: { absolute: "作品不存在 · Eimu" },
      robots: { index: false, follow: false },
    };
  }

  const siteUrl = await getSiteUrl();
  const canonical = `${siteUrl}${buildSharePath(share.view.shareId)}`;
  const modelLabel = formatModelLabel(share.view.modelId) || "AI 生图";
  const promptSummary = share.view.prompt ? summarise(share.view.prompt, 60) : "";
  const title = promptSummary ? `${promptSummary} · Eimu` : `用 ${modelLabel} 生成的作品 · Eimu`;
  // 作者隐藏提示词时，预览文案也不能把它说出来——description 只用模型名。
  const description = share.view.prompt
    ? summarise(share.view.prompt, 120)
    : `一件用 ${modelLabel} 生成的 AI 作品，点一下用同样的参数做一张自己的。`;

  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    // 分享页是给人转发的，不是给爬虫收的：先 noindex，等量起来再谈。
    robots: { index: false, follow: false },
    openGraph: {
      type: "article",
      title,
      description,
      url: canonical,
      images: [{ url: share.view.imageUrl, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [share.view.imageUrl],
    },
  };
}

const metaChipClass =
  "inline-flex items-center rounded-full bg-[rgba(255,255,255,0.55)] px-3 py-1 text-[13px] text-[rgba(0,0,0,0.62)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]";

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className={metaChipClass}>
      {label} {value}
    </span>
  );
}

export default async function PublicSharePage({ params }: RouteParams) {
  const { shareId } = await params;
  const share = await getPublicShare(shareId);
  if (!share) notFound();

  const { view } = share;
  const modelLabel = formatModelLabel(view.modelId);

  return (
    <div className="min-h-screen px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pt-10">
      <div className="mx-auto w-full max-w-[1440px]">
        <Link
          href="/"
          className="lg-float lg-transition inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-ios-footnote text-[rgba(0,0,0,0.62)] hover:text-[rgba(0,0,0,0.85)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          回 Eimu 首页
        </Link>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <div className="lg:col-span-2">
            <div className="lg-card relative overflow-hidden rounded-ios-3xl p-2.5 sm:rounded-ios-4xl sm:p-3">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              {/* 作品本体：外部 blob URL（既有 owner 托管），用 <img> 直出——站上既有
                  的同类画面（血统抽屉、参考图预览）都是这样，不经 /_next/image 白名单。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={view.imageUrl}
                alt={view.prompt ? summarise(view.prompt, 120) : "分享的 AI 作品"}
                className="w-full rounded-ios-2xl object-contain sm:rounded-ios-3xl"
              />
            </div>
          </div>

          <aside className="lg:col-span-1">
            <div className="lg-card relative overflow-hidden rounded-ios-3xl p-5 sm:rounded-ios-4xl sm:p-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />

              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[#007AFF]" aria-hidden="true" />
                <h1 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">Eimu 用户作品</h1>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {modelLabel && <MetaChip label="模型" value={modelLabel} />}
                {view.aspectRatio && <MetaChip label="比例" value={view.aspectRatio} />}
                {view.imageSize && <MetaChip label="尺寸" value={view.imageSize} />}
              </div>

              <div className="mt-4">
                <p className="text-[13px] font-medium text-[rgba(0,0,0,0.45)]">提示词</p>
                {view.prompt ? (
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.72)]">
                    {summarise(view.prompt, 600)}
                  </p>
                ) : (
                  <p className="mt-1.5 flex items-center gap-1.5 text-ios-footnote text-[rgba(0,0,0,0.45)]">
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    作者选择了隐藏提示词。
                  </p>
                )}
              </div>

              <div className="mt-6">
                <RemixButton
                  shareId={view.shareId}
                  prompt={view.prompt}
                  modelId={view.modelId}
                  aspectRatio={view.aspectRatio}
                  imageSize={view.imageSize}
                />
                <p className="mt-2.5 text-center text-[13px] leading-relaxed text-[rgba(0,0,0,0.45)]">
                  提示词、模型与比例会自动填进工作台，确认一下就能出图。
                </p>
              </div>

              <Link
                href="/"
                className="lg-float lg-transition mt-3 flex w-full items-center justify-center gap-1.5 rounded-ios-xl px-5 py-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] hover:text-[rgba(0,0,0,0.85)]"
              >
                也去做一张自己的
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
