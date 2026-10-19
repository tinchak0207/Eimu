import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { exportShotsZip } from "./export-zip.ts";

// exportShotsZip 是浏览器端函式（依赖 document / URL.createObjectURL）。
// 这里补最小 browser stub，抓出它交给 createObjectURL 的 zip blob，
// 再用 jszip 读回真实条目名——断言的是产物本身，不是原始码字串。
async function buildZipEntryNames(
  items: Array<{ name: string; blob: Blob }>,
): Promise<string[]> {
  const captured: { blob: Blob | null } = { blob: null };
  const globals = globalThis as unknown as {
    document?: unknown;
    FileReader?: unknown;
  };
  const originalDocument = globals.document;
  const originalFileReader = globals.FileReader;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  // jszip 在 node 下要吃 Blob，必须先经过 FileReader 转成 ArrayBuffer
  // （jszip/lib/utils.js prepareContent 的 isBlob 分支）；node 没有 FileReader，补一个。
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
  globals.document = {
    createElement: () => anchor,
    body: { appendChild() {}, removeChild() {} },
  };
  globals.FileReader = StubFileReader;
  URL.createObjectURL = ((blob: Blob) => {
    captured.blob = blob;
    return "blob:stub";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  try {
    await exportShotsZip(items, "out.zip");
  } finally {
    globals.document = originalDocument;
    globals.FileReader = originalFileReader;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  const zipBlob = captured.blob;
  assert.ok(zipBlob, "exportShotsZip 应把打包好的 zip blob 交给 createObjectURL");
  const zip = await JSZip.loadAsync(new Uint8Array(await zipBlob.arrayBuffer()));
  return Object.keys(zip.files).sort();
}

test("exportShotsZip 认得 .jpeg/.gif，不会补成 .jpeg.png/.gif.png", async () => {
  const names = await buildZipEntryNames([
    { name: "a.jpeg", blob: new Blob(["x"]) },
    { name: "b.gif", blob: new Blob(["y"]) },
  ]);
  assert.deepEqual(names, ["a.jpeg", "b.gif"]);
});

test("exportShotsZip 缺副档名补 .png，影片／音频副档名原样保留", async () => {
  const names = await buildZipEntryNames([
    { name: "a", blob: new Blob(["x"]) },
    { name: "b.mp4", blob: new Blob(["x"]) },
    { name: "c.mp3", blob: new Blob(["x"]) },
  ]);
  assert.deepEqual(names, ["a.png", "b.mp4", "c.mp3"]);
});

test("exportShotsZip 同名去重对新副档名仍正确", async () => {
  const names = await buildZipEntryNames([
    { name: "a.jpeg", blob: new Blob(["x"]) },
    { name: "a.jpeg", blob: new Blob(["y"]) },
  ]);
  assert.deepEqual(names, ["a-2.jpeg", "a.jpeg"]);
});

// 清单档 manifest.json 与图片同路打包：它已自带合法副档名 .json，不该被当成
// 「缺副档名的图片」补成 manifest.json.png（严格相等断言，非 startsWith）。
test("exportShotsZip 不把 manifest.json 补成 manifest.json.png；媒体副档名仍正确", async () => {
  const names = await buildZipEntryNames([
    { name: "manifest.json", blob: new Blob(["{}"], { type: "application/json" }) },
    { name: "镜S01-01", blob: new Blob(["x"]) },
    { name: "b.mp4", blob: new Blob(["y"]) },
  ]);
  assert.deepEqual(names, ["b.mp4", "manifest.json", "镜S01-01.png"]);
  assert.equal(names.includes("manifest.json.png"), false, "清单档名不得被补 .png");
});
