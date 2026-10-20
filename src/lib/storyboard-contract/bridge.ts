import { canUseAsset } from "../asset-scope";
import { filterApprovedShotCardIds, resolveReferenceAssetsToCardIds } from "./normalize";
import { isNonBlankString, uniqueCardIds, usableCardIds } from "./validate";
import { QC_REQUIRED_FIELDS, RATIO_SHAPE, SHOT_CARD_ID_FIELDS } from "./types";
import type { AgentInteractionMode } from "../agent-chat-client";
import type { StoryboardQcBridgeResult, StoryboardQcCardRef, StoryboardQcContext, StoryboardQcContextFields, StoryboardQcFieldSource, StoryboardQcGateArgs, StoryboardQcNodeRef, StoryboardQcProductionFields, StoryboardQcProjectRef, StoryboardQcScopeContext, StoryboardQcShot, StoryboardQcShotNodeMetadata, StoryboardScriptShot } from "./types";

/**
 * 「这一栏真的有值」的判准——**判的是值，不是键存不存在**。
 *
 * 为何不能只判 `v === undefined`（2026-09-17 实测缺陷，已修）：
 *   - `sceneId: ""` 旧判准算「已供给」→ `missing` 漏报、`complete` 回 `true`；
 *     但门禁 `Boolean(text(s.sceneId))` 照样 block →「桥接宣告可望 17/17、门禁实际 11/17」。
 *   - `durationSeconds: NaN` 旧判准算「已供给」，且 `typeof NaN === "number"` 让它**真的被送进门禁**；
 *     `JSON.stringify` 把 NaN 变成 `null` → 门禁 `num(null)` → `undefined` → 一样 block。
 *   两者都是「用空值骗门禁」的同型病灶，故本判准与门禁自身的正规化（trim 后非空、有限数）对齐。
 */
function hasUsableQcValue(field: (typeof QC_REQUIRED_FIELDS)[number], v: unknown): boolean {
  if (field === "characterCardIds" || field === "sceneCardIds") {
    return Array.isArray(v) && v.some((id): boolean => isNonBlankString(id));
  }
  if (field === "durationSeconds") return typeof v === "number" && Number.isFinite(v);
  return isNonBlankString(v);
}

/**
 * 21 栏分镜 → 门禁输入。只做**栏名映射**，不制造 21 栏里不存在的值：
 *   - `shotId` ← `shotNumber`（无则 `S{序}`）、`order` ← 阵列序（门禁 `shot_order` 要求 1..N 连续）
 *   - `prompt` ← `production.prompt` ?? `visualDescription`
 *   - 其余成片阶段栏位只从 `production` 取，缺者列进 `missing`。
 */
export function storyboardQcShots(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  return storyboardQcShotsWith(shots, production);
}

/** `storyboardQcShots` 的实作本体（保持原函数签名与语义不动，只抽出可被下方复用）。 */
function storyboardQcShotsWith(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  const missing = new Set<string>();
  const out = shots.map((shot, i) => {
    const p = production?.[shot.shotNumber] ?? {};
    const prompt = isNonBlankString(p.prompt) ? p.prompt : shot.visualDescription.trim();
    if (!prompt) missing.add("prompt");
    for (const field of QC_REQUIRED_FIELDS) {
      if (!hasUsableQcValue(field, p[field])) missing.add(field);
    }
    return {
      shotId: shot.shotNumber || `S${i + 1}`,
      order: i + 1,
      prompt,
      ...(isNonBlankString(p.sceneId) ? { sceneId: p.sceneId.trim() } : {}),
      ...(typeof p.durationSeconds === "number" && Number.isFinite(p.durationSeconds)
        ? { durationSeconds: p.durationSeconds }
        : {}),
      characterCardIds: usableCardIds(p.characterCardIds),
      sceneCardIds: usableCardIds(p.sceneCardIds),
      propCardIds: usableCardIds(p.propCardIds),
      ...(isNonBlankString(p.keyframeId) ? { keyframeId: p.keyframeId.trim() } : {}),
      ...(isNonBlankString(p.lastFrameId) ? { lastFrameId: p.lastFrameId.trim() } : {}),
      ...(isNonBlankString(p.audioAnchorId) ? { audioAnchorId: p.audioAnchorId.trim() } : {}),
      ...(isNonBlankString(p.aspectRatio) ? { aspectRatio: p.aspectRatio.trim() } : {}),
      // 旁白（加成栏位）：呼叫端供给才带（同 `approval` 范式，未供给不补默认值 → 既有输出键逐位不变）。
      ...(isNonBlankString(p.narration) ? { narration: p.narration.trim() } : {}),
      // 分镜确认状态：呼叫端供给才带（未供给＝缺省＝已批准，不补默认值 → 既有输出键逐位不变）。
      ...(p.approval ? { approval: p.approval } : {}),
    } satisfies StoryboardQcShot;
  });
  const missingList = [...missing];
  return { shots: out, missing: missingList, complete: shots.length > 0 && missingList.length === 0 };
}

/**
 * 上下文 → 成片阶段栏位（纯函数，唯一推导入口——**不用隐式魔法、不改任何既有函数语义**）。
 *
 * 目前**只有五条**推导成立（每条都有来源，逐条列在回报）：
 *   1. `characterCardIds` ← `referenceAssets` 的 `角色:[…]` 名称 → 卡 id（`kind==="character"` 逐字命中）
 *   2. `sceneCardIds` ← `referenceAssets` 的 `场景:[…]` 名称 → 卡 id（`kind==="scene"` 逐字命中）
 *   3. `aspectRatio` ← 该镜节点 `metadata.size`（canvas 的 `size` **就是比例**：
 *      `src/app/api/canvas/generate/route.ts:133` `const aspectRatio = body.size ?? "1:1"`；
 *      可选值域见 `src/components/canvas/CanvasNodePromptPanel.tsx:96-102`）
 *   4. `propCardIds` ← `referenceAssets` 的 `道具:[…]` 名称 → 卡 id（`kind==="prop"` 逐字命中，
 *      2026-09-24 新增）。**加成栏位**：推导不到不进 `missing`（`QC_REQUIRED_FIELDS` 刻意不含它，
 *      否则全部既有镜次瞬间多一项 missing＝门禁回归）。`kind==="style"` 的卡不进 prop 表。
 *   5. `characterCardIds`/`sceneCardIds`/`propCardIds`/`audioAnchorId` ← 该镜节点 `metadata` 的同名
 *      栏（2026-09-24 卡 id；2026-09-30 `audioAnchorId`）。来源 = agent 自动落卡后回填 ＋ 逐镜配音
 *      回写（闭环的消费端）。卡 id 是**集合**语义（联集去重）；`audioAnchorId` 是**单值**语义
 *      （同镜矛盾不给，值真源见 `storyboardQcContextFromProject`）。
 *
 * **推导优先序（照抄，勿改）**：`production`（呼叫端供给） > `referenceAssets`（①②④）
 * > 节点 metadata（⑤）。理由：`referenceAssets` 是**编剧阶段逐字写下的意图**（名称级、有明确
 * 指名）；节点 metadata 的卡 id 多半是**机器自动落卡后回填**（粗：可能把该模板产出的卡全填上）。
 * 若让 metadata 优先，会用「机器猜的较大集合」盖掉「编剧明确指名的较小集合」。
 * 实作上 ①②④ 的 `if (!out.x …)` 写法保证「已供给者不被覆盖」，⑤ 再对同一条件做第二次检查。
 *
 * **刻意不做的推导（附理由，避免下游误以为漏做）**：
 *   - `durationSeconds`：本 repo 有两把尺但**互相冲突**且**输入契约不同**——
 *     `drama-recipe.ts:340 deriveDurations`（4 字/秒，吃「场次 beat 清单」）与
 *     `shortdrama-domain/index.ts:499`（4 字/秒，吃「台词行清单」），而剧本模板教义写 **4.5 字/秒**
 *     （`agent-templates-payload.ts:103`）。射手的 `dialogue` 是**单一字串**、其 `[角色]：「…」`
 *     标记格式无契约文件，硬套等于**自造转换**→ 不生成，留 `missing` 由门禁如实 block。
 *   - `narration`（2026-09-30）：**旁白不从 `dialogue` 猜**。我方 21 栏契约**无旁白栏**，
 *     射手的 `dialogue` 是**单一字串**且其 `[角色]：「…」` 标记格式**无契约文件**——从 `dialogue`
 *     切出旁白＝**自造转换**（同 `durationSeconds` 的病灶），且分镜的旁白本就非逐镜台词可比。
 *     故本档不推导 `narration`，一律留给呼叫端供给：供给即进 `fields`（来源记 `production`）；
 *     未供给＝加成栏位不罚（不进 `missing`）。
 *   - `sceneId`：门禁 `sceneId` 是**场次编号**（`drama-recipe.ts:111-112` `DramaScriptScene.sceneId`
 *     「场次编号（如 S01）」），21 栏只有外层 `sceneName` = **场景资产名**（`storyboard-contract.ts:148`）。
 *     两者是不同实体，名称不可互换 → 不生成。
 *   - `keyframeId`/`lastFrameId`：本 repo **无生产者**（`grep keyframeId src/` 除本档与
 *     `shortdrama-domain` 型别外无写入端）→ 不生成。
 *   - `audioAnchorId`：**2026-09-30 起有生产者**——`storyboard-voiceover`／voiceboard 把
 *     `dialogueAudioId || narrationAudioId` 写回节点 metadata 的相容键，本桥第 ⑤ 条现会在
 *     呼叫端未供给时从节点 metadata 读取（单值语义：同镜矛盾不给）。因为 `audioAnchorId`
 *     已在 `QC_REQUIRED_FIELDS` 内，供给后自然不再进 `missing`。（旧注「无生产者→不生成」已过时。）
 *   - `pixels→ratio` 换算（`aspectRatioFromImageSize`）：canvas 存的是比例不是像素，用不到；
 *     且会把「尺寸」与「交付比例」两概念混一，故只认已是 ratio 形状的值。
 */
export function productionFieldsFromContext(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcContextFields {
  const fields: Record<string, StoryboardQcProductionFields> = {};
  const sources: Record<string, Record<string, StoryboardQcFieldSource>> = {};
  const blockedByShot: Record<string, string[]> = {};
  const cards = context?.cards ?? [];
  for (const shot of shots) {
    const key = shot.shotNumber;
    if (!key) continue;
    const supplied = context?.production?.[key] ?? {};
    const out: StoryboardQcProductionFields = { ...supplied };
    const src: Record<string, StoryboardQcFieldSource> = {};
    for (const field of QC_REQUIRED_FIELDS) {
      if (supplied[field] !== undefined) src[field] = "production";
    }
    if (supplied.prompt) src.prompt = "production";
    // `propCardIds` 不在 `QC_REQUIRED_FIELDS`（加成栏位，见该常数注），故上面的回圈不会标它；
    // 呼叫端有供给时补记来源（与 `prompt` 同一范式），否则它在审计迹里会是「有值却无来源」。
    if (supplied.propCardIds !== undefined) src.propCardIds = "production";
    // `narration` 同样不在 `QC_REQUIRED_FIELDS`（加成栏位，见该常数注），回圈不标它；呼叫端供给时
    // 补记来源（与 `propCardIds`/`prompt` 同一范式），否则审计迹里会是「有值却无来源」。
    if (supplied.narration !== undefined) src.narration = "production";

    // ① / ② referenceAssets 名称 → 卡 id（仅在呼叫端未供给时才推导；已供给者不被覆盖）
    const resolved = resolveReferenceAssetsToCardIds(shot.referenceAssets, cards);
    if (!(out.characterCardIds && out.characterCardIds.length > 0) && resolved.characterCardIds.length > 0) {
      out.characterCardIds = resolved.characterCardIds;
      src.characterCardIds = "referenceAssets";
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0) && resolved.sceneCardIds.length > 0) {
      out.sceneCardIds = resolved.sceneCardIds;
      src.sceneCardIds = "referenceAssets";
    }

    // ③ 节点 ratio → aspectRatio（只认已是 ratio 形状者，绝不做像素换算或补默认值）
    const nodeSize = context?.shotMetadata?.[key]?.size;
    if (!out.aspectRatio && typeof nodeSize === "string" && RATIO_SHAPE.test(nodeSize.trim())) {
      out.aspectRatio = nodeSize.trim();
      src.aspectRatio = "nodeSize";
    }

    // ④ referenceAssets 道具名称 → propCardIds（仅在呼叫端未供给时才推导）
    // 加成栏位：推导不到不进 missing（`QC_REQUIRED_FIELDS` 刻意不含它），有命中才回报来源。
    if (!(out.propCardIds && out.propCardIds.length > 0) && resolved.propCardIds.length > 0) {
      out.propCardIds = resolved.propCardIds;
      src.propCardIds = "referenceAssets";
    }

    // ⑤ 分镜节点 metadata 的卡 id → 三栏（**只在 ①②④ 都没推导到、且呼叫端未供给时**才生效）
    // 优先序最低的理由见上方函数注（编剧逐字指名 > 机器自动落卡的较大集合）。
    // 清洗复用 `usableCardIds`（`uniqueCardIds` = 同规则 + 去重）。
    const nodeCards = context?.shotMetadata?.[key];
    if (!(out.characterCardIds && out.characterCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.characterCardIds);
      if (ids.length > 0) {
        out.characterCardIds = ids;
        src.characterCardIds = "nodeMetadata";
      }
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.sceneCardIds);
      if (ids.length > 0) {
        out.sceneCardIds = ids;
        src.sceneCardIds = "nodeMetadata";
      }
    }
    if (!(out.propCardIds && out.propCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.propCardIds);
      if (ids.length > 0) {
        out.propCardIds = ids;
        src.propCardIds = "nodeMetadata";
      }
    }
    // `audioAnchorId` 同样由节点 metadata 带入（2026-09-30；写法与上方三条卡 id 逐行对称，
    // 含 `src[X] = "nodeMetadata"` 的来源补记）。**单值语义**（同 `size`，非卡 id 的集合语义），
    // 故只在呼叫端未供给且节点值是非空字串时才拿；因为本栏在 `QC_REQUIRED_FIELDS` 内，
    // 供给后自然不再进 `missing`。
    if (!isNonBlankString(out.audioAnchorId)) {
      const nodeAudioAnchorId = nodeCards?.audioAnchorId;
      if (isNonBlankString(nodeAudioAnchorId)) {
        out.audioAnchorId = nodeAudioAnchorId.trim();
        src.audioAnchorId = "nodeMetadata";
      }
    }

    // ⑥ 资产批准闸（**只在协作档生效**，决策 2/23）：未批准的卡 id 不得进分镜卡引用栏。
    // 未给 mode／preset／auto → 整段跳过（既有行为逐位不变，这是全自动档的护城河）。
    // 三条栏一律过（不论值来自 production 还是 ①②④⑤ 推导）：使用者在落卡后才驳回时，
    // 节点 metadata 里的旧绑定照样要被挡——否则「驳回」只是事后贴纸。
    // 挡到一个都不剩 → **连键与来源一起移除**（改进 `missing` 让门禁如实 block，
    // 不留 `[]` 这种「有键无值」骗门禁的空值；挡下的 id 记进 `blockedCardIdsByShot` 回报）。
    if (context?.mode === "collaborate") {
      for (const field of SHOT_CARD_ID_FIELDS) {
        const before = out[field];
        if (!before || before.length === 0) continue;
        const after = filterApprovedShotCardIds(before, cards, context.mode);
        if (after.length === before.length) continue;
        const blocked = before.filter((id) => !after.includes(id));
        if (blocked.length === 0) continue;
        const list = (blockedByShot[key] ??= []);
        for (const id of blocked) if (!list.includes(id)) list.push(id);
        if (after.length > 0) out[field] = after;
        else {
          delete out[field];
          delete src[field];
        }
      }
    }

    fields[key] = out;
    sources[key] = src;
  }
  return {
    fields,
    sources,
    ...(Object.keys(blockedByShot).length > 0 ? { blockedCardIdsByShot: blockedByShot } : {}),
  };
}

/**
 * 专案上下文 → 桥接上下文（**唯一专案级推导入口，显式不魔法**）。
 *
 * 目前只有四条专案级推导成立（每条都有来源）：
 *   1. `lockedCharacterCardIds` / `lockedSceneCardIds` ← `project.cardIds` 按卡 `kind` 分流
 *      （卡实体真源 = `listCharacterCards`，`src/lib/character-card-store.ts:122`）。
 *      门禁 `character_lock`/`scene_lock` 要求「每镜引用的卡都在锁定集合内」——集合就是专案锁定卡。
 *      `kind` 分流只认门禁真有集合的两族：`style`/`prop`（2026-09-24 起 prop 是真 kind）都
 *      **静默略过**（既不进锁定集合也不算未解析）——门禁 `Shot` 没有 lockedStyle/lockedProp 这两集。
 *   2. `shotMetadata[k]` ← `project.nodes` 中 `metadata.size`（供 `productionFieldsFromContext`
 *      推 `aspectRatio`；该栏位是否**真的**已是 ratio 形状由下游 `RATIO_SHAPE` 把关）。
 *   3. `shotMetadata[k]` ← `project.nodes` 中 `metadata.characterCardIds`/`sceneCardIds`/
 *      `propCardIds`（2026-09-24 新增；供 `productionFieldsFromContext` 第 ⑤ 条推导——即
 *      「agent 自动落卡 → 节点 metadata 宣告 → 门禁消费」闭环的带入端）。清洗用 `usableCardIds`，
 *      **空阵列省略该键**（不造 `characterCardIds: []` 的空键，否则 `src` 审计迹会误报「有值」）。
 *   4. `shotMetadata[k]` ← `project.nodes` 中 `metadata.audioAnchorId`（2026-09-30 新增；供第 ⑤ 条
 *      推导——「逐镜配音回写 → 节点 metadata → 门禁 `audio_anchor_present`/`dialogue_alignment`」
 *      闭环的带入端）。**单值语义**（同 `size`）：同镜多节点取首个非空，矛盾则整个不给；空值/非
 *      字串一律省略该键（不臆造、不误报「有值」）。
 *
 * **刻意不做的推导**：`aspectRatio` 没有专案级栏位可取（`grep aspectRatio src/lib/canvas/types.ts`
 * 为空——比例只存在于**节点** metadata，不在 `CanvasProject`），故不「从专案继承」；
 * 亦无 `segmentDurationSeconds` 的专案级来源（`CanvasEpisode` 无时长栏位）。
 *
 * `unresolvedCardIds`：`cardIds` 中**查不到卡片实体**的 id（卡未载入/已删）。这些 id 无法判定
 * `kind` → **不猜**、不塞进任一锁定集合，如实回报。缺卡清单时（`cards` 未提供）同理：
 * 宁可回报全部未解析，也不把角色卡当场景卡通关。
 */
export function storyboardQcContextFromProject(
  project?: StoryboardQcProjectRef,
  options?: {
    cards?: readonly StoryboardQcCardRef[];
    production?: Readonly<Record<string, StoryboardQcProductionFields>>;
    segmentDurationSeconds?: number;
    /**
     * 互动档位（`AgentInteractionMode`）。未给 → 既有行为逐位不变（零回归）；
     * 给了 `"collaborate"` → 推导出的分镜卡引用栏再过一次批准闸（第 ⑥ 条）。
     */
    mode?: AgentInteractionMode;
    /**
     * REQ-B2 作用域上下文。未给 → 既有行为逐位不变（零回归）；
     * 给了 → 卡与 cardIds 先过作用域裁决（不可见即不可用）。
     */
    scope?: StoryboardQcScopeContext;
  },
): { context: StoryboardQcContext; unresolvedCardIds: string[]; outOfScopeCardIds: string[] } {
  const cards = options?.cards ?? [];
  const scope = options?.scope;
  // 作用域裁决：唯一入口 canUseAsset（= resolveAssetVisibility）。未给上下文＝全放行
  // （＝本刀之前的行为，逐位不变）；给了＝跨项目未分享的卡在此不可用。
  const usableCard = (card: StoryboardQcCardRef): boolean => {
    if (!scope) return true;
    const id = typeof card?.id === "string" ? card.id.trim() : "";
    if (!id) return true; // 无 id 的卡既非可见也非不可见，走原有「不猜」路径
    return canUseAsset(
      { id, kind: "card", scope: card.scope, ownerUserId: scope.viewerUserId },
      { viewerUserId: scope.viewerUserId, projectId: scope.projectId, shares: scope.shares },
    );
  };
  const visibleCards = scope ? cards.filter(usableCard) : cards;
  // 被作用域拒掉的卡 id：与「查不到卡实体」分开如实回报（两态不混）。
  const outOfScopeCardIds: string[] = [];
  if (scope) {
    for (const card of cards) {
      if (usableCard(card)) continue;
      const id = typeof card?.id === "string" ? card.id.trim() : "";
      if (id && !outOfScopeCardIds.includes(id)) outOfScopeCardIds.push(id);
    }
  }

  const kindById = new Map<string, string>();
  for (const card of visibleCards) {
    if (!card || typeof card.id !== "string" || typeof card.kind !== "string") continue;
    const id = card.id.trim();
    if (!id) continue;
    // 同 id 多卡：kind 不一致 → 无法判定，标成歧义（空字串）以排除出两个锁定集合
    const prev = kindById.get(id);
    if (prev !== undefined && prev !== card.kind) kindById.set(id, "\u0000ambiguous");
    else if (prev === undefined) kindById.set(id, card.kind);
  }

  const lockedCharacterCardIds: string[] = [];
  const lockedSceneCardIds: string[] = [];
  const unresolvedCardIds: string[] = [];
  for (const raw of project?.cardIds ?? []) {
    if (!isNonBlankString(raw)) continue;
    const id = raw.trim();
    // 不可见即不可用：跨项目未分享的卡不进锁定集合（已在上方如实回报，不重复算未解析）。
    if (outOfScopeCardIds.includes(id)) continue;
    const kind = kindById.get(id);
    if (kind === "character") {
      if (!lockedCharacterCardIds.includes(id)) lockedCharacterCardIds.push(id);
    } else if (kind === "scene") {
      if (!lockedSceneCardIds.includes(id)) lockedSceneCardIds.push(id);
    } else if (kind === "style") {
      // style 卡不属门禁两集（`Shot` 无 styleCardIds）→ 既非未解析也非两者之一，静默略过
    } else if (kind === "prop") {
      // prop 卡同理：门禁 `Shot` 没有 lockedPropCardIds 这一集（道具是加成栏位，不设锁），
      // 故既不入角色/场景锁定集合，也**不得**被当成「查不到卡实体」而误进 unresolvedCardIds。
    } else {
      // 查不到卡实体 / id 撞 kind / 非字串 kind → 不猜
      if (!unresolvedCardIds.includes(id)) unresolvedCardIds.push(id);
    }
  }

  const shotMetadata: Record<string, StoryboardQcShotNodeMetadata> = {};
  // 卡 id 三栏与 `size` **分开累积**：`size` 是同镜矛盾就整个不给（比例是单一交付格式，猜不得）；
  // 卡 id 是**集合**语义（节点宣告「本镜引用这些卡」），同镜多节点取联集去重、不取首个也不丢资讯。
  const cardsByShot: Record<string, { character: string[]; scene: string[]; prop: string[] }> = {};
  // `audioAnchorId` 与 `size` **同范式（单值语义）**、**不照卡 id 的联集**：同镜多节点取首个非空，
  // 一旦矛盾（第二个非空值不同）就整个不给（`null` 哨兵），后续节点不得把它「救回」——音轨锚是
  // 单一交付物，猜不得。空/非字串值一律忽略（不占位、不算首个）。
  const anchorByShot: Record<string, string | null> = {};
  for (const node of project?.nodes ?? []) {
    const meta = node?.metadata;
    const shotNumber = meta?.storyboardShot?.shotNumber;
    if (!isNonBlankString(shotNumber)) continue; // 无镜号的节点不归属任一镜（不臆造键）
    const key = shotNumber.trim();

    const bucket = (cardsByShot[key] ??= { character: [], scene: [], prop: [] });
    const collect = (target: string[], raw: unknown) => {
      for (const id of uniqueCardIds(raw)) if (!target.includes(id)) target.push(id);
    };
    collect(bucket.character, meta?.characterCardIds);
    collect(bucket.scene, meta?.sceneCardIds);
    collect(bucket.prop, meta?.propCardIds);

    const rawAnchor = meta?.audioAnchorId;
    if (isNonBlankString(rawAnchor)) {
      const anchor = rawAnchor.trim();
      const prevAnchor = anchorByShot[key];
      if (prevAnchor === undefined) anchorByShot[key] = anchor;
      else if (prevAnchor !== anchor) anchorByShot[key] = null; // 同镜矛盾 → 不给（不取首个猜）
    }

    const size = meta?.size;
    if (size === undefined) continue;
    // 同镜号多节点：ratio 不一致 → 宁可不给（该镜 aspectRatio 留 missing），不取首个猜
    const prev = shotMetadata[key];
    if (prev === undefined) shotMetadata[key] = { size };
    else if (prev.size !== size) shotMetadata[key] = {};
  }
  // 音轨锚：真的有单一非空值时才挂上；同镜矛盾则**保留该镜键但不给值**（照 `size` 范式——
  // `{ [key]: {} }`，审计迹不误报「有值」）。
  for (const [key, anchor] of Object.entries(anchorByShot)) {
    const entry = (shotMetadata[key] ??= {});
    if (anchor === null) continue;
    entry.audioAnchorId = anchor;
  }
  // 卡 id 只在真的有值时挂上（空阵列省略该键 → 审计迹不误报「有值」）
  for (const [key, bucket] of Object.entries(cardsByShot)) {
    if (bucket.character.length === 0 && bucket.scene.length === 0 && bucket.prop.length === 0) continue;
    const entry = (shotMetadata[key] ??= {});
    if (bucket.character.length > 0) entry.characterCardIds = bucket.character;
    if (bucket.scene.length > 0) entry.sceneCardIds = bucket.scene;
    if (bucket.prop.length > 0) entry.propCardIds = bucket.prop;
  }

  const context: StoryboardQcContext = {
    ...(options?.production ? { production: options.production } : {}),
    // 注入上下文只带可用（可见）的卡：不可见即不可用，卡实体也不例外。
    cards: visibleCards,
    ...(Object.keys(shotMetadata).length > 0 ? { shotMetadata } : {}),
    ...(lockedCharacterCardIds.length > 0 ? { lockedCharacterCardIds } : {}),
    ...(lockedSceneCardIds.length > 0 ? { lockedSceneCardIds } : {}),
    ...(typeof options?.segmentDurationSeconds === "number" ? { segmentDurationSeconds: options.segmentDurationSeconds } : {}),
    ...(options?.mode ? { mode: options.mode } : {}),
  };
  return { context, unresolvedCardIds, outOfScopeCardIds };
}

/**
 * 一次组出**可直接喂门禁的两形 args**（本地判定 + VPS 工具），把推导结果真的接到门禁。
 * `missing` 为空不代表 17 门全过（门禁有自己的值域判定，如 `4:3` 不在 9:16/16:9/1:1 内），
 * 也不代表 `duration_bounds`/`scene_binding` 等已成立——**本函数只保证「输入没有缺项」**。
 */
export function storyboardQcGateArgs(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcGateArgs {
  const derived = productionFieldsFromContext(shots, context);
  const bridge = storyboardQcShotsWith(shots, derived.fields);
  const missing = new Set(bridge.missing);

  const lockedCharacters = (context?.lockedCharacterCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const lockedScenes = (context?.lockedSceneCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (lockedCharacters.length === 0) missing.add("lockedCharacterCardIds");
  if (lockedScenes.length === 0) missing.add("lockedSceneCardIds");

  const segment = context?.segmentDurationSeconds;
  const segmentOk = typeof segment === "number" && Number.isFinite(segment) && segment > 0;
  if (!segmentOk) missing.add("segmentDurationSeconds");

  const input: StoryboardQcGateArgs["input"] = {
    shots: bridge.shots,
    ...(lockedCharacters.length > 0 ? { lockedCharacterCardIds: lockedCharacters } : {}),
    ...(lockedScenes.length > 0 ? { lockedSceneCardIds: lockedScenes } : {}),
    ...(segmentOk ? { segmentDurationSeconds: segment } : {}),
  };
  const toolArgs: StoryboardQcGateArgs["toolArgs"] = {
    shots: JSON.stringify(bridge.shots),
    ...(lockedCharacters.length > 0 ? { locked_character_card_ids: JSON.stringify(lockedCharacters) } : {}),
    ...(lockedScenes.length > 0 ? { locked_scene_card_ids: JSON.stringify(lockedScenes) } : {}),
    ...(segmentOk ? { segment_duration_seconds: segment } : {}),
  };
  const missingList = [...missing];
  return {
    input,
    toolArgs,
    missing: missingList,
    complete: shots.length > 0 && missingList.length === 0,
    sources: derived.sources,
  };
}

// ─────────────────────────────────────────── 重跑影响面（纯判定，2026-09-24）

/**
 * 「某步重跑 → 哪些已完成结果受影响」的**纯判定**（决策 15：步骤条可回跳，只重跑后续）。
 *
 * 输入：
 *   - `nodes`：专案节点（`CanvasProject.nodes`，结构相容 `StoryboardQcNodeRef`）
 *   - `cardIds`：本轮会重做的卡 id。例：重跑资产步 → 该步节点的卡 id ＝
 *     `entityCardIdForNode(nodeId)`（`agent-output-cards.ts:154`，决定性推导），
 *     把这批 id 原样喂进来即得影响面（**不新建节点→卡的第二套推导**）。
 * 输出：
 *   - `affectedCardIds`：真的被某颗分镜节点引用到的卡 id（输入里没被引用的不回报）
 *   - `shotNodeIds`：宣告了这些卡的**分镜节点** id（`metadata.storyboardShot.shotNumber`
 *     非空才算分镜节点；节点无 id／非分镜节点 → 不回报，不臆造）
 *
 * **边界（诚实标记）**：只认**节点 metadata 三条卡引用栏**宣告的绑定；专案级锁定集合
 * （`CanvasProject.cardIds` → 全项目注入）不在此判定内。只回报，不触发任何重跑/UI/写入。
 */
export function affectedShotNodesByCardIds(
  nodes: readonly StoryboardQcNodeRef[],
  cardIds: readonly string[],
): { affectedCardIds: string[]; shotNodeIds: string[] } {
  const targets = new Set(uniqueCardIds(cardIds));
  const affectedCardIds: string[] = [];
  const shotNodeIds: string[] = [];
  if (targets.size === 0) return { affectedCardIds, shotNodeIds };
  for (const node of nodes ?? []) {
    const meta = node?.metadata;
    if (!isNonBlankString(meta?.storyboardShot?.shotNumber)) continue;
    const hits: string[] = [];
    for (const field of SHOT_CARD_ID_FIELDS) {
      for (const id of uniqueCardIds(meta?.[field])) if (targets.has(id)) hits.push(id);
    }
    if (hits.length === 0) continue;
    for (const id of hits) if (!affectedCardIds.includes(id)) affectedCardIds.push(id);
    const nodeId = isNonBlankString(node.id) ? node.id.trim() : "";
    if (nodeId && !shotNodeIds.includes(nodeId)) shotNodeIds.push(nodeId);
  }
  return { affectedCardIds, shotNodeIds };
}
