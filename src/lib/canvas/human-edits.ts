// 人手改过的，不许盖掉（2026-11-02）。
//
// 病灶：51a0fcbca 让人能在卡片上直接改字/改提示词，但改完不留任何记号；agent 下一轮
// workflow_write（compile.ts patchForExisting）或 canvas_apply_ops update_node 会照常把
// title/prompt/content 盖回模型版本。唯一的保护 `locked===true` 没有任何 UI 会设，且不在
// 两端 metadata 白名单里（重载即丢、上行快照看不到），等于死键。
//
// 做法：人手编辑时在 metadata.human_edited 记「哪个栏位、何时被人改过」；agent 写入路径
// （compile 与 reducer 的 agent_ops.update_node）对这些栏位一律保留人的版本并回报。
// 只有用户本轮明确要求改该栏位时，agent 才可在 patch.metadata._override_human 点名栏位
// 覆盖（可审计；覆盖后该栏位的人手记号清除，归还给 agent）。

/** 受保护的人手栏位：卡片标题、提示词、正文（文本卡）。 */
export const HUMAN_EDITABLE_FIELDS = ["title", "prompt", "content"] as const;
export type HumanEditableField = (typeof HUMAN_EDITABLE_FIELDS)[number];

/** 栏位 → 最后一次人手改动的毫秒时间戳。 */
export type HumanEditedFields = Partial<Record<HumanEditableField, number>>;

/** agent 点名覆盖人手栏位的运输键（只在 patch 里出现，绝不落进节点 metadata）。 */
export const HUMAN_OVERRIDE_KEY = "_override_human";

function isHumanField(value: unknown): value is HumanEditableField {
  return typeof value === "string" && (HUMAN_EDITABLE_FIELDS as readonly string[]).includes(value);
}

/** 宽松输入 → 合法 human_edited（非物件/空集合 → undefined＝省略键）。 */
export function cleanHumanEdited(raw: unknown): HumanEditedFields | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: HumanEditedFields = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isHumanField(key) && typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 人手改了 fields：回传合并后的 human_edited（给 patchNodeMetadata 用）。 */
export function stampHumanEdit(prevMetadata: unknown, fields: readonly HumanEditableField[], now = Date.now()): HumanEditedFields {
  const prev = cleanHumanEdited((prevMetadata as { human_edited?: unknown } | undefined)?.human_edited) ?? {};
  const next: HumanEditedFields = { ...prev };
  for (const f of fields) next[f] = now;
  return next;
}

/** patch 里 agent 点名覆盖的栏位（_override_human: ["prompt"] 或 "prompt"）。 */
export function overrideFieldsOf(metadataPatch: unknown): Set<HumanEditableField> {
  const raw = (metadataPatch as Record<string, unknown> | undefined)?.[HUMAN_OVERRIDE_KEY];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return new Set(list.filter(isHumanField));
}

type NodeLike = { title?: string; metadata?: Record<string, unknown> | object };
type PatchLike = { title?: string; metadata?: Record<string, unknown> };

/**
 * agent 写入守门：人手改过且 agent 未点名覆盖的栏位，从 patch 中剔除（保留人的版本）。
 * 回传新 patch、被拦下的栏位、以及覆盖后应写回的 human_edited（覆盖的栏位清掉记号）。
 * 只拦「值真的会变」的栏位：agent 原样回写人的版本不算冲突。
 */
/**
 * compile 侧的现值来自上行快照（compactMetadataForAgent：prompt 截前 120 字、长 content 截
 * 120 字＋「…」）。agent 原样回写人的全文时与截断现值「不等」，会误报。此判定只用于 compile
 * （放行后 reducer 拿全文现值再判一次，真改仍被拦）；reducer 端绝不能用（会放过追加改写）。
 */
function sameAsTruncatedView(field: HumanEditableField, incoming: unknown, current: unknown): boolean {
  if (typeof incoming !== "string" || typeof current !== "string" || !current) return false;
  if (field === "prompt") return current.length >= 120 && incoming.startsWith(current);
  if (field === "content") return current.endsWith("…") && incoming.startsWith(current.slice(0, -1));
  return false;
}

export function guardAgentPatchAgainstHumanEdits<P extends PatchLike>(
  prev: NodeLike,
  patch: P,
  opts: { currentIsAgentView?: boolean } = {},
): { patch: P; blocked: HumanEditableField[]; overridden: HumanEditableField[] } {
  const prevMd = (prev.metadata ?? {}) as Record<string, unknown>;
  const edited = cleanHumanEdited(prevMd.human_edited);
  const overrides = overrideFieldsOf(patch.metadata);
  const nextMd: Record<string, unknown> | undefined = patch.metadata ? { ...patch.metadata } : undefined;
  if (nextMd) delete nextMd[HUMAN_OVERRIDE_KEY];
  // agent 不得伪造/抹掉人手记号：human_edited 只能由人手路径与本守门写。
  if (nextMd) delete nextMd.human_edited;
  const out: PatchLike = { ...patch, ...(nextMd ? { metadata: nextMd } : {}) };
  const blocked: HumanEditableField[] = [];
  const overridden: HumanEditableField[] = [];
  if (edited) {
    for (const field of HUMAN_EDITABLE_FIELDS) {
      if (edited[field] === undefined) continue;
      const incoming = field === "title" ? patch.title : nextMd?.[field];
      const current = field === "title" ? prev.title : prevMd[field];
      if (incoming === undefined || incoming === current) continue;
      if (opts.currentIsAgentView && sameAsTruncatedView(field, incoming, current)) continue;
      if (overrides.has(field)) {
        overridden.push(field);
        continue;
      }
      blocked.push(field);
      if (field === "title") delete out.title;
      else if (out.metadata) delete out.metadata[field];
    }
    if (overridden.length > 0) {
      const rest: HumanEditedFields = { ...edited };
      for (const f of overridden) delete rest[f];
      // 覆盖授权随 patch 往下游带：compile 产出的 update_node 还要过 reducer 同一把守门，
      // 不带就会在 reducer 被二次拦下（下游守门会再剔除此键，不会落进节点）。
      out.metadata = {
        ...(out.metadata ?? {}),
        human_edited: Object.keys(rest).length > 0 ? rest : undefined,
        [HUMAN_OVERRIDE_KEY]: [...overridden],
      };
    }
  }
  return { patch: out as P, blocked, overridden };
}

/** 覆盖留痕：agent 点名覆盖了人手栏位（可审计；用户可据此撤回）。 */
export function humanEditOverriddenMessage(label: string, fields: readonly HumanEditableField[]): string {
  const names = fields.map((f) => (f === "title" ? "标题" : f === "prompt" ? "提示词" : "正文")).join("、");
  return `${label} 按 ${HUMAN_OVERRIDE_KEY} 覆盖了用户手改的${names}（须是用户本轮明确要求；回覆里要向用户说明改了哪一栏）`;
}

/** 回报给 agent / 用户的人话（compile warning 与 reducer 日志同一句）。 */
export function humanEditBlockedMessage(label: string, fields: readonly HumanEditableField[]): string {
  const names = fields.map((f) => (f === "title" ? "标题" : f === "prompt" ? "提示词" : "正文")).join("、");
  return `${label} 的${names}是用户手改过的，已保留用户版本、未覆盖；只有用户本轮明确要求改它时，才在该步 meta.${HUMAN_OVERRIDE_KEY} 里点名栏位（如 ["prompt"]）再写`;
}

/**
 * 整卡守门（2026-11-03，补 3dc273e25 的漏洞）：update_node 只拦栏位覆盖，agent 却可以
 * delete_nodes 删掉人改过的卡、再 add_node 一张「自己版本」的新卡（或 revert_node 退回
 * agent 旧版），人的改动照样消失。人改过（human_edited 非空）或锁定（locked===true）的卡，
 * 删除/回退一律拦下，除非该 op 带 `_override_human`（true 或点名节点 id 清单）——同
 * update_node 的覆盖契约：只在用户本轮明确要求时才可带，且回覆里要说明。
 */
export function isHumanProtectedNode(metadata: unknown): boolean {
  const md = (metadata ?? {}) as Record<string, unknown>;
  return md.locked === true || cleanHumanEdited(md.human_edited) !== undefined;
}

/** op 级覆盖授权：`_override_human: true` 放行全部；字串/阵列＝只放行点名的节点 id。 */
export function opOverridesNode(op: unknown, nodeId: string): boolean {
  const raw = (op as Record<string, unknown> | null | undefined)?.[HUMAN_OVERRIDE_KEY];
  if (raw === true) return true;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.includes(nodeId);
}

export function humanProtectedDeleteMessage(ids: readonly string[], verb: "删除" | "回退" = "删除"): string {
  return `节点 ${ids.join("、")} 是用户手改过或锁定的卡，已拒绝${verb}（删掉再新建也算覆盖人的版本）；只有用户本轮明确要求${verb}它时，才在该 op 上带 ${HUMAN_OVERRIDE_KEY}: true（或点名 id 清单）再发`;
}
