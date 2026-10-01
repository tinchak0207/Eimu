// POST /api/canvas/format-crops — 一稿多版位：一次生成，自動出滿 13 個版位。
//
// 契約：
//   入參 { sourceImageUrl?, sourceWidth?, sourceHeight?, sizes?, execute? }
//     - sourceWidth/sourceHeight 給定時只需 plan，不抓圖（零成本、零 IO）。
//     - sourceImageUrl（https 或 data:image）用於：入參沒給尺寸時讀真實尺寸；
//       execute:true 時取像素做實際裁切。
//     - sizes = 版位 id 清單（AD_SIZE_OPTIONS 的 id），走 normalizeSizeSelection
//       收斂；不給 = 全部 13 版位。
//     - execute = 是否真的出圖。只有 crop 版位會在伺服器端裁出來（sharp）；
//       outpaint 版位沒有專屬上游模型（見下方「擴圖上游」註），一律回
//       skipped，不假裝出了圖。
//   出參 { ok, source, summary, plans, executed? }
//
// 擴圖上游（2026-09-27 現場核查）：catalog 有 "adobe-firefly-fill"（智能扩图）
// 條目，但 image-model-ids.js 明寫它是「服務類定價條目，不加入 SUPPORTED_*」
// 且沒有任何 route/adapter 消費它（grep ADOBE_FIREFLY_FILL_MODEL_ID → 只有
// catalog 與 admin 定價面板）。所以 outpaint 執行層**缺上游**：本 route 只出
// 幾何 plan（outpaintEdges / outputWidth / outputHeight），不代呼叫生成。
//
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { AD_SIZE_OPTIONS, normalizeSizeSelection, type AdSizeOption } from "@/lib/ad-formats";
import { summarizeFormatCrops, type FormatCropPlan } from "@/lib/canvas/format-crops";
import { cropImage, readSourceImageInfo } from "@/lib/canvas/format-crops-exec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

interface FormatCropsRequest {
  sourceImageUrl?: unknown;
  sourceWidth?: unknown;
  sourceHeight?: unknown;
  sizes?: unknown;
  execute?: unknown;
}

interface ExecutedItem {
  id: string;
  mode: FormatCropPlan["mode"];
  status: "done" | "skipped";
  dataUrl?: string;
  width?: number;
  height?: number;
  reason?: string;
  /** outpaint 專用：建議送給既有生成入口的比例（既有入口吃 ratio 不吃像素）。 */
  suggestedSize?: string;
}

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** 主機黑名單：IP 字面量（v4/v6）、localhost、內網尾綴。同 /api/canvas/image-proxy 的守衛。 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

/** sourceImageUrl → Buffer。data:image 直解；https 限公網主機、限時限量、只認 image/*。 */
async function fetchSourceBuffer(url: string): Promise<Buffer> {
  if (url.startsWith("data:image/")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("data URL 格式无效");
    const buffer = Buffer.from(url.slice(comma + 1), "base64");
    if (buffer.byteLength === 0) throw new Error("data URL 图片为空");
    if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error("图片超过 25MB");
    return buffer;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("sourceImageUrl 不是合法网址");
  }
  if (target.protocol !== "https:" || isForbiddenHost(target.hostname)) {
    throw new Error("仅支持 https 公网图片地址");
  }
  const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`上游图片获取失败（${res.status}）`);
  const mime = res.headers.get("content-type") ?? "";
  if (!mime.startsWith("image/")) throw new Error(`不是图片（${mime || "无 content-type"}）`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error("图片为空");
  if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error("图片超过 25MB");
  return buffer;
}

function positiveNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: FormatCropsRequest;
  try {
    body = (await req.json()) as FormatCropsRequest;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }

  // 版位清單：走 ad-formats 的 normalizeSizeSelection（不另造一套版位表）。
  const rawSizes = Array.isArray(body.sizes) ? body.sizes.filter((s): s is string => typeof s === "string") : [];
  const selectedIds = rawSizes.length > 0 ? normalizeSizeSelection(rawSizes) : AD_SIZE_OPTIONS.map((o) => o.id);
  const targets: AdSizeOption[] = AD_SIZE_OPTIONS.filter((option) => selectedIds.includes(option.id));

  const execute = body.execute === true;
  const declaredWidth = positiveNumber(body.sourceWidth);
  const declaredHeight = positiveNumber(body.sourceHeight);
  const sourceImageUrl = typeof body.sourceImageUrl === "string" ? body.sourceImageUrl : "";

  let buffer: Buffer | null = null;
  let width = declaredWidth;
  let height = declaredHeight;
  let dimsFrom: "request" | "image" = "request";

  const needsImage = execute || width === null || height === null;
  if (needsImage) {
    if (!sourceImageUrl) {
      return fail(400, "缺少 sourceImageUrl（或同时给 sourceWidth / sourceHeight）", "missing_source");
    }
    try {
      buffer = await fetchSourceBuffer(sourceImageUrl);
      const info = await readSourceImageInfo(buffer);
      if (info.width <= 0 || info.height <= 0) return fail(400, "无法读取图片尺寸", "unknown_source_size");
      width = info.width;
      height = info.height;
      dimsFrom = "image";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(400, `源图读取失败：${reason}`, "source_fetch_failed");
    }
  }

  const summary = summarizeFormatCrops(width ?? NaN, height ?? NaN, targets);

  let executed: ExecutedItem[] | undefined;
  if (execute && buffer) {
    executed = [];
    for (const plan of summary.plans) {
      if (plan.mode === "crop" && plan.cropRect) {
        try {
          const out = await cropImage(buffer, plan.cropRect);
          executed.push({
            id: plan.id,
            mode: "crop",
            status: "done",
            dataUrl: `data:image/webp;base64,${out.toString("base64")}`,
            width: plan.outputWidth,
            height: plan.outputHeight,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          executed.push({ id: plan.id, mode: "crop", status: "skipped", reason: `crop_failed:${reason}` });
        }
        continue;
      }
      if (plan.mode === "outpaint") {
        // 不缺不騙：沒有專屬擴圖上游就不謊稱已出圖。suggestedSize 是版位比例
        // （既有生成入口吃 ratio：/api/canvas/generate 的 size 欄位、
        // /v1/images/edits 的 size→aspectRatioFromImageSize），由呼叫端決定何時付費生成。
        executed.push({
          id: plan.id,
          mode: "outpaint",
          status: "skipped",
          reason: "no_outpaint_upstream",
          suggestedSize: plan.ratio,
        });
        continue;
      }
      executed.push({ id: plan.id, mode: "rejected", status: "skipped", reason: plan.reason ?? "rejected" });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      source: {
        width: summary.sourceWidth,
        height: summary.sourceHeight,
        ratio: summary.sourceRatio,
        dimsFrom,
      },
      summary: {
        cropCount: summary.cropCount,
        outpaintCount: summary.outpaintCount,
        rejectedCount: summary.rejectedCount,
        displayCount: targets.length,
      },
      plans: summary.plans,
      ...(executed ? { executed } : {}),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
