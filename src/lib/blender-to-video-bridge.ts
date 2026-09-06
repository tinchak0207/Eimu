/**
 * Blender → Video bridge：3D 場景卡幀 → 視頻生成參考卡映射。
 *
 * 輪子真源（白名單外逐行等價，白名單內只改數據源）：
 * - 欄位構造：`GenerationReference`（src/lib/generation-core/types.ts:34-42）——
 *   url / mimeType / name / referenceRole，referenceRole 沿用既有枚舉
 *   （"general"|"character"|"product"|"style"|"composition"），不建第二套詞表。
 * - 通道契約：i2v 首/尾幀通道 references[0..1]（newapi-video-upstream.ts:144-155
 *   → metadata.first_frame_image/last_frame_image、metaso-upstream.ts:57-63 →
 *   role first_frame/last_frame，兩通道都 cap 2 張）。
 *
 * 白名單改動 = 數據源：幀來自 sceneCard.stills_urls（Blender 渲染 PNG），
 * 而非用戶上傳圖。品質标注（欄位級區分）：previz 灰盒幀 referenceRole 只准
 * "composition"（構圖參考）；lookdev 檔幀可作 "style"（風格參考）。
 * previz 幀永不佔 i2v 首/尾幀位（references[0..1]）——上游不讀 role，role 區分
 * 對它們無防護力，故用分層輸出硬隔離。
 */

import type { Scene3dCardMetadata } from "./canvas/types";
import type { GenerationReference } from "./generation-core/types";

/** 場景幀品質檔位：previz=Eevee 灰盒預演（samples=1 存活預設），lookdev=cycles/材質燈光定稿檔。 */
export type SceneFrameQuality = "previz" | "lookdev";

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface SceneFrameReferenceInput {
  /** 3D 場景卡（canvas scene_3d 節點 metadata，雙白名單已透傳）。 */
  sceneCard: Scene3dCardMetadata;
  /** 幀品質檔位。缺省 "previz"（保守：Blender 橋默認走 Eevee previz 存活預設）。 */
  quality?: SceneFrameQuality;
  /** 首/尾幀覆蓋（例如從 turntable 抽幀後的 URL）；缺省用 stills 前兩張。 */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  /** 參考卡張數帽。缺省 2 = i2v 首/尾幀通道契約（兩上游一致）。 */
  maxReferences?: number;
}

export interface SceneFrameReferenceCard {
  /** 可直接餵視頻生成 workflow.references 的參考卡（≤ maxReferences 張）。 */
  references: GenerationReference[];
  /** 生效的品質檔位。 */
  quality: SceneFrameQuality;
  /** true = previz：參考幀只准構圖參考，不得作風格參考，也不得佔首/尾幀位。 */
  compositionOnly: boolean;
  /** 隨卡拼接進視頻 prompt 的參考聲明（Seedance 正向語彙，品質鎖同形）。 */
  referenceDirective: string;
  /** 構造備注：剔除項與原因（可觀測、可驗收）。 */
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
 * sceneCard 幀 → 視頻生成參考卡。
 *
 * 分層規則（previz 品質标注的欄位級落地）：
 * - lookdev 檔：still 幀可佔 references[0..1]（i2v 首/尾幀位），referenceRole = "style"。
 * - previz 檔：referenceRole = "composition"，compositionOnly = true；本函數只產出
 *   構圖角色卡，呼叫方不得把它們放進 references[0..1]（上游按位置解讀，不讀 role）。
 * - turntable_url 是視頻（mp4/webm），不是幀：永不入參考卡；要抽幀由呼叫方先解出
 *   幀 URL 再經 firstFrameUrl/lastFrameUrl 覆蓋傳入。
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
      notes.push(`skipped non-image frame ${trimmed.slice(0, 120)} (turntable/blend/glb 不入參考卡)`);
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
    notes.push("previz 品質檔下 firstFrameUrl/lastFrameUrl 覆蓋被忽略：灰盒幀不得佔 i2v 首/尾幀位");
  }

  // 首/尾幀位：僅 lookdev 檔允許；顯式覆蓋優先，否則 stills 順位補位。
  if (!compositionOnly) {
    const first = input.firstFrameUrl?.trim() || input.sceneCard.stills_urls[0];
    if (first) push(first, "scene3d-first-frame");
    const last = input.lastFrameUrl?.trim() || input.sceneCard.stills_urls[1];
    if (last) push(last, "scene3d-last-frame");
  }

  // 剩餘槽位：stills 順位補齊（previz 檔在這裡以 composition 角色進卡）。
  for (const still of input.sceneCard.stills_urls) {
    if (references.length >= max) break;
    push(still, `scene3d-ref-${references.length}`);
  }

  if (references.length === 0) {
    notes.push("sceneCard 無可用圖像幀（stills 空或全為視頻/模型檔）：參考卡為空，不得宣稱已附參考圖");
  }
  if (!input.sceneCard.turntable_url && !input.sceneCard.blend_path) {
    notes.push("sceneCard 缺 turntable_url 與 blend_path：非完整交付，幀可信度存疑");
  }

  return {
    references,
    quality,
    compositionOnly,
    referenceDirective: compositionOnly ? PREVIZ_DIRECTIVE : LOOKDEV_DIRECTIVE,
    notes,
  };
}
