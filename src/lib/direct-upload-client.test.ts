// 兩段式上傳瀏覽器端薄客戶端（D36）——以注入的假 fetch 覆蓋四條契約：
//   happy path 的呼叫順序與參數／maxBytes 超限被拒／PUT 失敗重試沿用同一 objectKey／
//   commit 回 alreadyCommitted:true 時不重複上傳。
//
// runner 是 `npx --yes tsx --test src/lib/direct-upload-client.test.ts`（repo 的 npm test 腳本），不是 vitest。
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadDirect, DirectUploadError, UPLOAD_TOO_LARGE_CODE, PUT_FAILED_CODE } from "./direct-upload-client";

const OBJECT_KEY = "uploads/7/20261004/deadbeef-model.glb";
const DOWNLOAD_URL = "https://store.example/image-data/files/" + OBJECT_KEY;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CREDENTIAL = {
  success: true,
  backend: "vps-blob",
  objectKey: OBJECT_KEY,
  uploadUrl: "https://store.example/image-data/api/blob/" + OBJECT_KEY,
  method: "PUT",
  clientToken: "ticket-1",
  contentType: "model/gltf-binary",
  maxBytes: 104_857_600,
  downloadUrl: DOWNLOAD_URL,
  headers: {
    "x-upload-ticket": "ticket-1",
    "x-upload-path": OBJECT_KEY,
    "x-upload-expires": "1899999999999",
    "x-content-type": "model/gltf-binary",
  },
};

/**
 * 假後端：記錄每一次呼叫（URL／method／headers／body），依 `handlers` 決定 sign／PUT／commit 回應。
 */
function createBackend(handlers: {
  sign?: (call: Call, count: number) => Response;
  put?: (call: Call, count: number) => Response;
  commit?: (call: Call, count: number) => Response;
}): { fetchFn: typeof fetch; calls: Call[]; counts: { sign: number; put: number; commit: number } } {
  const calls: Call[] = [];
  const counts = { sign: 0, put: 0, commit: 0 };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const call: Call = { url, method, headers, body };
    calls.push(call);

    if (url.endsWith("/api/uploads/sign")) {
      counts.sign += 1;
      return handlers.sign ? handlers.sign(call, counts.sign) : jsonResponse(200, CREDENTIAL);
    }
    if (method === "PUT") {
      counts.put += 1;
      return handlers.put ? handlers.put(call, counts.put) : jsonResponse(200, { ok: true });
    }
    if (url.endsWith("/api/uploads/commit")) {
      counts.commit += 1;
      return handlers.commit
        ? handlers.commit(call, counts.commit)
        : jsonResponse(200, { success: true, alreadyCommitted: false, record: { url: DOWNLOAD_URL } });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls, counts };
}

function glb(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "model/gltf-binary" });
}

test("happy path：sign → PUT（帶 credential.headers）→ commit 的順序與參數", async () => {
  const backend = createBackend({});
  const progress: number[] = [];
  const result = await uploadDirect(glb(1024), {
    title: "模型 A",
    headers: { Authorization: "Bearer tok", "x-user-id": "7" },
    onProgress: (p) => progress.push(p),
    fetchFn: backend.fetchFn,
  });

  assert.equal(backend.counts.sign, 1);
  assert.equal(backend.counts.put, 1);
  assert.equal(backend.counts.commit, 1);
  assert.deepEqual(
    backend.calls.map((c) => `${c.method} ${c.url}`),
    [
      `POST /api/uploads/sign`,
      `PUT ${CREDENTIAL.uploadUrl}`,
      `POST /api/uploads/commit`,
    ],
  );

  // sign：只送 metadata，零檔案位元組；帶鑑權與 X-Request-Id。
  const sign = backend.calls[0]!;
  assert.deepEqual(sign.body, { filename: "upload", contentType: "model/gltf-binary", size: 1024 });
  assert.equal(sign.headers.authorization, "Bearer tok");
  assert.equal(sign.headers["x-user-id"], "7");
  const traceId = sign.headers["x-request-id"];
  assert.ok(traceId && traceId.length >= 8, "sign 必帶 X-Request-Id");

  // PUT：目標＝物件存儲，帶憑證 headers 與 content-type。
  const put = backend.calls[1]!;
  assert.equal(put.headers["x-upload-ticket"], "ticket-1");
  assert.equal(put.headers["content-type"], "model/gltf-binary");
  assert.ok(put.body instanceof Blob, "PUT body 是原始檔案位元組");

  // commit：帶同一 objectKey；X-Request-Id 與 sign 同一次呼叫一致。
  const commit = backend.calls[2]!;
  assert.deepEqual(commit.body, { objectKey: OBJECT_KEY, title: "模型 A" });
  assert.equal(commit.headers["x-request-id"], traceId, "同一次 uploadDirect 用同一個 trace id");

  assert.deepEqual(result, { objectKey: OBJECT_KEY, downloadUrl: DOWNLOAD_URL, alreadyCommitted: false });
  assert.deepEqual(progress, [0, 1]);
});

test("maxBytes 超限：上傳前被拒，且不發 PUT／commit", async () => {
  const backend = createBackend({
    sign: () => jsonResponse(200, { ...CREDENTIAL, maxBytes: 100 }),
  });
  await assert.rejects(
    () => uploadDirect(glb(200), { fetchFn: backend.fetchFn }),
    (error: unknown) => {
      assert.ok(error instanceof DirectUploadError);
      assert.equal(error.code, UPLOAD_TOO_LARGE_CODE);
      return true;
    },
  );
  assert.equal(backend.counts.sign, 1);
  assert.equal(backend.counts.put, 0);
  assert.equal(backend.counts.commit, 0);
});

test("PUT 失敗後重試：重跑 sign 帶回同一 objectKey（官方協議體），位元組落在同一物件鍵", async () => {
  const backend = createBackend({
    put: (_call, count) => (count === 1 ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { ok: true })),
  });

  const result = await uploadDirect(glb(512), { fetchFn: backend.fetchFn });

  assert.equal(backend.counts.sign, 2);
  assert.equal(backend.counts.put, 2);
  assert.equal(backend.counts.commit, 1);

  // 第一次 sign 走 metadata 形狀。
  assert.deepEqual(backend.calls[0]!.body, { filename: "upload", contentType: "model/gltf-binary", size: 512 });
  // 重試的 sign 走官方協議體，把上次的 objectKey 帶回去——不換新鍵。
  const retrySign = backend.calls[2]!; // order: sign, PUT(fail), sign, PUT(ok), commit
  assert.equal(retrySign.url, "/api/uploads/sign");
  assert.deepEqual(retrySign.body, {
    type: "blob.generate-client-token",
    payload: { pathname: OBJECT_KEY },
    contentType: "model/gltf-binary",
  });

  assert.equal(result.objectKey, OBJECT_KEY);
});

test("commit 回 alreadyCommitted:true：不重複上傳，結果忠實回報", async () => {
  const backend = createBackend({
    commit: () => jsonResponse(200, { success: true, alreadyCommitted: true, record: { url: DOWNLOAD_URL } }),
  });

  const result = await uploadDirect(glb(256), { fetchFn: backend.fetchFn });

  assert.equal(result.alreadyCommitted, true);
  assert.equal(backend.counts.put, 1, "alreadyCommitted 不觸發第二次上傳");
  assert.equal(backend.counts.commit, 1);
});

test("PUT 首次失敗＋重試仍失敗：拋出具名 PUT 失敗錯誤（不吞）", async () => {
  const backend = createBackend({
    put: () => jsonResponse(502, { error: "down" }),
  });
  await assert.rejects(
    () => uploadDirect(glb(128), { fetchFn: backend.fetchFn }),
    (error: unknown) => {
      assert.ok(error instanceof DirectUploadError);
      assert.equal(error.code, PUT_FAILED_CODE);
      return true;
    },
  );
  assert.equal(backend.counts.sign, 2, "兩次嘗試＝兩次 sign（同一 objectKey）");
  assert.equal(backend.counts.commit, 0);
});
