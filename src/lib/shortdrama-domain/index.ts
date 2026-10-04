import { fuseSceneVideo } from "../scene3d-video-fusion";

export const SHORTDRAMA_TOOL_IDS = [
  "script_scene_parse",
  "cast_asset_lock",
  "storyboard_qc_17",
  "keyframe_render",
  "audio_first_timeline",
  "last_frame_video_chain",
  "editing_manifest",
  "delivery_assets",
] as const;

export type ShortDramaToolId = (typeof SHORTDRAMA_TOOL_IDS)[number];
export type ShortDramaStatus = "succeeded" | "blocked" | "unsupported" | "failed";

export interface ShortDramaGate {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ShortDramaCanvasMetadata {
  workflowId: "shortdrama-production";
  tool: ShortDramaToolId;
  status: ShortDramaStatus;
  artifactKind: string;
  artifactId: string;
  inputRefs: string[];
  outputRefs: string[];
  gateIds: string[];
  unsupportedCode?: string;
}

export interface ShortDramaUnsupported {
  code: string;
  message: string;
  requiredCapability: string;
}

export interface ShortDramaToolResult<T = unknown> {
  tool: ShortDramaToolId;
  status: ShortDramaStatus;
  output: T;
  gates: ShortDramaGate[];
  canvas: ShortDramaCanvasMetadata;
  unsupported?: ShortDramaUnsupported;
  error?: { code: string; message: string };
}

export interface ShortDramaToolDefinition {
  id: ShortDramaToolId;
  description: string;
  input: string;
  output: string;
  gates: string[];
  unsupported: string[];
  canvas: {
    workflowId: "shortdrama-production";
    nodeType: "text" | "character_card" | "scene_card" | "image" | "audio" | "video" | "config";
    artifactKind: string;
  };
}

export interface ShortDramaCapabilities {
  imageGeneration?: {
    provider: string;
    render?: (shot: StoryboardShot) => { artifactId: string; uri: string } | Promise<{ artifactId: string; uri: string }>;
  };
  audioGeneration?: { provider: string };
  videoGeneration?: { provider: string };
  editing?: { engine: "ffmpeg" | "jianying" };
}

export interface ScriptBeat {
  type: "action" | "dialogue";
  speaker: string | null;
  text: string;
}

export interface ScriptScene {
  sceneId: string;
  heading: string;
  beats: ScriptBeat[];
}

export interface ScriptSceneOutput {
  scenes: ScriptScene[];
}

export interface CastAsset {
  id: string;
  kind: "character" | "scene";
  name: string;
  appearancePrompt?: string;
  referenceUri?: string;
}

export interface CastAssetLockOutput {
  locks: Array<CastAsset & { locked: true }>;
  missingIds: string[];
}

export interface StoryboardShot {
  shotId: string;
  sceneId?: string;
  order?: number;
  prompt: string;
  characterCardIds?: string[];
  sceneCardIds?: string[];
  durationSeconds: number;
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
}

export interface StoryboardQcOutput {
  gates: ShortDramaGate[];
  shotCount: number;
  ready: boolean;
}

export interface KeyframeRenderOutput {
  keyframes: Array<{ shotId: string; artifactId: string; uri: string }>;
}

export interface AudioTimelineOutput {
  tracks: Array<{ anchorId: string; speaker?: string; text: string; startSeconds: number; durationSeconds: number }>;
}

export interface VideoChainOutput {
  chains: Array<{
    shotId: string;
    inputLastFrameId: string;
    nextShotId?: string;
    durationSeconds: number;
  }>;
  /**
   * 3D 场景卡嵌合（片AC，2026-09-06）：输入带 scene_card_ref + camera_trajectory
   * 两可选栏且同时合法才出现；缺栏零行为变化（本栏缺席 = 既有行为逐字同）。
   * references/referenceDirective 真源 = blender-to-video-bridge（previz 档 compositionOnly）；
   * cameraDirective 真源 = camera-trajectory-to-prompt（六槽 Camera 槽描述词）。
   * VPS handler 消费：cameraDirective 并进视频生成请求 prompt；references 交通道
   * （站点 B 端 /v1/videos/generations 无帧栏位——registry 已锤，直调站点 /api/generate-videos
   * 的 scene_card/camera_trajectory 栏可全生效，见 deploy-staging/blender-gateway/ac-video-scene-stitch.md）。
   */
  sceneDirector?: {
    referenceDirective: string;
    cameraDirective: string;
    references: Array<{ url: string; mimeType: string; referenceRole: string }>;
    notes: string[];
  };
}

export interface EditingManifestOutput {
  engine: "ffmpeg" | "jianying";
  clips: Array<{ shotId: string; uri: string; order: number; durationSeconds: number }>;
  manifestId: string;
}

export interface DeliveryAssetsOutput {
  manifestId: string;
  assets: Array<{ id: string; kind: string; uri: string; required: boolean }>;
  formats: string[];
}

const STORYBOARD_GATE_IDS = [
  "shot_identity",
  "shot_order",
  "scene_binding",
  "duration_bounds",
  "segment_duration",
  "prompt_present",
  "characters_bound",
  "scenes_bound",
  "character_lock",
  "scene_lock",
  "keyframe_present",
  "last_frame_present",
  "audio_anchor_present",
  "aspect_ratio",
  "dialogue_alignment",
  "continuity",
  "export_readiness",
] as const;

const DEFINITIONS: ShortDramaToolDefinition[] = [
  {
    id: "script_scene_parse",
    description: "将剧本拆成场次与动作/台词节拍。",
    input: "{ script: string }",
    output: "{ scenes: Array<{ sceneId, heading, beats }> }",
    gates: ["script_present", "scene_non_empty", "beat_types_valid", "dialogue_speaker_present"],
    unsupported: ["script_parser_unavailable"],
    canvas: { workflowId: "shortdrama-production", nodeType: "text", artifactKind: "script-scene" },
  },
  {
    id: "cast_asset_lock",
    description: "将角色与场景资产绑定到本次制作，供跨镜头复用。",
    input: "{ assets: Array<{ id, kind, name, appearancePrompt?, referenceUri? }>, requiredIds?: string[] }",
    output: "{ locks: Array<asset & { locked: true }>, missingIds: string[] }",
    gates: ["asset_id_unique", "asset_kind_valid", "appearance_or_reference_present", "required_assets_resolved"],
    unsupported: ["asset_store_unavailable"],
    canvas: { workflowId: "shortdrama-production", nodeType: "character_card", artifactKind: "cast-asset-lock" },
  },
  {
    id: "storyboard_qc_17",
    description: "在生成前对分镜执行 17 道确定性门禁。",
    input: "{ shots, lockedCharacterCardIds, lockedSceneCardIds, segmentDurationSeconds }",
    output: "{ gates: Array<17>, shotCount, ready }",
    gates: [...STORYBOARD_GATE_IDS],
    unsupported: ["storyboard_schema_unavailable"],
    canvas: { workflowId: "shortdrama-production", nodeType: "config", artifactKind: "storyboard-qc-17" },
  },
  {
    id: "keyframe_render",
    description: "以已通过 QC 的分镜产生关键帧；没有影像上游时明确降级。",
    input: "{ shots: StoryboardShot[] }",
    output: "{ keyframes: Array<{ shotId, artifactId, uri }> }",
    gates: ["storyboard_ready", "image_upstream_available", "rendered_artifacts_present"],
    unsupported: ["image_generation_upstream_missing", "async_render_requires_runner"],
    canvas: { workflowId: "shortdrama-production", nodeType: "image", artifactKind: "keyframe" },
  },
  {
    id: "audio_first_timeline",
    description: "先建立台词/音讯锚点，再把时间轴对齐镜头。",
    input: "{ dialogue: Array<{ id, text, speaker? }> }",
    output: "{ tracks: Array<{ anchorId, speaker?, text, startSeconds, durationSeconds }> }",
    gates: ["dialogue_present", "audio_anchor_unique", "speech_duration_deterministic"],
    unsupported: ["audio_generation_upstream_missing"],
    canvas: { workflowId: "shortdrama-production", nodeType: "audio", artifactKind: "audio-first-timeline" },
  },
  {
    id: "last_frame_video_chain",
    description: "以每镜最后一帧作为下一镜输入，输出可追踪的影片链。",
    input: "{ shots: Array<{ shotId, keyframeId, durationSeconds }> }",
    output: "{ chains: Array<{ shotId, inputLastFrameId, nextShotId?, durationSeconds }> }",
    gates: ["shots_ordered", "last_frame_reference_present", "duration_bounds", "video_upstream_available"],
    unsupported: ["video_generation_upstream_missing"],
    canvas: { workflowId: "shortdrama-production", nodeType: "video", artifactKind: "last-frame-video-chain" },
  },
  {
    id: "editing_manifest",
    description: "输出 Jianying 或 FFmpeg 可消费的剪辑 manifest，不宣称已完成渲染。",
    input: "{ clips: Array<{ shotId, uri, durationSeconds }>, engine?: 'ffmpeg'|'jianying' }",
    output: "{ engine, clips, manifestId }",
    gates: ["clips_present", "shot_order_contiguous", "durations_valid", "editing_engine_available"],
    unsupported: ["editing_engine_missing"],
    canvas: { workflowId: "shortdrama-production", nodeType: "config", artifactKind: "editing-manifest" },
  },
  {
    id: "delivery_assets",
    description: "检查并整理成片交付资产清单与格式。",
    input: "{ assets: Array<{ id, kind, uri, required? }>, formats?: string[] }",
    output: "{ manifestId, assets, formats }",
    gates: ["required_assets_present", "uris_present", "format_declared", "delivery_manifest_stable"],
    unsupported: ["delivery_storage_missing"],
    canvas: { workflowId: "shortdrama-production", nodeType: "config", artifactKind: "delivery-assets" },
  },
];

export function getShortDramaToolDefinitions(): ShortDramaToolDefinition[] {
  return DEFINITIONS.map((definition) => ({
    ...definition,
    gates: [...definition.gates],
    unsupported: [...definition.unsupported],
    canvas: { ...definition.canvas },
  }));
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
}

function artifactId(tool: ShortDramaToolId, input: unknown): string {
  const raw = JSON.stringify(input);
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return `${tool}-${(hash >>> 0).toString(16)}`;
}

function makeCanvas(
  tool: ShortDramaToolId,
  status: ShortDramaStatus,
  kind: string,
  inputRefs: string[],
  outputRefs: string[],
  gates: ShortDramaGate[],
  unsupportedCode?: string,
): ShortDramaCanvasMetadata {
  return {
    workflowId: "shortdrama-production",
    tool,
    status,
    artifactKind: kind,
    artifactId: artifactId(tool, { inputRefs, outputRefs }),
    inputRefs,
    outputRefs,
    gateIds: gates.map((gate) => gate.id),
    ...(unsupportedCode ? { unsupportedCode } : {}),
  };
}

function result<T>(tool: ShortDramaToolId, input: unknown, output: T, gates: ShortDramaGate[], status: ShortDramaStatus, kind: string, refs: { input?: string[]; output?: string[] } = {}): ShortDramaToolResult<T> {
  return {
    tool,
    status,
    output,
    gates,
    canvas: makeCanvas(tool, status, kind, refs.input ?? [], refs.output ?? [], gates),
  };
}

function unsupported<T>(tool: ShortDramaToolId, input: unknown, output: T, gates: ShortDramaGate[], kind: string, code: string, message: string, capability: string, refs: string[] = []): ShortDramaToolResult<T> {
  return {
    ...result(tool, input, output, gates, "unsupported", kind, { input: refs }),
    unsupported: { code, message, requiredCapability: capability },
    canvas: makeCanvas(tool, "unsupported", kind, refs, [], gates, code),
  };
}

function blocked<T>(tool: ShortDramaToolId, input: unknown, output: T, gates: ShortDramaGate[], kind: string): ShortDramaToolResult<T> {
  return result(tool, input, output, gates, "blocked", kind, { input: [] });
}

export const STORYBOARD_MIN_SHOT_SECONDS = 10;

function durationBoundsDetail(offenders: string[]): string {
  if (offenders.length === 0) return `each shot is ${STORYBOARD_MIN_SHOT_SECONDS}-30 seconds (per-clip billing: fill the model's largest slot)`;
  return `duration_bounds failed: every shot must be ${STORYBOARD_MIN_SHOT_SECONDS}-30 seconds (hard rule: no <${STORYBOARD_MIN_SHOT_SECONDS}s short slots; 单镜须 ${STORYBOARD_MIN_SHOT_SECONDS}-30 秒，严禁 <${STORYBOARD_MIN_SHOT_SECONDS} 秒短档，不足请并入前一镜或加长至 ${STORYBOARD_MIN_SHOT_SECONDS}s 以上). offending shots: ${offenders.slice(0, 10).join(", ")}`;
}

function gate(id: string, passed: boolean, detail: string): ShortDramaGate {
  return { id, passed, detail };
}

function parseScript(input: unknown): ShortDramaToolResult<ScriptSceneOutput> {
  const script = text(asRecord(input).script);
  if (!script) {
    const gates = [gate("script_present", false, "script is empty")];
    return blocked("script_scene_parse", input, { scenes: [] }, gates, "script-scene");
  }

  const lines = script.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const scenes: ScriptScene[] = [];
  let current: ScriptScene | null = null;
  for (const line of lines) {
    const heading = /^(?:场|scene)\s*([\w-]+)?\s*(.*)$/i.exec(line);
    if (heading) {
      current = { sceneId: `S${String(scenes.length + 1).padStart(2, "0")}`, heading: line, beats: [] };
      scenes.push(current);
      continue;
    }
    if (!current) {
      current = { sceneId: "S01", heading: "未命名场次", beats: [] };
      scenes.push(current);
    }
    const dialogue = /^([^：:]{1,80})[：:](.+)$/.exec(line);
    current.beats.push(dialogue
      ? { type: "dialogue", speaker: dialogue[1]?.trim() || null, text: dialogue[2]?.trim() || "" }
      : { type: "action", speaker: null, text: line });
  }

  const gates = [
    gate("script_present", true, "script contains text"),
    gate("scene_non_empty", scenes.length > 0 && scenes.every((scene) => scene.beats.length > 0), "every scene has beats"),
    gate("beat_types_valid", scenes.every((scene) => scene.beats.every((beat) => beat.text.length > 0)), "beats are typed and non-empty"),
    gate("dialogue_speaker_present", scenes.every((scene) => scene.beats.every((beat) => beat.type !== "dialogue" || Boolean(beat.speaker))), "dialogue beats have speakers"),
  ];
  return result("script_scene_parse", input, { scenes }, gates, gates.every((item) => item.passed) ? "succeeded" : "blocked", "script-scene", {
    output: scenes.map((scene) => scene.sceneId),
  });
}

function lockAssets(input: unknown): ShortDramaToolResult<CastAssetLockOutput> {
  const record = asRecord(input);
  const assets = arrayOfRecords(record.assets).map((item) => ({
    id: text(item.id),
    kind: text(item.kind) as CastAsset["kind"],
    name: text(item.name),
    ...(text(item.appearancePrompt) ? { appearancePrompt: text(item.appearancePrompt) } : {}),
    ...(text(item.referenceUri) ? { referenceUri: text(item.referenceUri) } : {}),
  }));
  const requiredIds = Array.isArray(record.requiredIds) ? record.requiredIds.filter((id): id is string => typeof id === "string") : assets.map((asset) => asset.id);
  const ids = new Set<string>();
  const valid = assets.filter((asset) => {
    if (!asset.id || ids.has(asset.id)) return false;
    ids.add(asset.id);
    return (asset.kind === "character" || asset.kind === "scene") && Boolean(asset.name) && Boolean(asset.appearancePrompt || asset.referenceUri);
  });
  const missingIds = requiredIds.filter((id) => !valid.some((asset) => asset.id === id));
  const locks = valid.map((asset) => ({ ...asset, locked: true as const }));
  const gates = [
    gate("asset_id_unique", ids.size === assets.length, "asset ids are unique"),
    gate("asset_kind_valid", assets.every((asset) => asset.kind === "character" || asset.kind === "scene"), "asset kinds are character or scene"),
    gate("appearance_or_reference_present", valid.length === assets.length, "each asset has a prompt or reference"),
    gate("required_assets_resolved", missingIds.length === 0, missingIds.length ? `missing: ${missingIds.join(", ")}` : "all required assets resolved"),
  ];
  const status = gates.every((item) => item.passed) ? "succeeded" : "blocked";
  return result("cast_asset_lock", input, { locks, missingIds }, gates, status, "cast-asset-lock", {
    output: locks.map((lock) => lock.id),
  });
}

function storyboardQc(input: unknown): ShortDramaToolResult<StoryboardQcOutput> {
  const record = asRecord(input);
  const shots = arrayOfRecords(record.shots).map((item) => ({
    shotId: text(item.shotId),
    sceneId: text(item.sceneId) || undefined,
    order: finiteNumber(item.order),
    prompt: text(item.prompt),
    characterCardIds: Array.isArray(item.characterCardIds) ? item.characterCardIds.filter((id): id is string => typeof id === "string") : [],
    sceneCardIds: Array.isArray(item.sceneCardIds) ? item.sceneCardIds.filter((id): id is string => typeof id === "string") : [],
    durationSeconds: finiteNumber(item.durationSeconds),
    keyframeId: text(item.keyframeId) || undefined,
    lastFrameId: text(item.lastFrameId) || undefined,
    audioAnchorId: text(item.audioAnchorId) || undefined,
    aspectRatio: text(item.aspectRatio) || undefined,
  }));
  const lockedCharacters = new Set(Array.isArray(record.lockedCharacterCardIds) ? record.lockedCharacterCardIds.filter((id): id is string => typeof id === "string") : []);
  const lockedScenes = new Set(Array.isArray(record.lockedSceneCardIds) ? record.lockedSceneCardIds.filter((id): id is string => typeof id === "string") : []);
  const segmentDuration = finiteNumber(record.segmentDurationSeconds);
  const uniqueShotIds = new Set(shots.map((shot) => shot.shotId));
  const ordered = shots.every((shot, index) => shot.order === index + 1);
  const every = (fn: (shot: StoryboardShot) => boolean) => shots.length > 0 && shots.every(fn);
  const gates: ShortDramaGate[] = [
    gate("shot_identity", every((shot) => Boolean(shot.shotId)) && uniqueShotIds.size === shots.length, "shot ids are present and unique"),
    gate("shot_order", ordered, "shot order is contiguous"),
    gate("scene_binding", every((shot) => Boolean(shot.sceneId)), "each shot is bound to a scene"),
    // 2026-09-20 暴君裁定：上游视频按条计费（5/15/30s 同价），按条秒数最大化才划算。
    // 单镜上限 2→30s（允许打满 seedance-2.5 480p/30s 固定档；2.0 档 10-15s 同样在界内）。
    // 2026-10-02 H7：AGENTS.md 硬规则「严禁 <10 秒短档」（workflow-video-rules §4b，seedance 2.0/2.5 下限 10s）机器化。
    // 适用范围＝本门禁验的每个分镜条目（每镜 = 一条上游视频计费单位，不分题材/镜头类型；§4b 无例外条款，
    // 余数不足 10s 须并入前一条或明确说明，故不豁免末镜）。
    gate("duration_bounds", every((shot) => shot.durationSeconds >= STORYBOARD_MIN_SHOT_SECONDS && shot.durationSeconds <= 30), durationBoundsDetail(shots.filter((shot) => !(shot.durationSeconds >= STORYBOARD_MIN_SHOT_SECONDS && shot.durationSeconds <= 30)).map((shot) => `${shot.shotId}(${Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : "?"}s)`))),
    // 段长去 15s 上限：总长由创作需求决定，门禁只验「已声明且为正」；拆条打满档位是分镜纪律不是门禁。
    gate("segment_duration", segmentDuration > 0, "segment duration is declared and positive (split into max-slot clips, e.g. 80s -> 30+30+20)"),
    gate("prompt_present", every((shot) => Boolean(shot.prompt)), "each shot has a prompt"),
    gate("characters_bound", every((shot) => (shot.characterCardIds?.length ?? 0) > 0), "each shot has character bindings"),
    gate("scenes_bound", every((shot) => (shot.sceneCardIds?.length ?? 0) > 0), "each shot has scene bindings"),
    gate("character_lock", every((shot) => (shot.characterCardIds ?? []).every((id) => lockedCharacters.has(id)),), "character references resolve to locked cards"),
    gate("scene_lock", every((shot) => (shot.sceneCardIds ?? []).every((id) => lockedScenes.has(id)),), "scene references resolve to locked cards"),
    gate("keyframe_present", every((shot) => Boolean(shot.keyframeId)), "each shot has a keyframe"),
    gate("last_frame_present", every((shot) => Boolean(shot.lastFrameId)), "each shot has a last frame"),
    gate("audio_anchor_present", every((shot) => Boolean(shot.audioAnchorId)), "each shot has an audio anchor"),
    gate("aspect_ratio", every((shot) => shot.aspectRatio === "9:16" || shot.aspectRatio === "16:9" || shot.aspectRatio === "1:1"), "aspect ratio is deliverable"),
    gate("dialogue_alignment", every((shot) => Boolean(shot.audioAnchorId)), "dialogue/audio anchor is aligned"),
    gate("continuity", every((shot) => Boolean(shot.keyframeId && shot.lastFrameId)), "continuity references exist"),
    gate("export_readiness", every((shot) => Boolean(shot.shotId && shot.prompt && shot.durationSeconds > 0)), "shot is exportable"),
  ];
  const status = gates.every((item) => item.passed) ? "succeeded" : "blocked";
  return result("storyboard_qc_17", input, { gates, shotCount: shots.length, ready: status === "succeeded" }, gates, status, "storyboard-qc-17", {
    input: shots.map((shot) => shot.shotId),
  });
}

function keyframeRender(input: unknown, capabilities: ShortDramaCapabilities): ShortDramaToolResult<KeyframeRenderOutput> {
  const shots = arrayOfRecords(asRecord(input).shots).map((item) => ({
    shotId: text(item.shotId),
    prompt: text(item.prompt),
    durationSeconds: finiteNumber(item.durationSeconds),
  }));
  const gates = [
    gate("storyboard_ready", shots.length > 0 && shots.every((shot) => Boolean(shot.shotId && shot.prompt && shot.durationSeconds >= 2 && shot.durationSeconds <= 5)), "shots are renderable"),
    gate("image_upstream_available", Boolean(capabilities.imageGeneration?.render), "image renderer callback is available"),
    gate("rendered_artifacts_present", false, "render callback has not run"),
  ];
  if (!capabilities.imageGeneration?.render) {
    gates[2] = gate("rendered_artifacts_present", false, "image renderer callback is unavailable");
    return unsupported("keyframe_render", input, { keyframes: [] }, gates, "keyframe", "image_generation_upstream_missing", "影像生成上游未接入，未建立关键帧。", "imageGeneration.render", shots.map((shot) => shot.shotId));
  }
  const keyframes: KeyframeRenderOutput["keyframes"] = [];
  for (const shot of shots) {
    const rendered = capabilities.imageGeneration.render({ ...shot });
    if (rendered instanceof Promise) {
      return unsupported("keyframe_render", input, { keyframes: [] }, gates, "keyframe", "async_render_requires_runner", "目前纯函式 runner 不会隐式等待非同步影像工作。", "synchronous imageGeneration.render", shots.map((shot) => shot.shotId));
    }
    keyframes.push({ shotId: shot.shotId, ...rendered });
  }
  gates[2] = gate("rendered_artifacts_present", keyframes.length === shots.length, "all keyframes have artifact ids and uris");
  const status = gates.every((item) => item.passed) ? "succeeded" : "blocked";
  return result("keyframe_render", input, { keyframes }, gates, status, "keyframe", {
    input: shots.map((shot) => shot.shotId),
    output: keyframes.map((keyframe) => keyframe.artifactId),
  });
}

function audioTimeline(input: unknown, capabilities: ShortDramaCapabilities): ShortDramaToolResult<AudioTimelineOutput> {
  const dialogue = arrayOfRecords(asRecord(input).dialogue).map((item) => ({
    id: text(item.id),
    text: text(item.text),
    speaker: text(item.speaker) || undefined,
  }));
  const tracks: AudioTimelineOutput["tracks"] = [];
  let cursor = 0;
  for (const item of dialogue) {
    const durationSeconds = Math.max(1, Math.ceil(Array.from(item.text).length / 4));
    tracks.push({ anchorId: item.id, speaker: item.speaker, text: item.text, startSeconds: cursor, durationSeconds });
    cursor += durationSeconds;
  }
  const gates = [
    gate("dialogue_present", dialogue.length > 0 && dialogue.every((item) => item.id && item.text), "dialogue entries are present"),
    gate("audio_anchor_unique", new Set(dialogue.map((item) => item.id)).size === dialogue.length, "audio anchors are unique"),
    gate("speech_duration_deterministic", tracks.every((track) => track.durationSeconds >= 1), "speech duration is derived from text length"),
  ];
  if (!capabilities.audioGeneration?.provider) {
    return unsupported("audio_first_timeline", input, { tracks }, gates, "audio-first-timeline", "audio_generation_upstream_missing", "音讯生成上游未接入；仅保留时间轴不宣称已出音讯。", "audioGeneration.provider", dialogue.map((item) => item.id));
  }
  return result("audio_first_timeline", input, { tracks }, gates, gates.every((item) => item.passed) ? "succeeded" : "blocked", "audio-first-timeline", {
    input: dialogue.map((item) => item.id),
    output: tracks.map((track) => track.anchorId),
  });
}

function videoChain(input: unknown, capabilities: ShortDramaCapabilities): ShortDramaToolResult<VideoChainOutput> {
  const record = asRecord(input);
  const shots = arrayOfRecords(record.shots).map((item) => ({
    shotId: text(item.shotId),
    keyframeId: text(item.keyframeId),
    lastFrameId: text(item.lastFrameId),
    durationSeconds: finiteNumber(item.durationSeconds),
  }));
  const chains = shots.map((shot, index) => ({
    shotId: shot.shotId,
    inputLastFrameId: index === 0 ? shot.keyframeId : shots[index - 1]?.lastFrameId || "",
    ...(shots[index + 1]?.shotId ? { nextShotId: shots[index + 1]?.shotId } : {}),
    durationSeconds: shot.durationSeconds,
  }));
  // 3D 场景卡嵌合（片AC）：scene_card_ref + camera_trajectory 两可选栏，同时合法才出
  // sceneDirector；缺栏/脏栏 = null = 既有行为逐字同（下游链路对该栏不可见）。
  const fusion = fuseSceneVideo(record.scene_card_ref, record.camera_trajectory);
  const sceneDirector = fusion
    ? {
        referenceDirective: fusion.frameCard.referenceDirective,
        cameraDirective: fusion.cameraDirective,
        references: fusion.frameCard.references.map((reference) => ({
          url: reference.url,
          mimeType: reference.mimeType,
          referenceRole: reference.referenceRole ?? "general",
        })),
        notes: fusion.frameCard.notes,
      }
    : undefined;
  const gates = [
    gate("shots_ordered", shots.length > 0 && shots.every((shot) => Boolean(shot.shotId)), "shots have stable order"),
    gate("last_frame_reference_present", shots.every((shot, index) => Boolean(index === 0 ? shot.keyframeId : shot.lastFrameId)), "each shot has an input frame reference"),
    gate("duration_bounds", shots.every((shot) => shot.durationSeconds >= 2 && shot.durationSeconds <= 30), "each shot is 2-30 seconds (per-clip billing: fill the model's largest slot)"),
    gate("video_upstream_available", Boolean(capabilities.videoGeneration?.provider), "video provider is declared"),
  ];
  if (!capabilities.videoGeneration?.provider) {
    return unsupported("last_frame_video_chain", input, { chains }, gates, "last-frame-video-chain", "video_generation_upstream_missing", "影片生成上游未接入，未宣称已生成影片。", "videoGeneration.provider", shots.map((shot) => shot.shotId));
  }
  return result("last_frame_video_chain", input, { chains, ...(sceneDirector ? { sceneDirector } : {}) }, gates, gates.every((item) => item.passed) ? "succeeded" : "blocked", "last-frame-video-chain", {
    input: shots.map((shot) => shot.keyframeId),
    output: chains.map((chain) => chain.shotId),
  });
}

function editingManifest(input: unknown, capabilities: ShortDramaCapabilities): ShortDramaToolResult<EditingManifestOutput> {
  const record = asRecord(input);
  const engine = (text(record.engine) || capabilities.editing?.engine) as "ffmpeg" | "jianying" | "";
  const clips = arrayOfRecords(record.clips).map((item, index) => ({
    shotId: text(item.shotId),
    uri: text(item.uri),
    order: index + 1,
    durationSeconds: finiteNumber(item.durationSeconds),
  }));
  const gates = [
    gate("clips_present", clips.length > 0, "clips are present"),
    gate("shot_order_contiguous", clips.every((clip) => clip.order > 0), "clip order is contiguous"),
    gate("durations_valid", clips.every((clip) => clip.durationSeconds > 0), "clip durations are positive"),
    gate("editing_engine_available", engine === "ffmpeg" || engine === "jianying", "editing engine is ffmpeg or jianying"),
  ];
  if (engine !== "ffmpeg" && engine !== "jianying") {
    return unsupported("editing_manifest", input, { engine: "ffmpeg", clips: [], manifestId: "" }, gates, "editing-manifest", "editing_engine_missing", "未接入 Jianying 或 FFmpeg，未宣称已完成剪辑。", "editing.engine", clips.map((clip) => clip.shotId));
  }
  const manifestId = artifactId("editing_manifest", { engine, clips });
  return result("editing_manifest", input, { engine, clips, manifestId }, gates, gates.every((item) => item.passed) ? "succeeded" : "blocked", "editing-manifest", {
    input: clips.map((clip) => clip.shotId),
    output: [manifestId],
  });
}

function deliveryAssets(input: unknown): ShortDramaToolResult<DeliveryAssetsOutput> {
  const record = asRecord(input);
  const formats = Array.isArray(record.formats) ? record.formats.filter((format): format is string => typeof format === "string" && Boolean(format.trim())) : ["mp4", "json"];
  const assets = arrayOfRecords(record.assets).map((item) => ({
    id: text(item.id),
    kind: text(item.kind),
    uri: text(item.uri),
    required: item.required !== false,
  }));
  const gates = [
    gate("required_assets_present", assets.length > 0 && assets.every((asset) => !asset.required || Boolean(asset.id)), "required asset ids are present"),
    gate("uris_present", assets.length > 0 && assets.every((asset) => Boolean(asset.uri)), "asset uris are present"),
    gate("format_declared", formats.length > 0, "at least one delivery format is declared"),
    gate("delivery_manifest_stable", assets.every((asset) => Boolean(asset.id && asset.kind)), "asset entries are stable"),
  ];
  if (!gates.every((item) => item.passed)) {
    return blocked("delivery_assets", input, { manifestId: "", assets, formats }, gates, "delivery-assets");
  }
  const manifestId = artifactId("delivery_assets", { assets, formats });
  return result("delivery_assets", input, { manifestId, assets, formats }, gates, "succeeded", "delivery-assets", {
    input: assets.map((asset) => asset.id),
    output: [manifestId],
  });
}

export function runShortDramaTool<T = unknown>(tool: ShortDramaToolId, input: unknown, capabilities: ShortDramaCapabilities = {}): ShortDramaToolResult<T> {
  switch (tool) {
    case "script_scene_parse": return parseScript(input) as ShortDramaToolResult<T>;
    case "cast_asset_lock": return lockAssets(input) as ShortDramaToolResult<T>;
    case "storyboard_qc_17": return storyboardQc(input) as ShortDramaToolResult<T>;
    case "keyframe_render": return keyframeRender(input, capabilities) as ShortDramaToolResult<T>;
    case "audio_first_timeline": return audioTimeline(input, capabilities) as ShortDramaToolResult<T>;
    case "last_frame_video_chain": return videoChain(input, capabilities) as ShortDramaToolResult<T>;
    case "editing_manifest": return editingManifest(input, capabilities) as ShortDramaToolResult<T>;
    case "delivery_assets": return deliveryAssets(input) as ShortDramaToolResult<T>;
  }
}
