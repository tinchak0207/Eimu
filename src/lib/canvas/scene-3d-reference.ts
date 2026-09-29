// 3D 場景卡（scene_3d）→ 生成參考綁定 ＋ 回分鏡溯源（P1-1，2026-09-28）。
//
// 兩個缺口的補法（只補缺口，不重寫既有融合層）：
//
//   ① 參考綁定（餵得進去）：scene_3d 節點的白模/靜態圖過去只能看——卡面 stills 網格
//      有圖，但生成節點的參考集（`CanvasGenerationReference`）不看 scene_3d 型別
//      （`referenceImageUrlOf` 只認 image/reference），所以連了線也餵不進生成請求。
//      本檔把它接上既有畫布生成鏈路：
//        sceneCard.stills_urls --(既有參考卡輪子)--> CanvasGenerationReference[]
//      輪子真源＝`blender-to-video-bridge.buildSceneFrameReferenceCard`（**正是**
//      `scene3d-video-fusion` 用的同一份：previz→composition、lookdev→style、
//      非圖像檔剔除、幀數帽），本檔只做「GenerationReference → 畫布參考形」的欄位映射，
//      不另造第二套判定。產物經 `resolveGenerationInputs` 併進 references →
//      `/api/canvas/generate` 的 `reference_images`（與 @引用/reference 節點同一條通道）。
//
//   ② 回分鏡可追溯（讀得回來）：生成節點記下「這張參考來自哪個 director stage／哪一鏡」。
//      鍵名照現場既有約定，不另立詞表：
//        · `directorStageId` —— 沿用 director 族 `directorSessionId` 的 `<domain>Id` 形；
//          值＝來源 3D 導演台 stage＝`scene_3d` 節點 id。
//        · `shotId` —— 沿用 `storyboard-contract` 生產形 `StoryboardShotProduction.shotId`
//          口徑（`shotNumber` 或 `S{序}`；上限同 `normalizeStoryboardShot` 的 16 字）。
//      兩鍵都在 metadata 雙白名單內（還原端 `layout.toNodeMetadata` ＋ 上行端
//      `compactMetadataForAgent`），故刷新/回舊會話後仍讀得回（漏一端＝靜默消失）。
//
// 去重契約（**動它就會弄丟幀**）：`mergeGenerationReferences` 以 nodeId 去重
// （有 nodeId 者先佔名額）。同一 stage 的多張幀只在**首張**標 nodeId（＝該 stage 節點 id，
// 服務回分鏡指針），其餘幀省略 nodeId → 靠 url 去重，全部存活且指針唯一。
//
// 誠實邊界：`buildSceneFrameReferenceCard` 已剔除視頻（turntable mp4/webm）與模型檔；
// stills 缺席（導入卡只帶 glb_path）＝零參考，不編造。角色映射用既有
// `toReferenceImageRole`（未知值收斂 general），不另立枚舉。

import { buildSceneFrameReferenceCard } from "../blender-to-video-bridge";
import { toReferenceImageRole } from "../image-types";
import { CanvasNodeType } from "./types";
import type { CanvasConnection, CanvasNode, CanvasNodeMetadata } from "./types";
import type { CanvasGenerationReference } from "./semantic-nodes";

/** 回分鏡溯源指針：這張參考來自哪個 3D 導演台 stage、哪一鏡。 */
export interface SceneDirectorReferenceTrace {
  /** 來源 3D 導演台 stage（`scene_3d` 節點）id。 */
  directorStageId: string;
  /** 該生成所屬鏡號（`shotNumber` 口徑，`S{序}` 亦收）；無分鏡歸屬＝缺席。 */
  shotId?: string;
}

/** 鏡號上限＝`normalizeStoryboardShot` 的同把尺（漏對齊＝兩處字串長度不一致）。 */
const SHOT_ID_MAX = 16;

/** 節點的鏡號（`storyboardShot.shotNumber` 口徑；空/非字串＝無歸屬）。 */
function shotIdOf(node: CanvasNode | undefined): string | undefined {
  const raw = node?.metadata?.storyboardShot?.shotNumber;
  if (typeof raw !== "string") return undefined;
  const shot = raw.trim().slice(0, SHOT_ID_MAX);
  return shot || undefined;
}

/**
 * 一個 scene_3d 節點 → 畫布生成參考圖（復用既有參考卡輪子，不重寫融合層）。
 *
 * - 非 scene_3d 節點 / 無 sceneCard / stills 缺席 → 空陣列（零行為，不編造）。
 * - 首張帶 `nodeId`＝該節點 id（回分鏡指針的載體）；其餘幀不帶（去重契約見檔頭）。
 * - 角色取自參考卡（previz→composition；lookdev→style），經 `toReferenceImageRole` 收斂。
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
 * 沿「入邊」收生成節點的 3D 舞台參考（配對 staged trace）。
 *
 * 取**首個**真的產出幀的 scene_3d 節點當 `directorStageId`（多舞台連入時，
 * 幀全部保留，指針指向第一個有幀的舞台——不猜、不平均）。
 * `shotId` 優先取舞台節點自身的鏡號，其次取生成節點自身的（生成發生在某鏡節點上時）。
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
 * 溯源指針 → 生成節點 metadata patch（純函式，呼叫端 `patchNodeMetadata` 直用）。
 * 無 trace＝空 patch（不寫空殼鍵，零行為）。
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
 * 讀回（生成節點 metadata → 溯源指針）。缺 `directorStageId`／空字串＝回 null
 * （不製造半形指針）；值先 trim，與清洗端同尺。
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
