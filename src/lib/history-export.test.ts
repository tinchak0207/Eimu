import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import {
  buildHistoryArchive,
  entryFileName,
  entrySrc,
  exportHistoryZip,
  fetchAsBlob,
} from "./history-export.ts";
import type { HistoryEntry } from "./history-types.ts";

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "generatedAt">): HistoryEntry {
  return { prompt: "", results: [], source: "server", ...overrides };
}

test("buildHistoryArchive 摊平工作流参数并保留原始 workflow", () => {
  const archive = buildHistoryArchive([
    entry({
      id: "a",
      generatedAt: 1_700_000_000_000,
      prompt: "一只戴帽子的猫",
      modelId: "openai/gpt-image-2",
      starred: true,
      quota: 1_000_000,
      results: [
        { provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://x/a.png" },
        { provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: null },
      ],
      workflow: { imageSize: "1024x1024", workflowPresetLabel: "商品图", qualityProfile: "print" },
    }),
  ]);

  assert.equal(archive.count, 1);
  const record = archive.records[0];
  assert.equal(record.prompt, "一只戴帽子的猫");
  assert.equal(record.model, "openai/gpt-image-2");
  assert.equal(record.imageSize, "1024x1024");
  assert.equal(record.preset, "商品图");
  assert.equal(record.qualityProfile, "print");
  assert.equal(record.starred, true);
  assert.equal(record.coins, "2");
  assert.deepEqual(record.imageUrls, ["https://x/a.png"], "没有 URL 的结果项不应出现在清单里");
  assert.ok(record.workflow, "原始工作流参数应当保留，以便日后复现");
});

test("buildHistoryArchive 对没有消耗信息的记录不编造 coins 字段", () => {
  const archive = buildHistoryArchive([entry({ id: "a", generatedAt: 1_000 })]);
  assert.equal("coins" in archive.records[0], false);
});

test("buildHistoryArchive 输出 ISO 时间，跨时区可解析", () => {
  const archive = buildHistoryArchive([entry({ id: "a", generatedAt: 1_700_000_000_000 })]);
  assert.equal(archive.records[0].generatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(Date.parse(archive.records[0].generatedAt), 1_700_000_000_000);
});

test("buildHistoryArchive 对空输入返回空档案而不是抛错", () => {
  const archive = buildHistoryArchive([]);
  assert.equal(archive.count, 0);
  assert.deepEqual(archive.records, []);
});

test("entryFileName 把音频来源的副档名带进 zip 条目名", () => {
  const audio = entry({
    id: "audio",
    generatedAt: 1_700_000_000_000,
    prompt: "轻快的钢琴曲",
    results: [
      {
        provider: "audio_tinchak",
        modelId: "music-1",
        image: null,
        imageUrl: null,
        audioUrl: "https://blob.example/song.mp3?token=abc",
      },
    ],
  });
  assert.match(entryFileName(audio), /\.mp3$/, "mp3 音频条目名必须以 .mp3 结尾，否则会被补成 .png");

  const m4a = entry({
    id: "m4a",
    generatedAt: 1_700_000_000_000,
    prompt: "旁白",
    results: [
      { provider: "audio_tinchak", modelId: "tts-1", image: null, imageUrl: null, audioUrl: "https://blob.example/voice.m4a" },
    ],
  });
  assert.match(entryFileName(m4a), /\.m4a$/);
});

test("entryFileName 对图片沿用 .png（含 base64 无 URL）", () => {
  const imageEntry = entry({
    id: "img",
    generatedAt: 1_700_000_000_000,
    prompt: "一只猫",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://blob.example/cat.png" }],
  });
  assert.match(entryFileName(imageEntry), /\.png$/);

  const base64Entry = entry({
    id: "b64",
    generatedAt: 1_700_000_000_000,
    prompt: "一只狗",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: "AAAA", imageUrl: null }],
  });
  assert.match(entryFileName(base64Entry), /\.png$/);
});

test("纯视频记录：entrySrc 认得 videoUrl（不再被判 skipped），条目名以 .mp4 结尾", () => {
  const video = entry({
    id: "video",
    generatedAt: 1_700_000_000_000,
    prompt: "海边日落",
    results: [
      { provider: "video_tinchak", modelId: "seedance-2.0", image: null, imageUrl: null, videoUrl: "https://blob.example/clip.mp4", mediaType: "video" },
    ],
  });
  // entrySrc 返回非空即代表 exportHistoryZip 不会把它计入 skipped。
  assert.equal(entrySrc(video), "https://blob.example/clip.mp4");
  assert.match(entryFileName(video), /\.mp4$/);
});

// ────────────────── 2026-10-04「永久 pending」族：取图逾时只让该张 skipped
//
// 取图等待原本无界：上游半开连线（headers 永不到达）时 fetch 永久 pending，
// 批量导出（以及单张下载）没有终态。修復后 fetchImageResponse 用 AbortController
// 主动 abort 并抛人话错误；批量导出的 fetchAsBlob 用同一个 catch 吞成 null（skipped），
// 一次逾时不得炸掉整包 zip。以下以真实 exportHistoryZip 端到端断言（真 zip 产物）。

/** 装最小 browser 环境（document/FileReader/createObjectURL）并跑 exportHistoryZip，读回真 zip 条目名。 */
async function runZipExport(
  entries: HistoryEntry[],
  fetchImpl: typeof fetch,
  perImageTimeoutMs: number,
): Promise<{ result: { exported: number; skipped: number }; names: string[]; manifest: string | null }> {  const globals = globalThis as unknown as {
    document?: unknown;
    FileReader?: unknown;
    showDirectoryPicker?: unknown;
  };
  const originalFetch = globalThis.fetch;
  const originalDocument = globals.document;
  const originalFileReader = globals.FileReader;
  const originalDirectoryPicker = globals.showDirectoryPicker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  const captured: { blob: Blob | null } = { blob: null };

  // jszip 在 node 下要把 Blob 经 FileReader 转 ArrayBuffer（同 export-zip.test.ts）。
  class StubFileReader {
    result: ArrayBuffer | null = null;
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    async readAsArrayBuffer(blob: Blob): Promise<void> {
      try {
        const buffer = await blob.arrayBuffer();
        this.result = buffer;
        this.onload?.({ target: { result: buffer } });
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }

  const anchor = { href: "", download: "", style: {}, click() {} };
  globals.document = { createElement: () => anchor, body: { appendChild() {}, removeChild() {} } };
  globals.FileReader = StubFileReader;
  // 缺省无本机直存能力 → saveManyLocally 回 "unsupported" 回落 ZIP。
  delete globals.showDirectoryPicker;
  URL.createObjectURL = ((blob: Blob) => {
    captured.blob = blob;
    return "blob:stub";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  globalThis.fetch = fetchImpl;

  try {
    const result = await exportHistoryZip(entries, "out.zip", perImageTimeoutMs);
    assert.ok(captured.blob, "exportHistoryZip 應把打包好的 zip blob 交給 createObjectURL");
    const zip = await JSZip.loadAsync(new Uint8Array(await captured.blob.arrayBuffer()));
    const names = Object.keys(zip.files).sort();
    // 既有 export-zip 对未知副档名一律补 .png（.json 不在媒体白名单）→ 条目名是 manifest.json.png。
    const manifestKey = names.find((n) => n.startsWith("manifest.json"));
    const manifest = manifestKey ? await zip.files[manifestKey].async("string") : null;
    return { result, names, manifest };
  } finally {
    globalThis.fetch = originalFetch;
    globals.document = originalDocument;
    globals.FileReader = originalFileReader;
    globals.showDirectoryPicker = originalDirectoryPicker;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

/** 模拟真实 fetch：对指定 URL 永不回应、但在 signal abort 时 reject（半开连线）。 */
function fetchThatHangsOn(hangMatch: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(hangMatch)) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }
    return new Response(new Blob(["good-bytes"]), { status: 200 });
  }) as typeof fetch;
}

test("fetchAsBlob：取图逾时 → null（skipped 语义），不抛炸整包", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fetchThatHangsOn("bad.png");
  try {
    const started = Date.now();
    const out = await fetchAsBlob("https://blob.example/bad.png", 40);
    assert.equal(out, null, "逾时必须落 null（= skipped），不得抛出");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30 && elapsed < 400, `逾时应在 ~40ms 生效（实测 ${elapsed}ms）`);
  } finally {
    globalThis.fetch = original;
  }
});

test("批量导出：一张取图逾时 → 该张 skipped，其余照常，zip 仍产出且 manifest 完整", async () => {
  const good = entry({
    id: "good",
    generatedAt: 1_700_000_000_000,
    prompt: "好图",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://blob.example/good.png" }],
  });
  const bad = entry({
    id: "bad",
    generatedAt: 1_700_000_010_000,
    prompt: "坏图",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://blob.example/bad.png" }],
  });

  const { result, names, manifest } = await runZipExport(
    [good, bad],
    fetchThatHangsOn("bad.png"),
    40,
  );

  assert.equal(result.skipped, 1, "逾时那一条计入 skipped");
  assert.equal(result.exported, 1, "另一条照常导出");
  assert.ok(names.includes(entryFileName(good)), `zip 应含好图条目：${entryFileName(good)}`);
  assert.ok(!names.includes(entryFileName(bad)), "逾时的条目不得出现在 zip 里");
  assert.ok(
    names.some((n) => n.startsWith("manifest.json")),
    `manifest 仍须产出（实收条目：${names.join(", ")}）`,
  );
  assert.ok(manifest, "manifest 内容可读");
  const parsed = JSON.parse(manifest as string) as { count: number; records: unknown[] };
  assert.equal(parsed.count, 2, "manifest 记录全部选中条目（含被 skipped 的），计数与选择一致");
  assert.equal(parsed.records.length, 2);
});
