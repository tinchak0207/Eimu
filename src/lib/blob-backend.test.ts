// 物件儲存後端門禁測試（全部為**行為斷言**：真呼叫真函式、比對真拋錯/真回傳，非源碼字串掃描）。
//
// 病灶（本檔守住的回歸）：7 個 store 各自只看 `BLOB_READ_WRITE_TOKEN`。生產切到 VPS
// image-data-api 後端時該 token 為空 → 全部誤判「無後端」→ 靜默落進程內記憶體。
// Vercel 每個 serverless 實例各有自己的記憶體，冷啟動即消失，而用戶看到的是「寫入成功」。
//
// 本檔必須在任何 blob-backend 匯入**之前**清掉後端 env：vps-blob-adapter 的
// BASE_URL/API_KEY 是模組載入期快照，所以本檔一律用動態 import 載入被測模組。
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.IMAGE_DATA_BASE_URL;
delete process.env.IMAGE_DATA_API_KEY;
delete process.env.BLOB_ALLOW_MEMORY_FALLBACK;

type EnvPatch = Record<string, string | undefined>;

/** 臨時改 env（NODE_ENV / 後端變數都是呼叫期讀取，可動態切換），結束必定還原。 */
async function withEnv<T>(patch: EnvPatch, run: () => Promise<T>): Promise<T> {
  const saved: EnvPatch = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 被測模組一律動態載入（見檔頭說明：模組載入期 env 快照）。 */
async function loadModules() {
  const [backend, cards, projects, assets, packs, scope, gates, history] = await Promise.all([
    import("./blob-backend"),
    import("./character-card-store"),
    import("./canvas/project-store"),
    import("./canvas/asset-store"),
    import("./asset-pack-store"),
    import("./asset-scope-store"),
    import("./generation-gate-log"),
    import("./server-history-store"),
  ]);
  return { backend, cards, projects, assets, packs, scope, gates, history };
}

/** 7 個 store 的讀取入口（零輸入，故無「參數不合法而靜默早退」的假通過空間）。 */
function readEntryPoints(m: Awaited<ReturnType<typeof loadModules>>): Array<[string, () => Promise<unknown>]> {
  return [
    ["character-card-store.listCharacterCards", () => m.cards.listCharacterCards(1)],
    ["canvas/project-store.listCanvasProjects", () => m.projects.listCanvasProjects(1)],
    ["canvas/asset-store.listCanvasAssets", () => m.assets.listCanvasAssets(1)],
    ["asset-pack-store.listAssetPacks", () => m.packs.listAssetPacks(1)],
    ["asset-scope-store.listAssetShares", () => m.scope.listAssetShares(1)],
    ["asset-scope-store.listAssetMounts", () => m.scope.listAssetMounts(1)],
    ["generation-gate-log.listGateLog", () => m.gates.listGateLog(1)],
    ["server-history-store.listGeneratedHistoryEntries", () => m.history.listGeneratedHistoryEntries(1)],
  ];
}

function card(id: string) {
  return {
    id,
    name: `卡-${id}`,
    kind: "character" as const,
    prompt: "紅髮少女",
    references: [{ url: "https://img.example/a.png", role: "character" as const, name: "定妝照" }],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

/**
 * 真 HTTP 替身（@vercel/blob 走 undici 的 fetch，攔 globalThis.fetch 無效；
 * 改以 VERCEL_BLOB_API_URL 把 Vercel API 指到本機伺服器＝真請求、真路由）。
 */
async function startLocalBlobApi(): Promise<{
  baseUrl: string;
  calls: Array<{ method: string; path: string }>;
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const calls: Array<{ method: string; path: string }> = [];
  const server = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    calls.push({ method, path: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    if (method === "PUT") {
      res.end(JSON.stringify({
        url: "https://stub.public.blob.vercel-storage.com/probe",
        downloadUrl: "https://stub.public.blob.vercel-storage.com/probe",
        pathname: "probe",
        contentType: "application/json",
        contentDisposition: "inline",
        etag: "test-etag",
      }));
      return;
    }
    res.end(JSON.stringify({ blobs: [], hasMore: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/blob`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("production + 無後端：7 個 store 的讀取路徑全部誠實失敗，不得回空陣列冒充「這用戶沒有資料」", async () => {
  const m = await loadModules();
  await withEnv(
    { NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: undefined, BLOB_ALLOW_MEMORY_FALLBACK: undefined },
    async () => {
      assert.equal(m.backend.blobBackendConfigured(), false, "無後端時 blobBackendConfigured() 必須為 false");
      for (const [label, run] of readEntryPoints(m)) {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(
            error instanceof m.backend.BlobBackendUnconfiguredError,
            `${label} 應拋 BlobBackendUnconfiguredError，實際：${String(error)}`,
          );
          return true;
        });
      }
    },
  );
});

test("非 production + 無後端：允許記憶體降級（同一組讀取入口回空陣列＝控制組，證明呼叫可達）", async () => {
  const m = await loadModules();
  await withEnv(
    { NODE_ENV: "test", BLOB_READ_WRITE_TOKEN: undefined, BLOB_ALLOW_MEMORY_FALLBACK: undefined },
    async () => {
      assert.equal(m.backend.blobBackendConfigured(), false);
      assert.equal(m.backend.ensureBlobBackendWritable("probe"), false, "非生產允許降級時回 false（呼叫端走記憶體）");
      for (const [label, run] of readEntryPoints(m)) {
        assert.deepEqual(await run(), [], `${label} 非生產降級路徑應回空陣列`);
      }
    },
  );
});

test("production + 無後端：寫入路徑誠實失敗（帶非生產控制組，證明輸入合法且路徑可達）", async () => {
  const m = await loadModules();
  const writes: Array<[string, () => Promise<unknown>, () => void]> = [
    [
      "character-card-store.saveCharacterCard",
      () => m.cards.saveCharacterCard(1, card("card-a")),
      () => m.cards.__resetCharacterCardStoreForTests(),
    ],
    [
      "canvas/project-store.saveCanvasProject",
      () =>
        m.projects.saveCanvasProject(1, {
          id: "proj-a",
          title: "專案",
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
          nodes: [],
          connections: [],
          viewport: { x: 0, y: 0, k: 1 },
          backgroundMode: "dots",
        }),
      () => m.projects.__resetCanvasStoreForTests(),
    ],
    [
      "canvas/asset-store.saveCanvasAsset",
      () =>
        m.assets.saveCanvasAsset(1, {
          id: "asset-a",
          kind: "text",
          title: "素材",
          content: "正文",
          tags: [],
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
        }),
      () => m.assets.__resetCanvasAssetStoreForTests(),
    ],
    [
      "generation-gate-log.appendGateLog",
      () =>
        m.gates.appendGateLog(1, {
          id: "gate-a",
          at: "2026-09-25T00:00:00.000Z",
          modelId: "gpt-image-2",
          blocked: false,
          checks: [],
        }),
      () => m.gates.__resetGateLogStoreForTests(),
    ],
  ];

  await withEnv({ NODE_ENV: "test", BLOB_ALLOW_MEMORY_FALLBACK: undefined }, async () => {
    for (const [label, run, reset] of writes) {
      reset();
      await run(); // 控制組：輸入合法且非生產路徑可寫 → 不 reject
      reset();
    }
  });

  await withEnv({ NODE_ENV: "production", BLOB_ALLOW_MEMORY_FALLBACK: undefined }, async () => {
    for (const [label, run, reset] of writes) {
      reset();
      await assert.rejects(run, (error: unknown) => {
        assert.ok(
          error instanceof m.backend.BlobBackendUnconfiguredError,
          `${label} 應誠實失敗，實際：${String(error)}`,
        );
        return true;
      });
      reset();
    }
  });
});

test("production + 無後端：錯誤訊息含可操作指引（要設哪兩個 VPS env / 哪個 token / 哪個 opt-in）", async () => {
  const m = await loadModules();
  await withEnv({ NODE_ENV: "production", BLOB_ALLOW_MEMORY_FALLBACK: undefined }, async () => {
    await assert.rejects(
      async () => {
        m.backend.ensureBlobBackendWritable("probe-context");
      },
      (error: unknown) => {
        assert.ok(error instanceof m.backend.BlobBackendUnconfiguredError);
        const message = (error as Error).message;
        assert.match(message, /probe-context/);
        assert.match(message, /IMAGE_DATA_BASE_URL/);
        assert.match(message, /IMAGE_DATA_API_KEY/);
        assert.match(message, /BLOB_READ_WRITE_TOKEN/);
        assert.match(message, /BLOB_ALLOW_MEMORY_FALLBACK=true/);
        return true;
      },
    );
  });
});

test("production + BLOB_ALLOW_MEMORY_FALLBACK=true：顯式 opt-in 才允許記憶體降級（真寫真讀）", async () => {
  const m = await loadModules();
  await withEnv({ NODE_ENV: "production", BLOB_ALLOW_MEMORY_FALLBACK: "true" }, async () => {
    assert.equal(m.backend.blobMemoryFallbackAllowed(), true);
    assert.equal(m.backend.ensureBlobBackendWritable("probe"), false);
    m.cards.__resetCharacterCardStoreForTests();
    await m.cards.saveCharacterCard(1, card("card-optin"));
    const cards = await m.cards.listCharacterCards(1);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, "card-optin");
    m.cards.__resetCharacterCardStoreForTests();
  });
});

test("有 BLOB_READ_WRITE_TOKEN：視為已設定，寫入走 Vercel Blob 分支（真 HTTP 請求斷言）", async () => {
  const m = await loadModules();
  const localApi = await startLocalBlobApi();
  try {
    await withEnv(
      {
        NODE_ENV: "production",
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_fakesecret",
        VERCEL_BLOB_API_URL: localApi.baseUrl,
      },
      async () => {
        assert.equal(m.backend.useVpsBlobBackend(), false, "本檔無 VPS env，selector 應為 false");
        assert.equal(m.backend.blobBackendConfigured(), true);
        assert.equal(m.backend.ensureBlobBackendWritable("probe"), true, "production 有 token 應允許寫入");

        m.cards.__resetCharacterCardStoreForTests();
        await m.cards.saveCharacterCard(1, card("card-blob"));
        m.cards.__resetCharacterCardStoreForTests();

        const puts = localApi.calls.filter((call) => call.method === "PUT");
        assert.equal(puts.length, 1, "應恰有一次 PUT");
        assert.match(decodeURIComponent(puts[0].path), /^\/api\/blob\/\?pathname=character-cards\/1\/index-/);
      },
    );
  } finally {
    await localApi.close();
  }
});
