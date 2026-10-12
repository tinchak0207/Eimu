// B 端参考图通道（`/v1/images/generations` 与 `/v1/images/edits` 共用的轮子）。
//
// 2026-09-25：原 `/v1/images/edits` 的私有 helper（`resolveEditReference` 及相依的
// `mimeFromUrl` / `extensionFor` / `MAX_DATA_IMAGE_BYTES` / `EditInputError`）整段搬到
// 本档，edits 路由改成 import —— **纯搬移，行为逐位元不变**。唯一的形式改动是把
// data URI 正则提成常数 `DATA_IMAGE_PATTERN`（原为 inline 字面），形状校验与落地
// 共用同一个字面，语义零改。
//
// generations 侧新增的 `reference_images` 与 prompt 里的行内实体 tag `@[种类:名称]`
// 也走这里：形状校验（任何 I/O 之前）→ 命中的卡的参考图在前、显式 `reference_images`
// 在后 → 按 url 去重 → 上限 `MAX_REFERENCE_IMAGES` 张 → http(s) 直通、
// `data:image/*;base64` 落地 Blob 换公网 URL。
//
// 核心层本来就吃 `workflow.references`（worker 端 `supplier-adapter.ts` 按
// `references.length` 分支，不按 kind），所以本档只负责把入口接出来，不重写上游通道。

import { createHash } from "node:crypto";
import { put } from "@/lib/blob-backend";
import { validateImageBuffer } from "@/lib/generation-core/artifact-service";
import { MAX_REQUEST_REFERENCE_IMAGES } from "@/lib/generation-core/request-limits";
import type { GenerationReference, GenerationWorkflow } from "@/lib/generation-core/types";
import { applyCharacterCards } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import {
  expandEntityTokens,
  findMalformedEntityTokens,
  parseEntityTokens,
  type MalformedEntityToken,
} from "./entity-tokens";

// ─────────────────────────────────────────── 纯搬移（原 edits 私有 helper）

/** data:image URI 单张大小上限（4MB；Vercel 请求体限制留余裕）。 */
export const MAX_DATA_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * 单次生成最多带的参考图张数（与 /api/canvas/generate 同尺）。
 * 值＝执行端常数单点（`generation-core/request-limits.ts`）——本档只是这个闸门的
 * **引用点**，不再自己存一份数字（D23：能力契约揭露的值与真的挡人的值必须同一颗）。
 */
export const MAX_REFERENCE_IMAGES = MAX_REQUEST_REFERENCE_IMAGES;

/** 参考图名称上限（与 character-cards 的 MAX_REFERENCE_NAME_LENGTH 同尺）。 */
const MAX_REFERENCE_NAME_LENGTH = 60;

/** data:image base64 URI（落地 Blob 用；形状校验与 resolveEditReference 共用同一个字面）。 */
const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

/** 形状错误：呼叫端据 `status`/`code` 直接回错误体（原 edits 的 EditInputError）。 */
export class EditInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function mimeFromUrl(rawUrl: string): string {
  const pathname = rawUrl.split("?")[0].toLowerCase();
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  return "image/png";
}

export function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** image 参数 → 工作流参考图。URL 直接引用；data URI 落地 blob 后转平台公网 URL。 */
export async function resolveEditReference(
  image: string,
  tenantId: string,
  idempotencyKey: string,
): Promise<GenerationReference> {
  if (/^https?:\/\//i.test(image)) {
    return { url: image, mimeType: mimeFromUrl(image), referenceRole: "general" };
  }
  const match = DATA_IMAGE_PATTERN.exec(image);
  if (match) {
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) throw new EditInputError(400, "invalid_image", "image data URI is empty.");
    if (buffer.length > MAX_DATA_IMAGE_BYTES) {
      throw new EditInputError(413, "image_too_large", "image data URI exceeds 4MB. Upload the file first and pass a public URL.");
    }
    const validated = validateImageBuffer(buffer);
    if ("error" in validated) throw new EditInputError(400, "invalid_image", `image decode failed: ${validated.error}`);
    const stable = createHash("sha256")
      .update(`${tenantId}|${idempotencyKey}|${validated.sha256}`)
      .digest("hex");
    const objectKey = `generation/references/${stable}.${extensionFor(validated.mimeType)}`;
    const blob = await put(objectKey, buffer, {
      access: "public",
      contentType: validated.mimeType,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    });
    return {
      artifactId: `ref-${stable}`,
      url: blob.url,
      mimeType: validated.mimeType,
      name: "reference-1",
      referenceRole: "general",
    };
  }
  throw new EditInputError(
    400,
    "invalid_image",
    "image must be a public http(s) URL or a data:image base64 URI（pixai media id 仅适用于 pixai 系模型）.",
  );
}

// ─────────────────────────────────────────── 参考图角色值域

/**
 * `GenerationReference.referenceRole` 的唯一值域（`generation-core/types.ts:36-44`）。
 * 这是**对外契约**，不是 UI 的 `ReferenceImageRole`（后者多一个 `face`）。
 */
export const BIZ_REFERENCE_ROLE_VALUES: readonly NonNullable<GenerationReference["referenceRole"]>[] = [
  "general",
  "character",
  "product",
  "style",
  "composition",
];

export type BizReferenceRole = NonNullable<GenerationReference["referenceRole"]>;

/** 无法对应（含缺省、UI 专属的 `face`、乱填）一律收敛为 `"general"` —— 不把值域外的值传给上游。 */
export function normalizeBizReferenceRole(value: unknown): BizReferenceRole {
  return typeof value === "string" && (BIZ_REFERENCE_ROLE_VALUES as readonly string[]).includes(value)
    ? (value as BizReferenceRole)
    : "general";
}

// ─────────────────────────────────────────── reference_images 形状校验

/** 一个待落地的参考图规格（形状已验、尚未 materialize 成 GenerationReference）。 */
interface ReferenceImageSpec {
  url: string;
  role: BizReferenceRole;
  name?: string;
}

/** http(s) 或 data:image base64 —— 两者之外一律 400（`resolveEditReference` 也只认这两种）。 */
function isReferenceImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || DATA_IMAGE_PATTERN.test(url);
}

function invalidReferenceImages(message: string): EditInputError {
  return new EditInputError(400, "invalid_reference_images", message);
}

/**
 * `reference_images` body 栏位的形状校验（纯函式，零 I/O）。
 *
 * 契约：`Array<string | { url: string; role?: string; name?: string }>`，上限
 * `MAX_REFERENCE_IMAGES` 张、保序；超过或形状非法一律 400 `invalid_reference_images`，
 * **不静默截断**（静默截断＝客户以为 6 张都进去了）。
 */
export function parseReferenceImageSpecs(input: unknown, maxImages = MAX_REFERENCE_IMAGES): ReferenceImageSpec[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw invalidReferenceImages("reference_images 需为数组，元素为 URL 字符串或 { url, role?, name? } 对象。");
  }
  if (input.length > maxImages) {
    throw invalidReferenceImages(`reference_images 最多 ${maxImages} 张，收到 ${input.length} 张。`);
  }
  const specs: ReferenceImageSpec[] = [];
  for (const item of input) {
    const record: Record<string, unknown> | null = typeof item === "string"
      ? { url: item }
      : item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : null;
    const rawUrl = typeof record?.url === "string" ? record.url.trim() : "";
    if (!rawUrl || !isReferenceImageUrl(rawUrl)) {
      throw invalidReferenceImages(
        "reference_images 的每一项必须是 http(s) URL 或 data:image/*;base64 URI（可选 role/name）。",
      );
    }
    const rawName = record?.name;
    const name = typeof rawName === "string" && rawName.trim()
      ? rawName.trim().slice(0, MAX_REFERENCE_NAME_LENGTH)
      : undefined;
    specs.push({
      url: rawUrl,
      role: normalizeBizReferenceRole(record?.role),
      ...(name ? { name } : {}),
    });
  }
  return specs;
}

// ─────────────────────────────────────────── 卡 → 参考图规格

/**
 * 命中 token 的卡，其 `references[]` 展开成规格（保序）。
 * 卡里形状不合法的 URL 直接跳过——卡是增强，不让一张脏卡把生成打失败。
 */
function cardReferenceSpecs(cards: readonly CharacterCard[], usedCardIds: readonly string[]): ReferenceImageSpec[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const specs: ReferenceImageSpec[] = [];
  for (const cardId of usedCardIds) {
    const card = byId.get(cardId);
    if (!card) continue;
    for (const reference of card.references) {
      const url = typeof reference.url === "string" ? reference.url.trim() : "";
      if (!url || !isReferenceImageUrl(url)) continue;
      const name = typeof reference.name === "string" && reference.name.trim()
        ? reference.name.trim().slice(0, MAX_REFERENCE_NAME_LENGTH)
        : undefined;
      specs.push({
        url,
        role: normalizeBizReferenceRole(reference.role),
        ...(name ? { name } : {}),
      });
    }
  }
  return specs;
}

/** 按 url 去重（保首见序）。 */
function dedupeSpecsByUrl(specs: readonly ReferenceImageSpec[]): ReferenceImageSpec[] {
  const seen = new Set<string>();
  const out: ReferenceImageSpec[] = [];
  for (const spec of specs) {
    if (seen.has(spec.url)) continue;
    seen.add(spec.url);
    out.push(spec);
  }
  return out;
}

// ─────────────────────────────────────────── 生成链路（target）形状校验

/**
 * 生成链路值域。`"image"`＝视觉（既有行为）；`"audio"`＝音频（只有音频卡参与、无参考图语义）。
 */
export type BizGenerationTarget = "image" | "audio";

export const BIZ_GENERATION_TARGET_VALUES: readonly BizGenerationTarget[] = ["image", "audio"];

/**
 * `target` body 栏位的形状校验（纯函式，零 I/O）。
 *
 * 契约：缺省／`null` → `"image"`（＝既有行为，逐位元不变）；值域外一律 **400
 * `invalid_target`**，**不默默收敛成预设**——呼叫端把 `"Audio"`（大小写）或 `"video"`
 * 打成预设值时，音频卡会被静默排除（＝本轮要消灭的那类静默失效），宁可当场报错。
 */
export function parseBizGenerationTarget(input: unknown): BizGenerationTarget {
  if (input === undefined || input === null) return "image";
  if (input === "image" || input === "audio") return input;
  const shown = typeof input === "string" ? input.slice(0, 40) : typeof input;
  throw new EditInputError(400, "invalid_target", `target 只接受 "image" 或 "audio"，收到 ${shown}。`);
}

/** 畸形 token 的人话提示（**只提示，原文照留**——不改写提示词）。 */
function malformedTokenWarning(entry: MalformedEntityToken): string {
  switch (entry.reason) {
    case "empty_name":
      return `实体引用 ${entry.raw} 缺少名称（格式为 @[种类:名称]），已按原文保留在提示词里。`;
    case "unclosed":
      return `实体引用 ${entry.raw} 缺少右括号 "]"（格式为 @[种类:名称]），已按原文保留在提示词里。`;
    default:
      return `实体引用 ${entry.raw} 的种类字「${entry.kindLabel}」无法识别（可用：角色/场景/风格/道具/音频），已按原文保留在提示词里。`;
  }
}

// ─────────────────────────────────────────── 组装：prompt + references

export interface BizGenerationInputPlan {
  /** 实体 tag 展开后的 prompt（零 token 时与输入逐位元相同）。 */
  prompt: string;
  /** 卡的图在前、显式 reference_images 在后，去重并受上限；零参考图时为空阵列。 */
  references: GenerationReference[];
  /** 给呼叫端看得见的降级/截尾/未命中说明；无事发生时为空阵列。 */
  warnings: string[];
}

/**
 * prompt 与 `reference_images` → 可直接送进 `submitGenerationCommand` 的
 * `prompt` + `references`。
 *
 * 语义（冻结契约）：
 *   - 零 token 且零 reference_images → prompt 逐位元不变、references 空、warnings 空
 *     （呼叫端据此**完全不加 `workflow` 键**，零漂移）。
 *   - 命中 token → 就地换成卡的 prompt 片段（片段为空换卡名，`expandEntityTokens` 已内建）；
 *     卡的 `references[].url` 并入。
 *   - 未命中 token → 原样保留 token（fail-open）＋一条 warning。
 *   - 卡库读取失败 → **降级为不解析 token**（生成是主线、卡库是增强），原样送 prompt ＋ warning。
 *   - 形状非法的 reference_images 在任何 I/O 之前抛 `EditInputError`。
 *   - `target: "audio"`（新）→ 走 `applyCharacterCards(..., { target: "audio" })`：只有音频卡
 *     参与（被引用的卡就地展开片段、未引用的锁定音频卡照常进前缀），**references 一律空**、
 *     显式 `reference_images` 被忽略并出一条 warning。缺省／`"image"` 逐位元走上面那条旧路。
 */
export async function planBizGenerationInput(input: {
  prompt: string;
  rawReferenceImages: unknown;
  /** 生成链路；缺省 `"image"`＝既有行为（零漂移）。 */
  target?: BizGenerationTarget;
  /** 卡库读取（route 注入 `listCharacterCards(userId)`）；只有 prompt 真的带 token 时才会被呼叫。 */
  loadCards?: () => Promise<readonly CharacterCard[]>;
  tenantId: string;
  idempotencyKey: string;
}): Promise<BizGenerationInputPlan> {
  const warnings: string[] = [];
  const target = input.target ?? "image";
  // 形状校验先做：非法输入必须在卡库/Blob 任何 I/O 之前就 400。
  const explicitSpecs = parseReferenceImageSpecs(input.rawReferenceImages);

  let prompt = input.prompt;
  // 畸形 token 诊断（只诊断、不改写）：`@[角色:]` / `@[角色:灰羽` / `@[未知种类:灰羽]` 在
  // 解析器里分别是「不算 token」「不算 token」「未命中」，不主动提示就永远静默。原文一律照留。
  const malformed = findMalformedEntityTokens(prompt);
  const malformedRaws = new Set(malformed.map((entry) => entry.raw));
  for (const entry of malformed) warnings.push(malformedTokenWarning(entry));

  if (target === "audio") {
    // 音频链路：只有音频卡参与（`character-cards.ts` 的 target:"audio" 语义），参考图一律空。
    // 注：`applyCharacterCards` 的卡参数是可变阵列，故载入后展开成新阵列（不改原阵列）。
    let cards: CharacterCard[] = [];
    // 与视觉链路同纪律：零 token 不读卡库（不多一次 I/O）。
    if (parseEntityTokens(prompt).length > 0 && input.loadCards) {
      try {
        cards = [...(await input.loadCards())];
      } catch (error) {
        console.error("[biz-image-references] 卡库读取失败，本次不解析实体 tag。", error);
        cards = [];
        warnings.push("角色卡库读取失败，本次未解析 @[种类:名称] 引用，提示词原样提交。");
      }
    }
    // 未命中清单：`applyCharacterCards` 不回报 unresolved，故用**同一个解析器**
    // （`expandEntityTokens`，不是第二套解析）在原文上取一次未命中清单，才不会静默。
    // 必须喂**同一个参与卡池**（只有音频卡）——喂全卡库会把「被 target 排除、最终留在正文里」
    // 的非音频 token 当成已命中，warning 就漏了（实测踩过）。
    // 这行 kind 过滤与 `character-cards.ts:375` 的 audio 卡池规则同义（那边是唯一权威；
    // 本档不改它、也不另立语义，只为「算 warning」对齐同一个池）。
    const audioCards = cards.filter((card) => card.kind === "audio");
    for (const raw of expandEntityTokens(prompt, audioCards).unresolved) {
      if (malformedRaws.has(raw)) continue; // 已用更精确的「种类字无法辨识」提示过，不重复
      warnings.push(`未找到匹配的实体引用 ${raw}，已原样保留在提示词里。`);
    }
    prompt = applyCharacterCards(prompt, cards, { target: "audio" }).prompt;
    if (explicitSpecs.length > 0) {
      // 音频链路没有参考图语义 ⇒ 不回图，但**不静默**：明说忽略了几张。
      warnings.push(`音频链路不带参考图语义，已忽略 ${explicitSpecs.length} 张 reference_images（提示词照常展开）。`);
    }
    return { prompt, references: [], warnings };
  }

  let cardSpecs: ReferenceImageSpec[] = [];
  if (parseEntityTokens(prompt).length > 0) {
    let cards: readonly CharacterCard[] = [];
    if (input.loadCards) {
      try {
        cards = await input.loadCards();
      } catch (error) {
        console.error("[biz-image-references] 卡库读取失败，本次不解析实体 tag。", error);
        cards = [];
        warnings.push("角色卡库读取失败，本次未解析 @[种类:名称] 引用，提示词原样提交。");
      }
    }
    const expanded = expandEntityTokens(prompt, cards);
    prompt = expanded.prompt;
    for (const raw of expanded.unresolved) {
      if (malformedRaws.has(raw)) continue; // 同上：种类字不认的已单独提示
      warnings.push(`未找到匹配的实体引用 ${raw}，已原样保留在提示词里。`);
    }
    cardSpecs = cardReferenceSpecs(cards, expanded.usedCardIds);
  }

  // 卡的图在前、显式 reference_images 在后；同 URL 去重后受同一个上限。
  const deduped = dedupeSpecsByUrl([...cardSpecs, ...explicitSpecs]);
  let kept = deduped;
  if (deduped.length > MAX_REFERENCE_IMAGES) {
    kept = deduped.slice(0, MAX_REFERENCE_IMAGES);
    warnings.push(
      `参考图合计 ${deduped.length} 张超过上限 ${MAX_REFERENCE_IMAGES} 张，已保留前 ${MAX_REFERENCE_IMAGES} 张（丢弃 ${deduped.length - MAX_REFERENCE_IMAGES} 张）。`,
    );
  }

  const references: GenerationReference[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const spec = kept[index];
    const resolved = await resolveEditReference(spec.url, input.tenantId, `${input.idempotencyKey}-ref-${index + 1}`);
    references.push({
      ...resolved,
      referenceRole: spec.role,
      ...(spec.name ? { name: spec.name } : {}),
    });
  }

  return { prompt, references, warnings };
}

// ─────────────────────────────────────────── workflow 合并

/**
 * `references` 与既有 `metadata.controlNets` 合成**同一个** workflow 物件
 * （两个都在场时互不覆盖）；两者皆空回 `undefined`。
 */
export function buildGenerationWorkflow(input: {
  references?: readonly GenerationReference[];
  controlNets?: unknown;
}): GenerationWorkflow | undefined {
  const references = input.references ?? [];
  const controlNets = Array.isArray(input.controlNets) ? input.controlNets : [];
  if (references.length === 0 && controlNets.length === 0) return undefined;
  return {
    ...(references.length > 0 ? { references: [...references] } : {}),
    ...(controlNets.length > 0 ? { metadata: { controlNets } } : {}),
  };
}

/**
 * 提交命令用的 workflow 展开。**没有参考图也没有 ControlNet 时回空物件**——
 * route 以 `...generationWorkflowField(...)` 展开，零键＝与改动前的 payload 逐位元等价。
 */
export function generationWorkflowField(input: {
  references?: readonly GenerationReference[];
  controlNets?: unknown;
}): { workflow?: GenerationWorkflow } {
  const workflow = buildGenerationWorkflow(input);
  return workflow ? { workflow } : {};
}
