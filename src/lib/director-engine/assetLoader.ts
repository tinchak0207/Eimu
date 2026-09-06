/**
 * assetLoader — director-engine 的 glTF 資產載入入口（2026-09-06 片E）。
 *
 * 職責：把 .glb/.gltf 載入指定 parent Object3D，並做包圍盒歸一化
 * （等比縮放至目標高度 + 落地對齊 min.y=0，複製 three 標準 Box3 做法）。
 * 失敗一律回傳結構化錯誤（GltfLoadOutcome ok:false），不 throw。
 *
 * 邊界：本檔只提供載入入口；引擎掛點見 DirectorEngine.setGltfAsset。
 * 不解析 DRACO/KTX2 壓縮資產；動畫 clip 本片不播放（PRD 裁定只保留展示殼吃 glTF）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Vec3 } from './types';

/** 資產預設歸一化目標高度（公尺），對齊 mannequin 預設身高量級 */
export const GLTF_DEFAULT_TARGET_HEIGHT_M = 1.75;

/** 結構化 loader 介面：真身 GLTFLoader 滿足此形狀；測試可注入 mock */
export interface GltfLoaderLike {
  loadAsync(url: string): Promise<{ scene: THREE.Object3D }>;
}

export interface GltfAssetOptions {
  /** 歸一化目標高度（公尺）；省略用 GLTF_DEFAULT_TARGET_HEIGHT_M */
  targetHeightM?: number;
  /** 注入自訂 loader（測試 mock 用）；省略用真 GLTFLoader */
  loader?: GltfLoaderLike;
}

export type GltfLoadStage = 'invalid-url' | 'load' | 'empty';

export type GltfLoadOutcome =
  | {
      ok: true;
      /** 已歸一化並掛入 parent 的資產根物件 */
      object: THREE.Object3D;
      /** 歸一化前包圍盒尺寸（世界單位） */
      originalSize: Vec3;
      /** 等比縮放係數（targetHeightM / originalSize.y） */
      scaleFactor: number;
      /** 落地對齊的 y 位移量（加到 position.y 使 min.y=0） */
      groundOffsetY: number;
    }
  | { ok: false; stage: GltfLoadStage; message: string };

/**
 * 歸一化（原地修改）：等比縮放至 targetHeightM，再落地對齊 min.y=0。
 * 複製 three 標準做法：Box3.setFromObject → getSize → scale → updateMatrixWorld → 位移。
 * 空包圍盒（無可渲染幾何）回 null；退化高度（size.y≈0）跳過縮放只落地。
 */
export function applyGltfNormalization(
  object: THREE.Object3D,
  targetHeightM: number = GLTF_DEFAULT_TARGET_HEIGHT_M,
): { originalSize: Vec3; scaleFactor: number; groundOffsetY: number } | null {
  const before = new THREE.Box3().setFromObject(object);
  if (before.isEmpty()) return null;
  const size = before.getSize(new THREE.Vector3());
  const scaleFactor = targetHeightM > 0 && size.y > 1e-6 ? targetHeightM / size.y : 1;
  object.scale.multiplyScalar(scaleFactor);
  object.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(object);
  const groundOffsetY = -after.min.y;
  object.position.y += groundOffsetY;
  object.updateMatrixWorld(true);
  return {
    originalSize: { x: size.x, y: size.y, z: size.z },
    scaleFactor,
    groundOffsetY,
  };
}

/**
 * 載入 .glb/.gltf 到指定 parent 並歸一化。失敗回傳結構化錯誤，不 throw。
 * 成功時資產根物件已 add 進 parent；失敗時 parent 不變。
 */
export async function loadGltfAsset(
  parent: THREE.Object3D,
  url: string,
  opts: GltfAssetOptions = {},
): Promise<GltfLoadOutcome> {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, stage: 'invalid-url', message: 'glTF 資產 URL 為空' };
  }
  const loader: GltfLoaderLike = opts.loader ?? new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(url);
    const object = gltf?.scene;
    if (!object) {
      return { ok: false, stage: 'load', message: 'glTF 解析結果缺少 scene' };
    }
    const norm = applyGltfNormalization(object, opts.targetHeightM);
    if (!norm) {
      return { ok: false, stage: 'empty', message: 'glTF 資產無可渲染幾何（空場景）' };
    }
    parent.add(object);
    return { ok: true, object, ...norm };
  } catch (err) {
    return {
      ok: false,
      stage: 'load',
      message: `glTF 載入失敗：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const GLTF_TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
] as const;

/** 標準資源釋放：遍歷 dispose geometry / material / 常用紋理槽 */
export function disposeGltfObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of list) {
      for (const slot of GLTF_TEXTURE_SLOTS) {
        const tex = (m as unknown as Record<string, unknown>)[slot] as { dispose?: () => void } | null | undefined;
        tex?.dispose?.();
      }
      m.dispose();
    }
  });
}
