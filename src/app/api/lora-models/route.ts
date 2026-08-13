import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 100;

function cleanEnvValue(value: string): string {
  return value.replace(/^\uFEFF+/, "").trim();
}

function normalizeBaseURL(baseURL: string): string {
  return cleanEnvValue(baseURL).replace(/\/+$/, "");
}

/**
 * LoRA model catalog proxy: forwards search/filter requests to the PixAI
 * bridge (/v1/lora-models) so the browser never sees the bridge API key.
 */
export async function GET(req: NextRequest) {
  const base = normalizeBaseURL(process.env.PIXAI_BASE_URL ?? "");
  const key = cleanEnvValue(process.env.PIXAI_API_KEY ?? "");
  if (!base || !key) {
    return NextResponse.json({ error: "PixAI bridge is not configured." }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get("keyword") ?? "";
  const category = searchParams.get("category") ?? "";
  const sort = ["popular", "newest", "liked"].includes(searchParams.get("sort") ?? "")
    ? String(searchParams.get("sort"))
    : "popular";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE),
  );

  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort });
  if (keyword.trim()) query.set("keyword", keyword.trim());
  if (category) query.set("category", category);

  try {
    const response = await fetch(`${base}/lora-models?${query.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: `LoRA catalog request failed: ${response.status}` }, { status: 502 });
    }
    const payload = (await response.json()) as unknown;
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "LoRA catalog is temporarily unavailable." }, { status: 502 });
  }
}
