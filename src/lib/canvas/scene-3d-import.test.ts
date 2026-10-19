// 本机 3D 模型导入（2026-09-27）契约测试：
//   ① sceneCard 往复合同——导演卡（六栏全形）与导入卡（只带 GLB）各自过
//      「上行压缩 compactMetadataForAgent → 还原端 toNodeMetadata」后逐栏相等；
//      缺契约底线（glb_path / scene_summary）整包丢弃（负向对照）。
//   ② 导入档验证真函式直呼：体积上限（随 MAX_SCENE_3D_BYTES 常数）、副档名白名单、GLB/glTF 容器魔数。
// 这些测试穿过的正是生产路径（同一份清洗器 + 同一份验证函式），不是源码字串扫描。
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

/** 导演交付的六栏全形卡（放宽前后都必须逐栏存活）。 */
const DIRECTOR_CARD: Scene3dCardMetadata = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png"],
  blend_path: "/api/blender-artifact?name=scene_01.blend",
  glb_path: "/api/blender-artifact?name=scene_01.glb",
  scene_summary: "废弃灯塔主场景 · 白模已上材质",
  duration_ms: 8000,
};

/** 导入卡：物件存储公网 URL。 */
const IMPORT_CARD = scene3dImportCardMetadata({
  url: "https://blob.example.com/files/canvas/scene3d/42/8f3a.glb",
  fileName: "屋顶追逐.glb",
});

/** 真往复：清洗 → 上行压缩 → 还原端清洗。 */
function roundTrip(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
  return toNodeMetadata(compactMetadataForAgent(metadata));
}

// ─────────────────────────────────────────── ① 往复合同

test("导演卡（六栏全形、无 source）往复后逐栏相等", () => {
  const restored = roundTrip({ sceneCard: DIRECTOR_CARD });
  assert.deepEqual(restored.sceneCard, DIRECTOR_CARD);
});

test("导演卡（显式 source:director）往复后逐栏相等", () => {
  const director: Scene3dCardMetadata = { ...DIRECTOR_CARD, source: "director" };
  const restored = roundTrip({ sceneCard: director });
  assert.deepEqual(restored.sceneCard, director);
});

test("导入卡（只带 GLB）往复后逐栏相等，且不被导演六栏契约误杀", () => {
  const restored = roundTrip({ sceneCard: IMPORT_CARD });
  assert.deepEqual(restored.sceneCard, IMPORT_CARD);
});

test("导入卡 metadata 只含真实三键（不编造 turntable/stills/blend/duration）", () => {
  assert.deepEqual(Object.keys(IMPORT_CARD).sort(), ["glb_path", "scene_summary", "source"]);
  assert.equal(IMPORT_CARD.source, "import");
  assert.equal(IMPORT_CARD.scene_summary, "从本机导入的 GLB");
});

test("负向对照：缺 glb_path（只有 stills+summary）整包丢弃", () => {
  const restored = toNodeMetadata({
    sceneCard: { stills_urls: ["x.png"], scene_summary: "残形", source: "import" },
  });
  assert.equal(restored.sceneCard, undefined);
});

test("负向对照：缺 scene_summary（只有 glb_path）整包丢弃", () => {
  const restored = toNodeMetadata({ sceneCard: { glb_path: "https://blob.example.com/a.glb" } });
  assert.equal(restored.sceneCard, undefined);
});

test("source 非两值枚举：剥掉该键但卡本身存活（不连坐整包）", () => {
  const restored = toNodeMetadata({
    sceneCard: { glb_path: "https://blob.example.com/a.glb", scene_summary: "从本机导入的 GLB", source: "evil" },
  });
  assert.deepEqual(restored.sceneCard, {
    glb_path: "https://blob.example.com/a.glb",
    scene_summary: "从本机导入的 GLB",
  });
});

test("可选栏位型别不符：该栏省略、其余照活（不让 duration_ms 字串杀掉整张卡）", () => {
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

test("stills_urls 空阵列＝缺席（不写空壳栏位）", () => {
  const restored = toNodeMetadata({
    sceneCard: { glb_path: "https://blob.example.com/a.glb", scene_summary: "从本机导入的 GLB", stills_urls: [] },
  });
  assert.deepEqual(restored.sceneCard, {
    glb_path: "https://blob.example.com/a.glb",
    scene_summary: "从本机导入的 GLB",
  });
});

// ─────────────────────────────────────────── ② 导入档验证（真呼叫）

test("验证：.glb 档名 + GLB 容器魔数 → 通过", () => {
  const head = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]); // "glTF"
  const result = validateScene3dUpload({ name: "scene.glb", size: 1024, head });
  assert.deepEqual(result, { ok: true, extension: ".glb" });
});

test("验证：体积上限边界通过、上限+1 拒绝", () => {
  const ok = validateScene3dUpload({ name: "scene.glb", size: MAX_SCENE_3D_BYTES });
  assert.equal(ok.ok, true);
  const tooBig = validateScene3dUpload({ name: "scene.glb", size: MAX_SCENE_3D_BYTES + 1 });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) {
    assert.equal(tooBig.reason, "too_large");
    assert.match(tooBig.message, new RegExp(`${Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB`));
  }
});

test("验证：非 .glb/.gltf 副档名被拒（.obj/.png/无副档名）", () => {
  for (const name of ["model.obj", "screenshot.png", "scene"]) {
    const result = validateScene3dUpload({ name, size: 2048 });
    assert.equal(result.ok, false, `${name} 必须被拒`);
    if (!result.ok) assert.equal(result.reason, "bad_extension");
  }
});

test("验证：副档名对但容器头不对 → 拒（不靠档名放行）", () => {
  const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const result = validateScene3dUpload({ name: "fake.glb", size: 4096, head: zipHead });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_content");
});

test("验证：.gltf 需 JSON 物件根（BOM/空白容忍）", () => {
  const jsonHead = new TextEncoder().encode('{"asset":{}}');
  assert.equal(validateScene3dUpload({ name: "scene.gltf", size: 512, head: jsonHead }).ok, true);
  const bomHead = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  assert.equal(validateScene3dUpload({ name: "scene.gltf", size: 512, head: bomHead }).ok, true);
  const badHead = new TextEncoder().encode("<xml>");
  const bad = validateScene3dUpload({ name: "scene.gltf", size: 512, head: badHead });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "bad_content");
});

test("验证：空档被拒；不传 head 时不比对魔数（不无凭据地拒绝）", () => {
  const empty = validateScene3dUpload({ name: "scene.glb", size: 0 });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_file");
  const noHead = validateScene3dUpload({ name: "scene.glb", size: 2048 });
  assert.equal(noHead.ok, true);
});

test("魔数探针长度＝16（足够 GLB magic + .gltf BOM/空白容忍）", () => {
  assert.equal(SCENE_3D_MAGIC_BYTES, 16);
});

// ─────────────────────────────────────────── ③ 标题推导

test("标题＝档名去副档名（空/纯副档名回契约预设，不编造名字）", () => {
  assert.equal(scene3dImportTitle("屋顶追逐.glb"), "屋顶追逐");
  assert.equal(scene3dImportTitle("scene.final.gltf"), "scene.final");
  assert.equal(scene3dImportTitle("   "), "3D 场景卡");
  assert.equal(scene3dImportTitle("x".repeat(200) + ".glb").length, 100);
});

test("副档名解析：小写化、去空白；纯点名不当副档名", () => {
  assert.equal(scene3dExtensionOf("A.GLB"), ".glb");
  assert.equal(scene3dExtensionOf(" scene.gltf "), ".gltf");
  assert.equal(scene3dExtensionOf(".glb"), "");
  assert.equal(scene3dExtensionOf("scene"), "");
});
