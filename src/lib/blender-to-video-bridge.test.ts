import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSceneFrameReferenceCard,
  type SceneFrameQuality,
} from "./blender-to-video-bridge";

const FULL_CARD = {
  turntable_url: "https://cdn.example.com/scene/turntable.mp4",
  stills_urls: [
    "https://cdn.example.com/scene/still-0.png",
    "https://cdn.example.com/scene/still-1.png",
    "https://cdn.example.com/scene/still-2.png",
  ],
  blend_path: "https://cdn.example.com/scene/scene.blend",
  glb_path: "https://cdn.example.com/scene/scene.glb",
  scene_summary: "graybox two-room set",
  duration_ms: 4000,
};

test("lookdev 檔：stills 前兩張佔 i2v 首/尾幀位，referenceRole=style", () => {
  const card = buildSceneFrameReferenceCard({ sceneCard: FULL_CARD, quality: "lookdev" });
  assert.equal(card.quality, "lookdev");
  assert.equal(card.compositionOnly, false);
  assert.equal(card.references.length, 2);
  assert.equal(card.references[0].url, FULL_CARD.stills_urls[0]);
  assert.equal(card.references[0].name, "scene3d-first-frame");
  assert.equal(card.references[0].referenceRole, "style");
  assert.equal(card.references[0].mimeType, "image/png");
  assert.equal(card.references[1].name, "scene3d-last-frame");
  assert.equal(card.referenceDirective, card.referenceDirective); // 穩定引用
  assert.match(card.referenceDirective, /materials, and lighting mood/);
});

test("lookdev 檔：firstFrameUrl/lastFrameUrl 顯式覆蓋優先於 stills", () => {
  const card = buildSceneFrameReferenceCard({
    sceneCard: FULL_CARD,
    quality: "lookdev",
    firstFrameUrl: "https://cdn.example.com/scene/extracted-start.png",
    lastFrameUrl: "https://cdn.example.com/scene/extracted-end.jpg",
  });
  assert.equal(card.references[0].url, "https://cdn.example.com/scene/extracted-start.png");
  assert.equal(card.references[1].url, "https://cdn.example.com/scene/extracted-end.jpg");
  assert.equal(card.references[1].mimeType, "image/jpeg");
});

test("previz 檔：role=composition＋compositionOnly=true＋不得佔首/尾幀位", () => {
  const card = buildSceneFrameReferenceCard({ sceneCard: FULL_CARD, quality: "previz" });
  assert.equal(card.compositionOnly, true);
  for (const ref of card.references) {
    assert.equal(ref.referenceRole, "composition");
    assert.equal(ref.name.startsWith("scene3d-first-frame"), false);
    assert.equal(ref.name.startsWith("scene3d-last-frame"), false);
  }
  assert.match(card.referenceDirective, /composition and spatial layout only/);
});

test("previz 檔：首尾幀覆蓋被忽略並留下備注（可觀測拒絕）", () => {
  const card = buildSceneFrameReferenceCard({
    sceneCard: FULL_CARD,
    quality: "previz",
    firstFrameUrl: "https://cdn.example.com/scene/extracted-start.png",
  });
  assert.equal(card.compositionOnly, true);
  assert.equal(card.references.some((r) => r.url.includes("extracted-start")), false);
  assert.ok(card.notes.some((n) => n.includes("previz 品質檔下")));
});

test("缺省品質檔 = previz（保守：橋默認 Eevee 存活預設）", () => {
  const card = buildSceneFrameReferenceCard({ sceneCard: FULL_CARD });
  assert.equal<SceneFrameQuality>(card.quality, "previz");
  assert.equal(card.compositionOnly, true);
});

test("turntable mp4 / blend / glb 不入參考卡（非圖像幀剔除＋備注）", () => {
  const card = buildSceneFrameReferenceCard({
    sceneCard: { ...FULL_CARD, stills_urls: ["https://cdn.example.com/scene/turntable.mp4", "https://cdn.example.com/scene/scene.glb"] },
    quality: "lookdev",
  });
  assert.equal(card.references.length, 0);
  assert.ok(card.notes.some((n) => n.includes("skipped non-image frame")));
});

test("stills 空卡：參考卡為空＋誠實備注，不宣稱已附參考圖", () => {
  const card = buildSceneFrameReferenceCard({
    sceneCard: { ...FULL_CARD, stills_urls: [] },
  });
  assert.equal(card.references.length, 0);
  assert.ok(card.notes.some((n) => n.includes("不得宣稱已附參考圖")));
});

test("maxReferences 帽生效（stills 3 張 cap 3）與去重", () => {
  const card = buildSceneFrameReferenceCard({
    sceneCard: FULL_CARD,
    quality: "lookdev",
    firstFrameUrl: FULL_CARD.stills_urls[0], // 與 stills[0] 同 URL → 去重後補位
  });
  const urls = card.references.map((r) => r.url);
  assert.equal(new Set(urls).size, urls.length);
});
