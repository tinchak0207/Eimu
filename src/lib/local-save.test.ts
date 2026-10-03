import test from "node:test";
import assert from "node:assert/strict";

import { hasLocalFileSave, saveBlobLocally, saveManyLocally } from "./local-save.ts";

// 假 picker / handle：不碰真瀏覽器，只在 globalThis 上注入結構型別物件。
// 每個測試自己裝、finally 還原，避免互相污染。

type AnyRecord = Record<string, unknown>;

function setGlobals(values: AnyRecord): () => void {
  const g = globalThis as unknown as AnyRecord;
  const saved = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of Object.keys(values)) {
    saved.set(key, { existed: key in g, value: g[key] });
    g[key] = values[key];
  }
  return () => {
    for (const [key, prior] of saved) {
      if (prior.existed) g[key] = prior.value;
      else delete g[key];
    }
  };
}

/** 移除兩種端點，模擬 Firefox/Safari/手機等無 File System Access API 環境。 */
function withoutPickers(): () => void {
  return setGlobals({ showSaveFilePicker: undefined, showDirectoryPicker: undefined });
}

function abortError(): Error {
  const error = new Error("The user aborted a request.");
  error.name = "AbortError";
  return error;
}

test("unsupported：端點不存在時 hasLocalFileSave 為 false，兩個存檔函式回 unsupported", async () => {
  const restore = withoutPickers();
  try {
    assert.equal(hasLocalFileSave(), false);
    const blob = new Blob(["x"], { type: "text/plain" });

    const single = await saveBlobLocally(blob, "a.txt", { mimeType: "text/plain" });
    assert.equal(single, "unsupported");

    const many = await saveManyLocally([{ name: "a.txt", blob }]);
    assert.equal(many, "unsupported");
  } finally {
    restore();
  }
});

test("saved：showSaveFilePicker 存在 → 走 picker 並把 blob 寫進 writable", async () => {
  const written: { blob: Blob | null; closed: boolean } = { blob: null, closed: false };
  const handle = {
    async createWritable() {
      return {
        async write(data: Blob) {
          written.blob = data;
        },
        async close() {
          written.closed = true;
        },
      };
    },
  };
  let suggestedName: string | undefined;
  const restore = setGlobals({
    showSaveFilePicker: async (opts?: { suggestedName?: string }) => {
      suggestedName = opts?.suggestedName;
      return handle;
    },
    showDirectoryPicker: undefined,
  });
  try {
    assert.equal(hasLocalFileSave(), true);
    const blob = new Blob(["hello"], { type: "text/plain" });

    const result = await saveBlobLocally(blob, "hello.txt", { mimeType: "text/plain" });

    assert.equal(result, "saved");
    assert.equal(suggestedName, "hello.txt");
    assert.equal(written.blob, blob);
    assert.equal(written.closed, true);
  } finally {
    restore();
  }
});

test("cancelled：使用者取消（AbortError）→ 回 cancelled，不 throw", async () => {
  const restore = setGlobals({
    showSaveFilePicker: async () => {
      throw abortError();
    },
    showDirectoryPicker: async () => {
      throw abortError();
    },
  });
  try {
    const blob = new Blob(["x"], { type: "text/plain" });

    assert.equal(await saveBlobLocally(blob, "a.txt"), "cancelled");
    assert.equal(await saveManyLocally([{ name: "a.txt", blob }]), "cancelled");
  } finally {
    restore();
  }
});

test("saveManyLocally：一次目錄授權後把多檔逐一寫入（含去重前的原始名稱）", async () => {
  const created: string[] = [];
  const written = new Map<string, string>();
  const directory = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      assert.equal(opts?.create, true);
      created.push(name);
      return {
        async createWritable() {
          return {
            async write(data: Blob) {
              written.set(name, await data.text());
            },
            async close() {},
          };
        },
      };
    },
  };
  let pickerMode: string | undefined;
  const restore = setGlobals({
    showSaveFilePicker: undefined,
    showDirectoryPicker: async (opts?: { mode?: string }) => {
      pickerMode = opts?.mode;
      return directory;
    },
  });
  try {
    const files = [
      { name: "a.png", blob: new Blob(["AAA"]) },
      { name: "b.mp4", blob: new Blob(["BBB"]) },
    ];

    const result = await saveManyLocally(files, { directoryName: "生成历史" });

    assert.equal(result, "saved");
    assert.equal(pickerMode, "readwrite");
    assert.deepEqual(created, ["a.png", "b.mp4"]);
    assert.equal(written.get("a.png"), "AAA");
    assert.equal(written.get("b.mp4"), "BBB");
  } finally {
    restore();
  }
});

test("回落路徑：只有 showSaveFilePicker 時 saveManyLocally 回 unsupported（不 throw）", async () => {
  const restore = setGlobals({
    showSaveFilePicker: async () => ({
      async createWritable() {
        return { async write() {}, async close() {} };
      },
    }),
    showDirectoryPicker: undefined,
  });
  try {
    const blob = new Blob(["x"]);
    assert.equal(await saveManyLocally([{ name: "a.png", blob }]), "unsupported");
    // 單檔路徑仍可用（漸進增強逐端點判定）
    assert.equal(await saveBlobLocally(blob, "a.png"), "saved");
  } finally {
    restore();
  }
});

// 既有斷言原本是「非取消的寫入錯誤必須往外丟」；orchestrator 已拍板：漸進增強的
// 增強路徑失敗不得弄壞基礎流程——非取消的失敗一律降級成 "unsupported"，讓呼叫端
// 回落今天的 <a download>，不得把錯誤外拋給使用者。失敗原因仍以 console.warn 記錄
// 供除錯。故本條測試改為新語義（同時覆蓋單檔與多檔兩條路徑）。
test("非取消的寫入錯誤降級為 unsupported（可回落），不外拋且記 console.warn", async () => {
  const boom = new Error("disk full");
  const restore = setGlobals({
    showSaveFilePicker: async () => ({
      async createWritable() {
        throw boom;
      },
    }),
    showDirectoryPicker: async () => {
      throw boom;
    },
  });
  const originalWarn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    warned.push(args[0]);
  };
  try {
    assert.equal(await saveBlobLocally(new Blob(["x"]), "a.png"), "unsupported");
    assert.equal(await saveManyLocally([{ name: "a.png", blob: new Blob(["x"]) }]), "unsupported");
    assert.equal(warned.length, 2, "兩條失敗路徑都必須留下除錯紀錄");
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
