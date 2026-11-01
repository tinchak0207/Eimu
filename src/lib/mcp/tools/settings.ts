/**
 * MCP 设置写入：save_agent_settings（expert 面）＋ eimu_direct 的 thinking_level/beast_mode 前置写入共用。
 *
 * 只投影、不造第二套业务：POST 到与 get_agent_settings 同一 AGENT_SETTINGS_PATH
 * （/api/agent/biz/settings → 网关 /agent/v1/settings，部分更新、缺栏保留旧值、非法值 400）。
 * 栏位白名单与枚举取 `agent-chat-client/types` 真源；thinking_level 展开走
 * AGENT_THINKING_LEVEL_SETTINGS（extreme ＝ thoughtful + premium + beast_mode:true），不手抄。
 */

import {
  AGENT_THINKING_LEVEL_SETTINGS,
  AGENT_THINKING_LEVELS,
  COST_MODES,
  INTERACTION_MODES,
  INTERRUPT_MODES,
  PERSONA_MODES,
  type AgentSettings,
  type AgentThinkingLevel,
} from "@/lib/agent-chat-client/types";
import { machineError, structuredResult, type McpToolCallResult } from "../protocol";
import { AGENT_SETTINGS_PATH } from "./constants";
import type { McpToolContext, ToolInputSchema } from "./types";

type EnumSettingKey = "interrupt_mode" | "persona" | "cost_mode" | "interaction_mode";

const ENUM_SETTING_VALUES: Record<EnumSettingKey, readonly string[]> = {
  interrupt_mode: INTERRUPT_MODES,
  persona: PERSONA_MODES,
  cost_mode: COST_MODES,
  interaction_mode: INTERACTION_MODES,
};

const ENUM_SETTING_KEYS = Object.keys(ENUM_SETTING_VALUES) as EnumSettingKey[];

/** thinking_level / beast_mode 两栏的 schema（eimu_direct 与 save_agent_settings 共用）。 */
export const THINKING_LEVEL_SCHEMA: ToolInputSchema = {
  type: "string",
  enum: [...AGENT_THINKING_LEVELS],
  description:
    "思考档位（与站内「低/中/高/极限」同一张表）：extreme＝极限＝野兽模式（persona=thoughtful、cost_mode=premium、beast_mode=true）。账号级设置，写入后对之后所有会话生效。",
};

export const BEAST_MODE_SCHEMA: ToolInputSchema = {
  type: "boolean",
  description: "野兽模式开关（账号级）。true＝开；false＝关。与 thinking_level 同给时不得矛盾。",
};

export function saveSettingsInputSchema(): ToolInputSchema {
  const properties: Record<string, ToolInputSchema> = {
    thinking_level: THINKING_LEVEL_SCHEMA,
    beast_mode: BEAST_MODE_SCHEMA,
  };
  for (const key of ENUM_SETTING_KEYS) {
    properties[key] = { type: "string", enum: [...ENUM_SETTING_VALUES[key]], description: `${key}（可选）。` };
  }
  return { type: "object", properties, additionalProperties: false };
}

/**
 * 把工具参数收成网关 patch。失败回 machineError（code/message/retryable/next_action）。
 * 只取显式给出的栏位；thinking_level 先展开，再与显式栏位逐栏对账，矛盾即拒（不偷偷谁覆盖谁）。
 */
export function buildAgentSettingsPatch(
  args: Record<string, unknown>,
  keys: readonly string[] = ["thinking_level", "beast_mode", ...ENUM_SETTING_KEYS],
): { ok: true; patch: Partial<AgentSettings>; thinking_level?: AgentThinkingLevel } | { ok: false; error: McpToolCallResult } {
  const invalid = (message: string, next_action = "fix_settings_params") => ({
    ok: false as const,
    error: machineError({ code: "invalid_settings", message, retryable: false, next_action }),
  });

  const patch: Partial<AgentSettings> = {};
  let level: AgentThinkingLevel | undefined;

  if (keys.includes("thinking_level") && args.thinking_level !== undefined) {
    const raw = args.thinking_level;
    if (typeof raw !== "string" || !(AGENT_THINKING_LEVELS as readonly string[]).includes(raw)) {
      return invalid(`thinking_level 只能是 ${AGENT_THINKING_LEVELS.join(" / ")} 之一（收到 ${JSON.stringify(raw)}）`);
    }
    level = raw as AgentThinkingLevel;
    Object.assign(patch, AGENT_THINKING_LEVEL_SETTINGS[level]);
  }

  if (keys.includes("beast_mode") && args.beast_mode !== undefined) {
    if (typeof args.beast_mode !== "boolean") return invalid("beast_mode 必须是布尔值");
    if (level && patch.beast_mode !== args.beast_mode) {
      return invalid(`thinking_level=${level} 对应 beast_mode=${patch.beast_mode}，与 beast_mode=${args.beast_mode} 矛盾；二选一或保持一致`);
    }
    patch.beast_mode = args.beast_mode;
  }

  for (const key of ENUM_SETTING_KEYS) {
    if (!keys.includes(key) || args[key] === undefined) continue;
    const value = args[key];
    const allowed = ENUM_SETTING_VALUES[key];
    if (typeof value !== "string" || !allowed.includes(value)) {
      return invalid(`${key} 只能是 ${allowed.join(" / ")} 之一（收到 ${JSON.stringify(value)}）`);
    }
    const fromLevel = (patch as Record<string, unknown>)[key];
    if (level && fromLevel !== undefined && fromLevel !== value) {
      return invalid(`thinking_level=${level} 对应 ${key}=${String(fromLevel)}，与 ${key}=${value} 矛盾；二选一或保持一致`);
    }
    (patch as Record<string, unknown>)[key] = value;
  }

  return level ? { ok: true, patch, thinking_level: level } : { ok: true, patch };
}

/** POST 设置 patch 到 AGENT_SETTINGS_PATH；成功回网关合并后的整份设置。 */
export async function postAgentSettings(
  patch: Partial<AgentSettings>,
  ctx: McpToolContext,
  toolName: string,
): Promise<{ ok: true; settings: unknown } | { ok: false; error: McpToolCallResult }> {
  const response = await ctx.dispatcher({
    method: "POST",
    path: AGENT_SETTINGS_PATH,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: patch as Record<string, unknown>,
  });
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: machineError({
        code: response.status === 400 ? "invalid_settings" : "settings_save_failed",
        message: `上游 POST ${AGENT_SETTINGS_PATH} 回应 HTTP ${response.status}；设置未生效`,
        retryable: response.status >= 500 || response.status === 429,
        next_action:
          response.status === 401 || response.status === 403
            ? "check_api_key"
            : response.status === 400
              ? "fix_settings_params"
              : "retry_later",
        http_status: response.status,
        body_excerpt: response.text.slice(0, 800),
      }),
    };
  }
  let settings: unknown = null;
  try {
    settings = JSON.parse(response.text);
  } catch {
    settings = response.text;
  }
  return { ok: true, settings };
}

export async function saveAgentSettingsTool(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult> {
  const built = buildAgentSettingsPatch(args);
  if (!built.ok) return built.error;
  if (Object.keys(built.patch).length === 0) {
    return machineError({
      code: "invalid_settings",
      message: "至少给一个设置栏位（thinking_level / beast_mode / interrupt_mode / persona / cost_mode / interaction_mode）",
      retryable: false,
      next_action: "fix_settings_params",
    });
  }
  const saved = await postAgentSettings(built.patch, ctx, "save_agent_settings");
  if (!saved.ok) return saved.error;
  const body = {
    status: "saved",
    ...(built.thinking_level ? { thinking_level: built.thinking_level } : {}),
    applied_patch: built.patch,
    settings: saved.settings,
  };
  return structuredResult(`设置已保存（账号级，之后的会话生效）。\n\n${JSON.stringify(body, null, 2)}`, body);
}
