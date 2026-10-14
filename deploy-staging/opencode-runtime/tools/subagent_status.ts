import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// 网关新追加的只增栏位（照 §3.2 C1）：存在才透传，缺省不出现在回执里，
// 既有栏位语义一律不动。
// R4（2026-10-14）：以 handleSubagentStatus 运行中分支**实际构造的键**为准逐行核对补全
// （gateway subagent.ts 的 `for (const run of byChildOc.values())` 分支）——新增
// child_path/parent_subagent_id/resumed_from/last_tool/pending_parent_messages/notes_count/pending_questions。
const LIVE_FIELDS = [
  "phase",
  "child_path",
  "parent_subagent_id",
  "resumed_from",
  "tools",
  "last_tool",
  "text_tail",
  "artifacts",
  "silent_ms",
  "transcript_path",
  "artifact_path",
  "model",
  "attempt",
  "resumable",
  "current_turn_id",
  "pending_parent_messages",
  "notes_count",
  "pending_questions",
  "last_checkpoint",
  "checkpoints_count",
  "from_checkpoint",
  "suspension",
] as const

// 终态成败映射——**真源＝gateway types-gateway.ts 的 TASK_STATUS_SEMANTICS**（2026-10-14 逐值核对，
// 该表 `isFailure` 字段是唯一判据）：
//   ok→false｜error→true｜stopped→false（人工停止不是失败，见 memory stopped-status-not-failure-0920）｜
//   running→false（非终态）｜interrupted→false（一等非终态，可再收输入）｜suspended→false（主动挂起交出并发槽，非失败）。
// gateway 的 TaskStatus 枚举本身没有 "timeout"：超时终态以 status:"error" 收尾（finishRun 传 "error"）；
// 但**过期产物档**的头部状态行会写 "timeout"/"partial"（persistRunOutput 的 effStatus，被
// findPersistedArtifact 抽出）⇒ 本表额外收录这两个产物层状态（timeout=失败、partial=非失败的部分结果）。
const STATUS_IS_FAILURE: Record<string, boolean> = {
  ok: false,
  error: true,
  stopped: false,
  running: false,
  interrupted: false,
  suspended: false,
  timeout: true,
  partial: false,
}

function pickLive(data: any, keys: readonly string[], skip: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (skip.includes(k)) continue
    if (data?.[k] !== undefined) out[k] = data[k]
  }
  return out
}

export default tool({
  description: [
    "查询已派出子代理（subagent）的运行状态/结果。用于：async 派出后查进度、判断多个并行子代理是否到齐、唤醒过后复核摘要。",
    "`subagent_id` 传 subagent_dispatch 返回的完整 run id；也可传 `latest` 取得本会话最近一次 run（不必记住 id）。也支持 label 前缀，命中多笔会回候选清单（此时请用完整 runId 重查）。",
    "返回运行中（done=false，含已耗时）或终态（done=true）。终态成败以 `status` 判定：`ok`＝成功（`summary` 为交付文本）；`error`（含超时）＝**失败**，会如实带 `error`/`summary`/`reason`/`partial`/`artifacts`；`stopped`＝**人工停止、不是失败**（回成功回执并说明可否续跑）。结果在网关侧保留 10 分钟，过期会报「不存在或已过期」并附最近 3 笔 run 供你改用；已落盘的产物会附 artifact_path，直接 read 验收，不要重派。",
    "若只是等后台子代理完成，可结束本轮由自动唤醒回灌；也可按需轮询——轮询不会被禁用，但同一 id 连续同参数轮询超过阈值会收到「改变参数或停止」的工具层提示。",
    "终态记录会带 `artifacts`（该子代理已产出的成品 URL 清单），失败/超时也带——先读它再决定要不要重派。任何终态都会附 `artifact_path`（完整产物档）/`transcript_path`（工作日志档），可直接 read 验收，不要重派。",
    "`status` 可能是 `interrupted` 或 `suspended`：**这都不是失败、也不是终态**——`interrupted` 表示当前那一轮被打断了、会话还在，可以继续用 `subagent_message` 追加指令让它接着跑；`suspended` 表示子代理主动挂起交出并发槽等待异步任务完成，可在条件满足时用 `subagent_resume` 恢复它。",
    "运行中还会带 `phase`（当前阶段，如 running/suspended/awaiting_input/wrapping_up）、`tools`（工具时间线）、`last_tool`（当前工具）、`text_tail`（正文尾部）、`silent_ms`（静默时长）、`transcript_path`（可 read 的实时工作日志档路径）、`model`/`attempt`/`resumable`/`current_turn_id`、`child_path`（人可读寻址路径，形如 /root/<label>-<id>）、`last_checkpoint`/`checkpoints_count`（阶段检查点）、`suspension`（挂起状态信息）、`pending_parent_messages`（在途排队给它的消息数）/`notes_count`（它未读的回报数）。要判断它是「正常在跑」还是「跑偏」，看 `tools`/`text_tail`/`silent_ms` 与 transcript_path 的实况，而不是只看耗时。",
    "`pending_questions`（仅当它登记了阻塞式提问时出现）＝`[{ question_id, header, is_blocking, resolve_by }]`：要回答其中一条，用 subagent_message 带 `kind:\"question\"` 与取自该清单的 `question_id`（网关只按 id 精确解除）。",
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("subagent_dispatch 返回的完整 subagent_id，或 `latest`（本会话最近一次 run），或 label 前缀（必填；缺失会被拒并回传示例）"),
  },
  async execute(args, context) {
    const id = typeof args.subagent_id === "string" ? args.subagent_id.trim() : ""
    if (!id) {
      return fail(
        "missing_required_args",
        "subagent_status 缺少必填字段：subagent_id。请传 subagent_dispatch 返回的 run id，或传 \"latest\" 取本会话最近一次 run。示例：{\"subagent_id\":\"latest\"}",
        { missing: ["subagent_id"], example: { subagent_id: "latest" } },
      )
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: context.sessionID, subagent_id: id }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "not_found",
          data?.error || `HTTP ${res.status}`,
          {
            http_status: res.status,
            // D4：网关的 not_found 会附最近 3 笔 run（含 id/状态/label）。结构化透传，
            // 让模型不必从句子里捞 id 就能改用正确的一笔（或改传 latest）。
            ...(Array.isArray(data?.recent_runs) ? { recent_runs: data.recent_runs } : {}),
          },
        )
      }
      // label 前缀命中多笔：回候选清单（不是假 not_found）。
      if (data.multiple === true) {
        return ok({
          title: "命中多笔子代理",
          multiple: true,
          candidates: Array.isArray(data.candidates) ? data.candidates : [],
          note: typeof data.note === "string" ? data.note : "label 前缀命中多笔，请用完整 runId 重查。",
        })
      }
      // R1（2026-10-14）：**终态必须先判**（data.done===true），否则 artifact_path 分支会劫走
      // 所有自然终态——gateway 的 finishRun 对**所有**终态都写 artifactPath，旧顺序使 done 分支
      // 成死码，`error`/`summary` 全丢、失败被伪装成「记录已过期但产物在盘」。终态里
      // transcript_path/artifact_path 只是**追加**的路径指针（pickLive 已含这两键），不取代终态判定。
      if (data.done === true) {
        const status = typeof data.status === "string" && data.status ? data.status : "ok"
        const artifacts = Array.isArray(data.artifacts) ? data.artifacts : undefined
        const live = pickLive(data, LIVE_FIELDS, ["artifacts"])
        const gatewayNote = typeof data.note === "string" && data.note ? data.note : undefined
        // 非失败终态（TASK_STATUS_SEMANTICS.isFailure=false）：ok / stopped / interrupted。
        if (STATUS_IS_FAILURE[status] !== true) {
          const note =
            status === "stopped"
              ? "已停止（非失败）：成果按停时快照保留；若仍在接续窗口内，可用 subagent_message 追加指令续跑，不必重新派遣。"
              : status === "interrupted"
                ? "已中断（非终态）：可用 subagent_message 追加指令让它继续，或等它自行收尾。"
                : gatewayNote
          const title =
            status === "stopped"
              ? "子代理已停止（非失败，可续跑）"
              : status === "interrupted"
                ? "子代理已中断（非终态，可继续）"
                : "子代理已完成"
          return ok({
            title,
            status,
            summary: data.summary ?? "",
            ...(artifacts ? { artifacts } : {}),
            ...live,
            ...(note ? { note } : {}),
          })
        }
        // 失败终态（error/timeout）：error/summary/reason/partial/artifacts 必须如实透出；
        // code 用 gateway 的（现状缺省 subagent_error）。
        return fail(typeof data.code === "string" && data.code ? data.code : "subagent_error", data.error || data.summary || "子代理失败", {
          status,
          done: true,
          ...(data.summary ? { summary: data.summary } : {}),
          ...(data.reason ? { reason: data.reason } : {}),
          ...(data.partial ? { partial: true } : {}),
          ...(artifacts ? { artifacts } : {}),
          ...live,
          ...(gatewayNote ? { note: gatewayNote } : {}),
        })
      }
      // R1(c)：只有当记录**真的已过期**（!done）且有产物在盘时才走这条——给路径让调用方直接验收。
      // 若过期记录带失败状态（status error/timeout），如实判失败，**不把 error 伪装成 ok**。
      if (!data.done && data.artifact_path) {
        const expStatus = typeof data.status === "string" && data.status ? data.status : "unknown"
        const base = {
          status: expStatus,
          label: data.label ?? "",
          artifact_path: data.artifact_path,
          ...(data.artifact_bytes !== undefined ? { artifact_bytes: data.artifact_bytes } : {}),
          ...(data.artifact_mtime !== undefined ? { artifact_mtime: data.artifact_mtime } : {}),
          ...pickLive(data, LIVE_FIELDS, ["artifacts", "artifact_path"]),
        }
        const note = typeof data.note === "string" && data.note ? data.note : "run 记录已过期但产物已落盘：直接 read 该路径验收，勿重派。"
        if (STATUS_IS_FAILURE[expStatus] === true) {
          return fail("subagent_error", `子代理记录已过期（状态：${expStatus}），产物在盘：${data.artifact_path}`, { ...base, note })
        }
        return ok({ title: "子代理记录已过期（产物在盘）", ...base, note })
      }
      // 运行中（或 interrupted 非终态）：status 由网关给，缺省回退 running（未变）。
      const liveStatus = typeof data.status === "string" && data.status ? data.status : "running"
      return ok({
        title: liveStatus === "interrupted" ? "子代理已中断（非终态）" : "子代理运行中",
        subagent_id: data.subagent_id ?? id,
        status: liveStatus,
        label: data.label ?? "",
        elapsed_ms: data.elapsed_ms ?? 0,
        ...pickLive(data, LIVE_FIELDS),
        note:
          liveStatus === "interrupted"
            ? "已中断，但不是失败、也不是终态：可用 subagent_message 追加指令让它继续，或等它自行收尾。"
            : "仍在运行。可按需再查，或结束本轮等自动唤醒。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
