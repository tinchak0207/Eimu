import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 畫布「连接 Blender…」叫用戶去 Blender 裝 addon；站上可下載的那份必須與
// bridge 真源逐字相同（改 addon 忘了同步＝用戶裝到舊版，連接碼契約可能已變）。
test("public/downloads 的 Blender addon 與 bridge 真源逐字相同", () => {
  const source = readFileSync("bridge/blender-bridge/blender_addon.py", "utf8");
  const published = readFileSync("public/downloads/eimu-blender-addon.py", "utf8");
  assert.equal(published, source, "改了 bridge/blender-bridge/blender_addon.py 後請 cp 到 public/downloads/eimu-blender-addon.py");
});
