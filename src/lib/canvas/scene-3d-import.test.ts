// 本機 3D 模型導入（2026-09-27）契約測試：
//   ① sceneCard 往復合同——導演卡（六欄全形）與導入卡（只帶 GLB）各自過
//      「上行壓縮 compactMetadataForAgent → 還原端 toNodeMetadata」後逐欄相等；
//      缺契約底線（glb_path / scene_summary）整包丟棄（負向對照）。
//   ② 導入檔驗證真函式直呼：體積上限（隨 MAX_SCENE_3D_BYTES 常數）、副檔名白名單、GLB/glTF 容器魔數。
// 這些測試穿過的正是生產路徑（同一份清洗器 + 同一份驗證函式），不是源碼字串掃描。
import test from "node:test";
import assert from "node:assert/strict";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { toNodeMetadata } from "@/lib/canvas/layout";
import type { CanvasNodeMetadata, Scene3dCardMetadata } from "@/lib/canvas/types";
import {
  MAX_SCENE_3D_BYTES,
  SCENE_3D_MAGIC_BYTES,
  scene3dExtensionOf,
  scene3dImportCardMetadata,
  scene3dImportTitle,
  validateScene3dUpload,
} from "./scene-3d-import";

/** 導演交付的六欄全形卡（放寬前後都必須逐欄存活）。 */
const DIRECTOR_CARD: Scene3dCardMetadata = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png"],
  blend_path: "/api/blender-artifact?name=scene_01.blend",
  glb_path: "/api/blender-artifact?name=scene_01.glb",
  scene_summary: "废弃灯塔主场景 · 白模已上材质",
  duration_ms: 8000,
};

/** 導入卡：物件存儲公網 URL。 */
const IMPORT_CARD = scene3dImportCardMetadata({
  url: "https://blob.example.com/files/canvas/scene3d/42/8f3a.glb",
  fileName: "屋顶追逐.glb",
});

/** 真往復：清洗 → 上行壓縮 → 還原端清洗。 */
function roundTrip(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
  return toNodeMetadata(compactMetadataForAgent(metadata));
}

// ─────────────────────────────────────────── ① 往復合同

test("導演卡（六欄全形、無 source）往復後逐欄相等", () => {
  const restored = roundTrip({ sceneCard: DIRECTOR_CARD });
  assert.deepEqual(restored.sceneCard, DIRECTOR_CARD);
});

test("導演卡（顯式 source:director）往復後逐欄相等", () => {
  const director: Scene3dCardMetadata = { ...DIRECTOR_CARD, source: "director" };
  const restored = roundTrip({ sceneCard: director });
  assert.deepEqual(restored.sceneCard, director);
});

test("導入卡（只帶 GLB）往復後逐欄相等，且不被導演六欄契約誤殺", () => {
  const restored = roundTrip({ sceneCard: IMPORT_CARD });
  assert.deepEqual(restored.sceneCard, IMPORT_CARD);
});

test("導入卡 metadata 只含真實三鍵（不編造 turntable/stills/blend/duration）", () => {
  assert.deepEqual(Object.keys(IMPORT_CARD).sort(), ["glb_path", "scene_summary", "source"]);
  assert.equal(IMPORT_CARD.source, "import");
  assert.equal(IMPORT_CARD.scene_summary, "从本机导入的 GLB");
});

test("負向對照：缺 glb_path（只有 stills+summary）整包丟棄", () => {
  const restored = toNodeMetadata({
    sceneCard: { stills_urls: ["x.png"], scene_summary: "残形", source: "import" },
  });
  assert.equal(restored.sceneCard, undefined);
});

test("負向對照：缺 scene_summary（只有 glb_path）整包丟棄", () => {
  const restored = toNodeMetadata({ sceneCard: { glb_path: "https://blob.example.com/a.glb" } });
  assert.equal(restored.sceneCard, undefined);
});

test("source 非兩值枚舉：剝掉該鍵但卡本身存活（不連坐整包）", () => {
  const restored = toNodeMetadata({
    sceneCard: { glb_path: "https://blob.example.com/a.glb", scene_summary: "从本机导入的 GLB", source: "evil" },
  });
  assert.deepEqual(restored.sceneCard, {
    glb_path: "https://blob.example.com/a.glb",
    scene_summary: "从本机导入的 GLB",
  });
});

test("可選欄位型別不符：該欄省略、其餘照活（不讓 duration_ms 字串殺掉整張卡）", () => {
  const restored = toNodeMetadata({
    sceneCard: {
      glb_path: "https://blob.example.com/a.glb",
      scene_summary: "从本机导入的 GLB",
      duration_ms: "8000",
      stills_urls: "not-an-array",
      blend_path: "",
    },
  });
  assert.deepEqual(restored.sceneCard, {
    glb_path: "https://blob.example.com/a.glb",
    scene_summary: "从本机导入的 GLB",
  });
});

test("stills_urls 空陣列＝缺席（不寫空殼欄位）", () => {
  const restored = toNodeMetadata({
    sceneCard: { glb_path: "https://blob.example.com/a.glb", scene_summary: "从本机导入的 GLB", stills_urls: [] },
  });
  assert.deepEqual(restored.sceneCard, {
    glb_path: "https://blob.example.com/a.glb",
    scene_summary: "从本机导入的 GLB",
  });
});

// ─────────────────────────────────────────── ② 導入檔驗證（真呼叫）

test("驗證：.glb 檔名 + GLB 容器魔數 → 通過", () => {
  const head = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]); // "glTF"
  const result = validateScene3dUpload({ name: "scene.glb", size: 1024, head });
  assert.deepEqual(result, { ok: true, extension: ".glb" });
});

test("驗證：體積上限邊界通過、上限+1 拒絕", () => {
  const ok = validateScene3dUpload({ name: "scene.glb", size: MAX_SCENE_3D_BYTES });
  assert.equal(ok.ok, true);
  const tooBig = validateScene3dUpload({ name: "scene.glb", size: MAX_SCENE_3D_BYTES + 1 });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) {
    assert.equal(tooBig.reason, "too_large");
    assert.match(tooBig.message, new RegExp(`${Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB`));
  }
});

test("驗證：非 .glb/.gltf 副檔名被拒（.obj/.png/無副檔名）", () => {
  for (const name of ["model.obj", "screenshot.png", "scene"]) {
    const result = validateScene3dUpload({ name, size: 2048 });
    assert.equal(result.ok, false, `${name} 必須被拒`);
    if (!result.ok) assert.equal(result.reason, "bad_extension");
  }
});

test("驗證：副檔名對但容器頭不對 → 拒（不靠檔名放行）", () => {
  const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const result = validateScene3dUpload({ name: "fake.glb", size: 4096, head: zipHead });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_content");
});

test("驗證：.gltf 需 JSON 物件根（BOM/空白容忍）", () => {
  const jsonHead = new TextEncoder().encode('{"asset":{}}');
  assert.equal(validateScene3dUpload({ name: "scene.gltf", size: 512, head: jsonHead }).ok, true);
  const bomHead = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  assert.equal(validateScene3dUpload({ name: "scene.gltf", size: 512, head: bomHead }).ok, true);
  const badHead = new TextEncoder().encode("<xml>");
  const bad = validateScene3dUpload({ name: "scene.gltf", size: 512, head: badHead });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "bad_content");
});

test("驗證：空檔被拒；不傳 head 時不比對魔數（不無憑據地拒絕）", () => {
  const empty = validateScene3dUpload({ name: "scene.glb", size: 0 });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_file");
  const noHead = validateScene3dUpload({ name: "scene.glb", size: 2048 });
  assert.equal(noHead.ok, true);
});

test("魔數探針長度＝16（足夠 GLB magic + .gltf BOM/空白容忍）", () => {
  assert.equal(SCENE_3D_MAGIC_BYTES, 16);
});

// ─────────────────────────────────────────── ③ 標題推導

test("標題＝檔名去副檔名（空/純副檔名回契約預設，不編造名字）", () => {
  assert.equal(scene3dImportTitle("屋顶追逐.glb"), "屋顶追逐");
  assert.equal(scene3dImportTitle("scene.final.gltf"), "scene.final");
  assert.equal(scene3dImportTitle("   "), "3D 场景卡");
  assert.equal(scene3dImportTitle("x".repeat(200) + ".glb").length, 100);
});

test("副檔名解析：小寫化、去空白；純點名不當副檔名", () => {
  assert.equal(scene3dExtensionOf("A.GLB"), ".glb");
  assert.equal(scene3dExtensionOf(" scene.gltf "), ".gltf");
  assert.equal(scene3dExtensionOf(".glb"), "");
  assert.equal(scene3dExtensionOf("scene"), "");
});
