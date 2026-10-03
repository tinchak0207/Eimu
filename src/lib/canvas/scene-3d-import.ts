// 本機 3D 模型導入的**契約與驗證單一真源**（2026-09-27 刀：本機 GLB → 畫布 3D 場景卡）。
//
// 為什麼要有這一層：導入是「瀏覽器選檔 → 站內上傳路由 → 畫布節點 metadata」三段，
// 前後端都要擋同一組規則（副檔名、體積、容器魔數），兩份手寫判據＝兩個漂移點。
// 本檔零依賴（只 import type），前端元件與 `src/app/api/canvas/scene-3d/route.ts` 共用同一份。
//
// 職責邊界：
//   - 驗證：`validateScene3dUpload`（真函式，測試直接呼叫，不是源碼字串掃描）。
//   - 建卡：`scene3dImportCardMetadata` 只寫**真實**欄位——`scene_summary` 由來源推導
//     （「从本机导入的 GLB/GLTF」），**不編造場景描述**（沒人看過這個模型的內容）。
//   - 不做上傳本身：上傳走既有物件存儲輪子（`blob-backend` 的 put），不在本檔重造。

import type { Scene3dCardMetadata } from "./types";

/**
 * 導入模型體積上限（前後端同一把尺）。
 *
 * **為什麼不是 100MB**：本路由走「表單上傳 → 站內函式 → 物件存儲」這條代理路徑，
 * 請求體要先過平台硬頂（本 repo `/api/agent/sessions/[id]/attachments` 檔頭記的
 * Vercel 單請求體 4.5MB）。宣告 100MB 只會讓 4.5–100MB 的檔在前端驗證通過、
 * 卻在到達本函式前就被平台 413 —— 那是騙用戶。此處取平台真值並留 multipart 餘裕。
 * LibTV 級的 100MB 導入需要「瀏覽器直傳物件存儲」通道（Vercel Blob client upload
 * 或閘道直傳端點）；生產 blob 後端是 VPS image-data-api（`useVpsBlobBackend()`），
 * 站內現無該通道，故先誠實收窄上限，不以文案假裝能吃大檔。
 */
export const MAX_SCENE_3D_BYTES = 4 * 1024 * 1024;

/** 上限的人話（給用戶看的簡體文案；前端與錯誤訊息共用同一句）。 */
export const SCENE_3D_SIZE_HINT = `单次导入不超过 ${Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB。更大的模型请走 Blender 桥，或让助理生成。`;

/** 檔案選擇器 accept（.glb 交換格式 / .gltf JSON 場景）。 */
export const SCENE_3D_ACCEPT = ".glb,.gltf";

/** 兩個合法副檔名（小寫，含點）。 */
export const SCENE_3D_EXTENSIONS = [".glb", ".gltf"] as const;
export type Scene3dExtension = (typeof SCENE_3D_EXTENSIONS)[number];

/** 容器魔數探針長度（GLB 的 "glTF" magic 在頭 4 位元組；.gltf 只需看首個非空白字元）。 */
export const SCENE_3D_MAGIC_BYTES = 16;

export type Scene3dImportRejectReason =
  | "bad_extension"
  | "empty_file"
  | "too_large"
  | "bad_content";

export type Scene3dImportValidation =
  | { ok: true; extension: Scene3dExtension }
  | { ok: false; reason: Scene3dImportRejectReason; message: string };

/** 副檔名（小寫含點）；無副檔名回空字串。 */
export function scene3dExtensionOf(name: string): string {
  const base = (name ?? "").trim();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * 導入檔驗證（前後端共用）。
 *
 * - `head`＝檔案前 ≤16 位元組（呼叫端用 `file.slice(0, 16)` 取）。**可不傳**：
 *   不傳就只驗副檔名與體積（不比對魔數＝不無憑據地拒絕）。
 * - `.glb`：頭 4 位元組必須是 `glTF` magic；即使檔名對，內容不是 GLB 也拒。
 * - `.gltf`：首個非空白位元組必須是 `{`（JSON 物件；glTF JSON 根必為物件）。
 * - 失敗訊息是**給用戶看的人話**（簡體），不帶內部路徑或堆疊。
 */
export function validateScene3dUpload(input: {
  name: string;
  size: number;
  head?: Uint8Array | null;
  /**
   * 覆寫體積上限（bytes）。預設＝`MAX_SCENE_3D_BYTES`（站內代理路的平台真值）。
   * 前端要「先驗形狀、體積交給別的通道」時傳 `Number.POSITIVE_INFINITY`：
   * 體積的真實上限由該通道自己把關（例如兩段式直傳取回應的 `maxBytes`），
   * 這裡就只負責副檔名與容器魔數。
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
      // GLB 容器：magic 0x46546C67（小端讀作 "glTF" 的 ASCII 位元組序 g l T F）。
      const isGlb =
        head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46;
      if (!isGlb) {
        return { ok: false, reason: "bad_content", message: "文件不是有效的 GLB 模型（容器头不对）。" };
      }
    } else {
      let first = -1;
      for (let i = 0; i < head.length; i += 1) {
        const byte = head[i];
        // 跳過 UTF-8 BOM 與空白（0x20/0x09/0x0a/0x0d/0xef/0xbb/0xbf）。
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
 * 節點標題＝檔名去副檔名（trim、上限 100 字；空 → 契約預設標題，不編造名字）。
 */
export function scene3dImportTitle(fileName: string): string {
  const base = (fileName ?? "").trim();
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot).trim() : base;
  return stem.slice(0, 100) || "3D 场景卡";
}

/**
 * 導入卡的 sceneCard（**只有真實值**）：`glb_path` ＋ 由來源推導的 `scene_summary`
 * ＋ 判別欄位 `source: "import"`。turntable/stills/blend/duration 一律不寫空殼——
 * 缺席就是缺席（卡面走減法，見 `Scene3dCardBody`）。
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
