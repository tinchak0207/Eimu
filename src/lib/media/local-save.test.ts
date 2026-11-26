import test from "node:test";
import assert from "node:assert/strict";

import { hasLocalFileSave, saveBlobLocally, saveManyLocally } from "./local-save.ts";

// 假 picker / handle：不碰真浏览器，只在 globalThis 上注入结构型别物件。
// 每个测试自己装、finally 还原，避免互相污染。

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

/** 移除两种端点，模拟 Firefox/Safari/手机等无 File System Access API 环境。 */
function withoutPickers(): () => void {
  return setGlobals({ showSaveFilePicker: undefined, showDirectoryPicker: undefined });
}

function abortError(): Error {
  const error = new Error("The user aborted a request.");
  error.name = "AbortError";
  return error;
}

test("unsupported：端点不存在时 hasLocalFileSave 为 false，两个存档函式回 unsupported", async () => {
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

test("saved：showSaveFilePicker 存在 → 走 picker 并把 blob 写进 writable", async () => {
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

test("saveManyLocally：一次目录授权后把多档逐一写入（含去重前的原始名称）", async () => {
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

test("回落路径：只有 showSaveFilePicker 时 saveManyLocally 回 unsupported（不 throw）", async () => {
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
    // 单档路径仍可用（渐进增强逐端点判定）
    assert.equal(await saveBlobLocally(blob, "a.png"), "saved");
  } finally {
    restore();
  }
});

// 既有断言原本是「非取消的写入错误必须往外丢」；orchestrator 已拍板：渐进增强的
// 增强路径失败不得弄坏基础流程——非取消的失败一律降级成 "unsupported"，让呼叫端
// 回落今天的 <a download>，不得把错误外抛给使用者。失败原因仍以 console.warn 记录
// 供除错。故本条测试改为新语义（同时覆盖单档与多档两条路径）。
test("非取消的写入错误降级为 unsupported（可回落），不外抛且记 console.warn", async () => {
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
    assert.equal(warned.length, 2, "两条失败路径都必须留下除错纪录");
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
