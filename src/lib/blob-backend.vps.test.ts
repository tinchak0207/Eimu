// 本次修復的**核心斷言**：VPS 後端 selector 為真、但沒有 BLOB_READ_WRITE_TOKEN 時，
// 必須被視為「後端已設定」——舊病灶（只看 token）會在此靜默落進程內記憶體。
//
// vps-blob-adapter 的 BASE_URL/API_KEY 是模組載入期快照，所以本檔在載入任何被測模組
// **之前**先設好 env，並一律用動態 import。
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

test("核心斷言：VPS selector 為真 + 無 BLOB token → 視為已設定，production 寫入走 VPS 後端且真能讀回", async () => {
  const backend = await import("./blob-backend");
  const cards = await import("./character-card-store");
  const history = await import("./server-history-store");

  // 前提斷言（不成立則本測試無意義）。
  assert.equal(backend.useVpsBlobBackend(), true, "VPS selector 應為真（env 已設）");
  assert.equal(process.env.BLOB_READ_WRITE_TOKEN, undefined, "本測試不得有 BLOB token");

  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const stub = installVpsFetchStub();
  try {
    assert.equal(backend.blobBackendConfigured(), true, "VPS 後端可用即視為已設定（本次修復核心）");
    assert.equal(
      backend.ensureBlobBackendWritable("probe"),
      true,
      "production + VPS 後端：門禁必須放行（舊版此處會 throw 或靜默落記憶體）",
    );
    // 舊病灶的產品級後果：canPersistGeneratedImages() 舊版在此回 false → 生成路由靜默跳過圖片轉存。
    assert.equal(history.canPersistGeneratedImages(), true);

    cards.__resetCharacterCardStoreForTests();
    await cards.saveCharacterCard(1, {
      id: "card-vps",
      name: "VPS 卡",
      kind: "character",
      prompt: "紅髮少女",
      references: [{ url: "https://img.example/a.png", role: "character", name: "定妝照" }],
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    });

    const puts = stub.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1, "寫入應恰發一次 PUT 到 VPS 後端");
    assert.match(puts[0].url, /^https:\/\/vps-data\.example\/api\/blob\//);
    assert.match(decodeURIComponent(puts[0].url), /character-cards\/1\/index-/);
    assert.equal(
      stub.calls.some((call) => call.url.includes("vercel")),
      false,
      "不得有任何請求打到 Vercel Blob",
    );

    // 清掉進程內快取與記憶體後仍能讀回 → 證明資料真的經 VPS 後端序列化往返，不是記憶體假象。
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
