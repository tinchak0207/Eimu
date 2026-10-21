import type { AgentCanvasNodeConnected, AgentCanvasNodeCreated, AgentDirectorDone, AgentImageDone, AgentQuestionRequest, AgentSseEvent, AgentSteerStatus, AgentToolAuthScope, AgentTurnDone } from "./types-events";
import { AGENT_STEER_STATUSES, isAgentEventName } from "./types-events";
import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";
// ─────────────────────────── 解析（纯函数，可在 node --test 下测）

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 授权范围白名单（与桌面/网关冻结契约逐字对齐）。 */
const AUTH_SCOPES: readonly AgentToolAuthScope[] = ["once", "session", "permanent"];

/**
 * 宽松解析授权三选一选项。上游可能送 `[{scope:"once"},…]`、`["once",…]` 或
 * `{options:[{scope}]}`。只收白名单 scope、去重、保持契约顺序；解析不出 →
 * 回预设三项（宁可让用户看到标准三选一，也不给一个点无可点的空壳）。
 */
export function parseAuthOptions(v: unknown): AgentToolAuthScope[] {
  const raw = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { options?: unknown }).options)
      ? ((v as { options: unknown[] }).options)
      : [];
  const seen = new Set<AgentToolAuthScope>();
  for (const item of raw) {
    const scope = typeof item === "string" ? item : str((item as { scope?: unknown })?.scope);
    if (scope && (AUTH_SCOPES as readonly string[]).includes(scope)) seen.add(scope as AgentToolAuthScope);
  }
  return seen.size > 0 ? AUTH_SCOPES.filter((s) => seen.has(s)) : [];
}

/**
 * 二进位侦测（2026-10-04 缺陷 D，纯函式）：文字样本中 U+FFFD（替换字元）比例。
 * 二进位档被当文字解码 → 大量位元组落成 U+FFFD（实测 64KB 有 21,386 个）。
 * 只要替换字元占比 ≥ 0.5%（且样本 ≥ 64 字元）即判为二进位，**不得当成功内容呈现**。
 * 这是呈现层的最后一道闸；真正的治本在 read_file（gateway/desktop）侧。
 */
export function detectBinaryText(preview: string | undefined): boolean {
  if (typeof preview !== "string" || preview.length < 64) return false;
  let fffd = 0;
  for (let i = 0; i < preview.length; i += 1) {
    if (preview.charCodeAt(i) === 0xfffd) fffd += 1;
  }
  return fffd / preview.length >= 0.005;
}

/**
 * 宽松解析 string[]（turn.plan.experts）。非阵列 / 过滤后为空 → undefined
 * （呼叫方据此决定「不画晶片」）；逐项非字串或空字串一律剔除，绝不 throw。
 */
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * 宽松解析 image.done 附带的 recipe（VPS gateway 附加的真实生成参数）。
 * 白名单只收四个字符串栏位；非物件 / 非字符串一律忽略，绝不 throw。
 */
function recipe(v: unknown): AgentImageDone["recipe"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  const prompt = str(rec.prompt);
  const model = str(rec.model);
  const size = str(rec.size);
  const lora = str(rec.lora);
  if (prompt === undefined && model === undefined && size === undefined && lora === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(lora !== undefined ? { lora } : {}),
  };
}

/**
 * 宽松解析 director.done 的 plan 栏（白名单四栏位；非物件 / 缺核心栏位一律 null，
 * 绝不 throw —— reset/未初始化时本来就是 null）。
 */
function directorPlan(v: unknown): AgentDirectorDone["plan"] {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const id = str(p.id);
  const name = str(p.name);
  const shotCount = num(p.shot_count);
  if (!id || !name || shotCount === undefined) return null;
  return { id, name, summary: str(p.summary) ?? "", shot_count: shotCount };
}

/** 宽松解析 director.done 的 active_shot 栏。缺核心栏位回 null。 */
function directorActiveShot(v: unknown): AgentDirectorDone["active_shot"] {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const no = num(s.no);
  const name = str(s.name);
  if (no === undefined || !name) return null;
  return {
    no,
    name,
    duration_frames: num(s.duration_frames) ?? 0,
    camera_move: str(s.camera_move) ?? "",
    shot_scale: str(s.shot_scale) ?? null,
  };
}

/** 宽松解析 director.done 的 health.issues（白名单栏位逐项收敛，坏项跳过）。 */
function directorIssues(v: unknown): AgentDirectorDone["health"]["issues"] {
  if (!Array.isArray(v)) return [];
  const out: AgentDirectorDone["health"]["issues"] = [];
  for (const it of v) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const code = str(rec.code);
    const message = str(rec.message);
    const shotId = str(rec.shot_id);
    out.push({
      code: code ?? "",
      message: message ?? "",
      ...(shotId ? { shot_id: shotId } : {}),
    });
  }
  return out;
}

/**
 * 把一帧 SSE 解析成判别联合；任何不合契约的输入回 null（呼叫方直接丢弃该帧）。
 *
 * 为什么「丢弃」而不是「抛错」：SSE 是长连线，一帧坏掉不该让整条流断掉，
 * 更不该让已经渲染好的对话消失。坏帧在此静默落地，序号照样被上层记录，
 * 这样重连时不会反复重放同一帧坏数据。
 */
export function parseAgentSseEvent(name: string, rawData: string): AgentSseEvent | null {
  if (!isAgentEventName(name)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;

  // event_id 缺失是允许的（例如手动 /internal 注入的边角情况），退化成 0 表示
  // 「不参与续传计算」，而不是把整帧丢掉。
  const eventId = num(d.event_id) ?? 0;

  switch (name) {
    case "message.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "reasoning.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "tool.invoke": {
      const tool = str(d.tool);
      if (!tool) return null;
      return { name, event_id: eventId, data: { tool, args_summary: str(d.args_summary) } };
    }
    case "tool.progress": {
      const tool = str(d.tool);
      const done = num(d.done);
      const total = num(d.total);
      // 进度帧必须自洽：有工具名、done/total 为有限数、total>0、done 非负。
      // 任一不满足直接丢弃（宁可不显示进度，也不显示假的 X/N）。
      if (!tool || done === undefined || total === undefined || total <= 0 || done < 0) return null;
      const label = str(d.label);
      return { name, event_id: eventId, data: { tool, done, total, ...(label ? { label } : {}) } };
    }
    case "tool.result": {
      const tool = str(d.tool);
      if (!tool) return null;
      const rawErr = d.error as
        | { code?: unknown; human_message?: unknown; message?: unknown; action_required?: unknown; root?: unknown; reason?: unknown; options?: unknown }
        | undefined;
      const error =
        rawErr && typeof rawErr === "object"
          ? {
              code: str((rawErr as { code?: unknown }).code),
              message: str(rawErr.message),
              human_message: str(rawErr.human_message),
              action_required: str((rawErr as { action_required?: unknown }).action_required),
              root: str((rawErr as { root?: unknown }).root),
              reason: str((rawErr as { reason?: unknown }).reason),
              options: (rawErr as { options?: unknown }).options,
            }
          : undefined;
      // 授权载荷可能在 error 内，也可能在顶层（不同上游版本）；两处都收。
      const actionRequired = str(d.action_required) ?? error?.action_required;
      const authRoot = str(d.auth_root) ?? error?.root;
      const authReason = str(d.auth_reason) ?? error?.reason;
      const authOptions = parseAuthOptions(d.auth_options ?? error?.options);
      return {
        name,
        event_id: eventId,
        data: {
          tool,
          ok: d.ok === true,
          cost_coins: num(d.cost_coins),
          task_id: str(d.task_id),
          artifact_pending: d.artifact_pending === true,
          error,
          ...(actionRequired ? { action_required: actionRequired } : {}),
          ...(authRoot ? { auth_root: authRoot } : {}),
          ...(authReason ? { auth_reason: authReason } : {}),
          ...(authOptions.length > 0 ? { auth_options: authOptions } : {}),
          ...(d.binary === true ? { binary: true } : {}),
          ...(d.truncated === true ? { truncated: true } : {}),
          ...(num(d.bytes_read) !== undefined ? { bytes_read: num(d.bytes_read) } : {}),
          ...(num(d.bytes_total) !== undefined ? { bytes_total: num(d.bytes_total) } : {}),
          ...(str(d.preview) !== undefined ? { preview: str(d.preview) } : {}),
        },
      };
    }
    case "image.done": {
      const url = str(d.url);
      if (!url) return null;
      return { name, event_id: eventId, data: { url, cost_coins: num(d.cost_coins), task_id: str(d.task_id), recipe: recipe(d.recipe) } };
    }
    case "video.done": {
      const url = str(d.url);
      if (!url) return null;
      const mk = d.media_kind === "film" ? "film" : d.media_kind === "video" ? "video" : undefined;
      return { name, event_id: eventId, data: { url, cost_coins: num(d.cost_coins), task_id: str(d.task_id), ...(mk ? { media_kind: mk } : {}) } };
    }
    case "audio.done": {
      const url = str(d.url);
      if (!url) return null;
      const mk = d.media_kind === "music" ? "music" : d.media_kind === "audio" ? "audio" : undefined;
      // title / cover / lyric_status 是网关可选补栏位：可能还没落地（缺字段一律 undefined，
      // 不崩、不伪造）。空字串视同缺席，避免卡片渲染出空标题/破图。
      const title = str(d.title);
      const cover = str(d.cover);
      const lyricStatus = str(d.lyric_status);
      return {
        name,
        event_id: eventId,
        data: {
          url,
          cost_coins: num(d.cost_coins),
          task_id: str(d.task_id),
          ...(mk ? { media_kind: mk } : {}),
          ...(title ? { title } : {}),
          ...(cover ? { cover } : {}),
          ...(lyricStatus ? { lyric_status: lyricStatus } : {}),
        },
      };
    }
    case "image.failed": {
      // task_id 可能缺（防御性）：帧仍要送达，settler 按序兜底配对。
      return {
        name,
        event_id: eventId,
        data: { task_id: str(d.task_id), reason: str(d.reason), refunded: d.refunded === true, human_message: str(d.human_message) },
      };
    }
    case "director.done": {
      // 契约核心栏位 = session_id + revision（revision 是活卡替换的依据，缺失整帧丢弃）。
      // schematic/health/counts/plan/active_shot 全部走宽松解析：网关少送一律当
      // undefined/null 处理，坏帧不该让整条对话白屏。
      const sid = str(d.session_id);
      const revision = num(d.revision);
      if (!sid || revision === undefined) return null;
      const rawSchematic = d.schematic as Record<string, unknown> | undefined;
      const rawHealth = d.health as Record<string, unknown> | undefined;
      const rawCounts = d.counts as Record<string, unknown> | undefined;
      return {
        name,
        event_id: eventId,
        data: {
          session_id: sid,
          revision,
          action: str(d.action) ?? "",
          plan: directorPlan(d.plan),
          active_shot: directorActiveShot(d.active_shot),
          schematic: {
            top_view_svg: str(rawSchematic?.top_view_svg) ?? "",
            camera_view_svg: str(rawSchematic?.camera_view_svg) ?? "",
          },
          health: {
            ok: rawHealth?.ok === true,
            issues: directorIssues(rawHealth?.issues),
          },
          counts: {
            shots: num(rawCounts?.shots) ?? 0,
            elements: num(rawCounts?.elements) ?? 0,
            actions: num(rawCounts?.actions) ?? 0,
          },
        },
      };
    }
    case "turn.done":
      return { name, event_id: eventId, data: {} as AgentTurnDone };
    case "turn.status": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "context.compacted": {
      const trigger = d.trigger === "manual" ? "manual" : "auto";
      return { name, event_id: eventId, data: { trigger, preTokens: num(d.preTokens) } };
    }
    case "turn.plan": {
      // plan 是唯一必需栏位：空字串／缺栏位／非字串一律整帧丢弃（丢半张计画卡
      // 等于画一张空话卡）。其余栏位走白名单宽松解析，坏值折成 undefined 不 throw。
      const plan = str(d.plan);
      if (!plan || plan.trim().length === 0) return null;
      const experts = strArray(d.experts);
      // provisional 预设 true：只有明确 === false 才是 false（缺栏位当「还在进行中」，
      // 这是保守诚实的一侧——计画刚到时本来就还没定案）。
      const sup = d.superseded === true;
      const src = d.source === "model" || d.source === "rule" ? (d.source as "model" | "rule") : undefined;
      return {
        name,
        event_id: eventId,
        data: {
          plan,
          ...(experts ? { experts } : {}),
          provisional: d.provisional !== false,
          ...(src ? { source: src } : {}),
          ...(str(d.model) ? { model: str(d.model) } : {}),
          ...(sup ? { superseded: true } : {}),
        },
      };
    }
    case "confirm.request": {
      const requestId = str(d.request_id);
      const amount = num(d.amount_coins);
      if (!requestId || amount === undefined) return null;
      return { name, event_id: eventId, data: { request_id: requestId, amount_coins: amount, description: str(d.description) } };
    }
    case "confirm.resolved": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      // 只有 auto===true 才保留该键，人工裁决不带（避免把缺失值规约成噪音字段）。
      return { name, event_id: eventId, data: { request_id: requestId, approved: d.approved === true, ...(d.auto === true ? { auto: true } : {}) } };
    }
    case "quota.changed": {
      const balance = num(d.balance_coins);
      return {
        name,
        event_id: eventId,
        data: {
          balance_coins: balance ?? null,
          currency: str(d.currency) ?? "coins",
          available: d.available === true,
          ...(typeof d.spendable === "boolean" ? { spendable: d.spendable } : {}),
          reason: str(d.reason),
        },
      };
    }
    case "session.error": {
      return {
        name,
        event_id: eventId,
        data: {
          code: str(d.code) ?? "backend_error",
          message: str(d.message) ?? "会话发生未知错误。",
          human_message: str(d.human_message),
        },
      };
    }
    case "session.closed":
      return { name, event_id: eventId, data: { reason: str(d.reason) } };
    case "canvas.plan":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          tool: str(d.tool) ?? "",
          label: str(d.label) ?? "",
          prompt: str(d.prompt) ?? "",
          model: str(d.model) ?? "",
          size: str(d.size) ?? "",
          count: num(d.count) ?? 1,
          kind: str(d.kind) ?? "image",
          source_image: str(d.source_image) ?? null,
          cost_hint: num(d.cost_hint) ?? null,
        },
      };
    case "canvas.node.created":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node: (d.node as AgentCanvasNodeCreated["node"]) ?? { id: "", type: "", title: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.updated":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          patch: (d.patch as Record<string, unknown>) ?? {},
          ...(str(d.url) ? { url: str(d.url) } : {}),
          ...(num(d.cost_coins) !== undefined ? { cost_coins: num(d.cost_coins) } : {}),
        },
      };
    case "canvas.node.connected":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          connection: (d.connection as AgentCanvasNodeConnected["connection"]) ?? { id: "", fromNodeId: "", toNodeId: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.generating":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          status: str(d.status) ?? "running",
          ...(num(d.progress) !== undefined ? { progress: num(d.progress) } : {}),
        },
      };
    case "canvas.node.deleted":
      return { name, event_id: eventId, data: { unit_id: str(d.unit_id) ?? "", ...(str(d.node_id) ? { node_id: str(d.node_id) } : {}) } };
    case "canvas.node.disconnected":
      return { name, event_id: eventId, data: { unit_id: str(d.unit_id) ?? "", from: str(d.from) ?? "", to: str(d.to) ?? "" } };
    case "canvas.derive.started":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          source_node_id: str(d.source_node_id) ?? "",
          instruction: str(d.instruction) ?? "",
          ...(str(d.interpretation) ? { interpretation: str(d.interpretation) } : {}),
        },
      };
    case "canvas.budget.updated":
      return {
        name,
        event_id: eventId,
        data: {
          ...(str(d.unit_id) ? { unit_id: str(d.unit_id) } : {}),
          used_coins: num(d.used_coins) ?? 0,
          remaining_coins: num(d.remaining_coins) ?? 0,
        },
      };
    case "canvas.ops": {
      const requestId = str(d.request_id);
      const ops = d.ops;
      if (!requestId || !Array.isArray(ops)) return null;
      return {
        name,
        event_id: eventId,
        data: {
          request_id: requestId,
          ops: ops as CanvasAgentOpsEvent["ops"],
          ...(str(d.label) ? { label: str(d.label) } : {}),
        },
      };
    }
    case "subagent.started": {
      const id = str(d.id);
      if (!id) return null;
      return { name, event_id: eventId, data: { id, label: str(d.label) ?? "子任务" } };
    }
    case "subagent.delta": {
      const id = str(d.id);
      if (!id) return null;
      // kind 白名单单值：只认 "reasoning"（思维链）；其余（含缺省）一律当正文。
      // 认不得的值折成 undefined 而不是整帧丢弃——宁可少一个活动字，不少一段交付物。
      const kind = d.kind === "reasoning" ? ("reasoning" as const) : undefined;
      return { name, event_id: eventId, data: { id, text: str(d.text) ?? "", ...(kind ? { kind } : {}) } };
    }
    case "subagent.done": {
      const id = str(d.id);
      // status 是核心栏位：不属于合同值域的帧不合合同，整帧丢弃。
      // stopped＝人工停止成功（2026-09-20 gateway 契约），同为合法核心栏位。
      const status =
        d.status === "ok"
          ? ("ok" as const)
          : d.status === "error"
            ? ("error" as const)
            : d.status === "stopped"
              ? ("stopped" as const)
              : undefined;
      if (!id || !status) return null;
      return { name, event_id: eventId, data: { id, status, summary: str(d.summary) } };
    }
    case "subagent.tool": {
      const id = str(d.id);
      const callId = str(d.call_id);
      const tool = str(d.tool);
      // id / call_id / tool 必须是非空字串，status 必须是合同三值之一；
      // 任一不满足整帧丢弃（既有「宁缺勿假·非法帧一律丢弃」纪律）。
      const status =
        d.status === "running"
          ? ("running" as const)
          : d.status === "ok"
            ? ("ok" as const)
            : d.status === "failed"
              ? ("failed" as const)
              : undefined;
      if (!id || !callId || !tool || !status) return null;
      return { name, event_id: eventId, data: { id, call_id: callId, tool, status } };
    }
    case "question.request": {
      const requestId = str(d.request_id);
      const questions = parseQuestionItems(d.questions);
      if (!requestId || !questions) return null;
      return { name, event_id: eventId, data: { request_id: requestId, questions } };
    }
    case "question.replied": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, answer: str(d.answer) ?? "" } };
    }
    case "question.rejected": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, reason: str(d.reason) ?? "" } };
    }
    case "steer.status": {
      const steerId = str(d.steer_id);
      const status = parseSteerStatus(d.status);
      // 核心栏位（id + 状态）缺一即整帧丢弃：认不得的状态宁可不上屏，不猜。
      if (!steerId || !status) return null;
      const position = num(d.position);
      return {
        name,
        event_id: eventId,
        data: {
          steer_id: steerId,
          status,
          ...(typeof position === "number" ? { position } : {}),
          ...(str(d.text) ? { text: str(d.text) } : {}),
          ...(str(d.reason) ? { reason: str(d.reason) } : {}),
        },
      };
    }
  }
}
function parseSteerStatus(raw: unknown): AgentSteerStatus | undefined {
  return typeof raw === "string" && (AGENT_STEER_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSteerStatus)
    : undefined;
}

function parseQuestionItems(raw: unknown): AgentQuestionRequest["questions"] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AgentQuestionRequest["questions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const question = str(rec.question);
    if (!question) return null;
    const optionsRaw = rec.options;
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(optionsRaw)) {
      for (const opt of optionsRaw) {
        if (!opt || typeof opt !== "object") continue;
        const label = str((opt as Record<string, unknown>).label);
        if (!label) continue;
        const description = str((opt as Record<string, unknown>).description);
        options.push(description ? { label, description } : { label });
      }
    }
    const header = str(rec.header);
    out.push(header ? { question, header, options } : { question, options });
  }
  return out.length > 0 ? out : null;
}
