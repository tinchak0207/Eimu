/**
 * Blender → Video bridge：3D 场景卡帧 → 视频生成参考卡映射。
 *
 * 轮子真源（白名单外逐行等价，白名单内只改数据源）：
 * - 栏位构造：`GenerationReference`（src/lib/generation-core/types.ts:34-42）——
 *   url / mimeType / name / referenceRole，referenceRole 沿用既有枚举
 *   （"general"|"character"|"product"|"style"|"composition"），不建第二套词表。
 * - 通道契约：i2v 首/尾帧通道 references[0..1]（newapi-video-upstream.ts:144-155
 *   → metadata.first_frame_image/last_frame_image、metaso-upstream.ts:57-63 →
 *   role first_frame/last_frame，两通道都 cap 2 张）。
 *
 * 白名单改动 = 数据源：帧来自 sceneCard.stills_urls（Blender 渲染 PNG），
 * 而非用户上传图。品质标注（栏位级区分）：previz 灰盒帧 referenceRole 只准
 * "composition"（构图参考）；lookdev 档帧可作 "style"（风格参考）。
 * previz 帧永不占 i2v 首/尾帧位（references[0..1]）——上游不读 role，role 区分
 * 对它们无防护力，故用分层输出硬隔离。
 */

import type { Scene3dCardMetadata } from "./canvas/types";
import type { GenerationReference } from "./generation-core/types";

/** 场景帧品质档位：previz=Eevee 灰盒预演（samples=1 存活预设），lookdev=cycles/材质灯光定稿档。 */
export type SceneFrameQuality = "previz" | "lookdev";

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface SceneFrameReferenceInput {
  /** 3D 场景卡（canvas scene_3d 节点 metadata，双白名单已透传）。 */
  sceneCard: Scene3dCardMetadata;
  /** 帧品质档位。缺省 "previz"（保守：Blender 桥默认走 Eevee previz 存活预设）。 */
  quality?: SceneFrameQuality;
  /** 首/尾帧覆盖（例如从 turntable 抽帧后的 URL）；缺省用 stills 前两张。 */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  /** 参考卡张数帽。缺省 2 = i2v 首/尾帧通道契约（两上游一致）。 */
  maxReferences?: number;
}

export interface SceneFrameReferenceCard {
  /** 可直接喂视频生成 workflow.references 的参考卡（≤ maxReferences 张）。 */
  references: GenerationReference[];
  /** 生效的品质档位。 */
  quality: SceneFrameQuality;
  /** true = previz：参考帧只准构图参考，不得作风格参考，也不得占首/尾帧位。 */
  compositionOnly: boolean;
  /** 随卡拼接进视频 prompt 的参考声明（Seedance 正向语汇，品质锁同形）。 */
  referenceDirective: string;
  /** 构造备注：剔除项与原因（可观测、可验收）。 */
  notes: string[];
}

function extOf(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

function mimeOf(url: string): string | null {
  return IMAGE_MIME_BY_EXT[extOf(url)] ?? null;
}

const PREVIZ_DIRECTIVE =
  "The reference frames define composition and spatial layout only — final materials, lighting, and color grade follow the prompt, not the unshaded look of the references.";
const LOOKDEV_DIRECTIVE =
  "The reference frames define composition, materials, and lighting mood — keep the on-screen look consistent with them.";

/**
 * sceneCard 帧 → 视频生成参考卡。
 *
 * 分层规则（previz 品质标注的栏位级落地）：
 * - lookdev 档：still 帧可占 references[0..1]（i2v 首/尾帧位），referenceRole = "style"。
 * - previz 档：referenceRole = "composition"，compositionOnly = true；本函数只产出
 *   构图角色卡，呼叫方不得把它们放进 references[0..1]（上游按位置解读，不读 role）。
 * - turntable_url 是视频（mp4/webm），不是帧：永不入参考卡；要抽帧由呼叫方先解出
 *   帧 URL 再经 firstFrameUrl/lastFrameUrl 覆盖传入。
 */
export function buildSceneFrameReferenceCard(input: SceneFrameReferenceInput): SceneFrameReferenceCard {
  const quality: SceneFrameQuality = input.quality ?? "previz";
  const compositionOnly = quality === "previz";
  const max = Math.max(1, Math.min(input.maxReferences ?? 2, 4));
  const notes: string[] = [];
  const seen = new Set<string>();
  const references: GenerationReference[] = [];

  const push = (url: string, name: string) => {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    const mime = mimeOf(trimmed);
    if (!mime) {
      notes.push(`skipped non-image frame ${trimmed.slice(0, 120)} (turntable/blend/glb 不入参考卡)`);
      return;
    }
    references.push({
      url: trimmed,
      mimeType: mime,
      name,
      referenceRole: compositionOnly ? "composition" : "style",
    });
  };

  if (compositionOnly && (input.firstFrameUrl || input.lastFrameUrl)) {
    notes.push("previz 品质档下 firstFrameUrl/lastFrameUrl 覆盖被忽略：灰盒帧不得占 i2v 首/尾帧位");
  }

  // 首/尾帧位：仅 lookdev 档允许；显式覆盖优先，否则 stills 顺位补位。
  // stills_urls 自 2026-09-27 起是可选栏（本机导入卡只带 glb_path）→ 缺席＝空清单。
  const stills = input.sceneCard.stills_urls ?? [];
  if (!compositionOnly) {
    const first = input.firstFrameUrl?.trim() || stills[0];
    if (first) push(first, "scene3d-first-frame");
    const last = input.lastFrameUrl?.trim() || stills[1];
    if (last) push(last, "scene3d-last-frame");
  }

  // 剩余槽位：stills 顺位补齐（previz 档在这里以 composition 角色进卡）。
  for (const still of stills) {
    if (references.length >= max) break;
    push(still, `scene3d-ref-${references.length}`);
  }

  if (references.length === 0) {
    notes.push("sceneCard 无可用图像帧（stills 空或全为视频/模型档）：参考卡为空，不得宣称已附参考图");
  }
  if (!input.sceneCard.turntable_url && !input.sceneCard.blend_path) {
    notes.push("sceneCard 缺 turntable_url 与 blend_path：非完整交付，帧可信度存疑");
  }

  return {
    references,
    quality,
    compositionOnly,
    referenceDirective: compositionOnly ? PREVIZ_DIRECTIVE : LOOKDEV_DIRECTIVE,
    notes,
  };
}
