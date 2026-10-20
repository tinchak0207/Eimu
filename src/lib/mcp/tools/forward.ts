import { textResult, truncateToolText } from "../protocol";
import { pickString } from "./helpers";
import type { McpToolCallResult, McpToolContext } from "./types";
import { isPlainObject } from "./validation";

/** 一条转发工具的全部资讯：目标端点 + body 投影（投影只做挑栏位，不改语义）。 */
interface ForwardSpec {
  method: "GET" | "POST";
  path: string | ((args: Record<string, unknown>) => string);
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
}

export async function runForward(
  spec: ForwardSpec,
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<McpToolCallResult> {
  const path = typeof spec.path === "function" ? spec.path(args) : spec.path;
  const response = await ctx.dispatcher({
    method: spec.method,
    path,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: spec.body ? spec.body(args) : undefined,
  });

  const text = truncateToolText(response.text);
  if (response.status >= 200 && response.status < 300) return textResult(text);
  return textResult(`上游 ${spec.method} ${path} 回应 HTTP ${response.status}：\n${text}`, true);
}

/**
 * 读面转发：错误语义与 `runForward` 逐字一致（上游非 2xx 回原文 isError），
 * 差别只在成功时把上游 JSON **投影**出需要的栏位（只挑栏位/过滤，不重算、不改语义——
 * 与 `runListSkills`/`runGetSkill` 同层）。投影或解析失败一律回原文，绝不把上游回应弄丢。
 */
export async function runForwardProjected(
  spec: ForwardSpec,
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
  project: (payload: unknown) => unknown,
): Promise<McpToolCallResult> {
  const path = typeof spec.path === "function" ? spec.path(args) : spec.path;
  const response = await ctx.dispatcher({
    method: spec.method,
    path,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: spec.body ? spec.body(args) : undefined,
  });

  const text = truncateToolText(response.text);
  if (response.status < 200 || response.status >= 300) {
    return textResult(`上游 ${spec.method} ${path} 回应 HTTP ${response.status}：\n${text}`, true);
  }
  try {
    return textResult(JSON.stringify(project(JSON.parse(response.text)), null, 2));
  } catch {
    return textResult(text);
  }
}

/** 画布快照端点（B 端 key 经 `/api/agent/biz` 代理到 agent 闸道）的站内路径。 */
export function canvasStatePath(args: Record<string, unknown>): string {
  const sessionId = pickString(args, "session_id") ?? "";
  return `/api/agent/biz/sessions/${encodeURIComponent(sessionId)}/canvas/state`;
}

/** 从闸道快照回应挑出 `state`（快照本体）；非物件回空物件。 */
export function snapshotState(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) return {};
  const state = (payload as { state?: unknown }).state;
  return isPlainObject(state) ? state : {};
}
