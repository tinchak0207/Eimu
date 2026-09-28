// 角色/場景卡（P2 跨鏡頭一致性）：純邏輯層。
//
// 定位：卡 = 項目級「鎖定」配置。一經鎖定（掛到畫布項目的 cardIds），
// 該畫布所有生成（手動面板、agent run_generation、編輯器派生）自動攜帶：
//   - locked prompt 片段 → 以穩定順序（卡 id 序）注入 prompt 前綴
//   - 參考圖 → 合併進 reference_images（各帶 ReferenceRole，卡優先）
//   - 負面詞 → 合併進 negative_prompt
//
// 角色枚舉 owner 是 image-types.ReferenceImageRole（復用，不建第二套）；
// LoRA 關聯引用既有 lora versionId 標識（不建新 LoRA 體系）。
// 本檔只做純函式；存儲在 character-card-store.ts、HTTP 在 /api/character-cards。

import { toReferenceImageRole } from "./image-types";
import type { AgentInteractionMode } from "./agent-chat-client";
import type { ReferenceImageRole } from "./image-types";
import { normalizeLineageLinks } from "./lineage";
import type { LineageLink } from "./lineage";
import { ASSET_KEY_DELIMITER, GHOST_ASSET_SCOPE, normalizeAssetScope } from "./asset-scope";
import type { AssetScope } from "./asset-scope";
import { expandEntityTokens, parseEntityTokens, resolveEntityTokenKind } from "./entity-tokens";

/**
 * 卡種類：角色卡（外觀鎖定）/ 場景卡（環境鎖定）/ 風格卡（畫風鎖定）
 * / 道具卡（物件鎖定）/ 音頻卡（配樂/音效鎖定）。
 *
 * 音頻卡是**唯讀型別上的新 kind**：它照常是項目級「鎖定配置」，但只參與
 * `applyCharacterCards(..., { target: "audio" })` 的音頻提示詞鏈路
 * （視覺鏈路完全忽略它——不進 prompt 前綴、不進參考圖）。
 */
export type CharacterCardKind = "character" | "scene" | "style" | "prop" | "audio";

export const CHARACTER_CARD_KIND_VALUES: readonly CharacterCardKind[] = [
  "character",
  "scene",
  "style",
  "prop",
  "audio",
];

/** 卡種類的簡體中文標籤（UI 與 toast 共用，不散落三元表達式）。 */
export const CHARACTER_CARD_KIND_LABEL: Record<CharacterCardKind, string> = {
  character: "角色",
  scene: "场景",
  style: "风格",
  prop: "道具",
  audio: "音频",
};

/** 未知值收斂為 character（舊數據/agent 亂填不炸）。 */
export function toCharacterCardKind(value: unknown): CharacterCardKind {
  return typeof value === "string" && (CHARACTER_CARD_KIND_VALUES as readonly string[]).includes(value)
    ? (value as CharacterCardKind)
    : "character";
}

/**
 * 資產批准狀態（2026-09-24 決策定稿 23/4）。**路 1/2/3 與分鏡側共用同一個 shape**
 * （分鏡側見 `storyboard-contract.ts` 的 `approval?: ApprovalState`），禁止另建第二套。
 *
 * 語義（決策 23）：**缺省（`undefined`）＝ 已批准** —— 存量資產（無此欄位）一律視為已批准，
 * 不追溯、不攔流程。只有顯式 `pending`/`rejected` 才算「未批准」。
 * 檔位（決策 2）：批准閘**只在協作檔生效**；`preset`/`auto` 一律視為已批准（護城河）。
 * `reason` 是駁回理由（決策 4：駁回後停下等用戶指定怎麼改，理由存下、不擅自重生成）。
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

/** 卡的參考圖：url + 角色（ReferenceImageRole）+ 顯示名。 */
export interface CharacterCardReferenceImage {
  url: string;
  role: ReferenceImageRole;
  name: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  kind: CharacterCardKind;
  /** 鎖定的 prompt 片段（外觀/場景描述）；空字串 = 純參考圖卡。 */
  prompt: string;
  /** 參考圖列表（各帶角色）。 */
  references: CharacterCardReferenceImage[];
  /** 負面詞（可選）。 */
  negativePrompt?: string;
  /** LoRA 關聯（可選）：引用既有 lora versionId，不建新體系。 */
  loraIds?: string[];
  /** 變體母卡 id（變體＝kind 仍是 "character" 但帶此欄，例如「劼后-霍辞渊」是「霍辞渊」的造型變體）。
   *  指到的卡不存在＝當普通角色卡處理（fail-open，不報錯）。 */
  variantOf?: string;
  /**
   * REQ-D1 資產血統：這張卡的直接來源鏈（例如「存為卡片」時登記的歷史來源）。
   * 只存在卡本體供人看的「溯源」抽屜；不進 canvas 節點 metadata、
   * 不進 compactMetadataForAgent（裁決②：agent 不讀血統）。缺省＝來源不明。
   */
  lineage?: LineageLink[];
  /** parents 曾超上限被截尾的顯式標記。 */
  lineageTruncated?: boolean;
  /**
   * REQ-B2 歸屬（個人 / 項目）：缺省＝personal（既有卡零改動）。
   * 只給人看（項目資產庫面板的歸屬標記與顯式分享入口）——
   * **裁決排除**（同 D1 lineage 先例）：不進 canvas 節點 metadata、
   * 不進 toNodeMetadata、不進 compactMetadataForAgent。
   */
  scope?: AssetScope;
  /**
   * 資產批准狀態（2026-09-24 決策 23）：**缺省＝已批准**（存量資產零改動、不追溯）。
   * 只有 `pending`/`rejected` 才算未批准，且**只在協作檔**（`interaction_mode === "collaborate"`）
   * 當門檻（未批准的卡 id 不得進分鏡卡引用欄，見 `storyboard-contract.ts`
   * `filterApprovedShotCardIds`）；全自動檔（`preset`/`auto`）一律視為已批准、不擋（護城河）。
   */
  approval?: ApprovalState;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────── 清洗與上限

const MAX_CARD_ID_LENGTH = 100;
const MAX_CARD_NAME_LENGTH = 100;
const MAX_CARD_PROMPT_LENGTH = 2000;
const MAX_CARD_NEGATIVE_LENGTH = 1000;
/** 單張卡參考物上限（**唯一宣告**：卡清洗在此截尾；B 端 /v1/character-cards 用它做
 *  「超限回 400」的前置校驗——不靜默截尾，故必須與此處同值、不得另立常數）。 */
export const MAX_CARD_REFERENCES = 8;
const MAX_CARD_LORA_IDS = 8;
const MAX_REFERENCE_NAME_LENGTH = 60;
const MAX_APPROVAL_REASON_LENGTH = 200;
const MAX_APPROVAL_DECIDED_AT_LENGTH = 40;

/** 圖片 URL 判定核心：與 semantic-nodes 的收口一致（http(s) 與 data:image）。純布林，兩種呼叫端共用。 */
function isCardImageUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:image/");
}

/** 同上，type predicate 版（供需要收窄的呼叫端；`!url` 空值一律不合格）。 */
function isUsableCardImageUrl(url: string | undefined | null): url is string {
  return typeof url === "string" && !!url && isCardImageUrl(url);
}

/**
 * 卡**參考物** URL 判定（kind-aware，唯一收口）：卡儲存時用這把尺，不是純圖片尺。
 *
 *   - `http(s)`：兩類都收（既有寬鬆面原樣保留——舊尺 `startsWith("http")` 從不辨 mime／
 *     副檔名，本刀不動它：收緊會讓存量卡當場掉參考）。
 *   - `data:`：圖片卡收 `data:image/`；**音頻卡收 `data:audio/`**。
 *
 * Why：音頻卡的載體是音頻（`@[音频:…]` 片段 + 音頻參考），舊尺只認 `data:image/`
 * ⇒ `data:audio/mpeg;base64,…` 這種合法的內嵌參考音頻會被 `normalizeCharacterCard`
 * **靜默丟掉**（卡變成沒有載體的空殼）。視覺鏈路不受影響：音頻卡在
 * `applyCharacterCards` 的視覺 target 下整張被排除，其參考物永不冒充圖片。
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
 * 卡 id 邊界（REQ-B2）：在長度界之上**拒絕含保留分隔符 `:` 的 id**。
 * 理由：`:` 是作用域層確定性鍵（share/mount）的段分隔符，含它的 id 在舊版裸拼接鍵下
 * 可與別的 (kind, id) 組合撞鍵 → 授權跨資產別名。截斷/改寫 id 都不行（會斷掉 cardIds
 * 與既有引用），故一律 fail-closed 拒收（回 null）。
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
 * 批准狀態清洗（**唯一收口**：`normalizeCharacterCard` 與 `setApproval` 共用同一把尺）。
 *   - 非物件 / `status` 不在 `APPROVAL_STATUS_VALUES` 三值域 → **null（呼叫端省略欄位＝缺省＝已批准）**。
 *     讀不懂的值不猜成「未批准」：批准狀態不是安全邊界（卡內容對本帳號本來就可見），
 *     且與決策 23「缺省＝已批准」同向——髒資料不該讓存量卡突然被擋在分鏡之外。
 *   - `decidedAt` 只驗「非空字串且不超長」，**不做日期解析**（不引入第二套時間語義）。
 *   - `reason` 走 `boundedString`（trim + 上限）；空/純空白＝沒有理由（欄位省略）。
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

/** 清洗單張卡：欄位缺損返回 null（API 與 store 共用同一收口）。 */
export function normalizeCharacterCard(payload: unknown): CharacterCard | null {
  if (!payload || typeof payload !== "object") return null;
  const c = payload as Partial<CharacterCard>;
  const id = usableCardId(c.id);
  const name = boundedString(c.name, MAX_CARD_NAME_LENGTH);
  if (!id || !name) return null;
  const now = new Date().toISOString();
  // kind 先落定：參考物 URL 的收口尺是 kind-aware 的（音頻卡收 data:audio/，見上）。
  const kind = toCharacterCardKind(c.kind);
  const references = (Array.isArray(c.references) ? c.references : [])
    .flatMap((ref): CharacterCardReferenceImage[] => {
      if (!ref || typeof ref !== "object") return [];
      const r = ref as { url?: unknown; role?: unknown; name?: unknown };
      if (typeof r.url !== "string" || !isUsableCardReferenceUrl(r.url, kind)) return [];
      return [
        {
          url: r.url,
          role: toReferenceImageRole(r.role),
          name: boundedString(r.name, MAX_REFERENCE_NAME_LENGTH) ?? name,
        },
      ];
    })
    .slice(0, MAX_CARD_REFERENCES);
  const negativePrompt = boundedString(c.negativePrompt, MAX_CARD_NEGATIVE_LENGTH);
  const loraIds = (Array.isArray(c.loraIds) ? c.loraIds : [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, MAX_CARD_LORA_IDS);
  // 變體母卡指針：走與卡 id 同級的邊界（長度上限 + 拒 `:` + 拒控制字元）。
  // 不合法 → **只省略該欄位**（不整張卡回 null：母卡指針壞掉不該讓造型卡本身消失）；
  // 自環（指向自己）同樣省略——不製造鬼引用。
  const variantOfRaw = usableCardId(c.variantOf);
  const variantOf = variantOfRaw && variantOfRaw !== id ? variantOfRaw : null;
  // REQ-D1：血統欄位復用 ./lineage 的清洗收口（非法條目丟、上限截尾並顯式標記）。
  const lineageRaw = Array.isArray(c.lineage) ? normalizeLineageLinks(c.lineage) : null;
  // REQ-B2 作用域：同樣走 ./asset-scope 的清洗收口（缺省＝personal 且省略欄位）。
  // 回 null＝鬼狀態（owner=project 卻無 projectId / owner=team 卻無 teamId）：
  // **寫回 GHOST_ASSET_SCOPE**（不降格成 personal），該卡在任何上下文都不可見/不可用
  //（D3：降格＝把歸屬不明的項目資產變成人人可用的個人資產）。
  // P0-2：team 作用域同樣要落欄（只寫 project 會讓團隊卡在存檔端靜默丟失歸屬）。
  const scope = normalizeAssetScope(c.scope);
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
    ...(approval ? { approval } : {}),
    createdAt: typeof c.createdAt === "string" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : now,
  };
}

// ─────────────────────────────────────────── 資產批准狀態（檔位相關）

/**
 * 「這張資產算不算已批准」的**唯一判定入口**（純函式，不 mutate）。
 *
 * 檔位規則（決策 2/23，護城河）：
 *   - `mode !== "collaborate"`（含 `preset`/`auto`/`undefined`）→ **一律 `true`**：
 *     全自動檔零改動、不停不阻塞；既有呼叫端（不知道 mode 這回事）行為逐位不變。
 *   - `mode === "collaborate"` → 只有顯式 `pending`/`rejected` 才算未批准；
 *     缺省 `approval`（存量資產）仍＝已批准。
 * 因此「只有協作檔才可能回 false」寫進型別層的判定，不靠呼叫端自律——護城河不是約定。
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
   * 決策時間（ISO）。缺省＝現在。**同時作為該卡的 `updatedAt`**（一次讀鐘，不產生第二個時間源）：
   * 批准是使用者對該卡的動作，卡列表按 `updatedAt` 排序（`character-card-store.ts:125`），
   * 不更新會讓剛確認過的卡沉在列表底部。
   */
  decidedAt?: string;
  /** 駁回理由（決策 4）。空白＝沒有理由（省略欄位）。 */
  reason?: string;
}

/**
 * 設定批准狀態（純函式：回新物件、**不改傳入卡**）。
 * `status` 不合法（型別外呼叫）→ **原卡回傳**（不製造半形狀態、不寫半套）。
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
 * 清除批准狀態 → 回到**缺省＝已批准**（決策 23 的存量相容態）。
 * 刻意不是「設成 pending」：清狀態的語義是「這張卡沒有待決事項」，不是「再等一下」。
 * 本來就沒有 `approval` → **回同一物件**（呼叫端可用 `===` 略過無謂寫入）。
 */
export function clearApproval(card: CharacterCard): CharacterCard {
  if (!card.approval) return card;
  const next: CharacterCard = { ...card, updatedAt: new Date().toISOString() };
  delete next.approval;
  return next;
}

// ─────────────────────────────────────────── 鎖定注入語義

export interface AppliedCharacterCards {
  /** 未引用卡的前綴片段 + token 已就地展開的正文。 */
  prompt: string;
  /** 卡的參考圖（url 去重、角色保留；卡 id 序）。 */
  references: CharacterCardReferenceImage[];
  /** 合併後的負面詞；無則 null。 */
  negativePrompt: string | null;
}

export interface ApplyCharacterCardsOptions {
  /** "visual"（預設）：character/scene/style/prop 參與，audio 卡完全忽略（＝既有行為）。
   *  "audio"：只有 audio 卡參與，其餘 kind 忽略，references 一律回空。 */
  target?: "visual" | "audio";
  /** "all"（預設，＝既有行為）：所有傳入卡都貢獻 references。
   *  "referenced"：只讓「被 token 引用到的卡」貢獻 references；若正文裡一個 token 都沒有，
   *  退回 "all"（不讓「沒用 token」變成靜默丟參考圖）。 */
  referenceScope?: "all" | "referenced";
}

/**
 * 生成時卡集推導：把**本段提示詞 token 引用到的卡**就地併入既有卡集（純函式）。
 *
 * 補的缺口：agent 建的卡只落進卡庫（`characterCards`），不會自動鎖進項目
 * （`activeCardIds`／`project.cardIds` 的既有語義不動，本函式也**不自動鎖任何卡**）。
 * 於是正文寫了 `@[角色:灰羽]`，注入集裡卻沒有灰羽 → `expandEntityTokens` 找不到卡
 * → token 原樣送上游。本函式讓「卡在庫」就足以被 `@` 引用。
 *
 * 語義（判準與 `expandEntityTokens` 逐字同一把尺，不另立第二套）：
 *   - 種類字 → kind 走 `resolveEntityTokenKind`；命中卡＝**卡庫全量**裡第一張
 *     `card.kind === kind && card.name.trim() === hit.name.trim()` 的卡。
 *   - 未命中（種類字未知／卡庫沒有同名同 kind 的卡）→ 不併入、不 throw；
 *     該 token 交由 `expandEntityTokens` 既有的 fail-open 原樣保留處理。
 *   - 併入＝**聯集**：`cards` 原序在前，新命中的卡按 token 出現序補在後，同 id 去重。
 *   - 零 token／全部未命中 → **回傳同一陣列參考**（逐位元等價：零新增、零 I/O、payload 形狀不變）。
 *   - 純函式：不 mutate 任何輸入。
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
 * 鎖定注入核心（純函式、冪等）：
 *   - 穩定順序：卡按 id 升序（卡 id 序），與傳入順序無關
 *   - token 展開：正文裡的 `@[角色:霍辞渊]` 就地在原位置換成該卡的 prompt 片段
 *   - 冪等：同一卡出現兩次只注入一次；片段已存在於 prompt 時不再重複（含 token 展開後的位置）
 *   - 參考圖按 url 去重、角色原樣保留
 *   - 負面詞合併去重（", " 連接），**不論 referenceScope 一律收全部參與卡**
 *     （否定詞不影響構圖綁定，收窄反而讓畫面失控）
 */
export function applyCharacterCards(
  basePrompt: string,
  cards: CharacterCard[],
  options?: ApplyCharacterCardsOptions,
): AppliedCharacterCards {
  const target = options?.target ?? "visual";
  const referenceScope = options?.referenceScope ?? "all";

  // 卡池過濾：visual 丟 audio 卡；audio 只留 audio 卡。
  // variantOf 指到存在卡的變體＝照常參與（它就是角色卡）；指不到＝照常參與（fail-open）。
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

  // token 就地展開（用整個參與卡池解析；audio 鏈路同樣支援 `@[音频:配乐]`）。
  const expanded = expandEntityTokens(basePrompt, unique);
  const referenced = new Set(expanded.usedCardIds);

  const fragments: string[] = [];
  const negatives: string[] = [];
  // referenceScope："referenced" 且**真的有 token 命中**時才收窄到被引用的卡；
  // 零 token → 退回全收（既有行為，不讓「沒用 token」變成靜默丟參考圖）。
  const narrowReferences = referenceScope === "referenced" && expanded.usedCardIds.length > 0;
  const referenceCards = narrowReferences
    ? unique.filter((card) => referenced.has(card.id))
    : unique;
  const references: CharacterCardReferenceImage[] = [];
  const seenUrls = new Set<string>();
  // audio 鏈路沒有參考圖語義：references 一律回空。
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
    // 已被 token 引用的卡：片段已在正文對應位置，不再進前綴。
    if (!referenced.has(card.id)) {
      const fragment = card.prompt.trim();
      if (fragment && !fragments.includes(fragment)) fragments.push(fragment);
    }
    const negative = (card.negativePrompt ?? "").trim();
    if (negative && !negatives.includes(negative)) negatives.push(negative);
  }

  // 冪等：正文已含的片段不重複注入（apply 兩次 = 一次）。
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

// ─────────────────────────────────────────── 生成請求掛接

/** /api/canvas/generate 請求體中與卡相關的欄位形狀。 */
export interface CardAwareGeneratePayload {
  prompt: string;
  reference_images?: { url: string; role: ReferenceImageRole; name: string }[];
  negative_prompt?: string | null;
  [key: string]: unknown;
}

/**
 * 把鎖定卡注入生成請求 payload（不改動其餘欄位）：
 *   - prompt：卡片段前綴（冪等）
 *   - reference_images：卡參考圖排最前（locked 優先——上游 5 張上限從尾部截斷，
 *     鎖定卡不可被靜默丟棄），原有參考按 url 去重後排其後
 *   - negative_prompt：合併（原有在前、卡在後，去重）
 * 無卡可注入時原樣返回同一物件（零行為漂移）。options 透傳 applyCharacterCards
 * （target 選視覺/音頻鏈路、referenceScope 選參考圖收窄）。
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
  // 同 URL 以卡為準（locked 覆蓋）：手動引用撞卡圖時保留卡的角色與名稱。
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
