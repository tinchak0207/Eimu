// 提示词库服务端聚合（公共读，无需登入）。
//
// 内建远程源清单抄自 infinite-canvas 参考实现（yukkcat/image-prompts 注册表，
// dist/sources 下各源已预归一为同一 JSON 形状，但 adapter 仍容忍栏位变体与
// 包裹层差异，解析不了的条目跳过）。并行抓取，每源 8s timeout、失败跳过不
// 挡整体；模组级记忆体快取 1 小时，过期 stale-while-revalidate：先回旧资料、
// 背景刷新（在同一 serverless 实例存活期内生效）。
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const SOURCE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PROMPTS_RETURNED = 500;
const MAX_TAGS_PER_PROMPT = 12;

interface PromptSourceDef {
  id: string;
  label: string;
  url: string;
}

const PROMPT_REGISTRY_SOURCE_BASE = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";

function registrySource(id: string, label: string): PromptSourceDef {
  return { id, label, url: `${PROMPT_REGISTRY_SOURCE_BASE}/${id}.json` };
}

/** 内建远程源（与参考实现 DEFAULT_PROMPT_SOURCES 同一批真实 URL）。 */
const PROMPT_SOURCES: PromptSourceDef[] = [
  registrySource("banana-prompt-quicker", "Banana Prompt Quicker"),
  registrySource("davidwu-gpt-image2-prompts", "DavidWu GPT Image 2"),
  registrySource("freestylefly-gpt-image-2", "Freestylefly GPT Image 2"),
  registrySource("awesome-gpt-image", "Awesome GPT Image"),
  registrySource("awesome-gpt4o-image-prompts", "Awesome GPT-4o"),
  registrySource("youmind-gpt-image-2", "YouMind GPT Image 2"),
  registrySource("youmind-nano-banana-pro", "YouMind Nano Banana Pro"),
];

interface LibraryPromptItem {
  id: string;
  title: string;
  prompt: string;
  tags: string[];
  cover?: string;
  source: string;
}

interface PromptsSnapshot {
  prompts: LibraryPromptItem[];
  sources: { id: string; label: string; count: number }[];
  fetchedAt: string;
}

// ─────────────────────────────────────────── 归一化 adapter

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** 依序取第一个非空字串栏位（容忍各源栏位命名差异）。 */
function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = str(record[key]).trim();
    if (value) return value;
  }
  return "";
}

/** tags 容忍阵列或逗号分隔字串。 */
function pickTags(record: Record<string, unknown>): string[] {
  const raw = record.tags ?? record.tag ?? record.categories;
  const values = Array.isArray(raw) ? raw.map(str) : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = value.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_PROMPT) break;
  }
  return tags;
}

/** 相对路径补成绝对 URL（以来源 JSON 的 URL 为基准）；只接受 http(s) 结果。 */
function absoluteHttpUrl(baseUrl: string, path: string): string {
  if (!path) return "";
  try {
    const resolved = new URL(path, baseUrl).toString();
    return resolved.startsWith("http://") || resolved.startsWith("https://") ? resolved : "";
  } catch {
    return "";
  }
}

/** 容忍根层是阵列或 { prompts | items | data | list } 包裹。 */
function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  for (const key of ["prompts", "items", "data", "list"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

/** 单源归一化：尽力对齐栏位，缺 prompt 的条目跳过。 */
function normalizeSourceItems(source: PromptSourceDef, payload: unknown): LibraryPromptItem[] {
  const seen = new Set<string>();
  const items: LibraryPromptItem[] = [];
  const rawItems = extractItems(payload);
  for (let index = 0; index < rawItems.length; index += 1) {
    const record = asRecord(rawItems[index]);
    const prompt = pickString(record, ["prompt", "content", "text", "en_prompt", "zh_prompt"]);
    if (!prompt) continue;
    const title = pickString(record, ["title", "name", "label"]) || prompt.slice(0, 40);
    const rawId = pickString(record, ["id"]) || String(index + 1).padStart(4, "0");
    const id = `${source.id}:${rawId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const referenceUrls = Array.isArray(record.referenceImageUrls)
      ? record.referenceImageUrls.map(str).map((u) => u.trim()).filter(Boolean)
      : [];
    const coverRaw = pickString(record, ["coverUrl", "cover", "image", "imageUrl", "img"]) || referenceUrls[0] || "";
    const cover = absoluteHttpUrl(source.url, coverRaw);
    items.push({
      id,
      title: title.slice(0, 200),
      prompt,
      tags: pickTags(record),
      ...(cover ? { cover } : {}),
      source: source.id,
    });
  }
  return items;
}

// ─────────────────────────────────────────── 抓取 + 快取（SWR）

async function fetchOneSource(source: PromptSourceDef): Promise<LibraryPromptItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    return normalizeSourceItems(source, payload);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSnapshot(): Promise<PromptsSnapshot> {
  const results = await Promise.all(
    PROMPT_SOURCES.map(async (source) => {
      try {
        return { source, prompts: await fetchOneSource(source) };
      } catch (error) {
        // 单源失败跳过，不挡整体。
        console.error(
          `[canvas-prompts] 抓取来源 ${source.id} 失败（已跳过）:`,
          error instanceof Error ? error.message : error,
        );
        return { source, prompts: [] as LibraryPromptItem[] };
      }
    }),
  );
  return {
    prompts: results.flatMap((r) => r.prompts),
    sources: results.map((r) => ({ id: r.source.id, label: r.source.label, count: r.prompts.length })),
    fetchedAt: new Date().toISOString(),
  };
}

let cache: { snapshot: PromptsSnapshot; fetchedAtMs: number } | null = null;
let inflight: Promise<PromptsSnapshot> | null = null;

function refreshSnapshot(): Promise<PromptsSnapshot> {
  if (!inflight) {
    inflight = fetchSnapshot()
      .then((snapshot) => {
        // 全灭（0 条）不覆盖快取也不快取空结果——下次请求重试，不骗 1 小时空库。
        if (snapshot.prompts.length > 0) cache = { snapshot, fetchedAtMs: Date.now() };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  try {
    let snapshot: PromptsSnapshot;
    if (cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) {
      snapshot = cache.snapshot;
    } else if (cache) {
      // 过期：先回旧资料，背景刷新。
      snapshot = cache.snapshot;
      void refreshSnapshot().catch(() => undefined);
    } else {
      snapshot = await refreshSnapshot();
    }
    if (!snapshot.prompts.length) {
      return fail(502, "提示词源暂时不可用，请稍后重试", "sources_unavailable");
    }

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const tag = (req.nextUrl.searchParams.get("tag") ?? "").trim();
    const source = (req.nextUrl.searchParams.get("source") ?? "").trim();
    let prompts = snapshot.prompts;
    if (source) prompts = prompts.filter((p) => p.source === source);
    if (tag) prompts = prompts.filter((p) => p.tags.includes(tag));
    if (q) prompts = prompts.filter((p) => p.title.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q));

    return NextResponse.json(
      {
        success: true,
        prompts: prompts.slice(0, MAX_PROMPTS_RETURNED),
        sources: snapshot.sources,
        fetchedAt: snapshot.fetchedAt,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas-prompts] aggregate failed:", error);
    return fail(500, "提示词库读取失败，请稍后再试", "internal_error");
  }
}
