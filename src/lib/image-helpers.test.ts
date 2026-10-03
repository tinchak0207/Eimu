import test from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_FETCH_TIMEOUT_MS,
  PNG_REENCODE_TIMEOUT_MS,
  downloadExtension,
  imageHelpers,
  mediaExtensionFromUrl,
} from "./image-helpers.ts";

/**
 * 保证 promise 在观察窗内 settle；否则以「未 settle」失败。
 * 用于「先红后绿」：修復前取图等待无界 → 这里必落 did-not-settle（红）；
 * 修復后 timeout 主动 abort → 正常 reject（绿）。绝不靠等真实的 30s 默认值。
 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("mediaExtensionFromUrl 认出常见媒体副档名", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp3"), "mp3");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.m4a"), "m4a");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp4"), "mp4");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.webp"), "webp");
});

test("mediaExtensionFromUrl 带 query 或 hash 也认，大小写归一", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp3?download=1&token=xyz"), "mp3");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.M4A#t=3"), "m4a");
});

test("mediaExtensionFromUrl 非媒体/无副档名返回 null，downloadExtension 回落 png", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/download"), null);
  assert.equal(mediaExtensionFromUrl("https://blob.example/archive.zip"), null);
  assert.equal(mediaExtensionFromUrl("data:image/png;base64,AAAA"), null);
  assert.equal(downloadExtension("https://blob.example/download"), "png");
  assert.equal(downloadExtension("data:image/png;base64,AAAA"), "png");
});

// 2026-10-04 缺陷 B：本站批量导出必须与单张下载共用同一条 CORS 可用链。
// fetchImageResponse 是这条链的唯一入口——它必须补 ?dl=1（换缓存键）并带
// cache:"no-store"（绕过 <img> no-cors 留下的无 ACAO 缓存体）。
test("fetchImageResponse 对 http(s) 源补 ?dl=1 且 no-store", async () => {
  const calls: { url: string; cache?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), cache: init?.cache });
    return new Response(new Blob(["x"]), { status: 200 });
  }) as typeof fetch;
  try {
    await imageHelpers.fetchImageResponse("https://store.tinchak0207.xyz/image-data/files/a.png");
    assert.deepEqual(calls, [
      { url: "https://store.tinchak0207.xyz/image-data/files/a.png?dl=1", cache: "no-store" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchImageResponse 源已有 query 时用 & 追加 dl=1", async () => {
  let seen = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen = String(input);
    return new Response(new Blob(["x"]), { status: 200 });
  }) as typeof fetch;
  try {
    await imageHelpers.fetchImageResponse("https://store.tinchak0207.xyz/a.png?token=t1");
    assert.equal(seen, "https://store.tinchak0207.xyz/a.png?token=t1&dl=1");
  } finally {
    globalThis.fetch = original;
  }
});

// 2026-10-04「永久 pending」族：取图等待原本无界。以下两条是修復的先把关：
// ① 逾时必须在限时内 settle 且为具人话的明确失败（不靠等真实的 30s）；
// ② 非逾时的网络错误原样透传（不被误报成逾时）。
test("fetchImageResponse：上游永不回应 → timeout 主动 abort，落人话错误（限时内 settle）", async () => {
  const original = globalThis.fetch;
  // 模拟真实 fetch：监听 signal，abort 时 reject（半开连线永不 resolve）。
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });
  }) as typeof fetch;
  try {
    const started = Date.now();
    await assert.rejects(
      settlesWithin(
        imageHelpers.fetchImageResponse("https://store.tinchak0207.xyz/never.png", 40),
        400,
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "图片下载超时，请重试。");
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30 && elapsed < 400, `timeout 应在 ~40ms 生效（实测 ${elapsed}ms）`);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchImageResponse：非逾时的网络失败原样透传（不吞成逾时人话）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      imageHelpers.fetchImageResponse("https://store.tinchak0207.xyz/x.png", 5_000),
      /Failed to fetch/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("IMAGE_FETCH_TIMEOUT_MS 是秒级上限（单张图不该等太久，也不短到误杀慢网）", () => {
  assert.ok(IMAGE_FETCH_TIMEOUT_MS >= 10_000, "上限不得短于 10 秒");
  assert.ok(IMAGE_FETCH_TIMEOUT_MS <= 60_000, "上限不得长于 60 秒");
});

// 2026-10-04「永久 pending」族（同 captureFrame 形态）：reencodeAsPng 的 canvas.toBlob
// 无事件/错误通道，回调不触发就永久 pending → copyToClipboard 永不 settle。以下先用
// 窗口内 settle 逼出「未 settle」红，再看 timeout 具名 reject。
function stubBrowserForReencode(): {
  canvas: { toBlob: (...args: unknown[]) => void };
  restore: () => void;
} {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    Image: globals.Image,
    document: globals.document,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  globals.Image = class {
    naturalWidth = 4;
    naturalHeight = 4;
    onload: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    set src(_value: string) {
      this.onload?.();
    }
  };
  // toBlob 故意不回调：复现「回调永不触发」。
  const canvas = { toBlob: () => {} };
  globals.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: canvas.toBlob }),
  };
  URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  return {
    canvas,
    restore: () => {
      if (saved.Image === undefined) delete globals.Image;
      else globals.Image = saved.Image;
      if (saved.document === undefined) delete globals.document;
      else globals.document = saved.document;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    },
  };
}

test("reencodeAsPng：canvas.toBlob 永不回调 → timeout 落人话错误（限时内 settle，不永久 pending）", async () => {
  const stub = stubBrowserForReencode();
  try {
    const started = Date.now();
    await assert.rejects(
      settlesWithin(imageHelpers.reencodeAsPng(new Blob(["x"], { type: "image/jpeg" }), 40), 400),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "图片转 PNG 超时，请重试。");
        return true;
      },
    );
    assert.ok(Date.now() - started < 400, "逾时必须限时生效");
  } finally {
    stub.restore();
  }
});

test("PNG_REENCODE_TIMEOUT_MS 是秒级上限（不长到掩盖卡死，也不短到误杀）", () => {
  assert.ok(PNG_REENCODE_TIMEOUT_MS >= 5_000);
  assert.ok(PNG_REENCODE_TIMEOUT_MS <= 30_000);
});
