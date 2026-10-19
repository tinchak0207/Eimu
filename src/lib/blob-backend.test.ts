// 物件储存后端门禁测试（全部为**行为断言**：真呼叫真函式、比对真抛错/真回传，非源码字串扫描）。
//
// 病灶（本档守住的回归）：7 个 store 各自只看 `BLOB_READ_WRITE_TOKEN`。生产切到 VPS
// image-data-api 后端时该 token 为空 → 全部误判「无后端」→ 静默落进程内记忆体。
// Vercel 每个 serverless 实例各有自己的记忆体，冷启动即消失，而用户看到的是「写入成功」。
//
// 本档必须在任何 blob-backend 汇入**之前**清掉后端 env：vps-blob-adapter 的
// BASE_URL/API_KEY 是模组载入期快照，所以本档一律用动态 import 载入被测模组。
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.IMAGE_DATA_BASE_URL;
delete process.env.IMAGE_DATA_API_KEY;
delete process.env.BLOB_ALLOW_MEMORY_FALLBACK;

type EnvPatch = Record<string, string | undefined>;

/** 临时改 env（NODE_ENV / 后端变数都是呼叫期读取，可动态切换），结束必定还原。 */
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

/** 被测模组一律动态载入（见档头说明：模组载入期 env 快照）。 */
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

/** 7 个 store 的读取入口（零输入，故无「参数不合法而静默早退」的假通过空间）。 */
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
    prompt: "红发少女",
    references: [{ url: "https://img.example/a.png", role: "character" as const, name: "定妆照" }],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

/**
 * 真 HTTP 替身（@vercel/blob 走 undici 的 fetch，拦 globalThis.fetch 无效；
 * 改以 VERCEL_BLOB_API_URL 把 Vercel API 指到本机伺服器＝真请求、真路由）。
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

test("production + 无后端：7 个 store 的读取路径全部诚实失败，不得回空阵列冒充「这用户没有资料」", async () => {
  const m = await loadModules();
  await withEnv(
    { NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: undefined, BLOB_ALLOW_MEMORY_FALLBACK: undefined },
    async () => {
      assert.equal(m.backend.blobBackendConfigured(), false, "无后端时 blobBackendConfigured() 必须为 false");
      for (const [label, run] of readEntryPoints(m)) {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(
            error instanceof m.backend.BlobBackendUnconfiguredError,
            `${label} 应抛 BlobBackendUnconfiguredError，实际：${String(error)}`,
          );
          return true;
        });
      }
    },
  );
});

test("非 production + 无后端：允许记忆体降级（同一组读取入口回空阵列＝控制组，证明呼叫可达）", async () => {
  const m = await loadModules();
  await withEnv(
    { NODE_ENV: "test", BLOB_READ_WRITE_TOKEN: undefined, BLOB_ALLOW_MEMORY_FALLBACK: undefined },
    async () => {
      assert.equal(m.backend.blobBackendConfigured(), false);
      assert.equal(m.backend.ensureBlobBackendWritable("probe"), false, "非生产允许降级时回 false（呼叫端走记忆体）");
      for (const [label, run] of readEntryPoints(m)) {
        assert.deepEqual(await run(), [], `${label} 非生产降级路径应回空阵列`);
      }
    },
  );
});

test("production + 无后端：写入路径诚实失败（带非生产控制组，证明输入合法且路径可达）", async () => {
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
          title: "专案",
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
    for (const [_label, run, reset] of writes) {
      reset();
      await run(); // 控制组：输入合法且非生产路径可写 → 不 reject
      reset();
    }
  });

  await withEnv({ NODE_ENV: "production", BLOB_ALLOW_MEMORY_FALLBACK: undefined }, async () => {
    for (const [label, run, reset] of writes) {
      reset();
      await assert.rejects(run, (error: unknown) => {
        assert.ok(
          error instanceof m.backend.BlobBackendUnconfiguredError,
          `${label} 应诚实失败，实际：${String(error)}`,
        );
        return true;
      });
      reset();
    }
  });
});

test("production + 无后端：错误讯息含可操作指引（要设哪两个 VPS env / 哪个 token / 哪个 opt-in）", async () => {
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

test("production + BLOB_ALLOW_MEMORY_FALLBACK=true：显式 opt-in 才允许记忆体降级（真写真读）", async () => {
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

test("有 BLOB_READ_WRITE_TOKEN：视为已设定，写入走 Vercel Blob 分支（真 HTTP 请求断言）", async () => {
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
        assert.equal(m.backend.useVpsBlobBackend(), false, "本档无 VPS env，selector 应为 false");
        assert.equal(m.backend.blobBackendConfigured(), true);
        assert.equal(m.backend.ensureBlobBackendWritable("probe"), true, "production 有 token 应允许写入");

        m.cards.__resetCharacterCardStoreForTests();
        await m.cards.saveCharacterCard(1, card("card-blob"));
        m.cards.__resetCharacterCardStoreForTests();

        const puts = localApi.calls.filter((call) => call.method === "PUT");
        assert.equal(puts.length, 1, "应恰有一次 PUT");
        assert.match(decodeURIComponent(puts[0].path), /^\/api\/blob\/\?pathname=character-cards\/1\/index-/);
      },
    );
  } finally {
    await localApi.close();
  }
});
