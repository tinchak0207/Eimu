import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 画布「连接 Blender…」叫用户去 Blender 装 addon；站上可下载的那份必须与
// bridge 真源逐字相同（改 addon 忘了同步＝用户装到旧版，连接码契约可能已变）。
test("public/downloads 的 Blender addon 与 bridge 真源逐字相同", () => {
  const source = readFileSync("bridge/blender-bridge/blender_addon.py", "utf8");
  const published = readFileSync("public/downloads/eimu-blender-addon.py", "utf8");
  assert.equal(published, source, "改了 bridge/blender-bridge/blender_addon.py 后请 cp 到 public/downloads/eimu-blender-addon.py");
});
