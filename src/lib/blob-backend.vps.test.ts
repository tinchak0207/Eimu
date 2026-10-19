// 本次修复的**核心断言**：VPS 后端 selector 为真、但没有 BLOB_READ_WRITE_TOKEN 时，
// 必须被视为「后端已设定」——旧病灶（只看 token）会在此静默落进程内记忆体。
//
// vps-blob-adapter 的 BASE_URL/API_KEY 是模组载入期快照，所以本档在载入任何被测模组
// **之前**先设好 env，并一律用动态 import。
import { test } from "node:test";
import assert from "node:assert/strict";

const VPS_BASE = "https://vps-data.example";
process.env.IMAGE_DATA_BASE_URL = VPS_BASE;
process.env.IMAGE_DATA_API_KEY = "test-key";
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_ALLOW_MEMORY_FALLBACK;

interface StubCall {
  url: string;
  method: string;
}

/** VPS image-data-api 的替身：真解析 URL／真吃 PUT body／真回 get 文件。 */
function installVpsFetchStub(): {
  calls: StubCall[];
  uploadedPathnames: string[];
  restore: () => void;
} {
  const calls: StubCall[] = [];
  const documents = new Map<string, string>();
  const uploaded: Array<{ pathname: string; url: string; uploadedAt: string }> = [];
  const original = globalThis.fetch;

  const jsonResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const parsed = new URL(url);

    if (parsed.pathname === "/api/blob/list") {
      return jsonResponse({
        blobs: uploaded.map((item) => ({
          url: item.url,
          pathname: item.pathname,
          size: 1,
          uploadedAt: item.uploadedAt,
        })),
        hasMore: false,
      });
    }

    if (parsed.pathname === "/api/blob/get") {
      const pathname = parsed.searchParams.get("path") ?? "";
      const text = documents.get(pathname);
      if (text === undefined) return new Response("not found", { status: 404 });
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json", "x-blob-size": String(text.length) },
      });
    }

    if (parsed.pathname.startsWith("/api/blob/")) {
      const pathname = decodeURIComponent(parsed.pathname.slice("/api/blob/".length));
      if (method === "PUT") {
        const body = init?.body;
        const text =
          body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : typeof body === "string"
              ? body
              : "";
        documents.set(pathname, text);
        const fileUrl = `${VPS_BASE}/files/${pathname}`;
        const uploadedAt = new Date().toISOString();
        uploaded.unshift({ pathname, url: fileUrl, uploadedAt });
        return jsonResponse({ url: fileUrl, pathname, size: text.length, uploadedAt });
      }
      if (method === "DELETE") {
        documents.delete(pathname);
        return jsonResponse({ deleted: 1 });
      }
    }

    return new Response(`unexpected request: ${method} ${url}`, { status: 500 });
  }) as typeof fetch;

  return {
    calls,
    uploadedPathnames: uploaded.map((item) => item.pathname),
    restore: () => { globalThis.fetch = original; },
  };
}

test("核心断言：VPS selector 为真 + 无 BLOB token → 视为已设定，production 写入走 VPS 后端且真能读回", async () => {
  const backend = await import("./blob-backend");
  const cards = await import("./character-card-store");
  const history = await import("./server-history-store");

  // 前提断言（不成立则本测试无意义）。
  assert.equal(backend.useVpsBlobBackend(), true, "VPS selector 应为真（env 已设）");
  assert.equal(process.env.BLOB_READ_WRITE_TOKEN, undefined, "本测试不得有 BLOB token");

  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const stub = installVpsFetchStub();
  try {
    assert.equal(backend.blobBackendConfigured(), true, "VPS 后端可用即视为已设定（本次修复核心）");
    assert.equal(
      backend.ensureBlobBackendWritable("probe"),
      true,
      "production + VPS 后端：门禁必须放行（旧版此处会 throw 或静默落记忆体）",
    );
    // 旧病灶的产品级后果：canPersistGeneratedImages() 旧版在此回 false → 生成路由静默跳过图片转存。
    assert.equal(history.canPersistGeneratedImages(), true);

    cards.__resetCharacterCardStoreForTests();
    await cards.saveCharacterCard(1, {
      id: "card-vps",
      name: "VPS 卡",
      kind: "character",
      prompt: "红发少女",
      references: [{ url: "https://img.example/a.png", role: "character", name: "定妆照" }],
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    });

    const puts = stub.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1, "写入应恰发一次 PUT 到 VPS 后端");
    assert.match(puts[0].url, /^https:\/\/vps-data\.example\/api\/blob\//);
    assert.match(decodeURIComponent(puts[0].url), /character-cards\/1\/index-/);
    assert.equal(
      stub.calls.some((call) => call.url.includes("vercel")),
      false,
      "不得有任何请求打到 Vercel Blob",
    );

    // 清掉进程内快取与记忆体后仍能读回 → 证明资料真的经 VPS 后端序列化往返，不是记忆体假象。
    cards.__resetCharacterCardStoreForTests();
    const roundTripped = await cards.listCharacterCards(1);
    assert.equal(roundTripped.length, 1);
    assert.equal(roundTripped[0].id, "card-vps");
    assert.equal(roundTripped[0].name, "VPS 卡");
  } finally {
    stub.restore();
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    cards.__resetCharacterCardStoreForTests();
  }
});
