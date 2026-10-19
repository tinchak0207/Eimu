// 本机 3D 模型导入的**契约与验证单一真源**（2026-09-27 刀：本机 GLB → 画布 3D 场景卡）。
//
// 为什么要有这一层：导入是「浏览器选档 → 站内上传路由 → 画布节点 metadata」三段，
// 前后端都要挡同一组规则（副档名、体积、容器魔数），两份手写判据＝两个漂移点。
// 本档零依赖（只 import type），前端元件与 `src/app/api/canvas/scene-3d/route.ts` 共用同一份。
//
// 职责边界：
//   - 验证：`validateScene3dUpload`（真函式，测试直接呼叫，不是源码字串扫描）。
//   - 建卡：`scene3dImportCardMetadata` 只写**真实**栏位——`scene_summary` 由来源推导
//     （「从本机导入的 GLB/GLTF」），**不编造场景描述**（没人看过这个模型的内容）。
//   - 不做上传本身：上传走既有物件存储轮子（`blob-backend` 的 put），不在本档重造。

import type { Scene3dCardMetadata } from "./types";

/**
 * 导入模型体积上限（前后端同一把尺）。
 *
 * **为什么不是 100MB**：本路由走「表单上传 → 站内函式 → 物件存储」这条代理路径，
 * 请求体要先过平台硬顶（本 repo `/api/agent/sessions/[id]/attachments` 档头记的
 * Vercel 单请求体 4.5MB）。宣告 100MB 只会让 4.5–100MB 的档在前端验证通过、
 * 却在到达本函式前就被平台 413 —— 那是骗用户。此处取平台真值并留 multipart 余裕。
 * LibTV 级的 100MB 导入需要「浏览器直传物件存储」通道（Vercel Blob client upload
 * 或闸道直传端点）；生产 blob 后端是 VPS image-data-api（`useVpsBlobBackend()`），
 * 站内现无该通道，故先诚实收窄上限，不以文案假装能吃大档。
 */
export const MAX_SCENE_3D_BYTES = 4 * 1024 * 1024;

/** 上限的人话（给用户看的简体文案；前端与错误讯息共用同一句）。 */
export const SCENE_3D_SIZE_HINT = `单次导入不超过 ${Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB。更大的模型请走 Blender 桥，或让助理生成。`;

/** 档案选择器 accept（.glb 交换格式 / .gltf JSON 场景）。 */
export const SCENE_3D_ACCEPT = ".glb,.gltf";

/** 两个合法副档名（小写，含点）。 */
export const SCENE_3D_EXTENSIONS = [".glb", ".gltf"] as const;
export type Scene3dExtension = (typeof SCENE_3D_EXTENSIONS)[number];

/** 容器魔数探针长度（GLB 的 "glTF" magic 在头 4 位元组；.gltf 只需看首个非空白字元）。 */
export const SCENE_3D_MAGIC_BYTES = 16;

export type Scene3dImportRejectReason =
  | "bad_extension"
  | "empty_file"
  | "too_large"
  | "bad_content";

export type Scene3dImportValidation =
  | { ok: true; extension: Scene3dExtension }
  | { ok: false; reason: Scene3dImportRejectReason; message: string };

/** 副档名（小写含点）；无副档名回空字串。 */
export function scene3dExtensionOf(name: string): string {
  const base = (name ?? "").trim();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * 导入档验证（前后端共用）。
 *
 * - `head`＝档案前 ≤16 位元组（呼叫端用 `file.slice(0, 16)` 取）。**可不传**：
 *   不传就只验副档名与体积（不比对魔数＝不无凭据地拒绝）。
 * - `.glb`：头 4 位元组必须是 `glTF` magic；即使档名对，内容不是 GLB 也拒。
 * - `.gltf`：首个非空白位元组必须是 `{`（JSON 物件；glTF JSON 根必为物件）。
 * - 失败讯息是**给用户看的人话**（简体），不带内部路径或堆叠。
 */
export function validateScene3dUpload(input: {
  name: string;
  size: number;
  head?: Uint8Array | null;
  /**
   * 覆写体积上限（bytes）。预设＝`MAX_SCENE_3D_BYTES`（站内代理路的平台真值）。
   * 前端要「先验形状、体积交给别的通道」时传 `Number.POSITIVE_INFINITY`：
   * 体积的真实上限由该通道自己把关（例如两段式直传取回应的 `maxBytes`），
   * 这里就只负责副档名与容器魔数。
   */
  maxBytes?: number;
}): Scene3dImportValidation {
  const extension = scene3dExtensionOf(input.name);
  if (!SCENE_3D_EXTENSIONS.includes(extension as Scene3dExtension)) {
    return {
      ok: false,
      reason: "bad_extension",
      message: "只支持 .glb / .gltf 格式的 3D 模型文件。",
    };
  }
  const size = typeof input.size === "number" && Number.isFinite(input.size) ? input.size : 0;
  if (size <= 0) {
    return { ok: false, reason: "empty_file", message: "文件是空的，请重新选择。" };
  }
  const cap = typeof input.maxBytes === "number" && input.maxBytes > 0 ? input.maxBytes : MAX_SCENE_3D_BYTES;
  if (size > cap) {
    return {
      ok: false,
      reason: "too_large",
      message: SCENE_3D_SIZE_HINT,
    };
  }

  const head = input.head;
  if (head && head.length > 0) {
    const ext = extension as Scene3dExtension;
    if (ext === ".glb") {
      // GLB 容器：magic 0x46546C67（小端读作 "glTF" 的 ASCII 位元组序 g l T F）。
      const isGlb =
        head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46;
      if (!isGlb) {
        return { ok: false, reason: "bad_content", message: "文件不是有效的 GLB 模型（容器头不对）。" };
      }
    } else {
      let first = -1;
      for (let i = 0; i < head.length; i += 1) {
        const byte = head[i];
        // 跳过 UTF-8 BOM 与空白（0x20/0x09/0x0a/0x0d/0xef/0xbb/0xbf）。
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
        if (byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
        first = byte;
        break;
      }
      if (first !== 0x7b) {
        return { ok: false, reason: "bad_content", message: "文件不是有效的 glTF（JSON 根应为对象）。" };
      }
    }
  }

  return { ok: true, extension: extension as Scene3dExtension };
}

/**
 * 节点标题＝档名去副档名（trim、上限 100 字；空 → 契约预设标题，不编造名字）。
 */
export function scene3dImportTitle(fileName: string): string {
  const base = (fileName ?? "").trim();
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot).trim() : base;
  return stem.slice(0, 100) || "3D 场景卡";
}

/**
 * 导入卡的 sceneCard（**只有真实值**）：`glb_path` ＋ 由来源推导的 `scene_summary`
 * ＋ 判别栏位 `source: "import"`。turntable/stills/blend/duration 一律不写空壳——
 * 缺席就是缺席（卡面走减法，见 `Scene3dCardBody`）。
 */
export function scene3dImportCardMetadata(input: {
  url: string;
  fileName: string;
}): Scene3dCardMetadata {
  const ext = scene3dExtensionOf(input.fileName);
  const label = ext === ".gltf" ? "GLTF" : "GLB";
  return {
    glb_path: input.url,
    scene_summary: `从本机导入的 ${label}`,
    source: "import",
  };
}
