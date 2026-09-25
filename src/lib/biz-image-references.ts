// B 端參考圖通道（`/v1/images/generations` 與 `/v1/images/edits` 共用的輪子）。
//
// 2026-09-25：原 `/v1/images/edits` 的私有 helper（`resolveEditReference` 及相依的
// `mimeFromUrl` / `extensionFor` / `MAX_DATA_IMAGE_BYTES` / `EditInputError`）整段搬到
// 本檔，edits 路由改成 import —— **純搬移，行為逐位元不變**。唯一的形式改動是把
// data URI 正則提成常數 `DATA_IMAGE_PATTERN`（原為 inline 字面），形狀校驗與落地
// 共用同一個字面，語義零改。
//
// generations 側新增的 `reference_images` 與 prompt 裡的行內實體 tag `@[種類:名稱]`
// 也走這裡：形狀校驗（任何 I/O 之前）→ 命中的卡的參考圖在前、顯式 `reference_images`
// 在後 → 按 url 去重 → 上限 `MAX_REFERENCE_IMAGES` 張 → http(s) 直通、
// `data:image/*;base64` 落地 Blob 換公網 URL。
//
// 核心層本來就吃 `workflow.references`（worker 端 `supplier-adapter.ts` 按
// `references.length` 分支，不按 kind），所以本檔只負責把入口接出來，不重寫上游通道。

import { createHash } from "node:crypto";
import { put } from "@/lib/blob-backend";
import { validateImageBuffer } from "@/lib/generation-core/artifact-service";
import type { GenerationReference, GenerationWorkflow } from "@/lib/generation-core/types";
import { applyCharacterCards } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import {
  expandEntityTokens,
  findMalformedEntityTokens,
  parseEntityTokens,
  type MalformedEntityToken,
} from "./entity-tokens";

// ─────────────────────────────────────────── 純搬移（原 edits 私有 helper）

/** data:image URI 單張大小上限（4MB；Vercel 請求體限制留餘裕）。 */
export const MAX_DATA_IMAGE_BYTES = 4 * 1024 * 1024;

/** 單次生成最多帶的參考圖張數（與 /api/canvas/generate 同尺）。 */
export const MAX_REFERENCE_IMAGES = 5;

/** 參考圖名稱上限（與 character-cards 的 MAX_REFERENCE_NAME_LENGTH 同尺）。 */
const MAX_REFERENCE_NAME_LENGTH = 60;

/** data:image base64 URI（落地 Blob 用；形狀校驗與 resolveEditReference 共用同一個字面）。 */
const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

/** 形狀錯誤：呼叫端據 `status`/`code` 直接回錯誤體（原 edits 的 EditInputError）。 */
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

/** image 參數 → 工作流參考圖。URL 直接引用；data URI 落地 blob 後轉平台公網 URL。 */
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
    "image must be a public http(s) URL or a data:image base64 URI（pixai media id 僅適用於 pixai 系模型）.",
  );
}

// ─────────────────────────────────────────── 參考圖角色值域

/**
 * `GenerationReference.referenceRole` 的唯一值域（`generation-core/types.ts:36-44`）。
 * 這是**對外契約**，不是 UI 的 `ReferenceImageRole`（後者多一個 `face`）。
 */
export const BIZ_REFERENCE_ROLE_VALUES: readonly NonNullable<GenerationReference["referenceRole"]>[] = [
  "general",
  "character",
  "product",
  "style",
  "composition",
];

export type BizReferenceRole = NonNullable<GenerationReference["referenceRole"]>;

/** 無法對應（含缺省、UI 專屬的 `face`、亂填）一律收斂為 `"general"` —— 不把值域外的值傳給上游。 */
export function normalizeBizReferenceRole(value: unknown): BizReferenceRole {
  return typeof value === "string" && (BIZ_REFERENCE_ROLE_VALUES as readonly string[]).includes(value)
    ? (value as BizReferenceRole)
    : "general";
}

// ─────────────────────────────────────────── reference_images 形狀校驗

/** 一個待落地的參考圖規格（形狀已驗、尚未 materialize 成 GenerationReference）。 */
interface ReferenceImageSpec {
  url: string;
  role: BizReferenceRole;
  name?: string;
}

/** http(s) 或 data:image base64 —— 兩者之外一律 400（`resolveEditReference` 也只認這兩種）。 */
function isReferenceImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || DATA_IMAGE_PATTERN.test(url);
}

function invalidReferenceImages(message: string): EditInputError {
  return new EditInputError(400, "invalid_reference_images", message);
}

/**
 * `reference_images` body 欄位的形狀校驗（純函式，零 I/O）。
 *
 * 契約：`Array<string | { url: string; role?: string; name?: string }>`，上限
 * `MAX_REFERENCE_IMAGES` 張、保序；超過或形狀非法一律 400 `invalid_reference_images`，
 * **不靜默截斷**（靜默截斷＝客戶以為 6 張都進去了）。
 */
export function parseReferenceImageSpecs(input: unknown): ReferenceImageSpec[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw invalidReferenceImages("reference_images 需为数组，元素为 URL 字符串或 { url, role?, name? } 对象。");
  }
  if (input.length > MAX_REFERENCE_IMAGES) {
    throw invalidReferenceImages(`reference_images 最多 ${MAX_REFERENCE_IMAGES} 张，收到 ${input.length} 张。`);
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

// ─────────────────────────────────────────── 卡 → 參考圖規格

/**
 * 命中 token 的卡，其 `references[]` 展開成規格（保序）。
 * 卡裡形狀不合法的 URL 直接跳過——卡是增強，不讓一張髒卡把生成打失敗。
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

/** 按 url 去重（保首見序）。 */
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

// ─────────────────────────────────────────── 生成鏈路（target）形狀校驗

/**
 * 生成鏈路值域。`"image"`＝視覺（既有行為）；`"audio"`＝音頻（只有音頻卡參與、無參考圖語義）。
 */
export type BizGenerationTarget = "image" | "audio";

export const BIZ_GENERATION_TARGET_VALUES: readonly BizGenerationTarget[] = ["image", "audio"];

/**
 * `target` body 欄位的形狀校驗（純函式，零 I/O）。
 *
 * 契約：缺省／`null` → `"image"`（＝既有行為，逐位元不變）；值域外一律 **400
 * `invalid_target`**，**不默默收斂成預設**——呼叫端把 `"Audio"`（大小寫）或 `"video"`
 * 打成預設值時，音頻卡會被靜默排除（＝本輪要消滅的那類靜默失效），寧可當場報錯。
 */
export function parseBizGenerationTarget(input: unknown): BizGenerationTarget {
  if (input === undefined || input === null) return "image";
  if (input === "image" || input === "audio") return input;
  const shown = typeof input === "string" ? input.slice(0, 40) : typeof input;
  throw new EditInputError(400, "invalid_target", `target 只接受 "image" 或 "audio"，收到 ${shown}。`);
}

/** 畸形 token 的人話提示（**只提示，原文照留**——不改寫提示詞）。 */
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

// ─────────────────────────────────────────── 組裝：prompt + references

export interface BizGenerationInputPlan {
  /** 實體 tag 展開後的 prompt（零 token 時與輸入逐位元相同）。 */
  prompt: string;
  /** 卡的圖在前、顯式 reference_images 在後，去重並受上限；零參考圖時為空陣列。 */
  references: GenerationReference[];
  /** 給呼叫端看得見的降級/截尾/未命中說明；無事發生時為空陣列。 */
  warnings: string[];
}

/**
 * prompt 與 `reference_images` → 可直接送進 `submitGenerationCommand` 的
 * `prompt` + `references`。
 *
 * 語義（凍結契約）：
 *   - 零 token 且零 reference_images → prompt 逐位元不變、references 空、warnings 空
 *     （呼叫端據此**完全不加 `workflow` 鍵**，零漂移）。
 *   - 命中 token → 就地換成卡的 prompt 片段（片段為空換卡名，`expandEntityTokens` 已內建）；
 *     卡的 `references[].url` 併入。
 *   - 未命中 token → 原樣保留 token（fail-open）＋一條 warning。
 *   - 卡庫讀取失敗 → **降級為不解析 token**（生成是主線、卡庫是增強），原樣送 prompt ＋ warning。
 *   - 形狀非法的 reference_images 在任何 I/O 之前拋 `EditInputError`。
 *   - `target: "audio"`（新）→ 走 `applyCharacterCards(..., { target: "audio" })`：只有音頻卡
 *     參與（被引用的卡就地展開片段、未引用的鎖定音頻卡照常進前綴），**references 一律空**、
 *     顯式 `reference_images` 被忽略並出一條 warning。缺省／`"image"` 逐位元走上面那條舊路。
 */
export async function planBizGenerationInput(input: {
  prompt: string;
  rawReferenceImages: unknown;
  /** 生成鏈路；缺省 `"image"`＝既有行為（零漂移）。 */
  target?: BizGenerationTarget;
  /** 卡庫讀取（route 注入 `listCharacterCards(userId)`）；只有 prompt 真的帶 token 時才會被呼叫。 */
  loadCards?: () => Promise<readonly CharacterCard[]>;
  tenantId: string;
  idempotencyKey: string;
}): Promise<BizGenerationInputPlan> {
  const warnings: string[] = [];
  const target = input.target ?? "image";
  // 形狀校驗先做：非法輸入必須在卡庫/Blob 任何 I/O 之前就 400。
  const explicitSpecs = parseReferenceImageSpecs(input.rawReferenceImages);

  let prompt = input.prompt;
  // 畸形 token 診斷（只診斷、不改寫）：`@[角色:]` / `@[角色:灰羽` / `@[未知种类:灰羽]` 在
  // 解析器裡分別是「不算 token」「不算 token」「未命中」，不主動提示就永遠靜默。原文一律照留。
  const malformed = findMalformedEntityTokens(prompt);
  const malformedRaws = new Set(malformed.map((entry) => entry.raw));
  for (const entry of malformed) warnings.push(malformedTokenWarning(entry));

  if (target === "audio") {
    // 音頻鏈路：只有音頻卡參與（`character-cards.ts` 的 target:"audio" 語義），參考圖一律空。
    // 註：`applyCharacterCards` 的卡參數是可變陣列，故載入後展開成新陣列（不改原陣列）。
    let cards: CharacterCard[] = [];
    // 與視覺鏈路同紀律：零 token 不讀卡庫（不多一次 I/O）。
    if (parseEntityTokens(prompt).length > 0 && input.loadCards) {
      try {
        cards = [...(await input.loadCards())];
      } catch (error) {
        console.error("[biz-image-references] 卡库读取失败，本次不解析实体 tag。", error);
        cards = [];
        warnings.push("角色卡库读取失败，本次未解析 @[种类:名称] 引用，提示词原样提交。");
      }
    }
    // 未命中清單：`applyCharacterCards` 不回報 unresolved，故用**同一個解析器**
    // （`expandEntityTokens`，不是第二套解析）在原文上取一次未命中清單，才不會靜默。
    // 必須餵**同一個參與卡池**（只有音頻卡）——餵全卡庫會把「被 target 排除、最終留在正文裡」
    // 的非音頻 token 當成已命中，warning 就漏了（實測踩過）。
    // 這行 kind 過濾與 `character-cards.ts:375` 的 audio 卡池規則同義（那邊是唯一權威；
    // 本檔不改它、也不另立語義，只為「算 warning」對齊同一個池）。
    const audioCards = cards.filter((card) => card.kind === "audio");
    for (const raw of expandEntityTokens(prompt, audioCards).unresolved) {
      if (malformedRaws.has(raw)) continue; // 已用更精確的「種類字無法辨識」提示過，不重複
      warnings.push(`未找到匹配的实体引用 ${raw}，已原样保留在提示词里。`);
    }
    prompt = applyCharacterCards(prompt, cards, { target: "audio" }).prompt;
    if (explicitSpecs.length > 0) {
      // 音頻鏈路沒有參考圖語義 ⇒ 不回圖，但**不靜默**：明說忽略了幾張。
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
      if (malformedRaws.has(raw)) continue; // 同上：種類字不認的已單獨提示
      warnings.push(`未找到匹配的实体引用 ${raw}，已原样保留在提示词里。`);
    }
    cardSpecs = cardReferenceSpecs(cards, expanded.usedCardIds);
  }

  // 卡的圖在前、顯式 reference_images 在後；同 URL 去重後受同一個上限。
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

// ─────────────────────────────────────────── workflow 合併

/**
 * `references` 與既有 `metadata.controlNets` 合成**同一個** workflow 物件
 * （兩個都在場時互不覆蓋）；兩者皆空回 `undefined`。
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
 * 提交命令用的 workflow 展開。**沒有參考圖也沒有 ControlNet 時回空物件**——
 * route 以 `...generationWorkflowField(...)` 展開，零鍵＝與改動前的 payload 逐位元等價。
 */
export function generationWorkflowField(input: {
  references?: readonly GenerationReference[];
  controlNets?: unknown;
}): { workflow?: GenerationWorkflow } {
  const workflow = buildGenerationWorkflow(input);
  return workflow ? { workflow } : {};
}
