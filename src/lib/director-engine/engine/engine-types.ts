import type { DirectorElement, Vec3 } from '../types';

export interface CameraPose { position: Vec3; target: Vec3; fov: number; rollDeg?: number }

export interface ElementSnapshotForDesc {
  id: string;
  name: string;
  kind: DirectorElement['kind'];
  worldPos: Vec3;
  forwardDir: Vec3;
  visible: boolean;
}

export interface DirectorEngineDiagnostics {
  webglContextLost: boolean;
  stageSize: { width: number; height: number };
  monitorAttached: boolean;
  sceneObjectCount: number;
  renderedElementCount: number;
  elements: Array<{
    id: string;
    name: string;
    kind: DirectorElement['kind'];
    rootVisible: boolean;
    visibleMeshCount: number;
    worldPos: Vec3;
    distanceToShotCamera: number;
    insideShotFrustum: boolean;
  }>;
}
