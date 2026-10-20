import * as THREE from 'three';
import { vecEq, type MannequinElement, type Vec3 } from '../types';

export function actorMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72 });
}

export function buildAnimal(height: number, color: string, species: MannequinElement['animalSpecies']): THREE.Group {
  const group = new THREE.Group();
  const compact = species === 'small';
  const scale = compact ? height * 0.34 : height * 0.48;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(scale * 0.34, scale * 0.75, 5, 10), actorMaterial(color));
  body.rotation.z = Math.PI / 2;
  body.position.y = scale * 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(scale * 0.28, 16, 12), actorMaterial(color));
  head.position.set(scale * 0.62, scale * 0.88, 0);
  group.add(body, head);
  for (const x of [-0.34, 0.34]) for (const z of [-0.2, 0.2]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(scale * 0.07, scale * 0.085, scale * 0.58, 10), actorMaterial(color));
    leg.position.set(scale * x, scale * 0.34, scale * z);
    group.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(scale * 0.035, scale * 0.065, scale * 0.6, 8), actorMaterial(color));
  tail.rotation.z = -Math.PI / 3;
  tail.position.set(-scale * 0.72, scale * 0.78, 0);
  group.add(tail);
  return group;
}

export function disposeActorLabel(object: THREE.Object3D): void {
  const label = object.children.find((child) => child.userData.isDirectorActorLabel) as THREE.Sprite | undefined;
  if (!label) return;
  (label.material as THREE.SpriteMaterial).map?.dispose();
  (label.material as THREE.SpriteMaterial).dispose();
  object.remove(label);
}

export const MATERIAL_TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "bumpMap",
  "displacementMap",
  "alphaMap",
  "lightMap",
  "envMap",
] as const;

export function disposeMaterialTextures(material: THREE.Material): void {
  const bag = material as THREE.Material & Partial<Record<(typeof MATERIAL_TEXTURE_SLOTS)[number], THREE.Texture | null | undefined>>;
  for (const slot of MATERIAL_TEXTURE_SLOTS) {
    const tex = bag[slot];
    if (tex) tex.dispose();
  }
}

export function attachActorLabel(object: THREE.Object3D, name: string, color: string, height: number): void {
  disposeActorLabel(object);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(18, 20, 24, 0.92)';
  context.beginPath();
  context.roundRect(8, 10, 496, 108, 28);
  context.fill();
  context.fillStyle = color;
  context.fillRect(8, 10, 14, 108);
  context.font = '600 46px -apple-system, BlinkMacSystemFont, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  context.fillText(name.slice(0, 12), 264, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  label.userData.isDirectorActorLabel = true;
  if (object.userData.elementId) label.userData.elementId = object.userData.elementId;
  label.renderOrder = 999;
  label.position.set(0, height + 0.24, 0);
  label.scale.set(1.55, 0.39, 1);
  object.add(label);
}
export function vecChanged(a: Vec3, b: Vec3): boolean {
  return !vecEq(a, b);
}
