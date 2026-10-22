/**
 * assetLoader — director-engine 的 glTF 资产载入入口（2026-09-06 片E）。
 *
 * 职责：把 .glb/.gltf 载入指定 parent Object3D，并做包围盒归一化
 * （等比缩放至目标高度 + 落地对齐 min.y=0，复制 three 标准 Box3 做法）。
 * 失败一律回传结构化错误（GltfLoadOutcome ok:false），不 throw。
 *
 * 边界：本档只提供载入入口；引擎挂点见 DirectorEngine.setGltfAsset。
 * 不解析 DRACO/KTX2 压缩资产。成功时回传 glTF animations（供 AnimationMixer）；无 clip 时 clips=[]，展示壳行为不变。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Vec3 } from './types';

/** 资产预设归一化目标高度（公尺），对齐 mannequin 预设身高量级 */
export const GLTF_DEFAULT_TARGET_HEIGHT_M = 1.75;

/** 结构化 loader 介面：真身 GLTFLoader 满足此形状；测试可注入 mock */
export interface GltfLoaderLike {
  loadAsync(url: string): Promise<{ scene: THREE.Object3D; animations?: THREE.AnimationClip[] }>;
}

export interface GltfAssetOptions {
  /** 归一化目标高度（公尺）；省略用 GLTF_DEFAULT_TARGET_HEIGHT_M */
  targetHeightM?: number;
  /** 注入自订 loader（测试 mock 用）；省略用真 GLTFLoader */
  loader?: GltfLoaderLike;
}

export type GltfLoadStage = 'invalid-url' | 'load' | 'empty';

export type GltfLoadOutcome =
  | {
      ok: true;
      /** 已归一化并挂入 parent 的资产根物件 */
      object: THREE.Object3D;
      /** 归一化前包围盒尺寸（世界单位） */
      originalSize: Vec3;
      /** 等比缩放系数（targetHeightM / originalSize.y） */
      scaleFactor: number;
      /** 落地对齐的 y 位移量（加到 position.y 使 min.y=0） */
      groundOffsetY: number;
      /** glTF 内 AnimationClip（无则为空数组；调用方挂 AnimationMixer） */
      clips: THREE.AnimationClip[];
    }
  | { ok: false; stage: GltfLoadStage; message: string };

/**
 * 归一化（原地修改）：等比缩放至 targetHeightM，再落地对齐 min.y=0。
 * 复制 three 标准做法：Box3.setFromObject → getSize → scale → updateMatrixWorld → 位移。
 * 空包围盒（无可渲染几何）回 null；退化高度（size.y≈0）跳过缩放只落地。
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
 * 载入 .glb/.gltf 到指定 parent 并归一化。失败回传结构化错误，不 throw。
 * 成功时资产根物件已 add 进 parent；失败时 parent 不变。
 */
export async function loadGltfAsset(
  parent: THREE.Object3D,
  url: string,
  opts: GltfAssetOptions = {},
): Promise<GltfLoadOutcome> {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, stage: 'invalid-url', message: 'glTF 资产 URL 为空' };
  }
  const loader: GltfLoaderLike = opts.loader ?? new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(url);
    const object = gltf?.scene;
    if (!object) {
      return { ok: false, stage: 'load', message: 'glTF 解析结果缺少 scene' };
    }
    const clips = Array.isArray(gltf.animations) ? gltf.animations.slice() : [];
    const norm = applyGltfNormalization(object, opts.targetHeightM);
    if (!norm) {
      return { ok: false, stage: 'empty', message: 'glTF 资产无可渲染几何（空场景）' };
    }
    parent.add(object);
    return { ok: true, object, clips, ...norm };
  } catch (err) {
    return {
      ok: false,
      stage: 'load',
      message: `glTF 载入失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const GLTF_TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
] as const;

/** 标准资源释放：遍历 dispose geometry / material / 常用纹理槽 */
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
