import { MEMORY_CORROBORATION_BODY_JACCARD, MEMORY_DUPLICATE_JACCARD, MEMORY_QUOTA_PER_DOMAIN_DAY, MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY, MEMORY_QUOTA_SHARED_PER_BATCH, MEMORY_QUOTA_SHARED_PER_DOMAIN_DAY, MEMORY_SHARED_CORROBORATION_MIN, MEMORY_SHARED_MAX_PENDING_DOCS } from "./constants";
import { deterministicDocId } from "./keys";
import { mergeContributors, normalizeAuditIdList, normalizeAuditString, normalizeContributors, normalizeIsoField, normalizeProposed, normalizeSupersedes, sameContent } from "./normalize";
import { memoryJaccard } from "./text";
import { canActivateShared, findCorroborationEntry, pendingSharedCount, sameScope } from "./index-md";
import { loadCatalog, readDoc, saveCatalog, withCatalogLock, writeCatalogEntry, writeDoc, writeRevision } from "./store";
import { hasInvalidTimeRange, rebuildIndex, timeMs } from "./validity";
import { applyPrivateReconcileUpdate, findPrivateReconcileMatch, resolvePromptVersion } from "./reconcile";
import type { PrivateReconcileMatch } from "./reconcile";
import { isStructurallyValid } from "./validation";
import type { AgentMemoryDoc, MemoryCatalogEntry, MemoryIngestInput, MemoryIngestResult, MemoryProposal, MemoryStatus } from "./types";

/**
 * 摄入状态机（**仅 shared 生效**；private 恒 active）：
 * - 新文档：缺 `contributorKey` → `pending_review`（fail-closed，不静默当 active）；
 *   有提出者但去重人数 < `corroborationMin` → `pending_review`。
 * - 既有 `active`：内容不变 → 保持 active 并合并佐证；内容变更 → 走 `proposed` 提案
 *   （live 一字不动），提案达门槛才提升。
 * - `pending_review`：可直接改 live，但内容一变就重置佐证名单（重新收证）。
 * - `retracted`：留证终态，再入库一律 rejected "retracted"（人工 activate 另行放行）。
 *
 * private 额外在写入时对账（同一 ownerKey、精确 slug 未命中时）：矛盾／替换 → 旧事实
 * SUPERSEDE；近重复且正文一致 → NOOP（只刷新 lastConfirmedAt）；其余 ADD。
 *
 * 入库：G5 去重 + G7 配额 + 写正文 + 重建 INDEX.md + 更新 catalog.json。
 */
async function ingestMemoryDocsLocked(input: MemoryIngestInput): Promise<MemoryIngestResult> {
  const batchId = String(input?.batchId ?? "").trim();
  const now = input?.now ?? new Date();
  const nowIso = now.toISOString();
  const todayKey = nowIso.slice(0, 10);
  const candidates = Array.isArray(input?.docs) ? input.docs : [];
  const accepted: string[] = [];
  const acceptedRefs: NonNullable<MemoryIngestResult["acceptedRefs"]> = [];
  /** live 未变、只累积了未达门槛提案的 id（不进 accepted，避免误报「已入库」）。 */
  const proposals: string[] = [];
  /** 近重复被判定为已确认同一事实、只刷新 lastConfirmedAt 的 id。 */
  const noop: string[] = [];
  /** 被本批写入取代的旧 slug。 */
  const superseded: string[] = [];
  const rejected: MemoryIngestResult["rejected"] = [];

  if (!batchId) {
    for (const doc of candidates) {
      // 还没进入候选处理循环，只能按可读到的原始栏位保守补身份。
      const docScope = doc?.scope;
      rejected.push({
        slug: String(doc?.slug ?? ""),
        reason: "structure",
        ...(docScope === "private" || docScope === "shared" ? { scope: docScope } : {}),
        ...(docScope === "private" && doc?.ownerKey ? { ownerKey: doc.ownerKey } : {}),
        ...(typeof doc?.domain === "string" && doc.domain ? { domain: doc.domain } : {}),
      });
    }
    return {
      accepted,
      acceptedRefs,
      proposals,
      rejected,
      stats: { received: candidates.length, accepted: 0, index_lines: 0, seed_accepted: 0 },
    };
  }

  const catalog = await loadCatalog();
  const entries = catalog.entries;
  // 跨账号佐证门槛：坏值回退常量；至少 1（0 等价于只要有提出者即放行）。
  const corroborationMin =
    typeof input?.corroborationMin === "number" && Number.isFinite(input.corroborationMin)
      ? Math.max(1, Math.floor(input.corroborationMin))
      : MEMORY_SHARED_CORROBORATION_MIN;
  // 受控种子导入总开关；每个候选再用 scope/contributorKey 收窄（private 永不放宽）。
  const seedMode = input?.seedMode === true;
  const touchedPrivateOwners = new Set<string>();
  let sharedAcceptedThisBatch = 0;
  let touchedShared = false;
  /** 种子模式下实写的文档数（只计真正进 accepted 的 shared 种子文档）。 */
  let seedAccepted = 0;

  for (const candidate of candidates) {
    const slug = String(candidate?.slug ?? "");
    // 输入候选的原始身份：近重复合并会把 docSlug/docDomain 改写成 target，
    // 但审计／batch 抽检必须能用候选自己的 slug 找到这条回执。
    const inputDomain = String(candidate?.domain ?? "");
    const inputSlug = String(candidate?.slug ?? "");
    // 拒绝回执的候选身份：batch 审计按 (scope, ownerKey, domain, slug) 归属，
    // 否则同 slug 跨 domain 的 accepted/rejected 混合会被整条误标。
    const rejectIdentity = {
      scope:
        candidate?.scope === "private" || candidate?.scope === "shared"
          ? candidate.scope
          : undefined,
      ownerKey: candidate?.scope === "private" ? candidate.ownerKey : undefined,
      domain: typeof candidate?.domain === "string" ? candidate.domain : undefined,
    };
    if (!isStructurallyValid(candidate)) {
      rejected.push({ slug, reason: "structure", ...rejectIdentity });
      continue;
    }
    // 本候选是否只写入了未达门槛的提案（live 未变）：决定它进 proposals 而不是 accepted。
    let proposalOnly = false;
    // 同 slug 同内容＝只做确认（没有写新正文）：进 noop，不进 accepted。
    let reconfirmOnly = false;
    const scope = candidate.scope;
    const ownerKey = scope === "private" ? candidate.ownerKey : undefined;
    const contributorKey =
      scope === "shared" && typeof candidate.contributorKey === "string"
        ? candidate.contributorKey.trim()
        : "";
    // 种子模式只对「带 contributorKey 的 shared 文档」生效；private 与匿名 shared
    // 一律走普通闸门（有效门槛／容量上限都不放宽）。
    const docSeedMode = seedMode && scope === "shared" && contributorKey !== "";
    const effectiveCorroborationMin = docSeedMode ? 1 : corroborationMin;
    let existingIndex = entries.findIndex(
      (entry) =>
        sameScope(entry, scope, ownerKey) &&
        entry.domain === candidate.domain &&
        entry.slug === candidate.slug,
    );
    let existingEntry = existingIndex >= 0 ? entries[existingIndex] : null;

    // 近重复佐证入口（仅 shared，**只在精确 slug 未命中时启用**；精确命中优先级不变）：
    // 两个账号几乎不可能生成相同 slug（廉价通道用 note-<hash>、批次 curator 各自取名），
    // 若只按 scope+slug 精确匹配，shared 文档会永远停在 pending_review。这里把「同
    // domain + description 近重复」的既有文档当作**候选**，再以正文兼容作为合并门槛：
    // description 只负责找候选（措辞可能完全不同），正文才是「是否同一知识」的判据。
    // 正文不兼容 → **不采用该 target**，候选按新文档路径落盘成两条独立知识，绝不把
    // 候选正文并进目标后丢弃。private 完全不走这条路。
    let nearDuplicateTarget = false;
    // 正文兼容判定的显式结果：只有它为 true，pending 分支才允许把候选并进目标文档。
    let bodyCompatible = false;
    if (!existingEntry && scope === "shared" && contributorKey !== "") {
      const target = findCorroborationEntry(entries, candidate);
      if (target) {
        const targetDoc = await readDoc("shared", undefined, target.domain, target.slug);
        // 正文兼容门槛：内容四元组相同，或正文 token Jaccard ≥ 0.5（措辞差异容忍度）。
        // 目标正文读不到时无法证明兼容，fail-closed 视为不兼容（不拿它当合并目标）。
        bodyCompatible =
          targetDoc !== null &&
          (sameContent(targetDoc, candidate) ||
            memoryJaccard(targetDoc.body, candidate.body) >= MEMORY_CORROBORATION_BODY_JACCARD);
        if (bodyCompatible && targetDoc) {
          // 同一账号不得靠「换个 slug + 近重复描述」给自己补票：已在 live 或 proposed
          // 佐证名单里的一律按既有 duplicate 语义拒绝。
          const endorsers = mergeContributors(
            targetDoc.contributors,
            targetDoc.proposed?.contributors,
          );
          if (endorsers.includes(contributorKey)) {
            rejected.push({ slug, reason: "duplicate", ...rejectIdentity });
            continue;
          }
          existingIndex = entries.indexOf(target);
          existingEntry = target;
          nearDuplicateTarget = true;
        }
        // 不兼容：不使用 target，existingEntry 保持 null，候选走新文档落盘路径。
      }
    }

    // 文档身份一律用目标条目的 slug/domain（近重复命中时），绝不用候选自己生成的
    // 新 slug，否则又会分叉成新文档。精确命中时两者本来就相同。
    const docSlug = nearDuplicateTarget && existingEntry ? existingEntry.slug : candidate.slug;
    const docDomain =
      nearDuplicateTarget && existingEntry ? existingEntry.domain : candidate.domain;

    // 先读既有正文（shared 用 catalog 记的 domain 定位，避免候选改了 domain 时读不到
    // 本体）：状态判定与「内容同／异」比较都必须基于它，而不是基于 candidate。
    const previous = await readDoc(
      scope,
      ownerKey,
      scope === "shared" ? (existingEntry?.domain ?? candidate.domain) : candidate.domain,
      docSlug,
    );
    const previousStatus: MemoryStatus | undefined = previous?.status ?? existingEntry?.status;

    // retracted 是留证终态：shared 拒绝写入，正文一格不动（人工 activate 另行放行）。
    if (scope === "shared" && previousStatus === "retracted") {
      rejected.push({ slug, reason: "retracted", ...rejectIdentity });
      continue;
    }

    // L1：时间区间自检（必须在配额／对账之前——被拒候选不写文档、不消耗配额）。
    // 同 slug 更新时按「合并后的有效区间」判断：幂等重提保留旧 validFrom。
    const requestedFrom =
      normalizeIsoField(candidate.validFrom) ?? normalizeIsoField(candidate.observedAt);
    const requestedTo = normalizeIsoField(candidate.validTo);
    const sameContentAsPrevious = previous ? sameContent(previous, candidate) : false;
    const nowMs = timeMs(nowIso) ?? Date.now();
    const previousExpired =
      previous?.validTo !== undefined &&
      (timeMs(previous.validTo) ?? Infinity) <= nowMs;
    // 只有「active 且未过期」的同内容重提才是真 noop；retracted/superseded/过期
    // 同内容重提是**重新生效**，按新事实从 now 起算。
    const reconfirmEligible =
      previous !== null &&
      previous.status === "active" &&
      !previousExpired &&
      sameContentAsPrevious;
    const effectiveRangeFrom = reconfirmEligible
      ? previous.validFrom ?? previous.createdAt
      : // 非幂等写入会按新事实落 validFrom：未显式给 from 时默认 now，
        // 因此不能用旧 validFrom 校验（否则过去时刻的 validTo 会漏检）。
        requestedFrom ?? nowIso;
    const effectiveRangeTo = requestedTo ?? (reconfirmEligible ? previous.validTo : undefined);
    if (hasInvalidTimeRange(effectiveRangeFrom, effectiveRangeTo)) {
      rejected.push({ slug, reason: "time_range", ...rejectIdentity });
      continue;
    }

    // private 写入时对账（仅精确 slug 未命中时）。必须放在 G5 duplicate 之前：
    // 「同一事实被改写／否定」的候选天然是近重复，让它先有机会 SUPERSEDE 旧事实，
    // 而不是被 duplicate 直接丢掉。shared 不走这条路（保持既有佐证／提案状态机）。
    //
    // 决策与落盘分离：NOOP 不新增文档，可立即落盘；SUPERSEDE 只记决策，必须等本候选
    // 通过全部配额／结构检查、且新文档 writeDoc 成功后才置旧事实失效——否则配额拒绝
    // 会先杀掉旧事实，留下「旧的没了、新的没进来」的空洞。
    let supersededTargets: string[] = [];
    let supersedeMatch: PrivateReconcileMatch | null = null;
    if (!existingEntry && scope === "private" && ownerKey) {
      const match = await findPrivateReconcileMatch(entries, candidate, ownerKey);
      if (match?.mode === "noop") {
        await applyPrivateReconcileUpdate(match.entry, match.doc, "noop", nowIso);
        // NOOP：不写新文档、不进 accepted，只确认既有事实；revision 变了要重建索引。
        noop.push(match.entry.id);
        touchedPrivateOwners.add(ownerKey);
        continue;
      }
      if (match) {
        supersedeMatch = match;
        supersededTargets = [match.entry.slug];
      }
    }

    // G5（其二）：description 与既有 active 条目 token Jaccard > 0.8 → duplicate。
    // SUPERSEDE 是「替换同一事实」而非重复：本候选跳过此拒收。
    if (!existingEntry && !supersedeMatch) {
      const duplicate = entries.find(
        (entry) =>
          entry.status === "active" &&
          sameScope(entry, scope, ownerKey) &&
          // 同 slug／近重复只在同一 domain 内算重复；跨 domain 是两条独立事实。
          entry.domain === candidate.domain &&
          memoryJaccard(entry.description, candidate.description) > MEMORY_DUPLICATE_JACCARD,
      );
      if (duplicate) {
        rejected.push({ slug, reason: "duplicate", ...rejectIdentity });
        continue;
      }
    }

    const previousContributors = normalizeContributors(
      previous?.contributors ?? existingEntry?.contributors,
    );
    // 时间／来源栏位（宽松清洗；坏值视为 undefined，绝不拒绝整条）。
    // 新事实默认：validFrom = 显式值 ?? observedAt ?? now；validTo 空则视为仍有效。
    const timeFields = {
      validFrom:
        normalizeIsoField(candidate.validFrom) ??
        normalizeIsoField(candidate.observedAt) ??
        nowIso,
      validTo: normalizeIsoField(candidate.validTo),
      observedAt: normalizeIsoField(candidate.observedAt),
      referenceTime: normalizeIsoField(candidate.referenceTime),
      sourceSessionId: normalizeAuditString(candidate.sourceSessionId),
      sourceMessageIds: normalizeAuditIdList(candidate.sourceMessageIds),
    };
    // supersede 命中时把旧 slug 并入本事实的 supersedes（去重，最多 5 条）。
    const mergedSupersedes = normalizeSupersedes([
      ...supersededTargets,
      ...(normalizeSupersedes(candidate.supersedes) ?? []),
    ]);

    if (!existingEntry) {
      // G7：单批 shared ≤20（只计新增文档）。种子模式按批导入不受此限。
      if (
        scope === "shared" &&
        !docSeedMode &&
        sharedAcceptedThisBatch >= MEMORY_QUOTA_SHARED_PER_BATCH
      ) {
        rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
        continue;
      }
      // G7：单 domain 日配额，按 scope 取上限。**按 scope 隔离计数**：shared 只数
      // shared，private 只数该 ownerKey，避免别的租户的 private `general` 吃光全服
      // shared `general`。private 是用户自己的库，额度放宽；shared 进所有用户上下文，
      // 维持严格额度。
      const domainCount = entries.filter(
        (entry) =>
          sameScope(entry, scope, ownerKey) &&
          entry.domain === candidate.domain &&
          entry.createdAt.slice(0, 10) === todayKey,
      ).length;
      const domainCap =
        scope === "private" ? MEMORY_QUOTA_PER_DOMAIN_DAY : MEMORY_QUOTA_SHARED_PER_DOMAIN_DAY;
      // 种子模式按批导入不受单 domain 日配额限制；private 与普通 shared 不变。
      if (!docSeedMode && domainCount >= domainCap) {
        rejected.push({ slug, reason: "quota_domain", ...rejectIdentity });
        continue;
      }
      // G7：单 ownerKey private ≤10/日。
      if (scope === "private") {
        const ownerCount = entries.filter(
          (entry) =>
            entry.scope === "private" &&
            entry.ownerKey === ownerKey &&
            entry.createdAt.slice(0, 10) === todayKey,
        ).length;
        if (ownerCount >= MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY) {
          rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
          continue;
        }
      }
      // shared 新增若只能落 pending，而 pending 已满 → 拒绝（防跨日累积后批量升级）。
      if (scope === "shared" && !previous) {
        const wouldBeContributors = mergeContributors([], contributorKey);
        const wouldActivate =
          contributorKey !== "" &&
          wouldBeContributors.length >= effectiveCorroborationMin &&
          (docSeedMode || canActivateShared(catalog));
        if (!wouldActivate && pendingSharedCount(catalog) >= MEMORY_SHARED_MAX_PENDING_DOCS) {
          rejected.push({ slug, reason: "quota_scope", ...rejectIdentity });
          continue;
        }
      }
    }

    // G5（其一）：同 scope+ownerKey+slug 已存在 → 更新（revision+1，旧 body 存档）。
    const revision = existingEntry
      ? Math.max(existingEntry.revision, previous?.revision ?? 0) + 1
      : 1;
    if (previous) await writeRevision(previous);

    let doc: AgentMemoryDoc;

    if (scope === "private") {
      // active 且未过期的同内容重提＝幂等 noop（保留原 validFrom/validTo）；
      // retracted／superseded／已过期同内容重提＝重新生效：复用原 id、active、
      // validFrom 从 now（或候选显式值）起算、清空旧 validTo、进 accepted。
      const reconfirmSame = existingEntry !== null && reconfirmEligible;
      const reactivating =
        existingEntry !== null && previous !== null && sameContentAsPrevious && !reconfirmSame;
      if (reconfirmSame) reconfirmOnly = true;
      doc = {
        id:
          existingEntry?.id ??
          deterministicDocId({
            scope,
            ownerKey,
            domain: candidate.domain,
            slug: candidate.slug,
          }),
        scope,
        ownerKey,
        domain: candidate.domain,
        slug: candidate.slug,
        description: candidate.description,
        type: candidate.type,
        body: candidate.body,
        links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
        evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
        evidenceKind: candidate.evidenceKind,
        selfScore: candidate.selfScore,
        promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
        batchId: existingEntry?.batchId ?? batchId,
        status: "active",
        revision,
        contributors: [],
        ...timeFields,
        ...(reconfirmSame && previous
          ? {
              validFrom: previous.validFrom ?? previous.createdAt,
              validTo: timeFields.validTo ?? previous.validTo,
            }
          : {}),
        // 重新生效时不继承旧的 supersedes 指向（旧覆盖关系已经结束）。
        supersedes: reactivating
          ? mergedSupersedes
          : mergedSupersedes ?? previous?.supersedes,
        lastConfirmedAt: nowIso,
        lastOperation: reconfirmSame
          ? "noop"
          : reactivating
            ? "add"
            : existingEntry
              ? "update"
              : "add",
        createdAt: existingEntry?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
    } else if (!existingEntry && !previous) {
      // 新 shared 文档：达到跨账号门槛 **且** 容量允许才 active，否则 fail-closed 进 pending。
      const contributors = mergeContributors([], contributorKey);
      const reachable =
        contributorKey !== "" &&
        contributors.length >= effectiveCorroborationMin &&
        (docSeedMode || canActivateShared(catalog));
      doc = {
        id: deterministicDocId({ scope, ownerKey, domain: docDomain, slug: docSlug }),
        scope,
        ownerKey,
        domain: docDomain,
        slug: docSlug,
        description: candidate.description,
        type: candidate.type,
        body: candidate.body,
        links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
        evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
        evidenceKind: candidate.evidenceKind,
        selfScore: candidate.selfScore,
        promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
        batchId,
        status: reachable ? "active" : "pending_review",
        revision,
        contributors,
        ...timeFields,
        supersedes: mergedSupersedes,
        lastConfirmedAt: nowIso,
        lastOperation: "add",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    } else if (previousStatus === "active") {
      if (!previous) {
        // catalog 说 active 但正文读不到：绝不拿单账号候选覆盖 live（fail-closed）。
        rejected.push({ slug, reason: "structure", ...rejectIdentity });
        continue;
      }
      if (sameContent(previous, candidate)) {
        // 幂等重提：只并入佐证，live 内容与 validFrom/validTo 一字不动。
        doc = {
          ...previous,
          contributors: mergeContributors(previous.contributors, contributorKey),
          status: "active",
          revision,
          lastConfirmedAt: nowIso,
          lastOperation: "update",
          updatedAt: nowIso,
        };
      } else {
        // 内容变更：单账号不得覆盖 live，只能提交／累积提案。
        const liveProposal = normalizeProposed(previous.proposed);
        let proposed: MemoryProposal;
        if (!liveProposal) {
          proposed = {
            body: candidate.body,
            description: candidate.description,
            domain: candidate.domain,
            type: candidate.type,
            contributors: normalizeContributors([contributorKey]),
            updatedAt: nowIso,
          };
        } else if (sameContent(liveProposal, candidate)) {
          // 同一提案再获佐证（同一 ownerKey 去重后仍只算一人）。
          proposed = {
            ...liveProposal,
            contributors: mergeContributors(liveProposal.contributors, contributorKey),
            updatedAt: nowIso,
          };
        } else {
          // 提案内容又变了：新提案重新收证，旧提案作废。
          proposed = {
            body: candidate.body,
            description: candidate.description,
            domain: candidate.domain,
            type: candidate.type,
            contributors: normalizeContributors([contributorKey]),
            updatedAt: nowIso,
          };
        }

        if (
          proposed.contributors.length >= effectiveCorroborationMin &&
          (docSeedMode || canActivateShared(catalog, true))
        ) {
          // 提案达到跨账号门槛：提升为 live（该文档本就在 active，不增加 active 数）。
          doc = {
            ...previous,
            body: proposed.body,
            description: proposed.description,
            domain: proposed.domain,
            type: proposed.type,
            links: Array.isArray(candidate.links)
              ? candidate.links.map((link) => String(link))
              : previous.links,
            evidence:
              typeof candidate.evidence === "string"
                ? candidate.evidence.slice(0, 200)
                : previous.evidence,
            evidenceKind: candidate.evidenceKind,
            selfScore: candidate.selfScore,
            promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
            status: "active",
            revision,
            contributors: mergeContributors(previous.contributors, proposed.contributors),
            proposed: undefined,
            // live 内容被跨账号佐证推进：按新事实刷新时间字段。
            ...timeFields,
            supersedes: mergedSupersedes ?? previous.supersedes,
            lastConfirmedAt: nowIso,
            lastOperation: "update",
            updatedAt: nowIso,
          };
        } else {
          // 未达门槛：live 内容与对外状态保持原样，只更新提案（提案版本 revision+1）。
          // 该 id 只进 proposals：没有任何 live 内容变化，不能对外报「已入库」。
          proposalOnly = true;
          doc = {
            ...previous,
            status: "active",
            revision,
            proposed,
            updatedAt: nowIso,
          };
        }
      }
    } else if (previousStatus === "pending_review") {
      // 未发布态可直接改 live；**内容一变就重置佐证名单**（重新收证）。
      // 例外：近重复佐证——只有正文兼容判定（bodyCompatible）通过的候选才算对同一主张
      // 的独立佐证，措辞微调不算内容变更，保留既有正文，只并入新账号，达门槛才升
      // active。description 近重复本身不是合并理由；未通过正文兼容的候选已在上面放弃
      // 该 target，走新文档落盘，绝不接受后丢弃正文。
      const contentSame = previous ? sameContent(previous, candidate) : false;
      const contributors =
        contentSame || bodyCompatible
          ? mergeContributors(previousContributors, contributorKey)
          : normalizeContributors([contributorKey]);
      const reachable =
        contributors.length >= effectiveCorroborationMin &&
        (docSeedMode || canActivateShared(catalog));
      doc =
        nearDuplicateTarget && bodyCompatible && previous
          ? {
              // 正文兼容的近重复命中：身份与 live 正文沿用目标条目，候选取到的只是
              // 「一票佐证」；候选正文与目标正文兼容（Jaccard ≥ 0.5 或完全相同）。
              ...previous,
              domain: docDomain,
              slug: docSlug,
              status: reachable ? "active" : "pending_review",
              revision,
              contributors,
              // 措辞微调是对同一事实的佐证：不刷新 validFrom，只记确认时间。
              lastConfirmedAt: nowIso,
              lastOperation: "update",
              proposed: undefined,
              updatedAt: nowIso,
            }
          : {
              id:
                existingEntry?.id ??
                previous?.id ??
                deterministicDocId({ scope, ownerKey, domain: docDomain, slug: docSlug }),
              scope,
              ownerKey,
              domain: docDomain,
              slug: docSlug,
              description: candidate.description,
              type: candidate.type,
              body: candidate.body,
              links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
              evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
              evidenceKind: candidate.evidenceKind,
              selfScore: candidate.selfScore,
              promptVersion: resolvePromptVersion(candidate, input, docSeedMode),
              batchId: existingEntry?.batchId ?? previous?.batchId ?? batchId,
              status: reachable ? "active" : "pending_review",
              revision,
              contributors,
              // 内容未变才保留既有提案；live 被直接改写时旧提案作废。
              proposed: contentSame ? previous?.proposed : undefined,
              // live 内容被直接改写：按新事实刷新时间字段。
              ...timeFields,
              supersedes: mergedSupersedes ?? previous?.supersedes,
              lastConfirmedAt: nowIso,
              lastOperation: "update",
              createdAt: existingEntry?.createdAt ?? previous?.createdAt ?? nowIso,
              updatedAt: nowIso,
            };
    } else {
      // retracted 已在上面拦截；走到这里表示 catalog 状态损坏，拒绝写入。
      rejected.push({ slug, reason: "structure", ...rejectIdentity });
      continue;
    }
    await writeDoc(doc);

    // 新事实已落盘成功，才把旧事实置为 superseded（失败路径不会走到这里，
    // 因此配额／结构拒绝时候选旧事实保持 active、仍在 INDEX）。
    if (supersedeMatch) {
      await applyPrivateReconcileUpdate(
        supersedeMatch.entry,
        supersedeMatch.doc,
        "supersede",
        nowIso,
      );
      superseded.push(supersedeMatch.entry.slug);
      if (ownerKey) touchedPrivateOwners.add(ownerKey);
    }

    const entry: MemoryCatalogEntry = {
      id: doc.id,
      scope: doc.scope,
      ownerKey: doc.ownerKey,
      domain: doc.domain,
      slug: doc.slug,
      description: doc.description,
      status: doc.status,
      revision: doc.revision,
      contributors: doc.contributors,
      batchId: doc.batchId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      validFrom: doc.validFrom,
      validTo: doc.validTo,
      lastConfirmedAt: doc.lastConfirmedAt,
      // 同 identity 的原条目若带旧 id aliases，必须保留（旧 id 的 history/retract 兼容）。
      aliases: existingEntry?.aliases,
    };
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else {
      entries.push(entry);
      if (scope === "shared") sharedAcceptedThisBatch += 1;
    }
    // 逐文档日志：条目新建／更新都写自己的文件（跨进程并发不再共享一个 catalog.json）。
    await writeCatalogEntry(entry);
    if (scope === "shared") touchedShared = true;
    else if (ownerKey) touchedPrivateOwners.add(ownerKey);
    // 实写（新文档／内容提升为 live）才进 accepted；提案-only 进 proposals；
    // 同 slug 同内容的确认（没有写新正文）进 noop。
    if (proposalOnly) proposals.push(doc.id);
    else if (reconfirmOnly) noop.push(doc.id);
    else {
      accepted.push(doc.id);
      acceptedRefs.push({
        id: doc.id,
        batchId: doc.batchId,
        scope: doc.scope,
        ownerKey: doc.ownerKey,
        domain: doc.domain,
        slug: doc.slug,
        inputDomain,
        inputSlug,
      });
      if (docSeedMode) seedAccepted += 1;
    }
  }

  // 进入时的 catalog.revision 作为并发检测基线：别的进程若已写入，saveCatalog 会按 id 合并。
  await saveCatalog(catalog, catalog.revision ?? 0);

  let indexLines = 0;
  if (accepted.length > 0 || superseded.length > 0 || noop.length > 0) {
    if (touchedShared) indexLines += await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) {
      indexLines += await rebuildIndex("private", ownerKey);
    }
  }

  return {
    accepted,
    acceptedRefs,
    proposals,
    ...(noop.length > 0 ? { noop } : {}),
    ...(superseded.length > 0 ? { superseded } : {}),
    rejected,
    stats: {
      received: candidates.length,
      accepted: accepted.length,
      index_lines: indexLines,
      seed_accepted: seedAccepted,
    },
  };
}

/** 导出入口：整段函数体持锁，避免同进程内 read-modify-write catalog 互相覆盖。 */
export function ingestMemoryDocs(input: MemoryIngestInput): Promise<MemoryIngestResult> {
  return withCatalogLock(() => ingestMemoryDocsLocked(input));
}
