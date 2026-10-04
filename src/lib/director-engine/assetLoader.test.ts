// assetLoader 单元测试：归一化数学（缩放/落地对齐）、结构化错误路径、mock loader 注入。
// 风格对齐 director-wheel.test.ts（node:test + assert/strict），node 环境可跑（不触 WebGL）。
import { test } from "node:test";
import assert from "node:assert/strict";

import * as THREE from "three";

import {
  GLTF_DEFAULT_TARGET_HEIGHT_M,
  applyGltfNormalization,
  disposeGltfObject,
  loadGltfAsset,
  type GltfLoaderLike,
} from "./assetLoader";

const EPS = 1e-4;

function makeBoxMesh(size: { x: number; y: number; z: number }): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshStandardMaterial(),
  );
}

/** 建立未归一化资产：7 高长方体，重心悬在 (10, 100, -5) */
function makeFloatingAsset(): THREE.Group {
  const group = new THREE.Group();
  const mesh = makeBoxMesh({ x: 2, y: 7, z: 2 });
  mesh.position.set(10, 100, -5);
  group.add(mesh);
  return group;
}

function worldBoxOf(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

// ─────────────────────────── applyGltfNormalization ───────────────────────────

test("normalization scales asset to target height and grounds min.y to 0", () => {
  const asset = makeFloatingAsset();
  const norm = applyGltfNormalization(asset, 1.75);
  assert.ok(norm);
  assert.equal(norm.originalSize.y, 7);
  assert.ok(Math.abs(norm.scaleFactor - 0.25) < EPS);
  const box = worldBoxOf(asset);
  assert.ok(Math.abs(box.min.y - 0) < EPS, `grounded min.y, got ${box.min.y}`);
  assert.ok(Math.abs(box.max.y - 1.75) < EPS, `target height, got ${box.max.y - box.min.y}`);
});

test("normalization default target is GLTF_DEFAULT_TARGET_HEIGHT_M", () => {
  const asset = makeFloatingAsset();
  const norm = applyGltfNormalization(asset);
  assert.ok(norm);
  const box = worldBoxOf(asset);
  assert.ok(Math.abs(box.max.y - GLTF_DEFAULT_TARGET_HEIGHT_M) < EPS);
});

test("normalization keeps horizontal placement (ground align only moves y)", () => {
  const asset = makeFloatingAsset();
  const before = worldBoxOf(asset);
  applyGltfNormalization(asset, 1.4);
  const after = worldBoxOf(asset);
  assert.ok(Math.abs(after.min.x - before.min.x * 0.2) < 1e-3);
  assert.ok(Math.abs(after.min.z - before.min.z * 0.2) < 1e-3);
  assert.ok(Math.abs(after.min.y - 0) < EPS);
});

test("normalization degenerate flat asset skips scaling but still grounds", () => {
  const mesh = makeBoxMesh({ x: 2, y: 0.0000001, z: 2 });
  mesh.position.y = 5;
  const norm = applyGltfNormalization(mesh, 1.75);
  assert.ok(norm);
  assert.equal(norm.scaleFactor, 1);
  const box = worldBoxOf(mesh);
  assert.ok(Math.abs(box.min.y - 0) < 1e-6);
});

test("normalization returns null for object without renderable geometry", () => {
  const empty = new THREE.Group();
  assert.equal(applyGltfNormalization(empty, 1.75), null);
});

// ─────────────────────────── loadGltfAsset（mock loader） ───────────────────────────

function mockLoader(gltf: { scene: THREE.Object3D } | null): GltfLoaderLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async loadAsync(url: string) {
      calls.push(url);
      if (!gltf) throw new Error("404 mock network failure");
      return gltf;
    },
  };
}

test("loadGltfAsset rejects empty url without touching loader or parent", async () => {
  const parent = new THREE.Group();
  const loader = mockLoader(null);
  const outcome = await loadGltfAsset(parent, "   ", { loader });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.stage === "invalid-url");
  assert.equal(loader.calls.length, 0);
  assert.equal(parent.children.length, 0);
});

test("loadGltfAsset returns structured error on loader failure, parent unchanged", async () => {
  const parent = new THREE.Group();
  const loader = mockLoader(null);
  const outcome = await loadGltfAsset(parent, "https://example.com/broken.glb", { loader });
  assert.ok(!outcome.ok);
  if (!outcome.ok) {
    assert.equal(outcome.stage, "load");
    assert.match(outcome.message, /404 mock network failure/);
  }
  assert.equal(loader.calls.length, 1);
  assert.equal(parent.children.length, 0);
});

test("loadGltfAsset attaches normalized asset under parent on success", async () => {
  const parent = new THREE.Group();
  const asset = makeFloatingAsset();
  const outcome = await loadGltfAsset(parent, "https://example.com/hero.glb", {
    loader: mockLoader({ scene: asset }),
    targetHeightM: 2.8,
  });
  assert.ok(outcome.ok);
  if (outcome.ok) {
    assert.equal(outcome.originalSize.y, 7);
    assert.ok(Math.abs(outcome.scaleFactor - 0.4) < EPS);
    assert.equal(outcome.object, asset);
  }
  assert.equal(parent.children.length, 1);
  const box = worldBoxOf(asset);
  assert.ok(Math.abs(box.max.y - 2.8) < EPS);
  assert.ok(Math.abs(box.min.y - 0) < EPS);
});

test("loadGltfAsset default target height applies when opts omitted", async () => {
  const parent = new THREE.Group();
  const outcome = await loadGltfAsset(parent, "https://example.com/hero.glb", {
    loader: mockLoader({ scene: makeFloatingAsset() }),
  });
  assert.ok(outcome.ok);
  if (outcome.ok) assert.ok(Math.abs(outcome.scaleFactor - GLTF_DEFAULT_TARGET_HEIGHT_M / 7) < EPS);
});

test("loadGltfAsset flags empty glTF scene as 'empty' stage", async () => {
  const parent = new THREE.Group();
  const outcome = await loadGltfAsset(parent, "https://example.com/empty.glb", {
    loader: mockLoader({ scene: new THREE.Group() }),
  });
  assert.ok(!outcome.ok);
  assert.ok(!outcome.ok && outcome.stage === "empty");
  assert.equal(parent.children.length, 0);
});

test("loadGltfAsset reports missing scene as 'load' stage", async () => {
  const parent = new THREE.Group();
  const loader: GltfLoaderLike = { async loadAsync() { return { scene: undefined as unknown as THREE.Object3D }; } };
  const outcome = await loadGltfAsset(parent, "https://example.com/bad.glb", { loader });
  assert.ok(!outcome.ok);
  assert.ok(!outcome.ok && outcome.stage === "load");
  assert.equal(parent.children.length, 0);
});

// ─────────────────────────── disposeGltfObject ───────────────────────────

test("disposeGltfObject disposes geometry, materials and map textures", () => {
  const disposed: string[] = [];
  const geometry = { dispose: () => disposed.push("geometry"), morphAttributes: {} } as unknown as THREE.BufferGeometry;
  const map = { dispose: () => disposed.push("map") } as unknown as THREE.Texture;
  const material = {
    map,
    dispose: () => disposed.push("material"),
  } as unknown as THREE.Material;
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  root.add(new THREE.Mesh(geometry, [material, material]));
  disposeGltfObject(root);
  assert.ok(disposed.includes("geometry"));
  assert.equal(disposed.filter((d) => d === "material").length, 3);
  assert.equal(disposed.filter((d) => d === "map").length, 3);
});
