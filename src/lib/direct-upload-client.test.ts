// 两段式上传浏览器端薄客户端（D36）——以注入的假 fetch 覆盖四条契约：
//   happy path 的呼叫顺序与参数／maxBytes 超限被拒／PUT 失败重试沿用同一 objectKey／
//   commit 回 alreadyCommitted:true 时不重复上传。
//
// runner 是 `npx --yes tsx --test src/lib/direct-upload-client.test.ts`（repo 的 npm test 脚本），不是 vitest。
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
 * 假后端：记录每一次呼叫（URL／method／headers／body），依 `handlers` 决定 sign／PUT／commit 回应。
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

/**
 * 模拟**浏览器原生 fetch** 的 receiver 要求：`fetch` 是 global 物件的方法，
 * 只有 `this === undefined`（裸呼叫，会被替换成 global）或 `this === globalThis`
 * 才合法；一旦被当成别的物件的方法呼叫（`obj.fetchFn(...)`）就抛
 * `Failed to execute 'fetch' on 'Window': Illegal invocation`。
 *
 * 为什么要这条：Node 的 undici fetch 完全不看 receiver，所以「测试全绿、只有真浏览器爆」
 * ——本替身把那个隐形契约显式化，修复前 sign/commit 两处必红。
 */
function receiverStrictFetch(backend: { fetchFn: typeof fetch }): typeof fetch {
  return function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return backend.fetchFn(input, init);
  } as unknown as typeof fetch;
}

test("happy path：sign → PUT（带 credential.headers）→ commit 的顺序与参数", async () => {
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

  // sign：只送 metadata，零档案位元组；带鉴权与 X-Request-Id。
  const sign = backend.calls[0]!;
  assert.deepEqual(sign.body, { filename: "upload", contentType: "model/gltf-binary", size: 1024 });
  assert.equal(sign.headers.authorization, "Bearer tok");
  assert.equal(sign.headers["x-user-id"], "7");
  const traceId = sign.headers["x-request-id"];
  assert.ok(traceId && traceId.length >= 8, "sign 必带 X-Request-Id");

  // PUT：目标＝物件存储，带凭证 headers 与 content-type。
  const put = backend.calls[1]!;
  assert.equal(put.headers["x-upload-ticket"], "ticket-1");
  assert.equal(put.headers["content-type"], "model/gltf-binary");
  assert.ok(put.body instanceof Blob, "PUT body 是原始档案位元组");

  // commit：带同一 objectKey；X-Request-Id 与 sign 同一次呼叫一致。
  const commit = backend.calls[2]!;
  assert.deepEqual(commit.body, { objectKey: OBJECT_KEY, title: "模型 A" });
  assert.equal(commit.headers["x-request-id"], traceId, "同一次 uploadDirect 用同一个 trace id");

  assert.deepEqual(result, { objectKey: OBJECT_KEY, downloadUrl: DOWNLOAD_URL, alreadyCommitted: false });
  assert.deepEqual(progress, [0, 1]);
});

test("maxBytes 超限：上传前被拒，且不发 PUT／commit", async () => {
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

test("PUT 失败后重试：重跑 sign 带回同一 objectKey（官方协议体），位元组落在同一物件键", async () => {
  const backend = createBackend({
    put: (_call, count) => (count === 1 ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { ok: true })),
  });

  const result = await uploadDirect(glb(512), { fetchFn: backend.fetchFn });

  assert.equal(backend.counts.sign, 2);
  assert.equal(backend.counts.put, 2);
  assert.equal(backend.counts.commit, 1);

  // 第一次 sign 走 metadata 形状。
  assert.deepEqual(backend.calls[0]!.body, { filename: "upload", contentType: "model/gltf-binary", size: 512 });
  // 重试的 sign 走官方协议体，把上次的 objectKey 带回去——不换新键。
  const retrySign = backend.calls[2]!; // order: sign, PUT(fail), sign, PUT(ok), commit
  assert.equal(retrySign.url, "/api/uploads/sign");
  assert.deepEqual(retrySign.body, {
    type: "blob.generate-client-token",
    payload: { pathname: OBJECT_KEY },
    contentType: "model/gltf-binary",
  });

  assert.equal(result.objectKey, OBJECT_KEY);
});

test("commit 回 alreadyCommitted:true：不重复上传，结果忠实回报", async () => {
  const backend = createBackend({
    commit: () => jsonResponse(200, { success: true, alreadyCommitted: true, record: { url: DOWNLOAD_URL } }),
  });

  const result = await uploadDirect(glb(256), { fetchFn: backend.fetchFn });

  assert.equal(result.alreadyCommitted, true);
  assert.equal(backend.counts.put, 1, "alreadyCommitted 不触发第二次上传");
  assert.equal(backend.counts.commit, 1);
});

test("receiver：fetchFn 不得被当方法呼叫——模拟真浏览器 Illegal invocation，sign/PUT/commit 三条都必须成功", async () => {
  const backend = createBackend({});
  const result = await uploadDirect(glb(1024), {
    title: "模型 B",
    headers: { Authorization: "Bearer tok", "x-user-id": "7" },
    fetchFn: receiverStrictFetch(backend),
  });

  assert.equal(backend.counts.sign, 1, "sign 必须真的发出（修复前在 input.fetchFn(...) 就抛）");
  assert.equal(backend.counts.put, 1, "PUT 必须真的发出");
  assert.equal(backend.counts.commit, 1, "commit 必须真的发出（修复前在 input.fetchFn(...) 就抛）");
  assert.deepEqual(
    backend.calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/uploads/sign", `PUT ${CREDENTIAL.uploadUrl}`, "POST /api/uploads/commit"],
  );
  assert.equal(result.objectKey, OBJECT_KEY);
});

test("PUT 首次失败＋重试仍失败：抛出具名 PUT 失败错误（不吞）", async () => {
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
  assert.equal(backend.counts.sign, 2, "两次尝试＝两次 sign（同一 objectKey）");
  assert.equal(backend.counts.commit, 0);
});
