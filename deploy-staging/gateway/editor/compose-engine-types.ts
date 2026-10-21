import type { RenderBackendDecision } from './renderBackends';

export interface CommandResult { stdout: string; stderr: string; exit_code: number }

export interface ComposeProgress {
  stage: string;
  detail?: string;
  percent?: number;
  elapsedSec?: number;
  etaSec?: number;
}

export type ExportStrategy =
  | 'empty'
  | 'effects-only'
  | 'opaque-effects-direct'
  | 'simple-copy'
  | 'standard-compose';

export interface ExportAnalysis {
  durationSec: number;
  hasMainVideo: boolean;
  hasOverlays: boolean;
  hasFx: boolean;
  hasText: boolean;
  hasAudio: boolean;
  hasSubtitles: boolean;
  canFastCopy: boolean;
  canSkipFinalCompose: boolean;
  needsVirtualBase: boolean;
  strategy: ExportStrategy;
  recommendation: string;
  renderBackend: RenderBackendDecision;
  renderGraphSummary: {
    nodes: number;
    durationSec: number;
    output: string;
  };
}

export interface RenderedVideoProbe {
  formatName: string;
  codecName: string;
  width: number;
  height: number;
  durationSec: number;
  size: number;
}

export interface RenderedVideoExpectation {
  format?: 'mp4' | 'mov';
  width?: number;
  height?: number;
  durationSec?: number;
  durationToleranceSec?: number;
}
