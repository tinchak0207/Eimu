// 片P 測試：Scene3dCardBody「3D 预览」入口 + Scene3dGltfViewport 資產模式視口。
// 慣例：node:test + 行為斷言（純函數直測 / SSR 渲染 / 源碼形狀斷言）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩
// （agent-chat-ui.test.ts 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

import { Scene3dCardBody } from "./Scene3dCardBody";
import type { CanvasNode, Scene3dCardMetadata } from "@/lib/canvas/types";

const SCENE: Scene3dCardMetadata = {
  turntable_url: "/blender-work/out/scene.mp4",
  stills_urls: ["/blender-work/out/f1.png"],
  blend_path: "/blender-work/out/scene.blend",
  glb_path: "/blender-work/out/rain_chase_scene.glb",
  scene_summary: "雨夜屋顶追逐",
  duration_ms: 3200,
};

function sceneNode(scene: Scene3dCardMetadata | undefined): CanvasNode {
  return {
    id: "node-1",
    type: "scene_3d" as CanvasNode["type"],
    title: "3D 场景",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: scene ? { sceneCard: scene } : {},
  };
}

test("3D 预览入口：glb 在手时渲染入口按钮（简体文案）", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(SCENE) }));
  assert.match(html, /3D 预览/);
  assert.match(html, /aria-pressed="false"/);
});

test("3D 预览入口：无 glb_path 时不渲染入口（不可点的死按钮不出现）", () => {
  const html = renderToStaticMarkup(
    createElement(Scene3dCardBody, { node: sceneNode({ ...SCENE, glb_path: "" }) }),
  );
  assert.doesNotMatch(html, /3D 预览/);
});

test("3D 预览默认收起：初次渲染显示 turntable 主体而非 glTF 视口", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(SCENE) }));
  assert.match(html, /<video/);
  assert.doesNotMatch(html, /sgv|Scene3dGltfViewport/);
});

test("Scene3dGltfViewport 通路形：鉴权 fetch → blob → engine.setGltfAsset（禁裸 GLTFLoader 直连）", () => {
  const source = read("src/components/canvas/node-view/Scene3dGltfViewport.tsx");
  // 鑑權通路：authHeaders 必帶（歷史坑：裸 fetch 401 靜默 → 視口永遠空）
  assert.match(source, /authHeaders\(\)/);
  assert.match(source, /URL\.createObjectURL/);
  // 資產模式掛點：走片E engine.setGltfAsset，不走白模 plan 數據源
  assert.match(source, /setGltfAsset\(/);
  assert.doesNotMatch(source, /director\/state/);
  assert.doesNotMatch(source, /evaluateDirectorFrame/);
  // 結構化錯誤：onGltfAssetError 回呼必接（人話提示含 glb 路徑）
  assert.match(source, /onGltfAssetError/);
  assert.match(source, /模型：\$\{glbPath\}/);
  // 畫布手勢隔離（DirectorMiniViewport 同款鐵律）
  assert.match(source, /data-canvas-interactive/);
  assert.match(source, /stopPropagation\(\)/);
  // 卸載衛生：engine.dispose + blob URL 回收
  assert.match(source, /\.dispose\(\)/);
  assert.match(source, /revokeObjectURL/);
});

test("Scene3dGltfViewport 代理分支固定：只認 /api/blender-artifact 單檔名形", () => {
  const source = read("src/components/canvas/node-view/Scene3dGltfViewport.tsx");
  assert.match(source, /\/api\/blender-artifact\?name=/);
  assert.doesNotMatch(source, /image-proxy/);
});

// ── 本機導入卡（2026-09-27）：缺 turntable/stills 一律走減法，不出空播放器/空網格 ──

/** 導入卡：只帶 glb_path（真實來源＝公網物件存儲 URL）。 */
const IMPORT_SCENE: Scene3dCardMetadata = {
  glb_path: "https://blob.example.com/files/canvas/scene3d/42/a.glb",
  scene_summary: "从本机导入的 GLB",
  source: "import",
};

test("導入卡：缺 turntable/stills 時不渲染播放器、空網格與死按鈕，只留 GLB 視口與下載", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(IMPORT_SCENE) }));
  // 行為斷言：空播放器 / 未同步提示 / 靜帧網格 / 預覽切換鈕一律不出現
  assert.doesNotMatch(html, /<video/);
  assert.doesNotMatch(html, /turntable 未同步/);
  assert.doesNotMatch(html, /场景静帧/);
  assert.doesNotMatch(html, /3D 预览/);
  // 留下的：GLB 視口容器（Scene3dGltfViewport 的殼）+ 下載連結 + 本機導入標籤 + 真實摘要
  assert.match(html, /0b0f14/, "GLB 視口殼應在場");
  assert.match(html, /\.glb/);
  assert.match(html, /本机导入<\/span>/);
  assert.match(html, /从本机导入的 GLB/);
});

test("導入卡：glb 地址不可用（空值）時主體與資產行整塊不出現，只剩摘要", () => {
  const html = renderToStaticMarkup(
    createElement(Scene3dCardBody, {
      node: sceneNode({ glb_path: "", scene_summary: "从本机导入的 GLB", source: "import" }),
    }),
  );
  assert.doesNotMatch(html, /0b0f14/);
  assert.doesNotMatch(html, /本机导入<\/span>/);
  assert.doesNotMatch(html, /<a/);
  assert.match(html, /从本机导入的 GLB/);
});

test("導演卡不受導入刀影響：無「本机导入」標籤、turntable 主體照舊", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(SCENE) }));
  assert.doesNotMatch(html, /本机导入/);
  assert.match(html, /场景资产/);
});

test("blender-artifact 代理路由形：白名單/禁 traversal/白模共存不動 elements", () => {
  const route = read("src/app/api/blender-artifact/route.ts");
  assert.match(route, /requireVerifiedUser/);
  assert.match(route, /\.\.\/|traversal|includes\("\.\."\)|includes\("\/"\)/s);
  assert.match(route, /model\/gltf-binary/);
  // 產物目錄釘死 .blender-work/out（不出橋工作目錄範圍）
  assert.match(route, /\.blender-work/, "out");
});
