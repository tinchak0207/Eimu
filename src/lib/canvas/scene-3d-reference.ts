// 3D 场景卡（scene_3d）→ 生成参考绑定 ＋ 回分镜溯源（P1-1，2026-09-28）。
//
// 两个缺口的补法（只补缺口，不重写既有融合层）：
//
//   ① 参考绑定（喂得进去）：scene_3d 节点的白模/静态图过去只能看——卡面 stills 网格
//      有图，但生成节点的参考集（`CanvasGenerationReference`）不看 scene_3d 型别
//      （`referenceImageUrlOf` 只认 image/reference），所以连了线也喂不进生成请求。
//      本档把它接上既有画布生成链路：
//        sceneCard.stills_urls --(既有参考卡轮子)--> CanvasGenerationReference[]
//      轮子真源＝`blender-to-video-bridge.buildSceneFrameReferenceCard`（**正是**
//      `scene3d-video-fusion` 用的同一份：previz→composition、lookdev→style、
//      非图像档剔除、帧数帽），本档只做「GenerationReference → 画布参考形」的栏位映射，
//      不另造第二套判定。产物经 `resolveGenerationInputs` 并进 references →
//      `/api/canvas/generate` 的 `reference_images`（与 @引用/reference 节点同一条通道）。
//
//   ② 回分镜可追溯（读得回来）：生成节点记下「这张参考来自哪个 director stage／哪一镜」。
//      键名照现场既有约定，不另立词表：
//        · `directorStageId` —— 沿用 director 族 `directorSessionId` 的 `<domain>Id` 形；
//          值＝来源 3D 导演台 stage＝`scene_3d` 节点 id。
//        · `shotId` —— 沿用 `storyboard-contract` 生产形 `StoryboardShotProduction.shotId`
//          口径（`shotNumber` 或 `S{序}`；上限同 `normalizeStoryboardShot` 的 16 字）。
//      两键都在 metadata 双白名单内（还原端 `layout.toNodeMetadata` ＋ 上行端
//      `compactMetadataForAgent`），故刷新/回旧会话后仍读得回（漏一端＝静默消失）。
//
// 去重契约（**动它就会弄丢帧**）：`mergeGenerationReferences` 以 nodeId 去重
// （有 nodeId 者先占名额）。同一 stage 的多张帧只在**首张**标 nodeId（＝该 stage 节点 id，
// 服务回分镜指针），其余帧省略 nodeId → 靠 url 去重，全部存活且指针唯一。
//
// 诚实边界：`buildSceneFrameReferenceCard` 已剔除视频（turntable mp4/webm）与模型档；
// stills 缺席（导入卡只带 glb_path）＝零参考，不编造。角色映射用既有
// `toReferenceImageRole`（未知值收敛 general），不另立枚举。

import { buildSceneFrameReferenceCard } from "../blender-to-video-bridge";
import { toReferenceImageRole } from "../image-types";
import { CanvasNodeType } from "./types";
import type { CanvasConnection, CanvasNode, CanvasNodeMetadata } from "./types";
import type { CanvasGenerationReference } from "./semantic-nodes";

/** 回分镜溯源指针：这张参考来自哪个 3D 导演台 stage、哪一镜。 */
export interface SceneDirectorReferenceTrace {
  /** 来源 3D 导演台 stage（`scene_3d` 节点）id。 */
  directorStageId: string;
  /** 该生成所属镜号（`shotNumber` 口径，`S{序}` 亦收）；无分镜归属＝缺席。 */
  shotId?: string;
}

/** 镜号上限＝`normalizeStoryboardShot` 的同把尺（漏对齐＝两处字串长度不一致）。 */
const SHOT_ID_MAX = 16;

/** 节点的镜号（`storyboardShot.shotNumber` 口径；空/非字串＝无归属）。 */
function shotIdOf(node: CanvasNode | undefined): string | undefined {
  const raw = node?.metadata?.storyboardShot?.shotNumber;
  if (typeof raw !== "string") return undefined;
  const shot = raw.trim().slice(0, SHOT_ID_MAX);
  return shot || undefined;
}

/**
 * 一个 scene_3d 节点 → 画布生成参考图（复用既有参考卡轮子，不重写融合层）。
 *
 * - 非 scene_3d 节点 / 无 sceneCard / stills 缺席 → 空阵列（零行为，不编造）。
 * - 首张带 `nodeId`＝该节点 id（回分镜指针的载体）；其余帧不带（去重契约见档头）。
 * - 角色取自参考卡（previz→composition；lookdev→style），经 `toReferenceImageRole` 收敛。
 */
export function sceneCardGenerationReferences(node: CanvasNode | undefined): CanvasGenerationReference[] {
  if (!node || node.type !== CanvasNodeType.Scene3d) return [];
  const sceneCard = node.metadata?.sceneCard;
  if (!sceneCard) return [];
  const card = buildSceneFrameReferenceCard({ sceneCard });
  return card.references.map((reference, index) => ({
    ...(index === 0 ? { nodeId: node.id } : {}),
    url: reference.url,
    role: toReferenceImageRole(reference.referenceRole),
    name: reference.name?.trim() || node.title || "3D 场景参考",
  }));
}

/**
 * 沿「入边」收生成节点的 3D 舞台参考（配对 staged trace）。
 *
 * 取**首个**真的产出帧的 scene_3d 节点当 `directorStageId`（多舞台连入时，
 * 帧全部保留，指针指向第一个有帧的舞台——不猜、不平均）。
 * `shotId` 优先取舞台节点自身的镜号，其次取生成节点自身的（生成发生在某镜节点上时）。
 */
export function resolveSceneDirectorReferences(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  targetNodeId: string,
): { references: CanvasGenerationReference[]; trace: SceneDirectorReferenceTrace | null } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const references: CanvasGenerationReference[] = [];
  let stage: CanvasNode | undefined;
  for (const connection of connections) {
    if (connection.toNodeId !== targetNodeId) continue;
    const from = byId.get(connection.fromNodeId);
    if (!from || from.type !== CanvasNodeType.Scene3d) continue;
    const derived = sceneCardGenerationReferences(from);
    if (derived.length === 0) continue;
    if (!stage) stage = from;
    references.push(...derived);
  }
  if (!stage) return { references: [], trace: null };
  const shotId = shotIdOf(stage) ?? shotIdOf(byId.get(targetNodeId));
  return {
    references,
    trace: { directorStageId: stage.id, ...(shotId ? { shotId } : {}) },
  };
}

/**
 * 溯源指针 → 生成节点 metadata patch（纯函式，呼叫端 `patchNodeMetadata` 直用）。
 * 无 trace＝空 patch（不写空壳键，零行为）。
 */
export function sceneDirectorTraceMetadata(
  trace: SceneDirectorReferenceTrace | null | undefined,
): Pick<CanvasNodeMetadata, "directorStageId" | "shotId"> {
  if (!trace) return {};
  const directorStageId = trace.directorStageId.trim();
  if (!directorStageId) return {};
  const shotId = trace.shotId?.trim();
  return { directorStageId, ...(shotId ? { shotId } : {}) };
}

/**
 * 读回（生成节点 metadata → 溯源指针）。缺 `directorStageId`／空字串＝回 null
 * （不制造半形指针）；值先 trim，与清洗端同尺。
 */
export function readSceneDirectorTrace(
  metadata: CanvasNodeMetadata | undefined,
): SceneDirectorReferenceTrace | null {
  const directorStageId =
    typeof metadata?.directorStageId === "string" ? metadata.directorStageId.trim() : "";
  if (!directorStageId) return null;
  const shotId = typeof metadata?.shotId === "string" ? metadata.shotId.trim() : "";
  return { directorStageId, ...(shotId ? { shotId } : {}) };
}
