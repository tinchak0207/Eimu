// ControlNet 结构控制 → PixAI parameters 的纯函式映射层。
//
// 任务：把「结构控制图（control image）+ 控制类型（canny/depth/…）」从 API 请求
// 一路转成 pixai `createGenerationTask` 的 `controlNets` 栏位。
//
// 注意：pixai 的 controlNets 每笔栏位形状是依 pixai.art 网页端的 ControlNet 设定
// 模型推断（A1111 风格），未用真实 pixai 帐号验证过，只有 contract 测试锁住本层的
// 输入输出形状。若 pixai 上游回报栏位错误，唯一要改的就是本档——全系统只有这里
// 产生 pixai 形状的 entries。端到端未验证（见 /v1/images/generations 的测试注记）。
//
// 任何一个入口（C 端 generate-images / B 端 /v1/generations / durable worker /
// python bridge）都必须消费本模组，禁止在路由里自行拼 pixai 形状。

/**
 * 请求端的结构控制规格（与供应商无关的中立形状）。
 *
 * `image` 是控制图的引用：可以是控制面 /v1/uploads 回传的 `mediaId`，
 * 或是绝对 http(s) URL。原样透传为 pixai 的 `imageUrl` —— pixai 是否接受
 * mediaId 视上游实作（HYPOTHESIS）。
 */
export interface ControlNetSpec {
  /** 控制图引用（mediaId 或绝对 URL）。必填。 */
  image: string;
  /** 控制类型：canny / depth / openpose / softedge / lineart / …（大小写不拘）。 */
  type: string;
  /** 控制强度，[0, 2]，预设 1。 */
  weight?: number;
  /** 控制模式 0..3，预设 1（balanced）。 */
  controlMode?: number;
  /** 像素级对齐，预设 true。 */
  pixelPerfect?: boolean;
  /** 生效起始步比例 [0,1]，预设 0。 */
  startStep?: number;
  /** 生效结束步比例 [0,1]，预设 1。 */
  endStep?: number;
}

/** pixai `controlNets` 阵列单笔的形状。 */
export interface PixaiControlNetEntry {
  imageUrl: string;
  /** pixai 的 preprocessor 名字（大写驼峰，如 "Canny"）。 */
  preprocessor: string;
  controlMode: number;
  pixelPerfect: boolean;
  startStep: number;
  endStep: number;
  weight: number;
}

/** 单次生成最多携带的控制网数量（超过的直接拒绝整个请求）。 */
export const MAX_CONTROL_NETS = 4;

/**
 * 常见控制类型别名 → pixai preprocessor 名。
 *
 * 大小写不拘：`canny`/`Canny` 都是同一个。不在表内但通过字元白名单的 type 原样透传
 * （让 pixai 新增的 preprocessor 不用加压缩就能接入）；会破坏 body 的肮脏 input
 * （非字串、含控制字元）一律拒绝。
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
 * 清洗单笔 ControlNetSpec。非法输入回 null（由呼叫方决定丢弃或报错）。
 *
 * 规则：
 * - `image` 必须是绝对 URL 或极短 id 型字串，否则整笔拒绝。
 * - `type` 先比对别名表；不在表内的必须过字元白名单才能透传。
 * - `weight`/`startStep`/`endStep` 数字化后 clamp；`controlMode` 整数化并 clamp 0..3。
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
  /** 通过清洗的笔，顺序保持输入顺序。 */
  valid: ControlNetSpec[];
  /** 被拒绝的位置（index），供呼叫方回 400 时带讯息。 */
  rejected: number[];
}

/**
 * 清洗整个 `controlNets` 输入。非阵列或超过数量上限视为「全部无效」——
 * 呼叫方应回 400，而不是默默截断用户的请求。
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
 * 请求端 ControlNetSpec → pixai `controlNets` 单笔。
 *
 * `type` 已在 normalize 阶段归一成 canonical 名；这里直接当 preprocessor 喂出去。
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

/** 一批 specs → pixai `controlNets` 阵列。空阵列表示无控制网（别改回 [] 的伴生行为）。 */
export function toPixaiControlNets(specs: readonly ControlNetSpec[]): PixaiControlNetEntry[] {
  return specs.map(toPixaiControlNet);
}