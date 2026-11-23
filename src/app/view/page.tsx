import type { Metadata } from "next";
import Link from "next/link";
import { isDeliverableKind } from "@/lib/deliverable-kind";
import { stableAssetId, viewKindLabel } from "@/lib/viewer/from-items";
import type { ViewAsset, ViewKind } from "@/lib/viewer/types";
import { ViewClient } from "./ViewClient";

// 赏阅独立分享页：把任何一个成品 URL 打开成「可看、可标记、可回流」的整页预览。
//
// 查询参数：u（资源 URL，必填）、k（种类，缺省按扩展名推断）、title、cover、t（起始秒）。
// 规矩：
//   ①noindex：分享页是给人转发的，不进索引（沿用 /p/[shareId] 的理由）。
//   ②不需要登录；URL 只当作 <img>/<video>/<audio> 的 src，服务端不抓取、不代理。
//   ③force-dynamic：每个链接参数都不同，没有可共享的静态产物。

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** 分享页支持的种类（text/storyboard/collection 需要正文或成员，URL 单件无法表达）。 */
const SHAREABLE: readonly ViewKind[] = ["image", "video", "audio", "document", "scene3d"];

const EXT_KIND: Record<string, ViewKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio", opus: "audio",
  pdf: "document",
  glb: "scene3d", gltf: "scene3d",
};

type Parsed =
  | { ok: true; asset: ViewAsset; startSec: number }
  | { ok: false; reason: string };

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

function httpUrl(raw: string): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function extOf(url: string): string {
  try {
    return new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function parse(sp: Record<string, string | string[] | undefined>): Parsed {
  const rawUrl = first(sp.u);
  if (!rawUrl) return { ok: false, reason: "链接里缺少要查看的内容地址（参数 u）。" };
  const url = httpUrl(rawUrl);
  if (!url) return { ok: false, reason: "内容地址不是有效的 http(s) 链接。" };

  const rawKind = first(sp.k);
  let kind: ViewKind | undefined;
  if (rawKind) {
    const ok = isDeliverableKind(rawKind) || (SHAREABLE as readonly string[]).includes(rawKind);
    if (!ok) return { ok: false, reason: `暂不支持的种类「${rawKind.slice(0, 20)}」。` };
    kind = rawKind as ViewKind;
    if (!SHAREABLE.includes(kind)) return { ok: false, reason: `「${viewKindLabel(kind)}」暂不支持用链接单独分享。` };
  } else {
    kind = EXT_KIND[extOf(url)];
    if (!kind) return { ok: false, reason: "无法从地址判断是图片、视频还是音乐，请在链接里补上 k 参数。" };
  }

  const title = first(sp.title).slice(0, 120);
  const coverRaw = first(sp.cover);
  const cover = coverRaw ? httpUrl(coverRaw) : null;
  const t = Number(first(sp.t));
  const startSec = Number.isFinite(t) && t > 0 ? Math.min(t, 24 * 3600) : 0;

  return {
    ok: true,
    startSec,
    asset: {
      id: stableAssetId(url),
      kind,
      url,
      ...(title ? { title } : {}),
      ...(cover ? { cover } : {}),
    },
  };
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const parsed = parse(await searchParams);
  const robots = { index: false, follow: false } as const;
  if (!parsed.ok) return { title: { absolute: "链接打不开 · Eimu" }, robots };

  const { asset } = parsed;
  const label = viewKindLabel(asset.kind);
  const title = asset.title ? `${asset.title} · 赏阅` : `${label}预览 · 赏阅`;
  const description = `在 Eimu 赏阅里查看这件${label}，可以逐处标记、整理成反馈。`;
  // 图片 og:image 就是作品本身；其它种类只在真有封面时给，不拿别的东西占位。
  const ogImage = asset.kind === "image" ? asset.url : asset.cover;
  return {
    title: { absolute: title },
    description,
    robots,
    openGraph: {
      type: "website",
      title,
      description,
      ...(ogImage ? { images: [{ url: ogImage, alt: title }] } : {}),
    },
    twitter: {
      card: ogImage ? "summary_large_image" : "summary",
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  };
}

export default async function ViewPage({ searchParams }: { searchParams: SearchParams }) {
  const parsed = parse(await searchParams);

  if (!parsed.ok) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-[#0d0f14] p-6 text-center text-white">
        <h1 className="text-[18px] font-semibold">这个链接打不开</h1>
        <p className="max-w-[28rem] text-[14px] text-white/70">{parsed.reason}</p>
        <Link
          href="/"
          className="flex min-h-11 items-center rounded-full bg-white/15 px-5 text-[14px] font-medium hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          回到 Eimu
        </Link>
      </div>
    );
  }

  return <ViewClient asset={parsed.asset} startSec={parsed.startSec} />;
}
