// 模板節點交付 → 實體卡自動落卡（2026-09-24）：純邏輯層，零副作用、不做 I/O。
//
// 斷點：agent 跑完 `character_sheet`/`scene_setup`/… 模板產出角色四視圖、場景圖之後，
// 那批資產**沒有卡實體**（src/lib/character-cards.ts 的 CharacterCard）→ 因此不會
// 出現在素材池裡等人 `@` 引用，下一步得手動補。本檔把「模板節點的交付物」判成
// 「可被 @ 引用的實體卡」。
//
// 資料來源（工作流定義層宣告，零引擎改動）：模板節點的 `defaults.emitsEntity`
//   { kind: CharacterCardKind; nameFrom?: "nodeTitle" | "input" }
// 由 `expandTemplate` spread 進節點 metadata（deploy-staging/gateway/workflow-engine.ts
// 的 `filled` 合併）→ 隨 SSE `canvas.node.created/updated` 抵達畫布 → 本檔消費。
//
// 本檔只做四件事：
//   1. `emittedEntityOf`：清洗節點上的實體宣告（不合法 = 沒有宣告，不猜）
//   2. `entityCardIdForNode`：決定性 + 合法（過得了 `normalizeCharacterCard` 的 id 界線）
//      → 同節點重入必得同 id，這是冪等的根
//   3. `cardFromEntityNode`：**有交付物才建卡**（沒圖/沒文本 → null，絕不建空卡）
//   4. `emittedCardsForNodes`：批量產出「要新建的卡 / 要鎖定的 id / 要回填的分鏡引用」
//      （回填來源＝**自動落成的卡**，不只本輪新建——見該函式註解：這是耐久的根）
//
// 2026-09-24 增補（決策 2/23）：落卡可帶 `options.mode`（`AgentInteractionMode`）——
// 協作檔落的卡 `pending`（等人過資產確認閘），全自動兩檔落的卡 `approved`（不停：護城河）。
// **未給 mode → 一個欄位都不多寫**（既有呼叫端輸出逐欄不變）。本檔不做「未批准就不回填」：
// 回填是儲存層的候選綁定，生效層由 `storyboard-contract.ts` 的批准閘把關。
//
// 邊界（誠實標記，不假裝做了）：
//   - 四視圖聚合（2026-09-24 本刀）：`emitsEntity.referenceRoles` → 閘道
//     `expandTemplate` 解析成 `emitsEntity.referenceNodeIds` → 本檔把它收進**同一張卡**的
//     `references`（自己的交付圖在前，再按 referenceNodeIds 順序收兄弟節點的交付圖）。
//     跨檔鏈路已驗（真 `expandTemplate` → 真 `compactMetadataForAgent`/`toNodeMetadata`
//     兩處白名單 → 真 `emittedCardsForNodes`，見測試「四視圖只落一張角色卡」那條逐鍵全等斷言）：
//     `layout.cleanEmitsEntity` 已放行 `referenceRoles`/`referenceNodeIds` 兩鍵。
//   - `updatedCards` 只比**參考圖 url 集合**：名稱/prompt/批准狀態不是本輪焦點，
//     一律沿用既有卡（避免用重算把人的 `rejected` 決策洗回 pending）。
//   - 本檔不 import `canvas/types`：結構相容即可，測試能直接餵假物件。
//     邊界投影用 `toAgentOutputNodeRef`（CanvasNodeMetadata 是 interface，無
//     index signature，無法直接賦值給 `Record<string, unknown>`）。

import { CHARACTER_CARD_KIND_VALUES } from "./character-cards";
import type { ApprovalState, CharacterCard, CharacterCardKind, CharacterCardReferenceImage } from "./character-cards";
import type { AgentInteractionMode } from "./agent-chat-client";
import type { ReferenceImageRole } from "./image-types";
import { parseReferenceAssets } from "./storyboard-contract";

/** 節點 metadata 上的實體宣告鍵（模板 defaults 的保留鍵，與 gateway types.ts 同步）。 */
export const EMITS_ENTITY_KEY = "emitsEntity";
/** 節點 metadata 上的「已落卡」標記鍵（冪等：已標記者不重複建卡）。 */
export const ENTITY_CARD_ID_KEY = "entityCardId";

/** 卡 id 前綴：落卡節點與人手建卡在 id 上可區分（決定性推導，非隨機）。
 *  `entityCardIdForNode` 的唯一前綴；回填只認這批卡（使用者手建的卡一個都不動）。 */
export const ENTITY_CARD_ID_PREFIX = "card-node-";

/** 與 character-cards.ts 的邊界同級（id ≤100、name ≤100、prompt ≤2000、參考圖名 ≤60）。 */
const MAX_CARD_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_PROMPT_LENGTH = 2000;
const MAX_REFERENCE_NAME_LENGTH = 60;
/** 與 character-cards.ts 的 `MAX_CARD_REFERENCES` 同尺（8）：normalize 會 slice 到 8，
 *  本檔不設同一道限 → 逐欄相等斷言會失真（聚合後最多 1+7 張）。 */
const MAX_REFERENCES = 8;

export interface EmittedEntitySpec {
  kind: CharacterCardKind;
  nameFrom: "nodeTitle" | "input";
}

/**
 * 落卡時的檔位選項（2026-09-24 決策 2/23）。**只決定新卡的初始 `approval`**，不動其餘任何欄位。
 */
export interface EntityCardGateOptions {
  /**
   * 互動檔位（型別真源 `AgentInteractionMode`，`src/lib/agent-chat-client.ts:749`）：
   *   - `"collaborate"` → 落的卡 `pending`（等人過資產確認閘；決策 1/3）
   *   - `preset` / `auto` → `approved`（全自動檔一鍵跑完，資產卡不得讓它停：護城河）
   *   - **未給** → 不寫 `approval` 欄位（＝缺省＝已批准）：既有呼叫端的輸出逐欄不變。
   */
  mode?: AgentInteractionMode;
}

/**
 * 檔位 → 新卡的初始批准狀態。
 * 只有 `"collaborate"` 落 `pending`：其餘（含未給 mode）的「已批准」寫成顯式 `approved`
 * 只在呼叫端真的有給 mode 時才寫——未給 mode 的呼叫端（既有路徑）輸出鍵一個不多。
 * 刻意**不填 `decidedAt`**：自動落卡不是人的決策時間，填了就是假造審計跡。
 */
function initialApproval(mode?: AgentInteractionMode): ApprovalState | undefined {
  if (!mode) return undefined;
  return { status: mode === "collaborate" ? "pending" : "approved" };
}

/**
 * 本檔消費的節點投影（結構子集，不依賴 canvas/types）。
 * `metadata` 是不透明袋子：只讀宣告鍵與交付物欄位。
 */
export interface AgentOutputNodeRef {
  id: string;
  title?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * 一條需要回填的分鏡節點引用（鍵名 = `storyboard_qc_17` 門禁的卡引用欄名，
 * 見 src/lib/storyboard-contract.ts：`characterCardIds`/`sceneCardIds`）。
 * `propCardIds` 在本站門禁沒有對應欄位（誠實標記：先填，等消費端接）。
 */
export interface ShotEntityBackfill {
  nodeId: string;
  characterCardIds?: string[];
  sceneCardIds?: string[];
  propCardIds?: string[];
}

export interface EmittedCardsResult {
  /** 需要新建的卡（已存在者不重複；呼叫端逐張 upsert）。 */
  cards: CharacterCard[];
  /**
   * 既有卡但參考圖集合與現況不符 → 需就地更新的卡（2026-09-24 四視圖聚合）。
   * 聚合是**漸進**的：view1 的圖先生成、view2/3/4 晚到 → 兄弟圖到齊那幾輪才更新。
   * 判準＝同決定性 id 的既有卡，用當下節點重算期望 `references`，與既有卡的
   * **url 集合**（順序無關）不同才進；相同不回（跑兩次第二次為空＝冪等）。
   * 內容＝重算後的卡（`createdAt` 沿用既有的、既有卡的 `approval` 原樣保留——
   * 重算不得把人的 `rejected` 決策洗掉）。
   */
  updatedCards: CharacterCard[];
  /** 需要鎖進項目 cardIds 的 id（＝本輪新建卡的 id，讓它們自動生效）。 */
  lockedIds: string[];
  /**
   * 需要回填分鏡節點引用的清單。
   * 判準是「**自動落成的卡**存在且該分鏡節點缺引用」——不是「本輪有新建卡」：
   * 卡上次已落、這輪 `cards` 為空，但引用還沒寫進節點（刷新在中途、舊版通道丟欄）
   * 時仍要回填，否則分鏡節點永遠拿不到卡引用（本檔耐久性的根）。
   * 沒有自動落成的卡 → 空（不臆造）。
   */
  shotBackfill: ShotEntityBackfill[];
  /**
   * 卡名退回節點標題的節點（軟耦合的可見化，不靜默）：宣告 `nameFrom:"input"` 但
   * 三個候選名鍵（`input`/`characterName`/`sceneName`）都沒值，因此卡名＝節點標題
   * （如「正面」而不是角色名）。卡照樣建出——只是讓「誰沒寫 input」在報表上看得見。
   */
  nameFallbacks: { nodeId: string; fallbackName: string }[];
}

/**
 * 邊界投影：`CanvasNode`（或其結構子集）→ 本檔的節點投影。
 * `CanvasNodeMetadata` 是 interface（無 index signature），直接賦值給
 * `Record<string, unknown>` 會被 TS 擋；這裡做一次（只讀、不回寫的）寬化。
 */
export function toAgentOutputNodeRef(node: {
  id: string;
  title?: string;
  metadata?: object | null;
}): AgentOutputNodeRef {
  return {
    id: node.id,
    ...(typeof node.title === "string" ? { title: node.title } : {}),
    metadata: node.metadata ? (node.metadata as Record<string, unknown>) : undefined,
  };
}

function isCharacterCardKind(value: unknown): value is CharacterCardKind {
  return typeof value === "string" && (CHARACTER_CARD_KIND_VALUES as readonly string[]).includes(value);
}

function trimTo(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 讀節點的實體宣告並清洗成合法 spec。
 * 不合法的一律 = **沒有宣告**（回 null），不做任何猜測：
 *   - `kind` 不在卡種類五值域 → null（亂填不會憑空生出卡）
 *   - `nameFrom` 非 `"input"` → `"nodeTitle"`（預設值，不是錯誤）
 */
export function emittedEntityOf(node: AgentOutputNodeRef): EmittedEntitySpec | null {
  const raw = node?.metadata?.[EMITS_ENTITY_KEY];
  if (!isRecord(raw)) return null;
  if (!isCharacterCardKind(raw.kind)) return null;
  return { kind: raw.kind, nameFrom: raw.nameFrom === "input" ? "input" : "nodeTitle" };
}

/** 控制字元（含 DEL）逐字元剔除——與 character-cards 的 `usableCardId` 同一條界線。 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * 節點 → 卡 id：決定性、合法、可重入。
 *   - `"card-node-" + nodeId`
 *   - `:` 全數換 `-`（`:` 是作用域層 share/mount 鍵的段分隔符，含它的 id 會被
 *     `normalizeCharacterCard` 的 `usableCardId` 整張拒收）
 *   - 控制字元剔除、截到 100 字元
 * 保證：`normalizeCharacterCard({ id: entityCardIdForNode(anyNodeId), name: "x" })` 非 null。
 */
export function entityCardIdForNode(nodeId: string): string {
  const raw = typeof nodeId === "string" ? nodeId : "";
  const cleaned = stripControlChars(raw).split(":").join("-");
  return `${ENTITY_CARD_ID_PREFIX}${cleaned}`.trim().slice(0, MAX_CARD_ID_LENGTH);
}

/** 交付圖判定：與 character-cards 的 `isUsableCardImageUrl` 同尺（http(s) / data:image）。 */
function usableImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  return clean.startsWith("http") || clean.startsWith("data:image/") ? clean : null;
}

/**
 * 音頻 URL 認得的副檔名（2026-09-24 收緊）。
 * 現場真例（grep 過的真交付 URL，全部帶副檔名）：
 *   - `deploy-staging/gateway/workflow-gw.ts`：TTS `${TTS_PUBLIC_BASE}/tts_<ts>_<rand>.mp3`
 *   - `src/lib/music-tools.ts` 上傳：`https://store.tinchak0207.xyz/image-data/files/uploads/music-gen-<ts>.<ext>`
 *     （mime → ext 映射：audio/mpeg→mp3、audio/wav→wav、audio/ogg→ogg、audio/mp4→m4a、
 *       audio/flac→flac；`generation-core/artifact-service.ts` 同映射）
 *   - Lyria inline：`data:audio/mpeg;base64,…`
 * 沒找到「無副檔名的音頻交付 URL」真例（公網直連與 signed URL 都帶 `.mp3` 之類結尾）。
 */
const AUDIO_URL_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac", ".webm"] as const;

/**
 * 音頻交付物判定（2026-09-24 收緊，不只 `startsWith("http")`）：
 *   - `data:audio/…` → 收；其他 `data:`（含 `data:image/png`）→ null
 *   - `http(s)://` 且**路徑**（先剝 `?query` / `#fragment`）落在音頻副檔名白名單 → 收
 *   - 其餘（`.png` 圖 URL、無副檔名裸 URL、本地路徑）→ null
 *     **不建空殼音頻卡**（舊版會把任何 http URL 當合法音頻交付，png 也照落一張空殼卡）。
 */
function usableAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  if (clean.startsWith("data:")) return clean.startsWith("data:audio/") ? clean : null;
  if (!clean.startsWith("http")) return null;
  const path = clean.split("#")[0].split("?")[0].toLowerCase();
  return AUDIO_URL_EXTENSIONS.some((ext) => path.endsWith(ext)) ? clean : null;
}

/**
 * kind → 參考圖角色（復用 `ReferenceImageRole`，不另立枚舉）。
 * `audio` 為 null：`CharacterCardReferenceImage` 只收圖片 URL，音頻卡的載體是 `prompt` 片段。
 * 用 `Record<CharacterCardKind, …>`＝型別上窮盡：卡種類若擴充而這裡沒跟上會編譯失敗，
 * 而不是靜默把新 kind 的圖當成 general。
 */
const KIND_REFERENCE_ROLE: Record<CharacterCardKind, ReferenceImageRole | null> = {
  character: "character",
  scene: "composition",
  prop: "product",
  style: "style",
  audio: null,
};

/** 卡名來源鍵（`nameFrom: "input"` 時按序取第一個非空字串）。 */
const NAME_FROM_INPUT_KEYS = ["input", "characterName", "sceneName"] as const;

function resolveCardName(node: AgentOutputNodeRef, spec: EmittedEntitySpec, metadata: Record<string, unknown>): string | null {
  if (spec.nameFrom === "input") {
    for (const key of NAME_FROM_INPUT_KEYS) {
      const name = trimTo(metadata[key], MAX_NAME_LENGTH);
      if (name) return name;
    }
  }
  // 退回節點標題；標題也沒有 → null（沒名字的卡沒有意義，不建）。
  return trimTo(node.title, MAX_NAME_LENGTH);
}

/**
 * `emitsEntity.referenceNodeIds`：閘道 `expandTemplate` 的參考圖 post-pass 解析後填入
 * （順序＝模板宣告的 `referenceRoles` 順序）。非字串/空字串剔除、去重、保序；
 * 缺席/非陣列 → 空（＝沒有兄弟參考圖，行為與舊版相同）。
 */
function referenceNodeIdsOf(node: AgentOutputNodeRef): string[] {
  const raw = node?.metadata?.[EMITS_ENTITY_KEY];
  if (!isRecord(raw)) return [];
  const list = raw.referenceNodeIds;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** `nameFrom:"input"` 的候選名鍵是否全空（＝卡名會退回節點標題）。 */
function hasInputName(metadata: Record<string, unknown>): boolean {
  return NAME_FROM_INPUT_KEYS.some((key) => trimTo(metadata[key], MAX_NAME_LENGTH));
}

/**
 * 參考圖集合：**自己的交付圖在前**，再按 `referenceNodeIds` 的順序收兄弟節點的交付圖。
 *   - 只收真的有交付圖（`usableImageUrl`）且在 `allNodes` 裡找得到的兄弟節點；
 *     缺席（尚未生成／失敗／別輪才到）→ 略過該張（**漸進聚合**：晚到的圖下一輪進 `updatedCards`）
 *   - url 去重（`normalizeCharacterCard` 也按 url 去重——不去重會讓 normalize 收窄輸出）
 *   - kind 無參考角色（audio）→ 空：音頻卡的載體是 `prompt` 片段，不塞圖片參考
 *   - 上限 8（與 `normalizeCharacterCard` 的 `MAX_CARD_REFERENCES` 同尺）
 */
function buildReferences(
  deliverable: string,
  role: ReferenceImageRole | null,
  cardName: string,
  referenceNodeIds: readonly string[],
  allNodes?: readonly AgentOutputNodeRef[],
): CharacterCardReferenceImage[] {
  if (!role) return [];
  const refs: CharacterCardReferenceImage[] = [
    { url: deliverable, role, name: cardName.slice(0, MAX_REFERENCE_NAME_LENGTH) },
  ];
  if (allNodes && referenceNodeIds.length) {
    const seen = new Set([deliverable]);
    for (const nodeId of referenceNodeIds) {
      const sibling = allNodes.find((candidate) => candidate && candidate.id === nodeId);
      if (!sibling) continue;
      const url = usableImageUrl((isRecord(sibling.metadata) ? sibling.metadata : {}).content);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      refs.push({
        url,
        role,
        // 名字用兄弟節點標題（例：「侧面」）；標題缺席 → 退回卡名（normalize 的 fallback 同值）
        name: trimTo(sibling.title, MAX_REFERENCE_NAME_LENGTH) ?? cardName.slice(0, MAX_REFERENCE_NAME_LENGTH),
      });
    }
  }
  return refs.slice(0, MAX_REFERENCES);
}

/**
 * 第三參數的相容拆解：`allNodes`（聚合用的兄弟節點清單）與落卡檔位 `options`。
 * 舊呼叫端把 `options` 放第三位（`cardFromEntityNode(node, existing, { mode })`），
 * 新呼叫端第三位放 `allNodes`、第四位放 `options`——兩者都收，既有呼叫端逐欄不變。
 */
function splitCardArgs(
  third?: readonly AgentOutputNodeRef[] | EntityCardGateOptions,
  fourth?: EntityCardGateOptions,
): { allNodes?: readonly AgentOutputNodeRef[]; options?: EntityCardGateOptions } {
  if (Array.isArray(third)) return { allNodes: third, options: fourth };
  return { allNodes: undefined, options: third as EntityCardGateOptions | undefined };
}

/**
 * 節點交付 → 一張實體卡（**不含**「已存在就 null」的冪等閘；那條在 `cardFromEntityNode`／
 * `emittedCardsForNodes` 的呼叫端判）。任何一項不成立就回 null（**絕不建空卡/半形卡**）：
 *   1. 沒有交付物（圖像類 kind 要可用圖片 URL；audio 要可用音頻 URL〔辨副檔名〕）
 *   2. 取不到名字
 * `inherit.createdAt` 供漸進更新沿用既有卡的建立時間。
 * 回傳物件**逐欄等於** `normalizeCharacterCard(該物件)`（測試釘死）：
 * 欄位不多不少、prompt 已 trim+截斷、參考圖 url 已去重、參考圖名 ≤60。
 */
function buildEntityCard(
  node: AgentOutputNodeRef,
  spec: EmittedEntitySpec,
  allNodes?: readonly AgentOutputNodeRef[],
  options?: EntityCardGateOptions,
  inherit?: { createdAt: string },
): CharacterCard | null {
  const metadata = isRecord(node.metadata) ? node.metadata : {};
  const deliverable = spec.kind === "audio" ? usableAudioUrl(metadata.content) : usableImageUrl(metadata.content);
  if (!deliverable) return null;

  const name = resolveCardName(node, spec, metadata);
  if (!name) return null;

  const prompt =
    trimTo(metadata.deliverable, MAX_PROMPT_LENGTH) ??
    trimTo(metadata.dna, MAX_PROMPT_LENGTH) ??
    trimTo(metadata.signature, MAX_PROMPT_LENGTH) ??
    "";
  const role = KIND_REFERENCE_ROLE[spec.kind];
  const now = new Date().toISOString();
  const approval = initialApproval(options?.mode);
  return {
    id: entityCardIdForNode(node.id),
    name,
    kind: spec.kind,
    prompt,
    references: buildReferences(deliverable, role, name, referenceNodeIdsOf(node), allNodes),
    ...(approval ? { approval } : {}),
    createdAt: inherit?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * 節點交付 → 一張實體卡。任何一項不成立就回 null（**絕不建空卡/半形卡**）：
 *   1. 沒有合法實體宣告
 *   2. 沒有交付物（圖像類 kind 要可用圖片 URL；audio 要可用音頻 URL）
 *   3. `existing` 已有同 id（冪等：決定性 id 一撞即已建）
 *   4. 取不到名字
 * `allNodes`（可選，第三參數）：同批節點清單 —— 有它才收
 * `emitsEntity.referenceNodeIds` 指向的兄弟交付圖（四視圖聚合）；**不傳＝只有自己那張圖
 * （與舊版逐位元相同）**。第三參數收 `options` 的舊呼叫形式仍支援（見 `splitCardArgs`）。
 */
export function cardFromEntityNode(
  node: AgentOutputNodeRef,
  existing: readonly CharacterCard[],
  allNodes?: readonly AgentOutputNodeRef[] | EntityCardGateOptions,
  options?: EntityCardGateOptions,
): CharacterCard | null {
  const spec = emittedEntityOf(node);
  if (!spec) return null;
  if (!node || typeof node.id !== "string" || !node.id) return null;
  const id = entityCardIdForNode(node.id);
  if (existing.some((card) => card && card.id === id)) return null;
  const { allNodes: siblings, options: gate } = splitCardArgs(allNodes, options);
  return buildEntityCard(node, spec, siblings, gate);
}

/** 分鏡節點的三條卡引用欄（鍵名對齊 `storyboard_qc_17` 門禁欄名）。 */
const SHOT_ENTITY_FIELDS: readonly { kind: CharacterCardKind; field: keyof ShotEntityBackfill }[] = [
  { kind: "character", field: "characterCardIds" },
  { kind: "scene", field: "sceneCardIds" },
  { kind: "prop", field: "propCardIds" },
];

/** 已落卡標記：`metadata.entityCardId` 非空字串＝這顆節點建過卡（跳過，不再建）。 */
function markedEntityCardId(node: AgentOutputNodeRef): string | null {
  const value = node?.metadata?.[ENTITY_CARD_ID_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 分鏡節點判準（現場真源，grep 實證）：`metadata.storyboardShot.shotNumber` 非空。
 * 出處：src/lib/storyboard-contract.ts（AID 21 欄契約，`shotNumber` 為該實體唯一鍵）
 *   - `normalizeStoryboardShot`：`shotNumber` 空即整包丟棄
 *   - `storyboardQcShots`：`node?.metadata?.storyboardShot?.shotNumber` 無鏡號者不歸屬任一鏡
 * 畫布節點**沒有** `metadata.shotNumber` 這個扁平欄位（types.ts 的
 * `CanvasNodeMetadata` 無此鍵）→ 不臆造第二種判準。
 */
function shotNumberOf(node: AgentOutputNodeRef): string | null {
  const shot = node?.metadata?.storyboardShot;
  if (!isRecord(shot)) return null;
  return trimTo(shot.shotNumber, 16);
}

/** 該欄已有可用值（非空陣列、且至少一個非空字串）＝人工/上游已指定。 */
function hasFilledCardIds(metadata: Record<string, unknown>, field: keyof ShotEntityBackfill): boolean {
  const value = metadata[field];
  return Array.isArray(value) && value.some((id) => typeof id === "string" && id.trim().length > 0);
}

/**
 * 分鏡**已用名稱指定**了哪些 kind 的資產（現場的人工指定機制就是它）：
 * `metadata.storyboardShot.referenceAssets`（AID 格式 `場景:[A] 角色:[B] 道具:[C]`，
 * 解析器復用 storyboard-contract 的 `parseReferenceAssets`，不另造）。
 * 該 kind 名稱清單非空 → 後續不再用自動落卡的 id 覆蓋它（人工指定者優先）。
 */
function namedKindsInShot(node: AgentOutputNodeRef): Set<CharacterCardKind> {
  const out = new Set<CharacterCardKind>();
  const shot = node?.metadata?.storyboardShot;
  if (!isRecord(shot)) return out;
  const text = shot.referenceAssets;
  if (typeof text !== "string" || !text.trim()) return out;
  const parsed = parseReferenceAssets(text);
  if (parsed.character.length) out.add("character");
  if (parsed.scene.length) out.add("scene");
  if (parsed.prop.length) out.add("prop");
  return out;
}

/**
 * 分鏡引用回填（④）：
 *   - 分鏡節點＝`metadata.storyboardShot.shotNumber` 非空
 *   - 該欄已有人工/上游指定（`characterCardIds`/`sceneCardIds`/`propCardIds` 非空，
 *     或 `storyboardShot.referenceAssets` 已按名稱點名該 kind）→ **不動它**
 *   - 否則填同 kind 的**自動落成卡** id；一條都填不進去 → 該鏡不進清單
 * 值與現況相同就不產生（`hasFilledCardIds` 已把「已有值」整條擋掉）——呼叫端因此
 * 不會為同一顆節點反覆產生 patch（歷史噪音零）。
 * 無自動落成的卡 ⇒ 回填空清單（呼叫端不因此產生任何寫入）。
 */
function collectShotBackfill(
  nodes: readonly AgentOutputNodeRef[],
  entityIdsByKind: ReadonlyMap<CharacterCardKind, readonly string[]>,
): ShotEntityBackfill[] {
  const out: ShotEntityBackfill[] = [];
  for (const node of nodes) {
    if (!node || !shotNumberOf(node)) continue;
    const metadata = isRecord(node.metadata) ? node.metadata : {};
    const named = namedKindsInShot(node);
    const entry: ShotEntityBackfill = { nodeId: node.id };
    let filled = false;
    for (const { kind, field } of SHOT_ENTITY_FIELDS) {
      if (named.has(kind)) continue;
      if (hasFilledCardIds(metadata, field)) continue;
      const ids = entityIdsByKind.get(kind);
      if (!ids || ids.length === 0) continue;
      if (field === "characterCardIds") entry.characterCardIds = [...ids];
      else if (field === "sceneCardIds") entry.sceneCardIds = [...ids];
      else entry.propCardIds = [...ids];
      filled = true;
    }
    if (filled) out.push(entry);
  }
  return out;
}

/**
 * 自動落成的卡：id 帶 `ENTITY_CARD_ID_PREFIX`（決定性推導，`entityCardIdForNode` 產出）。
 * 使用者手建的卡（無前綴）**一律不進回填來源**——這是刻意的邊界：自動流程只碰自己造的東西。
 */
function autoEmittedCards(cards: readonly CharacterCard[]): CharacterCard[] {
  return cards.filter((card) => !!card && typeof card.id === "string" && card.id.startsWith(ENTITY_CARD_ID_PREFIX));
}

/** kind → 卡 id 清單（保留輸入順序，不重複）。 */
function idsByKind(cards: readonly CharacterCard[]): Map<CharacterCardKind, string[]> {
  const out = new Map<CharacterCardKind, string[]>();
  for (const card of cards) {
    const bucket = out.get(card.kind);
    if (bucket) bucket.push(card.id);
    else out.set(card.kind, [card.id]);
  }
  return out;
}

/** 參考圖 url 集合是否相同（順序無關；長度 ＋ 逐一包含）。 */
function sameUrlSet(
  left: readonly CharacterCardReferenceImage[],
  right: readonly CharacterCardReferenceImage[],
): boolean {
  if (left.length !== right.length) return false;
  const urls = new Set(right.map((ref) => ref?.url));
  return left.every((ref) => urls.has(ref?.url));
}

/**
 * 遍歷節點集合 → 要新建的卡 / 要更新的卡 / 要鎖定的 id / 要回填的分鏡引用。
 * **冪等**：
 *   - 同決定性 id 的卡已在 `existing` → 不建卡；只有參考圖 url 集合真的變了才進 `updatedCards`
 *     （兄弟圖晚到的漸進聚合走這條；重跑第二輪 → `cards`/`updatedCards` 皆空）
 *   - `metadata.entityCardId` 已存在且卡不在 `existing` 裡 → 視為已建，跳過
 * 聚合（2026-09-24）：標記節點的 `emitsEntity.referenceNodeIds` 指向的兄弟交付圖併進同一張卡。
 *
 * 回填來源＝**自動落成的卡**（`existing` 裡帶前綴的 ＋ 本輪新建的），不是「本輪新建」——
 * 卡已存在但分鏡缺引用時仍要回填（否則回填只在建卡那一輪有效，重載即失效）。
 * 收斂：第二輪同樣輸入 → 分鏡節點已帶引用 → backfill 為空（不再產生 patch）。
 */
export function emittedCardsForNodes(
  nodes: readonly AgentOutputNodeRef[],
  existing: readonly CharacterCard[],
  options?: EntityCardGateOptions,
): EmittedCardsResult {
  const known: CharacterCard[] = [...existing];
  const cards: CharacterCard[] = [];
  const updatedCards: CharacterCard[] = [];
  const nameFallbacks: { nodeId: string; fallbackName: string }[] = [];
  const updatedIds = new Set<string>();
  const fallbackIds = new Set<string>();
  for (const node of nodes ?? []) {
    if (!node || typeof node.id !== "string" || !node.id) continue;
    const spec = emittedEntityOf(node);
    if (!spec) continue;
    const metadata = isRecord(node.metadata) ? node.metadata : {};
    const id = entityCardIdForNode(node.id);
    const existingCard = known.find((card) => card && card.id === id);

    // 漸進聚合：卡已存在 → 用當下節點重算期望參考圖；url 集合不同才進 updatedCards。
    // 重算價值只在「節點還有交付物」時成立：圖被清空/失敗不該把既有參考圖抹掉。
    if (existingCard) {
      const expected = buildEntityCard(node, spec, nodes, undefined, { createdAt: existingCard.createdAt });
      if (!expected) continue;
      if (spec.nameFrom === "input" && !hasInputName(metadata)) {
        if (!fallbackIds.has(node.id)) {
          fallbackIds.add(node.id);
          nameFallbacks.push({ nodeId: node.id, fallbackName: expected.name });
        }
      }
      if (!sameUrlSet(expected.references, existingCard.references) && !updatedIds.has(id)) {
        updatedIds.add(id);
        updatedCards.push({
          ...expected,
          ...(existingCard.approval ? { approval: existingCard.approval } : {}),
        });
      }
      continue;
    }

    if (markedEntityCardId(node)) continue;
    const card = buildEntityCard(node, spec, nodes, options);
    if (!card) continue;
    // 軟耦合的可見化：卡名退回節點標題時記一筆（卡照樣建出，只是不靜默）
    if (spec.nameFrom === "input" && !hasInputName(metadata)) {
      if (!fallbackIds.has(node.id)) {
        fallbackIds.add(node.id);
        nameFallbacks.push({ nodeId: node.id, fallbackName: card.name });
      }
    }
    cards.push(card);
    known.push(card);
  }
  // 已存在的自動落成卡 ＋ 本輪新建者（新建卡 id 必帶前綴，且必不在 existing 裡 → 無重複）。
  const entityIdsByKind = idsByKind(autoEmittedCards(known));
  return {
    cards,
    updatedCards,
    lockedIds: cards.map((card) => card.id),
    shotBackfill: entityIdsByKind.size ? collectShotBackfill(nodes, entityIdsByKind) : [],
    nameFallbacks,
  };
}