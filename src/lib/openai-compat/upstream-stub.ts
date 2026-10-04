// `/openai/v1/*` 测试共用的**上游替身**（只有 *.test.ts 会 import，生产代码不引用）。
//
// 替身的东西就是被 beforeFiles 代理的那两个站内入口 + 产物交付 URL：
//   POST {origin}/api/v1/images/generations  → 202 { id }
//   GET  {origin}/api/v1/images/{id}         → 任务快照（依脚本逐次回）
//   GET  {artifactUrl}                       → 产物位元组
// 全程零外网、零花钱（付费上游一次都不碰）。
import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";

let originalFetch: typeof fetch | null = null;

/** 测试一律用占位 key，严禁真 key 进测试档。 */
export const PLACEHOLDER_BIZ_KEY = `sk-biz-${"0123456789abcdef".repeat(2)}`;
export const PLACEHOLDER_USER_ID = 777;
export const AUTH_HEADER = `Bearer ${PLACEHOLDER_BIZ_KEY}`;

/** 最小合法 PNG 档头 + 几个位元组：b64 往返可逐位元比对。 */
export const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
]);
export const ARTIFACT_URL = "https://cdn.example/openai-compat/art-1.png";
export const TASK_ID = "task-openai-compat-1";

export interface UpstreamScript {
  /** 提交回应状态（>=400 时回 `submitError` 信封）。 */
  submitStatus?: number;
  submitError?: unknown;
  /** 任务快照序列；用尽后重复最后一项。 */
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

/** 装上替身并回传呼叫纪录。呼叫端负责在 afterEach 用 `restoreFetch()` 还原。 */
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
      // 包成 Blob：TS 的 BodyInit 不接受 Uint8Array<ArrayBufferLike>，位元组不变。
      return new Response(new Blob([script.artifactBytes ?? PNG_BYTES]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    // 未预期 URL（blob 后端的内部探测、定价覆写读取…）：回 404 当作取不到，
    // 让被测代码走既有降级路径（fail-open / fallback），不让替身假装成功。
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

/** 每个测试前重置环境：占位 key 生效，控制面 DB/代理 origin 一律不设。 */
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
