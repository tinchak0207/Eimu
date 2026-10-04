import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

// local_files_authorize — 本机档案桥（W6）的**授权落地工具**。
//
// 当 local_files 回传 action_required=authorize_local_files（error.code=needs_authorization）
// 时，模型必须先把三段式选项逐字列给使用者、等他**明确选一个**，才能呼叫本工具把规则落下去。
// 本工具只做一件事：把使用者选定的 {scope, root} 原样 POST 给闸道 /internal/device/authorize。
// 不得自行决定 scope，尤其不得未经同意升级成 permanent。
//
// 契约（冻结，与 gateway device-bridge.ts 一对一）：
//   POST /internal/device/authorize?session_id=…  body {scope, root, tool?}
//   200: { ok: true, applied: {scope, root}, rules: [...], persist_on_device?: true }
//   错误: { ok:false, error:{ code, message } }  code ∈ bad_request|session_unknown|
//         root_not_absolute|root_too_broad|denylisted_root

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

const SCOPES = ["once", "session", "permanent"] as const;

/**
 * 授权端点错误码 → 面向使用者的繁中引导语。
 * 其余码（internal_error 等）原样带出闸道 message。
 */
const GUIDANCE: Record<string, string> = {
  bad_request: "授权请求格式不正确，请确认 scope 与 root 后再试。",
  session_unknown: "这个对话已失效，请重新开始对话后再试一次。",
  root_not_absolute: "请提供绝对路径。",
  root_too_broad: "这个范围太宽（例如整个家目录或根目录），请指定更具体的资料夹。",
  denylisted_root: "该位置属硬性禁止，不能授权。",
};

export default tool({
  description:
    "把使用者对本机档案路径的授权决定**落到规则**（本机档案桥）。" +
    "**只在使用者明确同意之后才可呼叫**：当 local_files 回传 action_required=authorize_local_files 时，" +
    "先把三段式选项逐字列给使用者，等他回答后，把**他选的那一个 scope** 原样传进来。" +
    "scope：once＝只允许这一次（用完即失效）；session＝本会话允许此目录；permanent＝永久允许（加入本机授权清单）。" +
    "root 用 local_files 回传里建议的 root。" +
    "**不得**自行决定 scope，**不得**擅自把 once/session 升级成 permanent；" +
    "使用者的授权范围疑义一律回去问他。" +
    "若回传显示该位置属硬性禁止（denylisted_root）或范围太宽（root_too_broad），把引导语照实转达，不要重试。",
  args: {
    scope: tool.schema
      .enum(["once", "session", "permanent"])
      .describe(
        "授权范围，必须是使用者从三个选项中选定的那一个，不得自行改动：once（允许一次）、session（本会话允许此目录）、permanent（永久允许）。",
      ),
    root: tool.schema
      .string()
      .describe("要授权的资料夹绝对路径（用 local_files 回传里建议的 root）。"),
    tool: tool.schema
      .string()
      .optional()
      .describe("选填：限定此授权只给某个工具使用；一般不需要带。"),
  },
  async execute(args, context) {
    const scope = args.scope;
    if (!(SCOPES as readonly string[]).includes(scope)) {
      return fail(
        "bad_request",
        `不支援的授权范围：${String(scope)}（仅限 once/session/permanent）。`,
      );
    }
    if (typeof args.root !== "string" || !args.root.trim()) {
      return fail("bad_request", "需要提供要授权的资料夹绝对路径（root）。");
    }

    const body: Record<string, unknown> = { scope, root: args.root };
    if (args.tool !== undefined) body.tool = args.tool;

    let res: Response;
    try {
      res = await fetch(
        `${GATEWAY}/internal/device/authorize?session_id=${encodeURIComponent(context.sessionID)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (e) {
      return fail("internal_error", `无法连上本机档案闸道：${(e as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data?.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      const code = typeof err.code === "string" && err.code ? err.code : "internal_error";
      const rawMessage =
        typeof err.message === "string" && err.message
          ? err.message
          : `授权本机档案失败（HTTP ${res.status}）。`;
      return fail(code, GUIDANCE[code] ?? rawMessage);
    }

    const applied = (data.applied ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      op: "authorize_local_files",
      applied,
      note: "已授权。下一次读取会自动放行（once 为一次性，用完即失效）。",
    };
    if (typeof data.persist_on_device === "boolean") payload.persist_on_device = data.persist_on_device;
    if (data.rules !== undefined) payload.rules = data.rules;
    return ok(payload);
  },
});