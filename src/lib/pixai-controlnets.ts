// ControlNet 結構控制 → PixAI parameters 的純函式映射層。
//
// 任務：把「結構控制圖（control image）+ 控制類型（canny/depth/…）」從 API 請求
// 一路轉成 pixai `createGenerationTask` 的 `controlNets` 欄位。
//
// 注意：pixai 的 controlNets 每筆欄位形狀是依 pixai.art 網頁端的 ControlNet 設定
// 模型推斷（A1111 風格），未用真實 pixai 帳號驗證過，只有 contract 測試鎖住本層的
// 輸入輸出形狀。若 pixai 上游回報欄位錯誤，唯一要改的就是本檔——全系統只有這裡
// 產生 pixai 形狀的 entries。端到端未驗證（見 /v1/images/generations 的測試註記）。
//
// 任何一個入口（C 端 generate-images / B 端 /v1/generations / durable worker /
// python bridge）都必須消費本模組，禁止在路由裡自行拼 pixai 形狀。

/**
 * 請求端的結構控制規格（與供應商無關的中立形狀）。
 *
 * `image` 是控制圖的引用：可以是控制面 /v1/uploads 回傳的 `mediaId`，
 * 或是絕對 http(s) URL。原樣透傳為 pixai 的 `imageUrl` —— pixai 是否接受
 * mediaId 視上游實作（HYPOTHESIS）。
 */
export interface ControlNetSpec {
  /** 控制圖引用（mediaId 或絕對 URL）。必填。 */
  image: string;
  /** 控制類型：canny / depth / openpose / softedge / lineart / …（大小寫不拘）。 */
  type: string;
  /** 控制強度，[0, 2]，預設 1。 */
  weight?: number;
  /** 控制模式 0..3，預設 1（balanced）。 */
  controlMode?: number;
  /** 像素級對齊，預設 true。 */
  pixelPerfect?: boolean;
  /** 生效起始步比例 [0,1]，預設 0。 */
  startStep?: number;
  /** 生效結束步比例 [0,1]，預設 1。 */
  endStep?: number;
}

/** pixai `controlNets` 陣列單筆的形狀。 */
export interface PixaiControlNetEntry {
  imageUrl: string;
  /** pixai 的 preprocessor 名字（大寫駝峰，如 "Canny"）。 */
  preprocessor: string;
  controlMode: number;
  pixelPerfect: boolean;
  startStep: number;
  endStep: number;
  weight: number;
}

/** 單次生成最多攜帶的控制網數量（超過的直接拒絕整個請求）。 */
export const MAX_CONTROL_NETS = 4;

/**
 * 常見控制類型別名 → pixai preprocessor 名。
 *
 * 大小寫不拘：`canny`/`Canny` 都是同一個。不在表內但通過字元白名單的 type 原樣透傳
 * （讓 pixai 新增的 preprocessor 不用加壓縮就能接入）；會破壞 body 的骯髒 input
 * （非字串、含控制字元）一律拒絕。
 */
export const CONTROL_NET_PREPROCESSORS: Readonly<Record<string, string>> = {
  canny: "Canny",
  depth: "Depth",
  "depth-anything-v2": "Depth",
  openpose: "OpenPose",
  mlsd: "MLSD",
  softedge: "SoftEdge",
  hed: "SoftEdge",
  lineart: "Lineart",
  "lineart-anime": "Lineart_Anime",
  scribble: "Scribble",
  normal: "Normal",
  segmentation: "Semantic",
  semantic: "Semantic",
  u2net: "Semantic",
  tile: "Tile",
  color: "Recolor",
  recolor: "Recolor",
  inpaint: "Inpaint_Global_Harmonious",
  ip2p: "IP2P",
  "reference-only": "Reference_Only",
};

const CONTROL_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/;
const IMAGE_PATTERN = /^(https?:\/\/\S{3,2048}|[A-Za-z0-9_\-]{4,64})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 清洗單筆 ControlNetSpec。非法輸入回 null（由呼叫方決定丟棄或報錯）。
 *
 * 規則：
 * - `image` 必須是絕對 URL 或極短 id 型字串，否則整筆拒絕。
 * - `type` 先比對別名表；不在表內的必須過字元白名單才能透傳。
 * - `weight`/`startStep`/`endStep` 數字化後 clamp；`controlMode` 整數化並 clamp 0..3。
 */
export function normalizeControlNetSpec(raw: unknown): ControlNetSpec | null {
  if (!isPlainObject(raw)) return null;
  const image = typeof raw.image === "string" ? raw.image.trim() : "";
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  if (!image || !IMAGE_PATTERN.test(image)) return null;
  if (!type) return null;

  const canonicalType = CONTROL_NET_PREPROCESSORS[type.toLowerCase()] ?? type;
  if (!CONTROL_TYPE_PATTERN.test(canonicalType)) return null;

  const spec: ControlNetSpec = { image, type: canonicalType };
  if (raw.weight !== undefined) spec.weight = clampNumber(raw.weight, 1, 0, 2);
  if (raw.controlMode !== undefined) {
    const mode = Math.floor(clampNumber(raw.controlMode, 1, 0, 3));
    spec.controlMode = mode;
  }
  if (raw.pixelPerfect !== undefined) spec.pixelPerfect = raw.pixelPerfect === true;
  if (raw.startStep !== undefined) spec.startStep = clampNumber(raw.startStep, 0, 0, 1);
  if (raw.endStep !== undefined) spec.endStep = clampNumber(raw.endStep, 1, 0, 1);
  return spec;
}

export interface ControlNetsNormalization {
  /** 通過清洗的筆，順序保持輸入順序。 */
  valid: ControlNetSpec[];
  /** 被拒絕的位置（index），供呼叫方回 400 時帶訊息。 */
  rejected: number[];
}

/**
 * 清洗整個 `controlNets` 輸入。非陣列或超過數量上限視為「全部無效」——
 * 呼叫方應回 400，而不是默默截斷用戶的請求。
 */
export function normalizeControlNets(raw: unknown): ControlNetsNormalization {
  if (!Array.isArray(raw)) return { valid: [], rejected: [] };
  if (raw.length > MAX_CONTROL_NETS) return { valid: [], rejected: Array.from({ length: raw.length }, (_, i) => i) };

  const valid: ControlNetSpec[] = [];
  const rejected: number[] = [];
  raw.forEach((entry, index) => {
    const normalized = normalizeControlNetSpec(entry);
    if (normalized) valid.push(normalized);
    else rejected.push(index);
  });
  return { valid, rejected };
}

/**
 * 請求端 ControlNetSpec → pixai `controlNets` 單筆。
 *
 * `type` 已在 normalize 階段歸一成 canonical 名；這裡直接當 preprocessor 餵出去。
 */
export function toPixaiControlNet(spec: ControlNetSpec): PixaiControlNetEntry {
  return {
    imageUrl: spec.image,
    preprocessor: spec.type,
    controlMode: spec.controlMode ?? 1,
    pixelPerfect: spec.pixelPerfect ?? true,
    startStep: round3(spec.startStep ?? 0),
    endStep: round3(spec.endStep ?? 1),
    weight: round3(spec.weight ?? 1),
  };
}

/** 一批 specs → pixai `controlNets` 陣列。空陣列表示無控制網（別改回 [] 的伴生行為）。 */
export function toPixaiControlNets(specs: readonly ControlNetSpec[]): PixaiControlNetEntry[] {
  return specs.map(toPixaiControlNet);
}