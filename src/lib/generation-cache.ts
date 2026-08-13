import type { ProviderKey } from "./provider-config";
import type { GenerationWorkflowMetadata } from "./image-types";

export interface PersistedGenerationResult {
  provider: ProviderKey;
  modelId: string;
  image: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  mediaType?: "image" | "video";
  endpointLabel?: string;
  taskId?: string;
  resultId?: string;
}

export interface PersistedGenerationEntry {
  id: string;
  prompt: string;
  generatedAt: number;
  results: PersistedGenerationResult[];
  source: "local" | "server";
  workflow?: GenerationWorkflowMetadata;
  taskId?: string;
  primaryResultId?: string;
}

export interface PersistedGenerationCurrent extends PersistedGenerationEntry {
  userId: number;
  username: string;
}

export interface PersistedGenerationCache {
  current: PersistedGenerationCurrent | null;
  historyByUser: Record<string, PersistedGenerationEntry[]>;
}

interface RecordGenerationInput {
  userId: number;
  username: string;
  prompt: string;
  generatedAt: number;
  results: PersistedGenerationResult[];
  workflow?: GenerationWorkflowMetadata;
}

const MAX_HISTORY_PER_USER = 20;
const STORAGE_KEY = "image_generation_cache_v1";

export function createEmptyGenerationCache(): PersistedGenerationCache {
  return {
    current: null,
    historyByUser: {},
  };
}

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * 校验反序列化出来的缓存形状。
 *
 * 之前这里只 catch 了 JSON 语法错误 —— 一份语法合法但结构不对的载荷
 * （比如少了 historyByUser，或者被别的版本写成了数组）会原样返回，
 * 随后 `cache.historyByUser[String(userId)]` 抛 TypeError，把整个历史页带崩。
 * 存储是尽力而为的，读不懂就当空的，绝不该让页面打不开。
 */
function coerceGenerationCache(payload: unknown): PersistedGenerationCache {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return createEmptyGenerationCache();
  }

  const raw = payload as Partial<PersistedGenerationCache>;
  const historyByUser: Record<string, PersistedGenerationEntry[]> = {};

  if (typeof raw.historyByUser === "object" && raw.historyByUser !== null && !Array.isArray(raw.historyByUser)) {
    for (const [userId, entries] of Object.entries(raw.historyByUser)) {
      if (!Array.isArray(entries)) continue;
      historyByUser[userId] = entries.filter(
        (entry): entry is PersistedGenerationEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as PersistedGenerationEntry).id === "string" &&
          Array.isArray((entry as PersistedGenerationEntry).results),
      );
    }
  }

  const current =
    typeof raw.current === "object" &&
    raw.current !== null &&
    typeof (raw.current as PersistedGenerationCurrent).id === "string" &&
    Array.isArray((raw.current as PersistedGenerationCurrent).results)
      ? (raw.current as PersistedGenerationCurrent)
      : null;

  return { current, historyByUser };
}

export function readGenerationCache(): PersistedGenerationCache {
  if (!isBrowser()) return createEmptyGenerationCache();

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Safari 无痕模式下访问 localStorage 会直接抛异常。
    return createEmptyGenerationCache();
  }
  if (!raw) return createEmptyGenerationCache();

  try {
    return coerceGenerationCache(JSON.parse(raw) as unknown);
  } catch {
    return createEmptyGenerationCache();
  }
}

export function writeGenerationCache(cache: PersistedGenerationCache): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stripImagePayloads(cache)));
    } catch {
      // Cache is best-effort; generation must not fail because localStorage is full.
    }
  }
}

function stripImagePayloads(cache: PersistedGenerationCache): PersistedGenerationCache {
  const stripEntry = <T extends PersistedGenerationEntry>(entry: T): T => ({
    ...entry,
    results: entry.results.map((result) => ({ ...result, image: null })),
  });

  return {
    current: cache.current ? stripEntry(cache.current) : null,
    historyByUser: Object.fromEntries(
      Object.entries(cache.historyByUser).map(([userId, entries]) => [
        userId,
        entries.map(stripEntry),
      ]),
    ),
  };
}

export function recordGenerationResult(
  cache: PersistedGenerationCache,
  input: RecordGenerationInput,
): PersistedGenerationCache {
  const stableTaskId = input.results.map((result) => result.taskId).find(Boolean);
  const primaryResultId = input.results.map((result) => result.resultId).find(Boolean);
  const entry: PersistedGenerationEntry = {
    id: stableTaskId ?? `${input.userId}-${input.generatedAt}`,
    prompt: input.prompt,
    generatedAt: input.generatedAt,
    // base64 不落 localStorage：多 MB 的同步 JSON.stringify 会在生成结束瞬间阻塞主线程数百 ms，
    // 且几乎必然触发 5MB 配额异常。召回只需要 prompt/workflow，刷新后回显走 imageUrl。
    results: input.results.map((result) => ({ ...result, image: null })),
    source: "local",
    workflow: input.workflow,
    ...(stableTaskId ? { taskId: stableTaskId } : {}),
    ...(primaryResultId ? { primaryResultId } : {}),
  };

  const userKey = String(input.userId);
  const nextUserHistory = [entry, ...(cache.historyByUser[userKey] ?? [])]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, MAX_HISTORY_PER_USER);

  return {
    current: {
      ...entry,
      userId: input.userId,
      username: input.username,
    },
    historyByUser: {
      ...cache.historyByUser,
      [userKey]: nextUserHistory,
    },
  };
}

export function selectPersistedHistoryForUser(
  cache: PersistedGenerationCache,
  userId: number,
): PersistedGenerationEntry[] {
  return cache.historyByUser[String(userId)] ?? [];
}

export function mergePersistedHistory(
  cache: PersistedGenerationCache,
  userId: number,
  serverEntries: PersistedGenerationEntry[],
): PersistedGenerationEntry[] {
  const localEntries = selectPersistedHistoryForUser(cache, userId);
  const merged = [...localEntries, ...serverEntries];

  return merged
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index)
    .sort((a, b) => b.generatedAt - a.generatedAt);
}
