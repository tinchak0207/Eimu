import test from "node:test";
import assert from "node:assert/strict";

import { MAX_VIDEO_BYTES, buildAssetUrl, uploadVideoDirect } from "./agent-uploads";

// node 没有 window/localStorage：mintUploadsTicket 的登录检查走 new-api-client 的
// getStoredToken/getStoredUser（typeof window === "undefined" 即判未登录）。
// 桩掉这两个全局让被测模块以为「已登录」，铸票请求一并落到下面 mock 的 fetch。
const authStore = new Map<string, string>([
  ["napi_token", "tok-test"],
  ["napi_user", JSON.stringify({ id: 7 })],
]);
const g = globalThis as unknown as Record<string, unknown>;
if (g.window === undefined) g.window = {};
g.localStorage = {
  getItem: (k: string) => authStore.get(k) ?? null,
  setItem: (k: string, v: string) => void authStore.set(k, v),
  removeItem: (k: string) => void authStore.delete(k),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 换掉全局 fetch：uploads-ticket 一律发真票，其余交给 handler；跑完还原。 */
async function withFetch<T>(
  handler: (call: FetchCall) => Response,
  run: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    if (call.url.includes("/uploads-ticket")) {
      return jsonResponse({ ticket: "t-abc", expires_in_ms: 3_600_000 });
    }
    return handler(call);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function videoFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
}

test("uploadVideoDirect：成功回单个 video ref；URL 打网关 video-upload 带票；body 是 multipart 且不设 Content-Type", async () => {
  await withFetch(
    () =>
      jsonResponse({
        ok: true,
        path: "uploads/s1/clip.mp4",
        name: "clip.mp4",
        size: 98765,
        mime: "video/mp4",
      }),
    async (calls) => {
      const file = videoFile();
      const ref = await uploadVideoDirect("s1", file);
      assert.deepEqual(ref, {
        kind: "video",
        path: "uploads/s1/clip.mp4",
        name: "clip.mp4",
        mime: "video/mp4",
        size: 98765,
      });
      // 第一发是铸票（站内代理），第二发才是网关直传。
      assert.equal(calls.length, 2);
      assert.match(calls[0]!.url, /\/api\/agent\/sessions\/s1\/uploads-ticket$/);
      const upload = calls[1]!;
      assert.equal(
        upload.url,
        "https://store.eimu.dev/agent/v1/sessions/s1/video-upload?t=t-abc",
      );
      assert.equal(upload.init?.method, "POST");
      assert.ok(upload.init?.body instanceof FormData);
      assert.equal((upload.init!.body as FormData).get("file"), file);
      // 不设 Content-Type：FormData 要由浏览器补 multipart boundary。
      const headers = upload.init?.headers;
      assert.ok(
        headers === undefined ||
          !Object.keys(headers as Record<string, string>).some(
            (k) => k.toLowerCase() === "content-type",
          ),
      );
    },
  );
});

test("uploadVideoDirect：会话 id 含特殊字符时 URL 逐段编码", async () => {
  await withFetch(
    () => jsonResponse({ ok: true, path: "uploads/x/clip.mp4", name: "clip.mp4", size: 3, mime: "video/mp4" }),
    async (calls) => {
      await uploadVideoDirect("s/1 x", videoFile());
      assert.equal(calls.length, 2);
      assert.match(calls[1]!.url, /\/sessions\/s%2F1%20x\/video-upload\?t=t-abc$/);
    },
  );
});

test("uploadVideoDirect：响应缺 mime/size/name 时回退 file 自身值，mime 兜底 video/mp4", async () => {
  await withFetch(
    () => jsonResponse({ ok: true, path: "uploads/s1/clip.mp4" }),
    async () => {
      const ref = await uploadVideoDirect("s1", videoFile());
      assert.equal(ref.kind, "video");
      assert.equal(ref.mime, "video/mp4");
      assert.equal(ref.size, 3);
      assert.equal(ref.name, "clip.mp4");
    },
  );
});

test("uploadVideoDirect：413/415/401 各抛带语义的错（呼叫端据此降级抽帧）", async () => {
  for (const [status, pattern] of [
    [413, /100 MB/],
    [415, /格式/],
    [401, /票/],
    [500, /HTTP 500/],
  ] as const) {
    await withFetch(() => jsonResponse({ ok: false }, status), async () => {
      await assert.rejects(() => uploadVideoDirect("s1", videoFile()), pattern);
    });
  }
});

test("uploadVideoDirect：200 但 ok!==true 或缺 path 一律抛错", async () => {
  await withFetch(() => jsonResponse({ ok: false, path: "uploads/s1/clip.mp4" }), async () => {
    await assert.rejects(() => uploadVideoDirect("s1", videoFile()), /path|ok/);
  });
  await withFetch(() => jsonResponse({ ok: true }), async () => {
    await assert.rejects(() => uploadVideoDirect("s1", videoFile()), /path/);
  });
});

test("MAX_VIDEO_BYTES 与网关 100MB 硬顶对齐", () => {
  assert.equal(MAX_VIDEO_BYTES, 100 * 1024 * 1024);
});

test("buildAssetUrl：video 气泡读回 URL 指向网关 uploads 路径带票", () => {
  assert.equal(
    buildAssetUrl("s1", "uploads/s1/clip.mp4", "t-9"),
    "https://store.eimu.dev/agent/v1/uploads/s1/clip.mp4?t=t-9",
  );
});
