import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { exportShotsZip } from "./export-zip.ts";

// exportShotsZip 是瀏覽器端函式（依賴 document / URL.createObjectURL）。
// 這裡補最小 browser stub，抓出它交給 createObjectURL 的 zip blob，
// 再用 jszip 讀回真實條目名——斷言的是產物本身，不是原始碼字串。
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

  // jszip 在 node 下要吃 Blob，必須先經過 FileReader 轉成 ArrayBuffer
  // （jszip/lib/utils.js prepareContent 的 isBlob 分支）；node 沒有 FileReader，補一個。
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
  assert.ok(zipBlob, "exportShotsZip 應把打包好的 zip blob 交給 createObjectURL");
  const zip = await JSZip.loadAsync(new Uint8Array(await zipBlob.arrayBuffer()));
  return Object.keys(zip.files).sort();
}

test("exportShotsZip 認得 .jpeg/.gif，不會補成 .jpeg.png/.gif.png", async () => {
  const names = await buildZipEntryNames([
    { name: "a.jpeg", blob: new Blob(["x"]) },
    { name: "b.gif", blob: new Blob(["y"]) },
  ]);
  assert.deepEqual(names, ["a.jpeg", "b.gif"]);
});

test("exportShotsZip 缺副檔名補 .png，影片／音頻副檔名原樣保留", async () => {
  const names = await buildZipEntryNames([
    { name: "a", blob: new Blob(["x"]) },
    { name: "b.mp4", blob: new Blob(["x"]) },
    { name: "c.mp3", blob: new Blob(["x"]) },
  ]);
  assert.deepEqual(names, ["a.png", "b.mp4", "c.mp3"]);
});

test("exportShotsZip 同名去重對新副檔名仍正確", async () => {
  const names = await buildZipEntryNames([
    { name: "a.jpeg", blob: new Blob(["x"]) },
    { name: "a.jpeg", blob: new Blob(["y"]) },
  ]);
  assert.deepEqual(names, ["a-2.jpeg", "a.jpeg"]);
});
