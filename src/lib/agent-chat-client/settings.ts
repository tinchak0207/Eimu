import type { AgentCostMode, AgentInteractionMode, AgentInterruptMode, AgentPersonaMode, AgentSettings, AgentThinkingLevel } from "./types";
import { AGENT_SETTINGS_STORAGE_KEY, COST_MODES, DEFAULT_AGENT_SETTINGS, INTERACTION_MODES, INTERRUPT_MODES, PERSONA_MODES, AGENT_THINKING_LEVELS, AGENT_THINKING_LEVEL_SETTINGS, AGENT_THINKING_LEVEL_STORAGE_KEY } from "./types";
import { agentFetch } from "./auth";
/** 逐字段白名单校验：localStorage 与网关的脏数据一律落回默认值。 */
function sanitizeAgentSettings(raw: unknown): AgentSettings {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    interrupt_mode: INTERRUPT_MODES.includes(d.interrupt_mode as AgentInterruptMode)
      ? (d.interrupt_mode as AgentInterruptMode)
      : DEFAULT_AGENT_SETTINGS.interrupt_mode,
    persona: PERSONA_MODES.includes(d.persona as AgentPersonaMode)
      ? (d.persona as AgentPersonaMode)
      : DEFAULT_AGENT_SETTINGS.persona,
    cost_mode: COST_MODES.includes(d.cost_mode as AgentCostMode)
      ? (d.cost_mode as AgentCostMode)
      : DEFAULT_AGENT_SETTINGS.cost_mode,
    interaction_mode: INTERACTION_MODES.includes(d.interaction_mode as AgentInteractionMode)
      ? (d.interaction_mode as AgentInteractionMode)
      : DEFAULT_AGENT_SETTINGS.interaction_mode,
    // beast_mode：布尔白名单（=== true 才为 ON，其余脏数据一律默认 OFF）。
    beast_mode: d.beast_mode === true,
  };
}

/**
 * 同步读本地缓存（无窗口环境 / 脏数据 / 缺项都回默认值）。
 * send() 发送前即时读它拿 interrupt_mode —— 零网络，不阻塞发送。
 */
export function readCachedAgentSettings(): AgentSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AGENT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(AGENT_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    return sanitizeAgentSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

/** 只写本地缓存（不触网）。设定弹层改值与挂载回读合并共用这条落盘路径。 */
export function writeCachedAgentSettings(settings: AgentSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeAgentSettings(settings)));
  } catch {
    // 隐私模式等写入失败：只影响下次冷启动的初值，不挡聊天。
  }
}

/**
 * 设定读写结果（2026-10-31 修复「默认值覆盖服务端」）：失败是显式状态，不再伪装成默认值。
 * 旧实现 GET 失败静默回 DEFAULT_AGENT_SETTINGS，调用方把它写进缓存，随后任意改动把整份
 * 默认值 POST 回网关 ⇒ 用户账号 beast_mode 等栏位被默认值覆盖（10-29 17:19:28 SGT 实案）。
 */
export type AgentSettingsResult =
  | { ok: true; settings: AgentSettings }
  | { ok: false; message: string };

function settingsErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * 回读网关设定：成功＝网关为准（缺项用默认）；失败（未登录 / 网关不可达 / 响应形状不对）
 * 回 `{ ok: false }`——调用方**不得**把失败当成默认值写缓存或拿来保存。永不 reject。
 */
export async function getAgentSettings(): Promise<AgentSettingsResult> {
  try {
    const data = await agentFetch("/api/agent/settings", { method: "GET" });
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, message: "设置读取失败" };
    }
    return { ok: true, settings: sanitizeAgentSettings(data) };
  } catch (e) {
    return { ok: false, message: settingsErrorMessage(e, "设置读取失败") };
  }
}

/** 只保留 patch 里显式给出且合法的栏位（patch 语义：未改的栏位一个字不发）。 */
function sanitizeAgentSettingsPatch(patch: Partial<AgentSettings>): Partial<AgentSettings> {
  const full = sanitizeAgentSettings(patch);
  const out: Partial<AgentSettings> = {};
  for (const k of Object.keys(patch) as (keyof AgentSettings)[]) {
    if (!(k in full) || patch[k] === undefined) continue;
    // 非法值（sanitize 后与原值不同）直接丢弃，不拿默认值顶替。
    if (k === "beast_mode" ? typeof patch[k] !== "boolean" : full[k] !== patch[k]) continue;
    (out as Record<string, unknown>)[k] = full[k];
  }
  return out;
}

/**
 * 保存设定（patch 语义）：只 POST 用户改动的栏位，网关读旧值合并，未改栏位不会被默认值覆盖。
 * 先乐观写本地缓存（send 下一拍就读得到）；网关失败则**回滚缓存**并回 `{ ok: false }`，
 * 由调用方给用户可见提示——不再静默。成功以网关回的整份合并结果刷新缓存。永不 reject。
 */
export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettingsResult> {
  const clean = sanitizeAgentSettingsPatch(patch);
  if (Object.keys(clean).length === 0) return { ok: false, message: "设置无效，未保存" };
  const prevRaw = typeof window === "undefined" ? null : (() => {
    try { return window.localStorage.getItem(AGENT_SETTINGS_STORAGE_KEY); } catch { return null; }
  })();
  writeCachedAgentSettings({ ...readCachedAgentSettings(), ...clean });
  try {
    const data = await agentFetch("/api/agent/settings", { method: "POST", body: JSON.stringify(clean) });
    const merged = sanitizeAgentSettings({ ...readCachedAgentSettings(), ...(data as object), ...clean });
    writeCachedAgentSettings(merged);
    return { ok: true, settings: merged };
  } catch (e) {
    if (typeof window !== "undefined") {
      try {
        if (prevRaw === null) window.localStorage.removeItem(AGENT_SETTINGS_STORAGE_KEY);
        else window.localStorage.setItem(AGENT_SETTINGS_STORAGE_KEY, prevRaw);
      } catch {
        // 隐私模式：回滚失败只影响冷启动初值。
      }
    }
    return { ok: false, message: settingsErrorMessage(e, "保存失败") };
  }
}

// ─────────────────────────── 思考级别（2026-10-03）
//
// 输入框「+」右上角的四档菜单：低 / 中 / 高 / 极限，收成一格给用户。
// 它是 persona / cost_mode / beast_mode 三栏的联合快捷档——本表是**唯一真源**，
// 组件与测试都直接读它，不许各自再抄一份 mapping。
// interrupt_mode 不属于这个 mapping（与思考级别正交）：改档时由 saveAgentSettings
// 的「合并现有缓存 + patch」语义原样保留用户当前值（默认 steer）。
/** 级别 → 写入 AgentSettings 的 patch（经 saveAgentSettings 既有链路落地）。 */
export function agentThinkingLevelPatch(level: AgentThinkingLevel): Partial<AgentSettings> {
  return { ...AGENT_THINKING_LEVEL_SETTINGS[level] };
}

/** 由 settings 反推级别：mapping 覆盖不到的组合（如 premium + efficient）回 null。 */
export function inferAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel | null {
  for (const level of AGENT_THINKING_LEVELS) {
    const spec = AGENT_THINKING_LEVEL_SETTINGS[level];
    if (
      settings.persona === spec.persona &&
      settings.cost_mode === spec.cost_mode &&
      settings.beast_mode === spec.beast_mode
    ) {
      return level;
    }
  }
  return null;
}

/**
 * 服务端设定 → 档位（对账用，服务端为准）：四档表命中直接用；组合不在表里时按
 * beast_mode > persona > cost_mode 就近归档（只决定显示，不改写 settings）。
 */
export function serverAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel {
  const exact = inferAgentThinkingLevel(settings);
  if (exact) return exact;
  if (settings.beast_mode) return "extreme";
  if (settings.persona === "thoughtful") return "high";
  if (settings.cost_mode === "economy") return "low";
  return "medium";
}

/** 读取显式保存的思考级别（无记录 / 脏数据 → null）。 */
export function readCachedAgentThinkingLevel(): AgentThinkingLevel | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AGENT_THINKING_LEVEL_STORAGE_KEY);
    return (AGENT_THINKING_LEVELS as readonly string[]).includes(raw ?? "")
      ? (raw as AgentThinkingLevel)
      : null;
  } catch {
    return null;
  }
}

/** 只写本地 localStorage（不触网）：改档立即生效，跨重载保留。 */
export function writeCachedAgentThinkingLevel(level: AgentThinkingLevel): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_THINKING_LEVEL_STORAGE_KEY, level);
  } catch {
    // 隐私模式等写入失败：只影响下次冷启动的初值，不挡聊天。
  }
}

/**
 * 解析要显示的思考级别：显式记录优先；无记录才由 settings 反推；反推不到显示「中」。
 * **纯读取**——反推不到时绝不改写用户的 settings（只影响显示，用户的真实三栏原样保留）。
 */
export function resolveAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel {
  return readCachedAgentThinkingLevel() ?? inferAgentThinkingLevel(settings) ?? "medium";
}
