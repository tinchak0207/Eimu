// `/openai/v1/*` 測試共用的**上游替身**（只有 *.test.ts 會 import，生產代碼不引用）。
//
// 替身的東西就是被 beforeFiles 代理的那兩個站內入口 + 產物交付 URL：
//   POST {origin}/api/v1/images/generations  → 202 { id }
//   GET  {origin}/api/v1/images/{id}         → 任務快照（依腳本逐次回）
//   GET  {artifactUrl}                       → 產物位元組
// 全程零外網、零花錢（付費上游一次都不碰）。
import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";

let originalFetch: typeof fetch | null = null;

/** 測試一律用佔位 key，嚴禁真 key 進測試檔。 */
export const PLACEHOLDER_BIZ_KEY = `sk-biz-${"0123456789abcdef".repeat(2)}`;
export const PLACEHOLDER_USER_ID = 777;
export const AUTH_HEADER = `Bearer ${PLACEHOLDER_BIZ_KEY}`;

/** 最小合法 PNG 檔頭 + 幾個位元組：b64 往返可逐位元比對。 */
export const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
]);
export const ARTIFACT_URL = "https://cdn.example/openai-compat/art-1.png";
export const TASK_ID = "task-openai-compat-1";

export interface UpstreamScript {
  /** 提交回應狀態（>=400 時回 `submitError` 信封）。 */
  submitStatus?: number;
  submitError?: unknown;
  /** 任務快照序列；用盡後重複最後一項。 */
  taskSnapshots: unknown[];
  artifactBytes?: Uint8Array<ArrayBuffer>;
}

export interface StubCalls {
  submits: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  polls: number;
  artifactFetches: number;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  new Headers(headers).forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  return (method ?? "GET").toUpperCase();
}

/** 裝上替身並回傳呼叫紀錄。呼叫端負責在 afterEach 用 `restoreFetch()` 還原。 */
export function installUpstreamStub(script: UpstreamScript): StubCalls {
  if (!originalFetch) originalFetch = globalThis.fetch;
  const calls: StubCalls = { submits: [], polls: 0, artifactFetches: 0 };
  let snapshotIndex = 0;

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = methodOf(input, init);

    if (url.endsWith("/api/v1/images/generations") && method === "POST") {
      calls.submits.push({
        url,
        headers: headerRecord(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      if (script.submitStatus && script.submitStatus >= 400) {
        return Response.json(
          script.submitError ?? {
            error: {
              message: "上游拒单",
              type: "invalid_request_error",
              code: "upstream_reject",
              param: null,
              trace_id: "trace-upstream",
            },
          },
          { status: script.submitStatus },
        );
      }
      return Response.json(
        {
          object: "image_generation.task",
          id: TASK_ID,
          task_id: TASK_ID,
          status: "queued",
          created: Math.floor(Date.now() / 1000),
        },
        { status: 202 },
      );
    }

    if (method === "GET" && /\/api\/v1\/images\/[^/]+$/.test(url)) {
      calls.polls += 1;
      const snapshot = script.taskSnapshots[Math.min(snapshotIndex, script.taskSnapshots.length - 1)];
      snapshotIndex += 1;
      return Response.json(snapshot, { status: 200 });
    }

    if (url === ARTIFACT_URL) {
      calls.artifactFetches += 1;
      // 包成 Blob：TS 的 BodyInit 不接受 Uint8Array<ArrayBufferLike>，位元組不變。
      return new Response(new Blob([script.artifactBytes ?? PNG_BYTES]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    // 未預期 URL（blob 後端的內部探測、定價覆寫讀取…）：回 404 當作取不到，
    // 讓被測代碼走既有降級路徑（fail-open / fallback），不讓替身假裝成功。
    return new Response("not found", { status: 404 });
  };

  globalThis.fetch = stub as typeof fetch;
  return calls;
}

export function restoreFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

/** 每個測試前重置環境：佔位 key 生效，控制面 DB/代理 origin 一律不設。 */
export function resetCompatEnv(): void {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.OPENAI_COMPAT_GENERATION_ORIGIN;
  delete process.env.OPENAI_COMPAT_MAX_WAIT_MS;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(PLACEHOLDER_BIZ_KEY)}:${PLACEHOLDER_USER_ID}`;
  __resetBizKeyStoreForTests();
}

export function clearCompatEnv(): void {
  delete process.env.BIZ_API_KEY_HASHES;
  delete process.env.OPENAI_COMPAT_MAX_WAIT_MS;
  __resetBizKeyStoreForTests();
}
