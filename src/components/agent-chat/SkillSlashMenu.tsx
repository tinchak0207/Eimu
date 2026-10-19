"use client";

/**
 * 打「/」直呼 Skill —— 输入框正上方的技能浮层（2026-09-27）。
 *
 * 职责边界（刻意收窄）：**纯展示 + 网络只读**（GET /api/skills 公开库 + GET
 * /api/skills/mine 我的技能；两支各自 AbortController，未登入的后者静默略过）。
 * 「选中之后干什么」不在这里——那是 AgentComposer 的事（本片只把技能名写回输入框，
 * 不自动送出、不碰附件与计费）。
 *
 * 三条硬要求（本片验收逐条钉）：
 * 1. **debounce ≥150ms + 竞态保护**：查询词一路打过去只让最后一条落地；先发后到的
 *    旧响应不得覆盖新结果。effect cleanup 置 alive=false 并 abort 双保险，判定收在
 *    shouldAcceptSlashResponse 纯函数里（可直测）。
 * 2. **定位**：父层必须是 position:relative；本层 absolute bottom-full 贴在**输入框
 *    正上方**——不遮输入框、不占文档流（零 layout shift）。
 * 3. **诚实**：空结果只留一行「没有匹配的技能」，绝不伪造条目；请求失败另给一句真话
 *    （「技能库暂时不可用」 ≠ 「没有匹配的技能」），畸形条目丢掉而不是猜。
 *
 * 材料沿用站内语汇：lg-float 二级玻璃层 + 顶缘 specular 高光线（MASTER.md §5）；
 * 行样式取「工具行无底色细行」的静——选中态才给一层极淡底色，不做彩色重音。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { tryAuthHeaders } from "@/lib/agent-chat-client";

/**
 * 一列所需要的最小字段（结构型别）。
 * 上游 `AgentSkillView` 还带 useScenario / inputType / toolIds / tags… 这里只用得着
 * 这四项，多余字段不声明——菜单不该因为上游加字段而漂移。
 */
export interface SlashMenuSkill {
  id: string;
  name: string;
  oneLiner: string;
  family: string;
}

/** 单次可见列数上限（与 `/api/skills?limit=` 同值）。 */
export const SLASH_MENU_LIMIT = 8;

/** 查询 debounce 下限 150ms；取 160ms 与站内其它输入防抖同量级。 */
export const SLASH_MENU_DEBOUNCE_MS = 160;

/** 请求状态：loading＝在飞（含 debounce 等待），ready＝落地（含空结果），error＝不可用。 */
export type SlashMenuStatus = "loading" | "ready" | "error";

/* ------------------------------------------------------------------ */
/* 纯函数层（不碰 DOM / 网络，可直测）                                   */
/* ------------------------------------------------------------------ */

/**
 * 菜单闸门：**输入框为空，或首字符是「/」**才允许开菜单。
 *
 * 这是「必要形态」判定，不是触发条件——真正的触发是使用者在输入框里真的打出那一颗
 * 「/」（AgentComposer 的 slashArmed）。两层都真才显示菜单：所以「普通文字」「/ 在句
 * 中」「首字符是空格再打 /」一律不开。
 */
export function shouldOpenSlashMenu(text: string): boolean {
  return text === "" || text.startsWith("/");
}

/** 「/」之后的文字＝查询词。非指令形态（首字符不是「/」）一律回空串。 */
export function slashQueryOf(text: string): string {
  return text.startsWith("/") ? text.slice(1).trim() : "";
}

/**
 * 上下键移动选中项（回绕，不越界不卡死）。纯函数，可直测。
 *
 * 越界或非整数的 index（列表刚变短、父层没来得及复位）按 0 起算，避免落到 undefined
 * 那一项上；length 为 0 时恒回 0（Enter 会因为取不到项而什么都不做）。
 */
export function moveActiveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const inRange = Number.isInteger(index) && index >= 0 && index < length;
  const base = inRange ? index : 0;
  return (((base + delta) % length) + length) % length;
}

/**
 * 选中一条技能 → 写回输入框的文字（纯函数）。
 *
 * 指令形态（框里正在打「/关键词」）＝整框就是那条指令，选中即把查询词换成技能名，
 * 末尾留一格空格好接着打需求，且**不再以「/」开头的查询词形态**继续触发搜索。
 * 其余形态（理论上菜单不开）不覆盖使用者已打的字，指令接在后面——与 D-24 prefill
 * 「接在后面不吃掉用户内容」同一条规矩。
 */
export function applySkillPick(current: string, skill: { name: string }): string {
  const command = `/${skill.name} `;
  const base = current.trim();
  if (!base || current.startsWith("/")) return command;
  return `${base} ${command}`;
}

/** 只读列举/搜寻端点的 URL（`q` 与 `limit` 由 URLSearchParams 负责编码）。 */
export function slashMenuUrl(query: string, limit: number = SLASH_MENU_LIMIT): string {
  const params = new URLSearchParams();
  params.set("q", query.trim());
  params.set("limit", String(limit));
  return `/api/skills?${params.toString()}`;
}

/**
 * 落地的响应该不该采用（竞态保护的判定本身，纯函数）。
 * request 已被 cleanup 作废（aborted）或 effect 已换代（!alive）→ 一律丢弃：
 * 先发的旧请求后到，绝不能覆盖新查询的结果。
 */
export function shouldAcceptSlashResponse(alive: boolean, signal: AbortSignal): boolean {
  return alive && !signal.aborted;
}

/**
 * 解析 `{ skills, total, families }` 里的 skills → 菜单列。
 * 契约不符（不是数组）＝空列表；单条畸形（缺 id/name、非对象）＝**丢掉那一列**，
 * 不猜、不补、不伪造。上限 SLASH_MENU_LIMIT 再截一次（上游 limit 之外的保险）。
 */
export function parseSlashSkills(payload: unknown): SlashMenuSkill[] {
  const raw = (payload as { skills?: unknown } | null | undefined)?.skills;
  if (!Array.isArray(raw)) return [];
  const out: SlashMenuSkill[] = [];
  for (const item of raw) {
    if (out.length >= SLASH_MENU_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!id || !name) continue;
    out.push({
      id,
      name,
      oneLiner: typeof row.oneLiner === "string" ? row.oneLiner.trim() : "",
      family: typeof row.family === "string" ? row.family.trim() : "",
    });
  }
  return out;
}

/**
 * 解析 `{ families: [{id,label,count}] }` → id→简体标签 的查表。
 * family 标签的真源在上游（不在这里写第二份家族表，免漂移）；缺席就退回显示原始 id。
 */
export function parseFamilyLabels(payload: unknown): Record<string, string> {
  const raw = (payload as { families?: unknown } | null | undefined)?.families;
  if (!Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && typeof row.label === "string" && row.label) {
      out[row.id] = row.label;
    }
  }
  return out;
}

/** 「我的技能」分区标题（分区标题只是标题，不是可选项）。 */
export const SLASH_MINE_SECTION_LABEL = "我的技能";

/** 我的技能端点的 URL（未登入回 401；列举自己的自订技能）。 */
export function slashMineUrl(): string {
  return "/api/skills/mine";
}

/** 菜单一个分区：公开库在上（无标题），我的技能在下（有标题，且只在有命中时才出现）。 */
export interface SlashMenuSection {
  key: "public" | "mine";
  /** 空串＝不渲染分区标题（公开库无标题）。 */
  label: string;
  skills: SlashMenuSkill[];
}

/** 按 id 去重（保留首次出现＝公开库那条优先），不猜、不合并字段。 */
function dedupeSkills(list: readonly SlashMenuSkill[]): SlashMenuSkill[] {
  const seen = new Set<string>();
  const out: SlashMenuSkill[] = [];
  for (const skill of list) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    out.push(skill);
  }
  return out;
}

/**
 * 两路结果合并（纯函数）：
 * - 分区顺序固定：公开库在上、我的技能在下（命中才出现）；
 * - 去重按 id，公开库那条优先（同一 id 不重复出现两次）；
 * - **我的技能为空（含未登入 401 静默略过）= 不产生分区标题**，不留空区块；
 * - 各自截到 SLASH_MENU_LIMIT（上游 limit 之外的保险）。
 */
export function mergeSlashResults(
  publicList: readonly SlashMenuSkill[],
  myList: readonly SlashMenuSkill[],
): SlashMenuSection[] {
  const publicRows = dedupeSkills(publicList).slice(0, SLASH_MENU_LIMIT);
  const seen = new Set(publicRows.map((skill) => skill.id));
  const myRows = dedupeSkills(myList)
    .filter((skill) => !seen.has(skill.id))
    .slice(0, SLASH_MENU_LIMIT);

  const sections: SlashMenuSection[] = [];
  if (publicRows.length > 0) {
    sections.push({ key: "public", label: "", skills: publicRows });
  }
  if (myRows.length > 0) {
    sections.push({ key: "mine", label: SLASH_MINE_SECTION_LABEL, skills: myRows });
  }
  return sections;
}

/**
 * 选区展平：**只有技能列进选区**，分区标题不进（标题不是可选项）。
 * 上下键/Enter 都按这个顺序换算索引，跨区连续移动＝在展平表上移动。
 */
export function flattenSlashRows(sections: readonly SlashMenuSection[]): SlashMenuSkill[] {
  const out: SlashMenuSkill[] = [];
  for (const section of sections) out.push(...section.skills);
  return out;
}

/** 按索引取项：越界/非整数/空区一律回 undefined（Enter 因此什么都不做，不落 undefined 崩）。 */
export function slashSkillAt(
  rows: readonly SlashMenuSkill[],
  index: number,
): SlashMenuSkill | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return undefined;
  return rows[index];
}

/* ------------------------------------------------------------------ */
/* 元件层                                                              */
/* ------------------------------------------------------------------ */

export interface SkillSlashMenuProps {
  /** 查询词（`/` 之后的文字）；变化即重新搜索（debounce + abort）。 */
  query: string;
  /** 当前选中行（受控：键盘在 textarea 上，上下键由父层转发）。 */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  /** 选中一条（点行或父层按 Enter/Tab）。父层负责「写回输入框」，本层不送出。 */
  onPick: (skill: SlashMenuSkill) => void;
  /** 收起菜单（本层自己的 Esc 监听会调它；不送出、不清输入框是父层的责任）。 */
  onClose: () => void;
  /**
   * 可见列表上报。父层用 ref 接住即可（Enter/Tab 要按 activeIndex 取当前项），
   * 不需要因此多一轮渲染。
   */
  onSkillsChange?: (skills: SlashMenuSkill[]) => void;
}

export function SkillSlashMenu({
  query,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onClose,
  onSkillsChange,
}: SkillSlashMenuProps) {
  const [publicSkills, setPublicSkills] = useState<SlashMenuSkill[]>([]);
  const [mySkills, setMySkills] = useState<SlashMenuSkill[]>([]);
  const [familyLabels, setFamilyLabels] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<SlashMenuStatus>("loading");

  // 回调进 ref：搜索 effect 的依赖只留 query，回调身份变化不重打网络。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSkillsChangeRef = useRef(onSkillsChange);
  onSkillsChangeRef.current = onSkillsChange;

  useEffect(() => {
    const term = query.trim();
    // 两路各自一个 AbortController：一路被取消/换代，不得牵连另一路。
    const publicController = new AbortController();
    const mineController = new AbortController();
    let alive = true;
    setStatus("loading");
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(slashMenuUrl(term), {
            signal: publicController.signal,
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(`skills ${res.status}`);
          const payload: unknown = await res.json();
          if (!shouldAcceptSlashResponse(alive, publicController.signal)) return;
          setPublicSkills(parseSlashSkills(payload));
          setFamilyLabels(parseFamilyLabels(payload));
          setStatus("ready");
        } catch {
          // 换代/取消的请求静默（不是错误）；真失败＝空结果 + error 态（诚实提示）。
          if (!shouldAcceptSlashResponse(alive, publicController.signal)) return;
          setPublicSkills([]);
          setStatus("error");
        }
      })();
      void (async () => {
        // 我的技能：未登入（无凭证 / 401）与任何失败**一律静默略过**——
        // 不报错、不摆空区块、不伪造条目；公开库照常显示。
        const headers = tryAuthHeaders();
        if (!headers) {
          setMySkills([]);
          return;
        }
        try {
          const res = await fetch(slashMineUrl(), {
            signal: mineController.signal,
            headers: { ...headers, accept: "application/json" },
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`skills/mine ${res.status}`);
          const payload: unknown = await res.json();
          if (!shouldAcceptSlashResponse(alive, mineController.signal)) return;
          setMySkills(parseSlashSkills(payload));
        } catch {
          if (!shouldAcceptSlashResponse(alive, mineController.signal)) return;
          setMySkills([]);
        }
      })();
    }, SLASH_MENU_DEBOUNCE_MS);
    return () => {
      // 双保险：alive 挡「已换代但 abort 还没传到」的窗口，abort 掐掉在飞的请求。
      alive = false;
      clearTimeout(timer);
      publicController.abort();
      mineController.abort();
    };
  }, [query]);

  // 两路合并成「公开区 + 我的技能区」，只有技能列进选区（分区标题不是可选项）。
  const sections = useMemo(
    () => mergeSlashResults(publicSkills, mySkills),
    [publicSkills, mySkills],
  );
  const rows = useMemo(() => flattenSlashRows(sections), [sections]);

  useEffect(() => {
    onSkillsChangeRef.current?.(rows);
  }, [rows]);

  // Esc 收起：菜单自己也能收（父层忘了转发也不会卡住）。这里不做 preventDefault，
  // 键盘语义（不送出、不清输入框）由 composer 的 handleKeyDown 负责。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const empty = rows.length === 0;

  return (
    <div
      role="listbox"
      aria-label="技能（斜线直呼）"
      data-slash-menu="true"
      // absolute bottom-full：贴在本元件父层（= composer 根，position:relative）的正上方；
      // 不进流 ⇒ 不推挤任何东西（零 layout shift），也不遮输入框本身。
      className="lg-float absolute bottom-full left-1.5 right-1.5 z-50 mb-2 min-w-0 rounded-ios-xl p-1"
    >
      {/* 顶缘 specular 高光线：与站内每张玻璃浮层同一条配方。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
      />

      {empty && (status === "loading" || status === "error") ? (
        <div className="px-2.5 py-2 text-ios-footnote text-foreground/45">
          {status === "loading" ? "正在搜索技能…" : "技能库暂时不可用"}
        </div>
      ) : empty ? (
        // 空结果＝一行真话，不伪造成「热门技能」之类的假条目。
        <div className="px-2.5 py-2 text-ios-footnote text-foreground/45">没有匹配的技能</div>
      ) : (
        <div className="agent-scroll-thin max-h-[19rem] overflow-y-auto overscroll-contain">
          {/* 分区顺序＝公开库在上、我的技能在下；分区标题不是可选项，
              不进 rows（键盘索引按 rows 换算，标题自动被跳过、跨区连续移动）。 */}
          {sections.map((section) => (
            <div key={section.key}>
              {section.label ? (
                <p className="px-2.5 pt-1.5 pb-0.5 text-ios-caption1 font-medium text-foreground/60">
                  {section.label}
                </p>
              ) : null}
              {section.skills.map((skill) => {
                const index = rows.indexOf(skill);
                const label = familyLabels[skill.family] ?? skill.family;
                const active = index === activeIndex;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    // 按下不抢焦点：菜单是输入框的附庸，焦点留在 textarea 才能接着打字。
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(skill)}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    className={cn(
                      "block w-full cursor-pointer rounded-[14px] px-2.5 py-2 text-left transition-colors duration-100 touch-manipulation [-webkit-tap-highlight-color:transparent]",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      active ? "bg-black/[0.06]" : "hover:bg-black/[0.04]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-ios-footnote font-medium text-foreground">
                        {skill.name}
                      </span>
                      {label ? (
                        <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 py-px text-ios-caption1 text-foreground/55">
                          {label}
                        </span>
                      ) : null}
                    </span>
                    {skill.oneLiner ? (
                      <span className="mt-0.5 block truncate text-ios-caption1 text-foreground/50">
                        {skill.oneLiner}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {/* 技能目录页 /skills 此前站内零链接：打了「/」的人正是想找技能的人。 */}
      <a
        href="/skills"
        target="_blank"
        rel="noopener"
        onMouseDown={(event) => event.preventDefault()}
        className="mt-0.5 block rounded-[14px] px-2.5 py-1.5 text-ios-caption1 text-foreground/50 transition-colors hover:bg-black/[0.04] hover:text-foreground/75"
      >
        浏览全部技能 →
      </a>
    </div>
  );
}
