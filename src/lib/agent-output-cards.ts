// 模板节点交付 → 实体卡自动落卡（2026-09-24）：纯逻辑层，零副作用、不做 I/O。
//
// 断点：agent 跑完 `character_sheet`/`scene_setup`/… 模板产出角色四视图、场景图之后，
// 那批资产**没有卡实体**（src/lib/character-cards.ts 的 CharacterCard）→ 因此不会
// 出现在素材池里等人 `@` 引用，下一步得手动补。本档把「模板节点的交付物」判成
// 「可被 @ 引用的实体卡」。
//
// 资料来源（工作流定义层宣告，零引擎改动）：模板节点的 `defaults.emitsEntity`
//   { kind: CharacterCardKind; nameFrom?: "nodeTitle" | "input" }
// 由 `expandTemplate` spread 进节点 metadata（deploy-staging/gateway/workflow-engine.ts
// 的 `filled` 合并）→ 随 SSE `canvas.node.created/updated` 抵达画布 → 本档消费。
//
// 本档只做四件事：
//   1. `emittedEntityOf`：清洗节点上的实体宣告（不合法 = 没有宣告，不猜）
//   2. `entityCardIdForNode`：决定性 + 合法（过得了 `normalizeCharacterCard` 的 id 界线）
//      → 同节点重入必得同 id，这是幂等的根
//   3. `cardFromEntityNode`：**有交付物才建卡**（没图/没文本 → null，绝不建空卡）
//   4. `emittedCardsForNodes`：批量产出「要新建的卡 / 要锁定的 id / 要回填的分镜引用」
//      （回填来源＝**自动落成的卡**，不只本轮新建——见该函式注解：这是耐久的根）
//
// 2026-09-24 增补（决策 2/23）：落卡可带 `options.mode`（`AgentInteractionMode`）——
// 协作档落的卡 `pending`（等人过资产确认闸），全自动两档落的卡 `approved`（不停：护城河）。
// **未给 mode → 一个栏位都不多写**（既有呼叫端输出逐栏不变）。本档不做「未批准就不回填」：
// 回填是储存层的候选绑定，生效层由 `storyboard-contract.ts` 的批准闸把关。
//
// 边界（诚实标记，不假装做了）：
//   - 四视图聚合（2026-09-24 本刀）：`emitsEntity.referenceRoles` → 闸道
//     `expandTemplate` 解析成 `emitsEntity.referenceNodeIds` → 本档把它收进**同一张卡**的
//     `references`（自己的交付图在前，再按 referenceNodeIds 顺序收兄弟节点的交付图）。
//     跨档链路已验（真 `expandTemplate` → 真 `compactMetadataForAgent`/`toNodeMetadata`
//     两处白名单 → 真 `emittedCardsForNodes`，见测试「四视图只落一张角色卡」那条逐键全等断言）：
//     `layout.cleanEmitsEntity` 已放行 `referenceRoles`/`referenceNodeIds` 两键。
//   - `updatedCards` 只比**参考图 url 集合**：名称/prompt/批准状态不是本轮焦点，
//     一律沿用既有卡（避免用重算把人的 `rejected` 决策洗回 pending）。
//   - 本档不 import `canvas/types`：结构相容即可，测试能直接喂假物件。
//     边界投影用 `toAgentOutputNodeRef`（CanvasNodeMetadata 是 interface，无
//     index signature，无法直接赋值给 `Record<string, unknown>`）。

import { CHARACTER_CARD_KIND_VALUES } from "./character-cards";
import type { ApprovalState, CharacterCard, CharacterCardKind, CharacterCardReferenceImage } from "./character-cards";
import type { AgentInteractionMode } from "./agent-chat-client";
import type { ReferenceImageRole } from "./image-types";
import { parseReferenceAssets } from "./storyboard-contract";

/** 节点 metadata 上的实体宣告键（模板 defaults 的保留键，与 gateway types.ts 同步）。 */
export const EMITS_ENTITY_KEY = "emitsEntity";
/** 节点 metadata 上的「已落卡」标记键（幂等：已标记者不重复建卡）。 */
export const ENTITY_CARD_ID_KEY = "entityCardId";

/** 卡 id 前缀：落卡节点与人手建卡在 id 上可区分（决定性推导，非随机）。
 *  `entityCardIdForNode` 的唯一前缀；回填只认这批卡（使用者手建的卡一个都不动）。 */
export const ENTITY_CARD_ID_PREFIX = "card-node-";

/** 与 character-cards.ts 的边界同级（id ≤100、name ≤100、prompt ≤2000、参考图名 ≤60）。 */
const MAX_CARD_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_PROMPT_LENGTH = 2000;
const MAX_REFERENCE_NAME_LENGTH = 60;
/** 与 character-cards.ts 的 `MAX_CARD_REFERENCES` 同尺（8）：normalize 会 slice 到 8，
 *  本档不设同一道限 → 逐栏相等断言会失真（聚合后最多 1+7 张）。 */
const MAX_REFERENCES = 8;

export interface EmittedEntitySpec {
  kind: CharacterCardKind;
  nameFrom: "nodeTitle" | "input";
}

/**
 * 落卡时的档位选项（2026-09-24 决策 2/23）。**只决定新卡的初始 `approval`**，不动其余任何栏位。
 */
export interface EntityCardGateOptions {
  /**
   * 互动档位（型别真源 `AgentInteractionMode`，`src/lib/agent-chat-client.ts:749`）：
   *   - `"collaborate"` → 落的卡 `pending`（等人过资产确认闸；决策 1/3）
   *   - `preset` / `auto` → `approved`（全自动档一键跑完，资产卡不得让它停：护城河）
   *   - **未给** → 不写 `approval` 栏位（＝缺省＝已批准）：既有呼叫端的输出逐栏不变。
   */
  mode?: AgentInteractionMode;
}

/**
 * 档位 → 新卡的初始批准状态。
 * 只有 `"collaborate"` 落 `pending`：其余（含未给 mode）的「已批准」写成显式 `approved`
 * 只在呼叫端真的有给 mode 时才写——未给 mode 的呼叫端（既有路径）输出键一个不多。
 * 刻意**不填 `decidedAt`**：自动落卡不是人的决策时间，填了就是假造审计迹。
 */
function initialApproval(mode?: AgentInteractionMode): ApprovalState | undefined {
  if (!mode) return undefined;
  return { status: mode === "collaborate" ? "pending" : "approved" };
}

/**
 * 本档消费的节点投影（结构子集，不依赖 canvas/types）。
 * `metadata` 是不透明袋子：只读宣告键与交付物栏位。
 */
export interface AgentOutputNodeRef {
  id: string;
  title?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * 一条需要回填的分镜节点引用（键名 = `storyboard_qc_17` 门禁的卡引用栏名，
 * 见 src/lib/storyboard-contract.ts：`characterCardIds`/`sceneCardIds`）。
 * `propCardIds` 在本站门禁没有对应栏位（诚实标记：先填，等消费端接）。
 */
export interface ShotEntityBackfill {
  nodeId: string;
  characterCardIds?: string[];
  sceneCardIds?: string[];
  propCardIds?: string[];
}

export interface EmittedCardsResult {
  /** 需要新建的卡（已存在者不重复；呼叫端逐张 upsert）。 */
  cards: CharacterCard[];
  /**
   * 既有卡但参考图集合与现况不符 → 需就地更新的卡（2026-09-24 四视图聚合）。
   * 聚合是**渐进**的：view1 的图先生成、view2/3/4 晚到 → 兄弟图到齐那几轮才更新。
   * 判准＝同决定性 id 的既有卡，用当下节点重算期望 `references`，与既有卡的
   * **url 集合**（顺序无关）不同才进；相同不回（跑两次第二次为空＝幂等）。
   * 内容＝重算后的卡（`createdAt` 沿用既有的、既有卡的 `approval` 原样保留——
   * 重算不得把人的 `rejected` 决策洗掉）。
   */
  updatedCards: CharacterCard[];
  /** 需要锁进项目 cardIds 的 id（＝本轮新建卡的 id，让它们自动生效）。 */
  lockedIds: string[];
  /**
   * 需要回填分镜节点引用的清单。
   * 判准是「**自动落成的卡**存在且该分镜节点缺引用」——不是「本轮有新建卡」：
   * 卡上次已落、这轮 `cards` 为空，但引用还没写进节点（刷新在中途、旧版通道丢栏）
   * 时仍要回填，否则分镜节点永远拿不到卡引用（本档耐久性的根）。
   * 没有自动落成的卡 → 空（不臆造）。
   */
  shotBackfill: ShotEntityBackfill[];
  /**
   * 卡名退回节点标题的节点（软耦合的可见化，不静默）：宣告 `nameFrom:"input"` 但
   * 三个候选名键（`input`/`characterName`/`sceneName`）都没值，因此卡名＝节点标题
   * （如「正面」而不是角色名）。卡照样建出——只是让「谁没写 input」在报表上看得见。
   */
  nameFallbacks: { nodeId: string; fallbackName: string }[];
}

/**
 * 边界投影：`CanvasNode`（或其结构子集）→ 本档的节点投影。
 * `CanvasNodeMetadata` 是 interface（无 index signature），直接赋值给
 * `Record<string, unknown>` 会被 TS 挡；这里做一次（只读、不回写的）宽化。
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
 * 读节点的实体宣告并清洗成合法 spec。
 * 不合法的一律 = **没有宣告**（回 null），不做任何猜测：
 *   - `kind` 不在卡种类五值域 → null（乱填不会凭空生出卡）
 *   - `nameFrom` 非 `"input"` → `"nodeTitle"`（预设值，不是错误）
 */
export function emittedEntityOf(node: AgentOutputNodeRef): EmittedEntitySpec | null {
  const raw = node?.metadata?.[EMITS_ENTITY_KEY];
  if (!isRecord(raw)) return null;
  if (!isCharacterCardKind(raw.kind)) return null;
  return { kind: raw.kind, nameFrom: raw.nameFrom === "input" ? "input" : "nodeTitle" };
}

/** 控制字元（含 DEL）逐字元剔除——与 character-cards 的 `usableCardId` 同一条界线。 */
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
 * 节点 → 卡 id：决定性、合法、可重入。
 *   - `"card-node-" + nodeId`
 *   - `:` 全数换 `-`（`:` 是作用域层 share/mount 键的段分隔符，含它的 id 会被
 *     `normalizeCharacterCard` 的 `usableCardId` 整张拒收）
 *   - 控制字元剔除、截到 100 字元
 * 保证：`normalizeCharacterCard({ id: entityCardIdForNode(anyNodeId), name: "x" })` 非 null。
 */
export function entityCardIdForNode(nodeId: string): string {
  const raw = typeof nodeId === "string" ? nodeId : "";
  const cleaned = stripControlChars(raw).split(":").join("-");
  return `${ENTITY_CARD_ID_PREFIX}${cleaned}`.trim().slice(0, MAX_CARD_ID_LENGTH);
}

/** 交付图判定：与 character-cards 的 `isUsableCardImageUrl` 同尺（http(s) / data:image）。 */
function usableImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  return clean.startsWith("http") || clean.startsWith("data:image/") ? clean : null;
}

/**
 * 音频 URL 认得的副档名（2026-09-24 收紧）。
 * 现场真例（grep 过的真交付 URL，全部带副档名）：
 *   - `deploy-staging/gateway/workflow-gw.ts`：TTS `${TTS_PUBLIC_BASE}/tts_<ts>_<rand>.mp3`
 *   - `src/lib/music-tools.ts` 上传：`https://store.eimu.dev/image-data/files/uploads/music-gen-<ts>.<ext>`
 *     （mime → ext 映射：audio/mpeg→mp3、audio/wav→wav、audio/ogg→ogg、audio/mp4→m4a、
 *       audio/flac→flac；`generation-core/artifact-service.ts` 同映射）
 *   - Lyria inline：`data:audio/mpeg;base64,…`
 * 没找到「无副档名的音频交付 URL」真例（公网直连与 signed URL 都带 `.mp3` 之类结尾）。
 */
const AUDIO_URL_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac", ".webm"] as const;

/**
 * 音频交付物判定（2026-09-24 收紧，不只 `startsWith("http")`）：
 *   - `data:audio/…` → 收；其他 `data:`（含 `data:image/png`）→ null
 *   - `http(s)://` 且**路径**（先剥 `?query` / `#fragment`）落在音频副档名白名单 → 收
 *   - 其余（`.png` 图 URL、无副档名裸 URL、本地路径）→ null
 *     **不建空壳音频卡**（旧版会把任何 http URL 当合法音频交付，png 也照落一张空壳卡）。
 *
 * 导出原因（2026-09-30）：分镜音轨绑定（`canvas/storyboard-shots.ts` 的
 * `bindShotAudioTrack`）必须走**同一把尺**——音频可用性判准只准一份，否则
 * 「音频副档名白名单」会出现第二个漂移点（禁造轮子）。
 */
export function usableAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  if (clean.startsWith("data:")) return clean.startsWith("data:audio/") ? clean : null;
  if (!clean.startsWith("http")) return null;
  const path = clean.split("#")[0].split("?")[0].toLowerCase();
  return AUDIO_URL_EXTENSIONS.some((ext) => path.endsWith(ext)) ? clean : null;
}

/**
 * kind → 参考图角色（复用 `ReferenceImageRole`，不另立枚举）。
 * `audio` 为 null：`CharacterCardReferenceImage` 只收图片 URL，音频卡的载体是 `prompt` 片段。
 * 用 `Record<CharacterCardKind, …>`＝型别上穷尽：卡种类若扩充而这里没跟上会编译失败，
 * 而不是静默把新 kind 的图当成 general。
 */
const KIND_REFERENCE_ROLE: Record<CharacterCardKind, ReferenceImageRole | null> = {
  character: "character",
  scene: "composition",
  prop: "product",
  style: "style",
  audio: null,
};

/** 卡名来源键（`nameFrom: "input"` 时按序取第一个非空字串）。 */
const NAME_FROM_INPUT_KEYS = ["input", "characterName", "sceneName"] as const;

function resolveCardName(node: AgentOutputNodeRef, spec: EmittedEntitySpec, metadata: Record<string, unknown>): string | null {
  if (spec.nameFrom === "input") {
    for (const key of NAME_FROM_INPUT_KEYS) {
      const name = trimTo(metadata[key], MAX_NAME_LENGTH);
      if (name) return name;
    }
  }
  // 退回节点标题；标题也没有 → null（没名字的卡没有意义，不建）。
  return trimTo(node.title, MAX_NAME_LENGTH);
}

/**
 * `emitsEntity.referenceNodeIds`：闸道 `expandTemplate` 的参考图 post-pass 解析后填入
 * （顺序＝模板宣告的 `referenceRoles` 顺序）。非字串/空字串剔除、去重、保序；
 * 缺席/非阵列 → 空（＝没有兄弟参考图，行为与旧版相同）。
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

/** `nameFrom:"input"` 的候选名键是否全空（＝卡名会退回节点标题）。 */
function hasInputName(metadata: Record<string, unknown>): boolean {
  return NAME_FROM_INPUT_KEYS.some((key) => trimTo(metadata[key], MAX_NAME_LENGTH));
}

/**
 * 参考图集合：**自己的交付图在前**，再按 `referenceNodeIds` 的顺序收兄弟节点的交付图。
 *   - 只收真的有交付图（`usableImageUrl`）且在 `allNodes` 里找得到的兄弟节点；
 *     缺席（尚未生成／失败／别轮才到）→ 略过该张（**渐进聚合**：晚到的图下一轮进 `updatedCards`）
 *   - url 去重（`normalizeCharacterCard` 也按 url 去重——不去重会让 normalize 收窄输出）
 *   - kind 无参考角色（audio）→ 空：音频卡的载体是 `prompt` 片段，不塞图片参考
 *   - 上限 8（与 `normalizeCharacterCard` 的 `MAX_CARD_REFERENCES` 同尺）
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
        // 名字用兄弟节点标题（例：「侧面」）；标题缺席 → 退回卡名（normalize 的 fallback 同值）
        name: trimTo(sibling.title, MAX_REFERENCE_NAME_LENGTH) ?? cardName.slice(0, MAX_REFERENCE_NAME_LENGTH),
      });
    }
  }
  return refs.slice(0, MAX_REFERENCES);
}

/**
 * 第三参数的相容拆解：`allNodes`（聚合用的兄弟节点清单）与落卡档位 `options`。
 * 旧呼叫端把 `options` 放第三位（`cardFromEntityNode(node, existing, { mode })`），
 * 新呼叫端第三位放 `allNodes`、第四位放 `options`——两者都收，既有呼叫端逐栏不变。
 */
function splitCardArgs(
  third?: readonly AgentOutputNodeRef[] | EntityCardGateOptions,
  fourth?: EntityCardGateOptions,
): { allNodes?: readonly AgentOutputNodeRef[]; options?: EntityCardGateOptions } {
  if (Array.isArray(third)) return { allNodes: third, options: fourth };
  return { allNodes: undefined, options: third as EntityCardGateOptions | undefined };
}

/**
 * 节点交付 → 一张实体卡（**不含**「已存在就 null」的幂等闸；那条在 `cardFromEntityNode`／
 * `emittedCardsForNodes` 的呼叫端判）。任何一项不成立就回 null（**绝不建空卡/半形卡**）：
 *   1. 没有交付物（图像类 kind 要可用图片 URL；audio 要可用音频 URL〔辨副档名〕）
 *   2. 取不到名字
 * `inherit.createdAt` 供渐进更新沿用既有卡的建立时间。
 * 回传物件**逐栏等于** `normalizeCharacterCard(该物件)`（测试钉死）：
 * 栏位不多不少、prompt 已 trim+截断、参考图 url 已去重、参考图名 ≤60。
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
 * 节点交付 → 一张实体卡。任何一项不成立就回 null（**绝不建空卡/半形卡**）：
 *   1. 没有合法实体宣告
 *   2. 没有交付物（图像类 kind 要可用图片 URL；audio 要可用音频 URL）
 *   3. `existing` 已有同 id（幂等：决定性 id 一撞即已建）
 *   4. 取不到名字
 * `allNodes`（可选，第三参数）：同批节点清单 —— 有它才收
 * `emitsEntity.referenceNodeIds` 指向的兄弟交付图（四视图聚合）；**不传＝只有自己那张图
 * （与旧版逐位元相同）**。第三参数收 `options` 的旧呼叫形式仍支援（见 `splitCardArgs`）。
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

/** 分镜节点的三条卡引用栏（键名对齐 `storyboard_qc_17` 门禁栏名）。 */
const SHOT_ENTITY_FIELDS: readonly { kind: CharacterCardKind; field: keyof ShotEntityBackfill }[] = [
  { kind: "character", field: "characterCardIds" },
  { kind: "scene", field: "sceneCardIds" },
  { kind: "prop", field: "propCardIds" },
];

/** 已落卡标记：`metadata.entityCardId` 非空字串＝这颗节点建过卡（跳过，不再建）。 */
function markedEntityCardId(node: AgentOutputNodeRef): string | null {
  const value = node?.metadata?.[ENTITY_CARD_ID_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 分镜节点判准（现场真源，grep 实证）：`metadata.storyboardShot.shotNumber` 非空。
 * 出处：src/lib/storyboard-contract.ts（AID 21 栏契约，`shotNumber` 为该实体唯一键）
 *   - `normalizeStoryboardShot`：`shotNumber` 空即整包丢弃
 *   - `storyboardQcShots`：`node?.metadata?.storyboardShot?.shotNumber` 无镜号者不归属任一镜
 * 画布节点**没有** `metadata.shotNumber` 这个扁平栏位（types.ts 的
 * `CanvasNodeMetadata` 无此键）→ 不臆造第二种判准。
 */
function shotNumberOf(node: AgentOutputNodeRef): string | null {
  const shot = node?.metadata?.storyboardShot;
  if (!isRecord(shot)) return null;
  return trimTo(shot.shotNumber, 16);
}

/** 该栏已有可用值（非空阵列、且至少一个非空字串）＝人工/上游已指定。 */
function hasFilledCardIds(metadata: Record<string, unknown>, field: keyof ShotEntityBackfill): boolean {
  const value = metadata[field];
  return Array.isArray(value) && value.some((id) => typeof id === "string" && id.trim().length > 0);
}

/**
 * 分镜**已用名称指定**了哪些 kind 的资产（现场的人工指定机制就是它）：
 * `metadata.storyboardShot.referenceAssets`（AID 格式 `场景:[A] 角色:[B] 道具:[C]`，
 * 解析器复用 storyboard-contract 的 `parseReferenceAssets`，不另造）。
 * 该 kind 名称清单非空 → 后续不再用自动落卡的 id 覆盖它（人工指定者优先）。
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
 * 分镜引用回填（④）：
 *   - 分镜节点＝`metadata.storyboardShot.shotNumber` 非空
 *   - 该栏已有人工/上游指定（`characterCardIds`/`sceneCardIds`/`propCardIds` 非空，
 *     或 `storyboardShot.referenceAssets` 已按名称点名该 kind）→ **不动它**
 *   - 否则填同 kind 的**自动落成卡** id；一条都填不进去 → 该镜不进清单
 * 值与现况相同就不产生（`hasFilledCardIds` 已把「已有值」整条挡掉）——呼叫端因此
 * 不会为同一颗节点反覆产生 patch（历史噪音零）。
 * 无自动落成的卡 ⇒ 回填空清单（呼叫端不因此产生任何写入）。
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
 * 自动落成的卡：id 带 `ENTITY_CARD_ID_PREFIX`（决定性推导，`entityCardIdForNode` 产出）。
 * 使用者手建的卡（无前缀）**一律不进回填来源**——这是刻意的边界：自动流程只碰自己造的东西。
 */
function autoEmittedCards(cards: readonly CharacterCard[]): CharacterCard[] {
  return cards.filter((card) => !!card && typeof card.id === "string" && card.id.startsWith(ENTITY_CARD_ID_PREFIX));
}

/** kind → 卡 id 清单（保留输入顺序，不重复）。 */
function idsByKind(cards: readonly CharacterCard[]): Map<CharacterCardKind, string[]> {
  const out = new Map<CharacterCardKind, string[]>();
  for (const card of cards) {
    const bucket = out.get(card.kind);
    if (bucket) bucket.push(card.id);
    else out.set(card.kind, [card.id]);
  }
  return out;
}

/** 参考图 url 集合是否相同（顺序无关；长度 ＋ 逐一包含）。 */
function sameUrlSet(
  left: readonly CharacterCardReferenceImage[],
  right: readonly CharacterCardReferenceImage[],
): boolean {
  if (left.length !== right.length) return false;
  const urls = new Set(right.map((ref) => ref?.url));
  return left.every((ref) => urls.has(ref?.url));
}

/**
 * 遍历节点集合 → 要新建的卡 / 要更新的卡 / 要锁定的 id / 要回填的分镜引用。
 * **幂等**：
 *   - 同决定性 id 的卡已在 `existing` → 不建卡；只有参考图 url 集合真的变了才进 `updatedCards`
 *     （兄弟图晚到的渐进聚合走这条；重跑第二轮 → `cards`/`updatedCards` 皆空）
 *   - `metadata.entityCardId` 已存在且卡不在 `existing` 里 → 视为已建，跳过
 * 聚合（2026-09-24）：标记节点的 `emitsEntity.referenceNodeIds` 指向的兄弟交付图并进同一张卡。
 *
 * 回填来源＝**自动落成的卡**（`existing` 里带前缀的 ＋ 本轮新建的），不是「本轮新建」——
 * 卡已存在但分镜缺引用时仍要回填（否则回填只在建卡那一轮有效，重载即失效）。
 * 收敛：第二轮同样输入 → 分镜节点已带引用 → backfill 为空（不再产生 patch）。
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

    // 渐进聚合：卡已存在 → 用当下节点重算期望参考图；url 集合不同才进 updatedCards。
    // 重算价值只在「节点还有交付物」时成立：图被清空/失败不该把既有参考图抹掉。
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
    // 软耦合的可见化：卡名退回节点标题时记一笔（卡照样建出，只是不静默）
    if (spec.nameFrom === "input" && !hasInputName(metadata)) {
      if (!fallbackIds.has(node.id)) {
        fallbackIds.add(node.id);
        nameFallbacks.push({ nodeId: node.id, fallbackName: card.name });
      }
    }
    cards.push(card);
    known.push(card);
  }
  // 已存在的自动落成卡 ＋ 本轮新建者（新建卡 id 必带前缀，且必不在 existing 里 → 无重复）。
  const entityIdsByKind = idsByKind(autoEmittedCards(known));
  return {
    cards,
    updatedCards,
    lockedIds: cards.map((card) => card.id),
    shotBackfill: entityIdsByKind.size ? collectShotBackfill(nodes, entityIdsByKind) : [],
    nameFallbacks,
  };
}