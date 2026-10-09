// 角色/场景卡（P2 跨镜头一致性）：纯逻辑层。
//
// 定位：卡 = 项目级「锁定」配置。一经锁定（挂到画布项目的 cardIds），
// 该画布所有生成（手动面板、agent run_generation、编辑器派生）自动携带：
//   - locked prompt 片段 → 以稳定顺序（卡 id 序）注入 prompt 前缀
//   - 参考图 → 合并进 reference_images（各带 ReferenceRole，卡优先）
//   - 负面词 → 合并进 negative_prompt
//
// 角色枚举 owner 是 image-types.ReferenceImageRole（复用，不建第二套）；
// LoRA 关联引用既有 lora versionId 标识（不建新 LoRA 体系）。
// 本档只做纯函式；存储在 character-card-store.ts、HTTP 在 /api/character-cards。

import { toReferenceImageRole } from "./image-types";
import type { AgentInteractionMode } from "./agent-chat-client";
import type { ReferenceImageRole } from "./image-types";
import { normalizeLineageLinks } from "./lineage";
import type { LineageLink } from "./lineage";
import { ASSET_KEY_DELIMITER, GHOST_ASSET_SCOPE, normalizeAssetScope, normalizeProjectIds } from "./asset-scope";
import type { AssetScope } from "./asset-scope";
import { expandEntityTokens, parseEntityTokens, resolveEntityTokenKind } from "./entity-tokens";

/**
 * 卡种类：角色卡（外观锁定）/ 场景卡（环境锁定）/ 风格卡（画风锁定）
 * / 道具卡（物件锁定）/ 音频卡（配乐/音效锁定）。
 *
 * 音频卡是**唯读型别上的新 kind**：它照常是项目级「锁定配置」，但只参与
 * `applyCharacterCards(..., { target: "audio" })` 的音频提示词链路
 * （视觉链路完全忽略它——不进 prompt 前缀、不进参考图）。
 */
export type CharacterCardKind = "character" | "scene" | "style" | "prop" | "audio";

export const CHARACTER_CARD_KIND_VALUES: readonly CharacterCardKind[] = [
  "character",
  "scene",
  "style",
  "prop",
  "audio",
];

/** 卡种类的简体中文标签（UI 与 toast 共用，不散落三元表达式）。 */
export const CHARACTER_CARD_KIND_LABEL: Record<CharacterCardKind, string> = {
  character: "角色",
  scene: "场景",
  style: "风格",
  prop: "道具",
  audio: "音频",
};

/** 未知值收敛为 character（旧数据/agent 乱填不炸）。 */
export function toCharacterCardKind(value: unknown): CharacterCardKind {
  return typeof value === "string" && (CHARACTER_CARD_KIND_VALUES as readonly string[]).includes(value)
    ? (value as CharacterCardKind)
    : "character";
}

/**
 * 资产批准状态（2026-09-24 决策定稿 23/4）。**路 1/2/3 与分镜侧共用同一个 shape**
 * （分镜侧见 `storyboard-contract.ts` 的 `approval?: ApprovalState`），禁止另建第二套。
 *
 * 语义（决策 23）：**缺省（`undefined`）＝ 已批准** —— 存量资产（无此栏位）一律视为已批准，
 * 不追溯、不拦流程。只有显式 `pending`/`rejected` 才算「未批准」。
 * 档位（决策 2）：批准闸**只在协作档生效**；`preset`/`auto` 一律视为已批准（护城河）。
 * `reason` 是驳回理由（决策 4：驳回后停下等用户指定怎么改，理由存下、不擅自重生成）。
 */
export interface ApprovalState {
  status: "approved" | "pending" | "rejected";
  decidedAt?: string;
  reason?: string;
}

export const APPROVAL_STATUS_VALUES: readonly ApprovalState["status"][] = [
  "approved",
  "pending",
  "rejected",
];

/** 卡的参考图：url + 角色（ReferenceImageRole）+ 显示名。 */
export interface CharacterCardReferenceImage {
  url: string;
  role: ReferenceImageRole;
  name: string;
}

/**
 * 变装（Disguise，对称差 D8「变装作为角色的一等子资产」）：
 * **同一角色的具名替代造型**——有自己在本卡内唯一的稳定识别 `id`、自己的名字、
 * 自己的参考图（与可选的锁定 prompt 片段）。
 *
 * 为什么不是「把变装摊平成互不相关的角色卡」（我方旧况只有 `variantOf` 单向指针）：
 *   - 母卡身分不变（`kind` 仍 `"character"`、卡 id/名称不变）⇒ 卡 id 序锁定注入、
 *     分镜引用栏（`characterCardIds`）、专案锁定（`activeCardIds`）全部零迁移；
 *   - 一个角色可挂**多个**变装，镜次只挑它要的那个（`resolveCharacterDisguises`）；
 *   - **变装自己的参考图就是它自己的参考图**，缺件时不回退主造型（见 `withCharacterDisguises`）。
 */
export interface CharacterCardDisguise {
  /** 卡内唯一识别（新增时没有也可由名字导出，见 `disguiseIdFromName`）。 */
  id: string;
  /** 变装名（**具名状态的载体**：缺件回报、`requiredDisguises` 对帐都用这个名字）。 */
  name: string;
  /** 该变装的锁定 prompt 片段（可选；空＝只用参考图锁造型）。 */
  prompt?: string;
  /** 该变装专属参考图（自己的尺，不共用主造型的）。 */
  references: CharacterCardReferenceImage[];
}

/** 变装选择：在哪些角色卡上找哪个具名变装（`cardId` 缺省＝在全部传入卡拉上找）。 */
export interface DisguiseSelection {
  cardId?: string;
  name: string;
}

export interface ResolvedCharacterDisguises {
  /** 命中的变装（带所属卡 id）。 */
  matched: { cardId: string; disguise: CharacterCardDisguise }[];
  /** 具名缺件：找不到同名变装的名字（trim 去重、宣告序）。 */
  missing: string[];
}

export interface CharacterCard {
  id: string;
  name: string;
  kind: CharacterCardKind;
  /** 锁定的 prompt 片段（外观/场景描述）；空字串 = 纯参考图卡。 */
  prompt: string;
  /** 参考图列表（各带角色）。 */
  references: CharacterCardReferenceImage[];
  /** 负面词（可选）。 */
  negativePrompt?: string;
  /** LoRA 关联（可选）：引用既有 lora versionId，不建新体系。 */
  loraIds?: string[];
  /** 变体母卡 id（变体＝kind 仍是 "character" 但带此栏，例如「劼后-霍辞渊」是「霍辞渊」的造型变体）。
   *  指到的卡不存在＝当普通角色卡处理（fail-open，不报错）。 */
  variantOf?: string;
  /**
   * 变装清单（对称差 D8，一等子资产）：本角色可用的具名造型，每个带自己的 id/名字/参考图。
   * 缺省＝没有变装（旧卡零改动、零栏位）。**不影响既有锁定注入**——
   * 只有当分镜/呼叫端**明确选用**某个变装时才换参考（`withCharacterDisguises`），
   * 没选＝行为与旧况逐位元相同（用 `references` 主造型）。
   */
  disguises?: CharacterCardDisguise[];
  /**
   * 必要变装清单（**设定阶段的强制补齐要求**）：这个角色在本剧必须具备哪些具名造型。
   * 缺省＝无要求（旧卡零改动）。以**名字**对帐（不是 id：缺件要用人看得懂的名字回报），
   * 对帐入口 `auditCharacterDisguises` / 全库入口 `auditDisguiseRequirements`——
   * 缺件＝明确回报缺哪些名字，**不得静默用主造型顶替**。
   */
  requiredDisguises?: string[];
  /**
   * REQ-D1 资产血统：这张卡的直接来源链（例如「存为卡片」时登记的历史来源）。
   * 只存在卡本体供人看的「溯源」抽屉；不进 canvas 节点 metadata、
   * 不进 compactMetadataForAgent（裁决②：agent 不读血统）。缺省＝来源不明。
   */
  lineage?: LineageLink[];
  /** parents 曾超上限被截尾的显式标记。 */
  lineageTruncated?: boolean;
  /**
   * REQ-B2 归属（个人 / 项目）：缺省＝personal（既有卡零改动）。
   * 只给人看（项目资产库面板的归属标记与显式分享入口）——
   * **裁决排除**（同 D1 lineage 先例）：不进 canvas 节点 metadata、
   * 不进 toNodeMetadata、不进 compactMetadataForAgent。
   * **LEGACY 并存（P1-A）**：单归属语义一行不动；新归属走下面的 `projectIds` 标签。
   */
  scope?: AssetScope;
  /**
   * P1-A 项目标签（多归属，纯加法）：与 scope 并存；缺省＝没有标签。
   * 可见性判定见 asset-scope.resolveAssetScopeVisibility 的新允许路径；
   * 同 scope 裁决：只给人看与前端筛选，不进 canvas 节点 metadata / agent 压缩白名单。
   */
  projectIds?: string[];
  /**
   * 资产批准状态（2026-09-24 决策 23）：**缺省＝已批准**（存量资产零改动、不追溯）。
   * 只有 `pending`/`rejected` 才算未批准，且**只在协作档**（`interaction_mode === "collaborate"`）
   * 当门槛（未批准的卡 id 不得进分镜卡引用栏，见 `storyboard-contract.ts`
   * `filterApprovedShotCardIds`）；全自动档（`preset`/`auto`）一律视为已批准、不挡（护城河）。
   */
  approval?: ApprovalState;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────── 清洗与上限

const MAX_CARD_ID_LENGTH = 100;
const MAX_CARD_NAME_LENGTH = 100;
const MAX_CARD_PROMPT_LENGTH = 2000;
const MAX_CARD_NEGATIVE_LENGTH = 1000;
/** 单张卡参考物上限（**唯一宣告**：卡清洗在此截尾；B 端 /v1/character-cards 用它做
 *  「超限回 400」的前置校验——不静默截尾，故必须与此处同值、不得另立常数）。 */
export const MAX_CARD_REFERENCES = 8;
const MAX_CARD_LORA_IDS = 8;
const MAX_REFERENCE_NAME_LENGTH = 60;
const MAX_APPROVAL_REASON_LENGTH = 200;
const MAX_APPROVAL_DECIDED_AT_LENGTH = 40;
/** 单卡变装上限（新增超过＝拒绝，清洗超过＝截尾；与 `MAX_CARD_REFERENCES` 同一种界）。 */
export const MAX_DISGUISES_PER_CARD = 12;
const MAX_DISGUISE_NAME_LENGTH = 60;
const MAX_DISGUISE_PROMPT_LENGTH = 1000;
/** 必要变装清单上限（`requiredDisguises`）。 */
export const MAX_REQUIRED_DISGUISES = 12;

/** 图片 URL 判定核心：与 semantic-nodes 的收口一致（http(s) 与 data:image）。纯布林，两种呼叫端共用。 */
function isCardImageUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:image/");
}

/** 同上，type predicate 版（供需要收窄的呼叫端；`!url` 空值一律不合格）。 */
function isUsableCardImageUrl(url: string | undefined | null): url is string {
  return typeof url === "string" && !!url && isCardImageUrl(url);
}

/**
 * 卡**参考物** URL 判定（kind-aware，唯一收口）：卡储存时用这把尺，不是纯图片尺。
 *
 *   - `http(s)`：两类都收（既有宽松面原样保留——旧尺 `startsWith("http")` 从不辨 mime／
 *     副档名，本刀不动它：收紧会让存量卡当场掉参考）。
 *   - `data:`：图片卡收 `data:image/`；**音频卡收 `data:audio/`**。
 *
 * Why：音频卡的载体是音频（`@[音频:…]` 片段 + 音频参考），旧尺只认 `data:image/`
 * ⇒ `data:audio/mpeg;base64,…` 这种合法的内嵌参考音频会被 `normalizeCharacterCard`
 * **静默丢掉**（卡变成没有载体的空壳）。视觉链路不受影响：音频卡在
 * `applyCharacterCards` 的视觉 target 下整张被排除，其参考物永不冒充图片。
 */
function isUsableCardReferenceUrl(url: string | undefined | null, kind: CharacterCardKind): url is string {
  if (typeof url !== "string" || !url) return false;
  return isCardImageUrl(url) || (kind === "audio" && url.startsWith("data:audio/"));
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

/**
 * 卡 id 边界（REQ-B2）：在长度界之上**拒绝含保留分隔符 `:` 的 id**。
 * 理由：`:` 是作用域层确定性键（share/mount）的段分隔符，含它的 id 在旧版裸拼接键下
 * 可与别的 (kind, id) 组合撞键 → 授权跨资产别名。截断/改写 id 都不行（会断掉 cardIds
 * 与既有引用），故一律 fail-closed 拒收（回 null）。
 */
function usableCardId(value: unknown): string | null {
  const clean = boundedString(value, MAX_CARD_ID_LENGTH);
  if (!clean || clean.includes(ASSET_KEY_DELIMITER)) return null;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return clean;
}

/**
 * 参考物阵列清洗（**唯一收口**：卡的 `references` 与变装的 `references` 走同一把尺，
 * 不另立第二套变装参考尺）。非法 URL 丢、名字缺省回 `fallbackName`、上限截尾。
 */
function normalizeCardReferenceImages(
  raw: unknown,
  kind: CharacterCardKind,
  fallbackName: string,
): CharacterCardReferenceImage[] {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((ref): CharacterCardReferenceImage[] => {
      if (!ref || typeof ref !== "object") return [];
      const r = ref as { url?: unknown; role?: unknown; name?: unknown };
      if (typeof r.url !== "string" || !isUsableCardReferenceUrl(r.url, kind)) return [];
      return [
        {
          url: r.url,
          role: toReferenceImageRole(r.role),
          name: boundedString(r.name, MAX_REFERENCE_NAME_LENGTH) ?? fallbackName,
        },
      ];
    })
    .slice(0, MAX_CARD_REFERENCES);
}

/**
 * 批准状态清洗（**唯一收口**：`normalizeCharacterCard` 与 `setApproval` 共用同一把尺）。
 *   - 非物件 / `status` 不在 `APPROVAL_STATUS_VALUES` 三值域 → **null（呼叫端省略栏位＝缺省＝已批准）**。
 *     读不懂的值不猜成「未批准」：批准状态不是安全边界（卡内容对本帐号本来就可见），
 *     且与决策 23「缺省＝已批准」同向——脏资料不该让存量卡突然被挡在分镜之外。
 *   - `decidedAt` 只验「非空字串且不超长」，**不做日期解析**（不引入第二套时间语义）。
 *   - `reason` 走 `boundedString`（trim + 上限）；空/纯空白＝没有理由（栏位省略）。
 */
export function normalizeApprovalState(payload: unknown): ApprovalState | null {
  if (!payload || typeof payload !== "object") return null;
  const a = payload as Partial<ApprovalState>;
  const status =
    typeof a.status === "string" && (APPROVAL_STATUS_VALUES as readonly string[]).includes(a.status)
      ? (a.status as ApprovalState["status"])
      : null;
  if (!status) return null;
  const decidedAt = boundedString(a.decidedAt, MAX_APPROVAL_DECIDED_AT_LENGTH);
  const reason = boundedString(a.reason, MAX_APPROVAL_REASON_LENGTH);
  return { status, ...(decidedAt ? { decidedAt } : {}), ...(reason ? { reason } : {}) };
}

/** 清洗单张卡：栏位缺损返回 null（API 与 store 共用同一收口）。 */
export function normalizeCharacterCard(payload: unknown): CharacterCard | null {
  if (!payload || typeof payload !== "object") return null;
  const c = payload as Partial<CharacterCard>;
  const id = usableCardId(c.id);
  const name = boundedString(c.name, MAX_CARD_NAME_LENGTH);
  if (!id || !name) return null;
  const now = new Date().toISOString();
  // kind 先落定：参考物 URL 的收口尺是 kind-aware 的（音频卡收 data:audio/，见上）。
  const kind = toCharacterCardKind(c.kind);
  const references = normalizeCardReferenceImages(c.references, kind, name);
  const negativePrompt = boundedString(c.negativePrompt, MAX_CARD_NEGATIVE_LENGTH);
  const loraIds = (Array.isArray(c.loraIds) ? c.loraIds : [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, MAX_CARD_LORA_IDS);
  // 变体母卡指针：走与卡 id 同级的边界（长度上限 + 拒 `:` + 拒控制字元）。
  // 不合法 → **只省略该栏位**（不整张卡回 null：母卡指针坏掉不该让造型卡本身消失）；
  // 自环（指向自己）同样省略——不制造鬼引用。
  const variantOfRaw = usableCardId(c.variantOf);
  const variantOf = variantOfRaw && variantOfRaw !== id ? variantOfRaw : null;
  // 变装（D8）：走本档的变装清洗收口；id 与卡本体 id 相同的变装条目丢掉
  //（自指＝鬼引用，与 variantOf 自环同款处置）。空清单＝不写栏位（旧卡零改动）。
  const disguises = normalizeCharacterDisguises(c.disguises).filter((d) => d.id !== id);
  // 必要变装清单：名字清单，缺省＝无要求（不写空阵列）。
  const requiredDisguises = normalizeRequiredDisguises(c.requiredDisguises);
  // REQ-D1：血统栏位复用 ./lineage 的清洗收口（非法条目丢、上限截尾并显式标记）。
  const lineageRaw = Array.isArray(c.lineage) ? normalizeLineageLinks(c.lineage) : null;
  // REQ-B2 作用域：同样走 ./asset-scope 的清洗收口（缺省＝personal 且省略栏位）。
  // 回 null＝鬼状态（owner=project 却无 projectId / owner=team 却无 teamId）：
  // **写回 GHOST_ASSET_SCOPE**（不降格成 personal），该卡在任何上下文都不可见/不可用
  //（D3：降格＝把归属不明的项目资产变成人人可用的个人资产）。
  // P0-2：team 作用域同样要落栏（只写 project 会让团队卡在存档端静默丢失归属）。
  const scope = normalizeAssetScope(c.scope);
  // P1-A 项目标签：走 ./asset-scope 的 normalizeProjectIds 收口（去重 / 只留非空 string /
  // 截 120 / 上限 20）；**结果为空则省略键**（不写空阵列冒充设定，同 scope 收口范式）。
  const projectIds = normalizeProjectIds(c.projectIds);
  const approval = normalizeApprovalState(c.approval);
  return {
    id,
    name,
    kind,
    prompt: typeof c.prompt === "string" ? c.prompt.trim().slice(0, MAX_CARD_PROMPT_LENGTH) : "",
    references,
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(loraIds.length ? { loraIds } : {}),
    ...(variantOf ? { variantOf } : {}),
    ...(disguises.length ? { disguises } : {}),
    ...(requiredDisguises.length ? { requiredDisguises } : {}),
    ...(lineageRaw && lineageRaw.parents.length
      ? {
          lineage: lineageRaw.parents,
          ...(lineageRaw.truncated || c.lineageTruncated === true ? { lineageTruncated: true } : {}),
        }
      : {}),
    ...(scope === null
      ? { scope: { ...GHOST_ASSET_SCOPE } }
      : scope.owner === "project" || scope.owner === "team"
        ? { scope }
        : {}),
    ...(projectIds.length ? { projectIds } : {}),
    ...(approval ? { approval } : {}),
    createdAt: typeof c.createdAt === "string" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : now,
  };
}

// ─────────────────────────────────────────── 资产批准状态（档位相关）

/**
 * 「这张资产算不算已批准」的**唯一判定入口**（纯函式，不 mutate）。
 *
 * 档位规则（决策 2/23，护城河）：
 *   - `mode !== "collaborate"`（含 `preset`/`auto`/`undefined`）→ **一律 `true`**：
 *     全自动档零改动、不停不阻塞；既有呼叫端（不知道 mode 这回事）行为逐位不变。
 *   - `mode === "collaborate"` → 只有显式 `pending`/`rejected` 才算未批准；
 *     缺省 `approval`（存量资产）仍＝已批准。
 * 因此「只有协作档才可能回 false」写进型别层的判定，不靠呼叫端自律——护城河不是约定。
 */
export function isAssetApproved(
  approval: ApprovalState | null | undefined,
  mode?: AgentInteractionMode,
): boolean {
  if (mode !== "collaborate") return true;
  if (!approval) return true;
  return approval.status === "approved";
}

export interface SetApprovalOptions {
  /**
   * 决策时间（ISO）。缺省＝现在。**同时作为该卡的 `updatedAt`**（一次读钟，不产生第二个时间源）：
   * 批准是使用者对该卡的动作，卡列表按 `updatedAt` 排序（`character-card-store.ts:125`），
   * 不更新会让刚确认过的卡沉在列表底部。
   */
  decidedAt?: string;
  /** 驳回理由（决策 4）。空白＝没有理由（省略栏位）。 */
  reason?: string;
}

/**
 * 设定批准状态（纯函式：回新物件、**不改传入卡**）。
 * `status` 不合法（型别外呼叫）→ **原卡回传**（不制造半形状态、不写半套）。
 */
export function setApproval(
  card: CharacterCard,
  status: ApprovalState["status"],
  options?: SetApprovalOptions,
): CharacterCard {
  const decidedAt = options?.decidedAt ?? new Date().toISOString();
  const approval = normalizeApprovalState({ status, decidedAt, reason: options?.reason });
  if (!approval) return card;
  return { ...card, approval, updatedAt: decidedAt };
}

/**
 * 清除批准状态 → 回到**缺省＝已批准**（决策 23 的存量相容态）。
 * 刻意不是「设成 pending」：清状态的语义是「这张卡没有待决事项」，不是「再等一下」。
 * 本来就没有 `approval` → **回同一物件**（呼叫端可用 `===` 略过无谓写入）。
 */
export function clearApproval(card: CharacterCard): CharacterCard {
  if (!card.approval) return card;
  const next: CharacterCard = { ...card, updatedAt: new Date().toISOString() };
  delete next.approval;
  return next;
}

// ─────────────────────────────────────────── 变装子资产（对称差 D8）

/**
 * 由变装名导出稳定 id（无 id 时使用）：trim、空白折成 `-`，再走**与卡 id 同一把尺**
 * （`usableCardId`：长度上限、拒保留分隔符 `:`、拒控制字元）。
 * 导不出（名含 `:`／空／超长）→ null（呼叫端拒收，不制造半形 id）。
 */
export function disguiseIdFromName(name: unknown): string | null {
  const clean = boundedString(name, MAX_DISGUISE_NAME_LENGTH);
  if (!clean) return null;
  return usableCardId(clean.replace(/\s+/g, "-"));
}

/**
 * 清洗单个变装。缺名字 = null（没有名字就没有「具名状态」，无法被要求/对帐）。
 * id 非法或未给 → 由名字导出（导不出才 null）；参考图走卡参考物同一把尺。
 */
export function normalizeCharacterDisguise(payload: unknown): CharacterCardDisguise | null {
  if (!payload || typeof payload !== "object") return null;
  const d = payload as Partial<CharacterCardDisguise>;
  const name = boundedString(d.name, MAX_DISGUISE_NAME_LENGTH);
  if (!name) return null;
  const id = usableCardId(d.id) ?? disguiseIdFromName(name);
  if (!id) return null;
  const prompt = typeof d.prompt === "string" ? d.prompt.trim().slice(0, MAX_DISGUISE_PROMPT_LENGTH) : "";
  return {
    id,
    name,
    ...(prompt ? { prompt } : {}),
    references: normalizeCardReferenceImages(d.references, "character", name),
  };
}

/**
 * 清洗变装清单：非法项丢、**同 id 或同 name 只留最后一张**、上限 `MAX_DISGUISES_PER_CARD` 截尾。
 *
 * 为什么是「同 id **或**同 name」且留最后一张：去重键必须与 `addCharacterDisguise` 一致。
 * 新增路径覆盖既有变装时用的判准是 `d.id === id || d.name === name`，即**同名不同 id 也会被覆盖**
 * （旧稿被移出、新稿排在后面）——旧版清洗器只按 `id` 去重，于是「同名不同 id」两条并存，
 * 而下游 `resolveCharacterDisguises` 是**按 name 取第一条**，解析结果就取决于清单序（不确定）。
 * 留最后一张而非第一张，理由同上：清洗器读的是可能被多次写入过的持久化资料，
 * 先出现者是被覆盖掉的旧稿；若留第一张，把 add 路径写出的资料再清洗一次会把旧稿复活。
 */
export function normalizeCharacterDisguises(raw: unknown): CharacterCardDisguise[] {
  if (!Array.isArray(raw)) return [];
  const kept = new Map<string, CharacterCardDisguise>();
  for (const item of raw) {
    const disguise = normalizeCharacterDisguise(item);
    if (!disguise) continue;
    for (const [key, existing] of kept) {
      if (existing.id === disguise.id || existing.name === disguise.name) kept.delete(key);
    }
    kept.set(disguise.id, disguise);
  }
  // 截尾在去重之后：上限管的是「最终有几张」，不是「扫过几笔」。
  return [...kept.values()].slice(0, MAX_DISGUISES_PER_CARD);
}

/** 清洗必要变装名清单：trim、去重、上限 `MAX_REQUIRED_DISGUISES` 截尾。 */
export function normalizeRequiredDisguises(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const name = boundedString(item, MAX_DISGUISE_NAME_LENGTH);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_REQUIRED_DISGUISES) break;
  }
  return out;
}

export interface AddCharacterDisguiseInput {
  /** 稳定 id（可选；缺省由名字导出）。同名／同 id ＝ 覆盖（新增幂等）。 */
  id?: string;
  name: string;
  prompt?: string;
  references?: unknown;
}

/**
 * **可新增变装**（为既有角色新增，含命名与参考图）：纯函式，回新卡、**不改传入卡**。
 *
 * 拒收（回 null，不制造半形资产）：
 *   - 非角色卡（`kind !== "character"`：变装是角色的子资产，场景/道具卡没有这个概念）；
 *   - 没有名字 / 名字含保留分隔符 `:` / id 导不出；
 *   - id 等于卡自己的 id（自指）；
 *   - 已达 `MAX_DISGUISES_PER_CARD` 且不是覆盖既有变装。
 * 同名或同 id ＝ **覆盖**（同一名字重复新增不长张数，参考图/片段换成新的）。
 */
export function addCharacterDisguise(
  card: CharacterCard,
  input: AddCharacterDisguiseInput,
): CharacterCard | null {
  if (!card || card.kind !== "character") return null;
  const name = boundedString(input?.name, MAX_DISGUISE_NAME_LENGTH);
  if (!name) return null;
  const id = usableCardId(input?.id) ?? disguiseIdFromName(name);
  if (!id || id === card.id) return null;
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim().slice(0, MAX_DISGUISE_PROMPT_LENGTH) : "";
  const existing = card.disguises ?? [];
  const isOverwrite = existing.some((d) => d.id === id || d.name === name);
  if (!isOverwrite && existing.length >= MAX_DISGUISES_PER_CARD) return null;
  const disguise: CharacterCardDisguise = {
    id,
    name,
    ...(prompt ? { prompt } : {}),
    references: normalizeCardReferenceImages(input?.references, "character", name),
  };
  return {
    ...card,
    disguises: [...existing.filter((d) => d.id !== id && d.name !== name), disguise],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 设定这个角色**必要的变装名清单**（设定阶段的「要求补齐」写入端）。
 * 空清单＝清掉要求（回缺省＝无要求）；纯函式，回新卡。
 */
export function setRequiredDisguises(card: CharacterCard, names: readonly string[]): CharacterCard {
  const clean = normalizeRequiredDisguises(names);
  const next: CharacterCard = { ...card, updatedAt: new Date().toISOString() };
  if (clean.length) next.requiredDisguises = clean;
  else delete next.requiredDisguises;
  return next;
}

export interface CharacterDisguiseAudit {
  /** 没有缺件＝true（无 `requiredDisguises` 的旧卡一律 true，零追溯）。 */
  complete: boolean;
  required: string[];
  /** 要求中已具备的变装名。 */
  present: string[];
  /** **缺件（具名）**：要求中卡上没有的变装名——这就是「要求补齐」要回报的东西。 */
  missing: string[];
  /** 卡上实际挂载的变装名（诊断用）。 */
  provided: string[];
}

/** 单卡变装对帐（纯函式）：以**名字**比对 `requiredDisguises` ↔ `disguises`。 */
export function auditCharacterDisguises(card: CharacterCard): CharacterDisguiseAudit {
  const required = normalizeRequiredDisguises(card?.requiredDisguises);
  const provided = (card?.disguises ?? []).map((d) => d.name);
  return {
    complete: required.every((name) => provided.includes(name)),
    required,
    present: required.filter((name) => provided.includes(name)),
    missing: required.filter((name) => !provided.includes(name)),
    provided,
  };
}

export interface DisguiseRequirementGap {
  cardId: string;
  cardName: string;
  /** 具名缺件（设定阶段要照这个名字要求补齐）。 */
  missingDisguises: string[];
}

export interface DisguiseRequirementReport {
  /** 全部有要求的卡都已补齐＝true（没有任何要求＝true）。 */
  complete: boolean;
  /** 未补齐的卡（具名：卡 id + 卡名 + 缺的变装名）。 */
  gaps: DisguiseRequirementGap[];
  /** 有要求且已补齐的卡 id。 */
  satisfiedCardIds: string[];
}

/**
 * **设定阶段强制补齐的入口**（纯函式）：扫卡库里所有宣告了 `requiredDisguises` 的卡，
 * 回报哪些卡缺哪些**具名**变装。呼叫端据此要求补齐（缺件非空即不得放行），
 * 而不是拿主造型顶上——「强制」二字的落点。
 */
export function auditDisguiseRequirements(cards: readonly CharacterCard[]): DisguiseRequirementReport {
  const gaps: DisguiseRequirementGap[] = [];
  const satisfiedCardIds: string[] = [];
  for (const card of cards ?? []) {
    if (!card || !card.requiredDisguises?.length) continue;
    const audit = auditCharacterDisguises(card);
    if (audit.missing.length) {
      gaps.push({ cardId: card.id, cardName: card.name, missingDisguises: audit.missing });
    } else {
      satisfiedCardIds.push(card.id);
    }
  }
  return { complete: gaps.length === 0, gaps, satisfiedCardIds };
}

/**
 * 解析变装选择 → 命中的（卡 id, 变装）与**具名缺件**。
 * `cardId` 有给＝只在那张卡拉上找；缺省＝在全部传入卡拉上找（同名到多卡＝全命中）。
 * 缺件名字 trim 去重、按宣告序（回报顺序稳定＝可测）。
 */
export function resolveCharacterDisguises(
  cards: readonly CharacterCard[],
  selections: readonly DisguiseSelection[],
): ResolvedCharacterDisguises {
  const matched: { cardId: string; disguise: CharacterCardDisguise }[] = [];
  const missing: string[] = [];
  const seenMatch = new Set<string>();
  const seenMissing = new Set<string>();
  for (const selection of selections ?? []) {
    const name = typeof selection?.name === "string" ? selection.name.trim() : "";
    if (!name) continue;
    const cardId = typeof selection?.cardId === "string" ? selection.cardId.trim() : "";
    const scope = cardId ? (cards ?? []).filter((card) => card.id === cardId) : (cards ?? []);
    let hit = false;
    for (const card of scope) {
      const disguise = (card.disguises ?? []).find((d) => d.name === name);
      if (!disguise) continue;
      const key = `${card.id}\u0000${disguise.id}`;
      if (seenMatch.has(key)) continue;
      seenMatch.add(key);
      matched.push({ cardId: card.id, disguise });
      hit = true;
    }
    if (!hit && !seenMissing.has(name)) {
      seenMissing.add(name);
      missing.push(name);
    }
  }
  return { matched, missing };
}

/**
 * 把命中的变装套成「该角色卡在本镜的造型版本」（纯函式，回 clone、原卡不动）：
 *   - 参考图＝**变装自己的参考图**（url 去重），主造型参考图**一律不进**——
 *     变装的造型由它自己的参考图表达，混入主造型参考即「静默用主造型顶替」；
 *     变装没带参考图＝这一镜没有角色参考（缺件由 `resolveCharacterDisguises.missing` /
 *     审计函式具名回报，不靠主造型补位）。
 *   - prompt＝各变装片段（去重、"\\n" 连接）。**缺件（`disguises` 为空）时 prompt 一律清空**，
 *     不沿用卡本体片段——参考图已清空而文字还在，等于用主造型出图；命中的变装自己没写 prompt
 *     才沿用卡本体片段（那是角色的基础外观描述，不是造型替换）。
 *   - 卡 id / 名称 / kind / loraIds / negativePrompt 原样保留（母卡身分不变，
 *     卡 id 序锁定注入与分镜引用栏零迁移）。
 * 呼叫本函式＝宣告「本卡在这一镜**不是主造型**」⇒ 变装清单为空时参考图一样清空
 * （仍回 clone，不退化成主造型；那正是「绑定式缺件不得顶替」的落点）。
 * 不需要变装的呼叫端就**别呼叫本函式**（原卡直通，零行为漂移）。
 */
export function withCharacterDisguises(
  card: CharacterCard,
  disguises: readonly CharacterCardDisguise[],
): CharacterCard {
  const fragments: string[] = [];
  const references: CharacterCardReferenceImage[] = [];
  const seenUrls = new Set<string>();
  for (const disguise of disguises) {
    const fragment = (disguise.prompt ?? "").trim();
    if (fragment && !fragments.includes(fragment)) fragments.push(fragment);
    for (const ref of disguise.references) {
      if (!isUsableCardImageUrl(ref.url) || seenUrls.has(ref.url)) continue;
      seenUrls.add(ref.url);
      references.push({
        url: ref.url,
        role: toReferenceImageRole(ref.role),
        name: ref.name || disguise.name,
      });
    }
  }
  // prompt：全部变装都没片段时要分辨两种形状相同的处境——
  //   * `disguises` 为空＝**这张卡在这一镜宣告了变装却没命中（缺件）**：不得沿用卡本体片段，
  //     否则参考图清空了、文字描述却还在，等于用主造型去出图（缺件必须整格 fail-closed）。
  //   * `disguises` 非空但都没写 prompt＝命中变装、只是它没描述：沿用卡本体片段合理
  //     （角色的基础外观描述仍然成立，这一镜换的只是造型）。
  const missingDeclaration = disguises.length === 0;
  return {
    ...card,
    prompt: fragments.length ? fragments.join("\n") : missingDeclaration ? "" : card.prompt,
    references,
  };
}

// ─────────────────────────────────────────── 锁定注入语义

export interface AppliedCharacterCards {
  /** 未引用卡的前缀片段 + token 已就地展开的正文。 */
  prompt: string;
  /** 卡的参考图（url 去重、角色保留；卡 id 序）。 */
  references: CharacterCardReferenceImage[];
  /** 合并后的负面词；无则 null。 */
  negativePrompt: string | null;
}

export interface ApplyCharacterCardsOptions {
  /** "visual"（预设）：character/scene/style/prop 参与，audio 卡完全忽略（＝既有行为）。
   *  "audio"：只有 audio 卡参与，其余 kind 忽略，references 一律回空。 */
  target?: "visual" | "audio";
  /** "all"（预设，＝既有行为）：所有传入卡都贡献 references。
   *  "referenced"：只让「被 token 引用到的卡」贡献 references；若正文里一个 token 都没有，
   *  退回 "all"（不让「没用 token」变成静默丢参考图）。 */
  referenceScope?: "all" | "referenced";
}

/**
 * 生成时卡集推导：把**本段提示词 token 引用到的卡**就地并入既有卡集（纯函式）。
 *
 * 补的缺口：agent 建的卡只落进卡库（`characterCards`），不会自动锁进项目
 * （`activeCardIds`／`project.cardIds` 的既有语义不动，本函式也**不自动锁任何卡**）。
 * 于是正文写了 `@[角色:灰羽]`，注入集里却没有灰羽 → `expandEntityTokens` 找不到卡
 * → token 原样送上游。本函式让「卡在库」就足以被 `@` 引用。
 *
 * 语义（判准与 `expandEntityTokens` 逐字同一把尺，不另立第二套）：
 *   - 种类字 → kind 走 `resolveEntityTokenKind`；命中卡＝**卡库全量**里第一张
 *     `card.kind === kind && card.name.trim() === hit.name.trim()` 的卡。
 *   - 未命中（种类字未知／卡库没有同名同 kind 的卡）→ 不并入、不 throw；
 *     该 token 交由 `expandEntityTokens` 既有的 fail-open 原样保留处理。
 *   - 并入＝**联集**：`cards` 原序在前，新命中的卡按 token 出现序补在后，同 id 去重。
 *   - 零 token／全部未命中 → **回传同一阵列参考**（逐位元等价：零新增、零 I/O、payload 形状不变）。
 *   - 纯函式：不 mutate 任何输入。
 */
export function mergeTokenReferencedCards(
  cards: CharacterCard[],
  libraryCards: readonly CharacterCard[] | null | undefined,
  prompt: string,
): CharacterCard[] {
  if (!prompt || !libraryCards?.length) return cards;
  const hits = parseEntityTokens(prompt);
  if (hits.length === 0) return cards;
  const seen = new Set(cards.map((card) => card.id));
  let merged: CharacterCard[] | null = null;
  for (const hit of hits) {
    const kind = resolveEntityTokenKind(hit.kindLabel);
    if (!kind) continue;
    const name = hit.name.trim();
    const matched = libraryCards.find((card) => card.kind === kind && card.name.trim() === name);
    if (!matched || seen.has(matched.id)) continue;
    seen.add(matched.id);
    merged ??= [...cards];
    merged.push(matched);
  }
  return merged ?? cards;
}


/**
 * 锁定注入核心（纯函式、幂等）：
 *   - 稳定顺序：卡按 id 升序（卡 id 序），与传入顺序无关
 *   - token 展开：正文里的 `@[角色:霍辞渊]` 就地在原位置换成该卡的 prompt 片段
 *   - 幂等：同一卡出现两次只注入一次；片段已存在于 prompt 时不再重复（含 token 展开后的位置）
 *   - 参考图按 url 去重、角色原样保留
 *   - 负面词合并去重（", " 连接），**不论 referenceScope 一律收全部参与卡**
 *     （否定词不影响构图绑定，收窄反而让画面失控）
 */
export function applyCharacterCards(
  basePrompt: string,
  cards: CharacterCard[],
  options?: ApplyCharacterCardsOptions,
): AppliedCharacterCards {
  const target = options?.target ?? "visual";
  const referenceScope = options?.referenceScope ?? "all";

  // 卡池过滤：visual 丢 audio 卡；audio 只留 audio 卡。
  // variantOf 指到存在卡的变体＝照常参与（它就是角色卡）；指不到＝照常参与（fail-open）。
  const pool = cards.filter((card) =>
    target === "audio" ? card.kind === "audio" : card.kind !== "audio",
  );
  if (pool.length === 0 && target === "audio") {
    return { prompt: basePrompt, references: [], negativePrompt: null };
  }

  const ordered = [...pool].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const seenIds = new Set<string>();
  const unique: CharacterCard[] = [];
  for (const card of ordered) {
    if (seenIds.has(card.id)) continue;
    seenIds.add(card.id);
    unique.push(card);
  }

  // token 就地展开（用整个参与卡池解析；audio 链路同样支援 `@[音频:配乐]`）。
  const expanded = expandEntityTokens(basePrompt, unique);
  const referenced = new Set(expanded.usedCardIds);

  const fragments: string[] = [];
  const negatives: string[] = [];
  // referenceScope："referenced" 且**真的有 token 命中**时才收窄到被引用的卡；
  // 零 token → 退回全收（既有行为，不让「没用 token」变成静默丢参考图）。
  const narrowReferences = referenceScope === "referenced" && expanded.usedCardIds.length > 0;
  const referenceCards = narrowReferences
    ? unique.filter((card) => referenced.has(card.id))
    : unique;
  const references: CharacterCardReferenceImage[] = [];
  const seenUrls = new Set<string>();
  // audio 链路没有参考图语义：references 一律回空。
  if (target !== "audio") {
    for (const card of referenceCards) {
      for (const ref of card.references) {
        if (!isUsableCardImageUrl(ref.url) || seenUrls.has(ref.url)) continue;
        seenUrls.add(ref.url);
        references.push({
          url: ref.url,
          role: toReferenceImageRole(ref.role),
          name: ref.name || card.name,
        });
      }
    }
  }
  for (const card of unique) {
    // 已被 token 引用的卡：片段已在正文对应位置，不再进前缀。
    if (!referenced.has(card.id)) {
      const fragment = card.prompt.trim();
      if (fragment && !fragments.includes(fragment)) fragments.push(fragment);
    }
    const negative = (card.negativePrompt ?? "").trim();
    if (negative && !negatives.includes(negative)) negatives.push(negative);
  }

  // 幂等：正文已含的片段不重复注入（apply 两次 = 一次）。
  const base = expanded.prompt.trim();
  const injectable = fragments.filter((fragment) => !base.includes(fragment));
  const prefix = injectable.join("\n");
  const prompt = prefix ? (base ? prefix + "\n" + base : prefix) : expanded.prompt;

  return {
    prompt,
    references,
    negativePrompt: negatives.length > 0 ? negatives.join(", ") : null,
  };
}

// ─────────────────────────────────────────── 生成请求挂接

/** /api/canvas/generate 请求体中与卡相关的栏位形状。 */
export interface CardAwareGeneratePayload {
  prompt: string;
  reference_images?: { url: string; role: ReferenceImageRole; name: string }[];
  negative_prompt?: string | null;
  [key: string]: unknown;
}

/**
 * 把锁定卡注入生成请求 payload（不改动其余栏位）：
 *   - prompt：卡片段前缀（幂等）
 *   - reference_images：卡参考图排最前（locked 优先——上游 5 张上限从尾部截断，
 *     锁定卡不可被静默丢弃），原有参考按 url 去重后排其后
 *   - negative_prompt：合并（原有在前、卡在后，去重）
 * 无卡可注入时原样返回同一物件（零行为漂移）。options 透传 applyCharacterCards
 * （target 选视觉/音频链路、referenceScope 选参考图收窄）。
 */
export function applyCharacterCardsToPayload<T extends CardAwareGeneratePayload>(
  payload: T,
  cards: CharacterCard[],
  options?: ApplyCharacterCardsOptions,
): T {
  if (cards.length === 0) return payload;
  const applied = applyCharacterCards(payload.prompt, cards, options);
  if (!applied.references.length && applied.prompt === payload.prompt && !applied.negativePrompt) return payload;

  const existingRefs = Array.isArray(payload.reference_images) ? payload.reference_images : [];
  // 同 URL 以卡为准（locked 覆盖）：手动引用撞卡图时保留卡的角色与名称。
  const cardUrls = new Set(applied.references.map((ref) => ref.url));
  const mergedRefs = [...applied.references, ...existingRefs.filter((ref) => !cardUrls.has(ref.url))];

  const negatives: string[] = [];
  const baseNegative = (payload.negative_prompt ?? "").trim();
  if (baseNegative) negatives.push(baseNegative);
  for (const item of (applied.negativePrompt ?? "").split(", ")) {
    const clean = item.trim();
    if (clean && !negatives.includes(clean)) negatives.push(clean);
  }

  return {
    ...payload,
    prompt: applied.prompt,
    ...(mergedRefs.length > 0 ? { reference_images: mergedRefs } : {}),
    ...(negatives.length > 0 ? { negative_prompt: negatives.join(", ") } : {}),
  };
}
