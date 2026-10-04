// 片P 测试：Scene3dCardBody「3D 预览」入口 + Scene3dGltfViewport 资产模式视口。
// 惯例：node:test + 行为断言（纯函数直测 / SSR 渲染 / 源码形状断言）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩
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
  // 鉴权通路：authHeaders 必带（历史坑：裸 fetch 401 静默 → 视口永远空）
  assert.match(source, /authHeaders\(\)/);
  assert.match(source, /URL\.createObjectURL/);
  // 资产模式挂点：走片E engine.setGltfAsset，不走白模 plan 数据源
  assert.match(source, /setGltfAsset\(/);
  assert.doesNotMatch(source, /director\/state/);
  assert.doesNotMatch(source, /evaluateDirectorFrame/);
  // 结构化错误：onGltfAssetError 回呼必接（人话提示含 glb 路径）
  assert.match(source, /onGltfAssetError/);
  assert.match(source, /模型：\$\{glbPath\}/);
  // 画布手势隔离（DirectorMiniViewport 同款铁律）
  assert.match(source, /data-canvas-interactive/);
  assert.match(source, /stopPropagation\(\)/);
  // 卸载卫生：engine.dispose + blob URL 回收
  assert.match(source, /\.dispose\(\)/);
  assert.match(source, /revokeObjectURL/);
});

test("Scene3dGltfViewport 代理分支固定：只认 /api/blender-artifact 单档名形", () => {
  const source = read("src/components/canvas/node-view/Scene3dGltfViewport.tsx");
  assert.match(source, /\/api\/blender-artifact\?name=/);
  assert.doesNotMatch(source, /image-proxy/);
});

// ── 本机导入卡（2026-09-27）：缺 turntable/stills 一律走减法，不出空播放器/空网格 ──

/** 导入卡：只带 glb_path（真实来源＝公网物件存储 URL）。 */
const IMPORT_SCENE: Scene3dCardMetadata = {
  glb_path: "https://blob.example.com/files/canvas/scene3d/42/a.glb",
  scene_summary: "从本机导入的 GLB",
  source: "import",
};

test("导入卡：缺 turntable/stills 时不渲染播放器、空网格与死按钮，只留 GLB 视口与下载", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(IMPORT_SCENE) }));
  // 行为断言：空播放器 / 未同步提示 / 静帧网格 / 预览切换钮一律不出现
  assert.doesNotMatch(html, /<video/);
  assert.doesNotMatch(html, /turntable 未同步/);
  assert.doesNotMatch(html, /场景静帧/);
  assert.doesNotMatch(html, /3D 预览/);
  // 留下的：GLB 视口容器（Scene3dGltfViewport 的壳）+ 下载连结 + 本机导入标签 + 真实摘要
  assert.match(html, /0b0f14/, "GLB 视口壳应在场");
  assert.match(html, /\.glb/);
  assert.match(html, /本机导入<\/span>/);
  assert.match(html, /从本机导入的 GLB/);
});

test("导入卡：glb 地址不可用（空值）时主体与资产行整块不出现，只剩摘要", () => {
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

test("导演卡不受导入刀影响：无「本机导入」标签、turntable 主体照旧", () => {
  const html = renderToStaticMarkup(createElement(Scene3dCardBody, { node: sceneNode(SCENE) }));
  assert.doesNotMatch(html, /本机导入/);
  assert.match(html, /场景资产/);
});

test("blender-artifact 代理路由形：白名单/禁 traversal/白模共存不动 elements", () => {
  const route = read("src/app/api/blender-artifact/route.ts");
  assert.match(route, /requireVerifiedUser/);
  assert.match(route, /\.\.\/|traversal|includes\("\.\."\)|includes\("\/"\)/s);
  assert.match(route, /model\/gltf-binary/);
  // 产物目录钉死 .blender-work/out（不出桥工作目录范围）
  assert.match(route, /\.blender-work/, "out");
});
