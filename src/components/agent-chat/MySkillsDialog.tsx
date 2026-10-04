"use client";

/**
 * 「我的技能」管理面（2026-09-27）。
 *
 * 定位：**站内没有公开发布／市集**，但使用者要能上传、管理自己的 Skill，且自己的
 * Skill 要能在输入框用「/」直呼。本档只做「管理」这一件：列举／新增／编辑／删除，
 * 端点沿用冻结契约（GET/POST /api/skills/mine，DELETE /api/skills/mine/<id>）。
 *
 * 三条硬要求：
 * 1. **不假装成功**：未登入（无凭证或 401）只显示「登录后可以保存自己的技能」，
 *    不显示任何看起来像成功的空列表或假条目。
 * 2. **错误说人话**：后端 400 的 `reason` 是稳定代码（`name_required`、
 *    `sensitive_content:api_key_sk`…），**不得原文丢给使用者**；一律经
 *    `humanizeSkillError` 翻译，且翻译结果不含原始代码字样（负向对照在测试里）。
 * 3. **删除二次确认**：删除是不可逆的（agent-memory 落库），先问一次再送。
 *
 * 外壳沿用站内语汇：fixed 遮罩 + lg-sheet 玻璃卡 + 顶缘 specular 高光线
 * （与 AgentSettingsPopover / 历史 dropdown 同配方）；行用「无底色细行」，
 * hover 只换底色不动尺寸（零 layout shift）。
 */

import { SKILL_OUTPUT_KIND_OPTIONS } from "@/lib/agent-skills/output-kinds";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { tryAuthHeaders } from "@/lib/agent-chat-client";
import { useAuth } from "@/hooks/use-auth";
import { useGithubLoginHandoff } from "@/hooks/use-github-login-handoff";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { parseFamilyLabels, slashMenuUrl } from "./SkillSlashMenu";

/* ------------------------------------------------------------------ */
/* 型别与纯函式层（不碰 DOM / 网路，可直测）                             */
/* ------------------------------------------------------------------ */

/** 管理面列出的自订技能（比斜线菜单多几个编辑用栏位）。 */
export interface MySkillRow {
  id: string;
  name: string;
  oneLiner: string;
  family: string;
  useScenario: string;
  inputType: string;
  outputContent: string;
  outputKind: string;
  tags: string[];
}

/** 输出类型选项：真源在 `@/lib/agent-skills/output-kinds`（列表页／详情页共用同一组词）。 */
export const SKILL_OUTPUT_KINDS = SKILL_OUTPUT_KIND_OPTIONS;

/**
 * 型别 → 可调用工具。使用者填的是「交付什么」，工具是机制层的必然推导，
 * 不让使用者手选一串工具 id（那是内部实作）。
 *
 * 为什么要有这张表：后端发布验证要求 `toolIds` 非空（`tool_ids_required`），
 * 而表单只问交付形态；由型别推导是唯一不逼使用者背工具名的做法。表里每个 id
 * 都有测试对 `HARNESS_TOOL_IDS` 做「真实注册表」断言（不在表里的 id 进不去）。
 */
const TOOLS_BY_OUTPUT_KIND: Record<string, readonly string[]> = {
  image: ["image_generate"],
  text: ["doc_struct"],
  video: ["last_frame_video_chain"],
  audio: ["tts_speak"],
  director: ["director_select"],
  mixed: ["image_generate", "last_frame_video_chain"],
};

/** 由输出类型推导 toolIds；未知型别回空阵列（呼叫端据此挡下送出，不猜）。 */
export function deriveToolIds(outputKind: string): string[] {
  return [...(TOOLS_BY_OUTPUT_KIND[outputKind] ?? [])];
}

/** 标签输入 → 标签阵列（逗号/顿号/换行分隔；去空、去重、上限 8）。 */
export function splitSkillTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? "").split(/[,，、\n]+/)) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

/** 我的技能端点（单条：DELETE 用）。 */
export function mineSkillUrl(id: string): string {
  return `/api/skills/mine/${encodeURIComponent(id)}`;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 解析 `{ skills }` → 管理面列（畸形条目丢掉，不猜不补）。
 * 与斜线菜单的 `parseSlashSkills` 分开：这里要多留编辑需要的栏位。
 */
export function parseMySkills(payload: unknown): MySkillRow[] {
  const raw = (payload as { skills?: unknown } | null | undefined)?.skills;
  if (!Array.isArray(raw)) return [];
  const out: MySkillRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id);
    const name = str(row.name);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      oneLiner: str(row.oneLiner),
      family: str(row.family),
      useScenario: str(row.useScenario),
      inputType: str(row.inputType),
      outputContent: str(row.outputContent),
      outputKind: str(row.outputKind),
      tags: Array.isArray(row.tags)
        ? row.tags.map((tag) => str(tag)).filter(Boolean)
        : [],
    });
  }
  return out;
}

/**
 * 错误 → 人话（**纯函式，不得回传原始 reason 原文**）。
 *
 * 后端 reason 是稳定代码（`invalid_skill` / `sensitive_content:<kind>` / `name_required`…），
 * 直接显示等于把内部代码丢给使用者；凭证类更是红线（AGENTS.md：secret 永不入
 * log／memory，也不该在文案里二次外泄代码细节）。所以：认识的代码逐条翻译，
 * 不认识的一律回一句通用人话——**任何分支都不得把输入原样回传**。
 */
export function humanizeSkillError(reason: unknown, status?: number): string {
  if (status === 401) return "请先登录后再管理自己的技能。";
  if (status === 404) return "这条技能已经不在了，刷新看看。";
  if (status === 409) return "已经有一条同名技能了，换个名称，或直接编辑它。";
  if (status === 429) return "今天新增的技能有点多，明天再试吧。";
  if (status === 502 || status === 503 || status === 504) return "服务暂时不可用，请稍后再试。";

  const code = typeof reason === "string" ? reason.trim() : "";
  if (!code) return "操作没成功，请稍后重试。";
  // 网路层自己给的哨兵值（不是后端代码）。
  if (code === "network_error") return "网络不给力，请检查连接后重试。";
  // 凭证／隐私命中：只给「怎么修」，不重述命中种类。
  if (code.startsWith("sensitive_content")) {
    return "内容里像是含有密钥或隐私信息，请移除后再保存。";
  }

  const MAP: Record<string, string> = {
    invalid_skill: "这条技能还没填完整，请检查各栏后再保存。",
    invalid_json: "提交的内容格式不对，请重试。",
    name_required: "请填写技能名称。",
    name_too_long: "技能名称太长了，请精简到 32 个字以内。",
    name_invalid: "技能名称里有不能用的字符，请换一个。",
    one_liner_required: "请写一句话介绍。",
    one_liner_too_long: "一句话介绍太长了，请精简到 24 个字以内。",
    family_invalid: "请选择一个题材家族。",
    output_kind_invalid: "请选择输出类型。",
    use_scenario_required: "请填写使用场景。",
    input_type_required: "请填写需要提供什么。",
    output_content_required: "请填写会交付什么。",
    tool_ids_required: "这条技能还没有可调用的工具，请换个输出类型。",
    tool_ids_count: "可调用的工具太多了，请精简。",
    tool_id_not_found: "有工具当前不可用，请换个输出类型。",
    tags_required: "请至少写一个标签。",
    tags_count: "标签最多 8 个。",
    tag_invalid: "标签里有不能用的字符。",
    tag_too_long: "有个标签太长了，请精简。",
    expert_not_found: "指定的专家不存在，请清除后重试。",
    id_invalid: "这条技能的标识不合法，请退出后重新新建。",
    content_too_long: "内容太长了，请精简后再保存。",
    duplicate: "已经有一条同名技能了，换个名称，或直接编辑它。",
    quota_exceeded: "今天新增技能的数量到上限了，明天再来。",
    structure: "这条技能的内容不完整，请检查后再保存。",
    rejected: "这条技能被拒绝了，请修改后再保存。",
    unauthorized: "请先登录后再管理自己的技能。",
  };
  if (MAP[code]) return MAP[code];
  // 同族代码（逐栏扫描的 `use_scenario_*` 等）收一句人话，不细分内部判定。
  if (code.startsWith("one_liner_")) return "一句话介绍里有不合适的内容，请修改。";
  if (
    code.startsWith("use_scenario_")
    || code.startsWith("input_type_")
    || code.startsWith("output_content_")
    || code.startsWith("aesthetic_")
  ) {
    return "填写的内容里有不合适的地方，请修改后再保存。";
  }
  return "操作没成功，请检查填写内容后重试。";
}

/* ------------------------------------------------------------------ */
/* 元件层                                                              */
/* ------------------------------------------------------------------ */

export interface MySkillsDialogProps {
  /** 关闭（点右上角 X、点遮罩、按 Esc 都走这里）。 */
  onClose: () => void;
}

/** 表单初值（新增＝空白；编辑＝带入该条）。 */
interface SkillFormState {
  id: string;
  name: string;
  oneLiner: string;
  family: string;
  useScenario: string;
  inputType: string;
  outputContent: string;
  outputKind: string;
  tags: string;
}

const EMPTY_FORM: SkillFormState = {
  id: "",
  name: "",
  oneLiner: "",
  family: "",
  useScenario: "",
  inputType: "",
  outputContent: "",
  outputKind: "image",
  tags: "",
};

export const INPUT_CLASS =
  "w-full rounded-lg border border-input bg-black/5 px-2.5 py-1.5 text-ios-caption1 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ios-blue";

/** 一行栏位：标签在上、控件在下（标签固定占位，hover/focus 不改尺寸）。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-ios-caption2 font-medium text-foreground/60">{label}</span>
      {children}
    </label>
  );
}

export function MySkillsDialog({ onClose }: MySkillsDialogProps) {
  // 清单：null＝载入中，[]＝已载入但为空。
  const [skills, setSkills] = useState<MySkillRow[] | null>(null);
  /** 未登入（无凭证或 401）：只说真话，不摆假成功。 */
  const [loggedOut, setLoggedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 删除二次确认：记住待确认的那条。 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState<SkillFormState | null>(null);
  const [saving, setSaving] = useState(false);
  /** 家族选项（公开端点列举，标签真源在上游，本档不写第二份家族表）。 */
  const [families, setFamilies] = useState<Array<{ id: string; label: string }>>([]);

  // 换代保护：关窗后迟到的响应不得 setState。
  const aliveRef = useRef(true);

  // standalone PWA / Electron 桌面壳：GitHub 登入态带不进来，走跨浏览器交接。
  const { handoffUrl, startLogin, closeHandoff } = useGithubLoginHandoff();
  const { refresh } = useAuth();

  // 稳定引用：交接面板的轮询 effect 以 onSuccess 为依赖，inline 箭头会让
  // effect 随每次 re-render 重建、2 秒轮询永远开不出第一枪。
  const handleHandoffSuccess = useCallback(() => {
    closeHandoff();
    void refresh();
  }, [closeHandoff, refresh]);

  const loadFamilies = useCallback(async () => {
    try {
      const res = await fetch(slashMenuUrl("", 1), { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const payload: unknown = await res.json();
      const labels = parseFamilyLabels(payload);
      if (!aliveRef.current) return;
      setFamilies(Object.entries(labels).map(([id, label]) => ({ id, label })));
    } catch {
      // 家族表拿不到不挡保存：退回让使用者自己填 family id。
    }
  }, []);

  const loadSkills = useCallback(async () => {
    const headers = tryAuthHeaders();
    if (!headers) {
      setLoggedOut(true);
      setSkills([]);
      return;
    }
    setSkills(null);
    setError(null);
    try {
      const res = await fetch("/api/skills/mine", {
        headers: { ...headers, accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 401) {
        if (!aliveRef.current) return;
        setLoggedOut(true);
        setSkills([]);
        return;
      }
      if (!res.ok) throw new Error(`skills/mine ${res.status}`);
      const payload: unknown = await res.json();
      if (!aliveRef.current) return;
      setLoggedOut(false);
      setSkills(parseMySkills(payload));
    } catch {
      if (!aliveRef.current) return;
      setSkills([]);
      setError(humanizeSkillError("network_error"));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadFamilies();
    void loadSkills();
    return () => {
      aliveRef.current = false;
    };
  }, [loadFamilies, loadSkills]);

  // Esc 关闭（与站内浮层同一条键盘语义）。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const familyOptions = useMemo(() => families, [families]);

  /** 新增：开一张空表；家族预设第一个（家族表还没回来就先空著，送出前会挡）。 */
  const startCreate = useCallback(() => {
    setError(null);
    setConfirmId(null);
    setForm({ ...EMPTY_FORM, family: familyOptions[0]?.id ?? "" });
  }, [familyOptions]);

  const startEdit = useCallback((skill: MySkillRow) => {
    setError(null);
    setConfirmId(null);
    setForm({
      id: skill.id,
      name: skill.name,
      oneLiner: skill.oneLiner,
      family: skill.family,
      useScenario: skill.useScenario,
      inputType: skill.inputType,
      outputContent: skill.outputContent,
      outputKind: skill.outputKind || "image",
      tags: skill.tags.join("，"),
    });
  }, []);

  /** 本地先挡一轮必填（送出前的真话），通过才打后端。 */
  const localIssue = useCallback((state: SkillFormState): string | null => {
    if (!state.name.trim()) return "请填写技能名称。";
    if (!state.oneLiner.trim()) return "请写一句话介绍。";
    if (!state.family.trim()) return "请选择一个题材家族。";
    if (!state.useScenario.trim()) return "请填写使用场景。";
    if (!state.inputType.trim()) return "请填写需要提供什么。";
    if (!state.outputContent.trim()) return "请填写会交付什么。";
    if (splitSkillTags(state.tags).length === 0) return "请至少写一个标签。";
    if (deriveToolIds(state.outputKind).length === 0) return "请选择输出类型。";
    return null;
  }, []);

  const submit = useCallback(async () => {
    if (!form || saving) return;
    const issue = localIssue(form);
    if (issue) {
      setError(issue);
      return;
    }
    const headers = tryAuthHeaders();
    if (!headers) {
      setLoggedOut(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/mine", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          name: form.name.trim(),
          oneLiner: form.oneLiner.trim(),
          family: form.family.trim(),
          useScenario: form.useScenario.trim(),
          inputType: form.inputType.trim(),
          outputContent: form.outputContent.trim(),
          outputKind: form.outputKind,
          toolIds: deriveToolIds(form.outputKind),
          tags: splitSkillTags(form.tags),
        }),
      });
      if (res.status === 401) {
        setLoggedOut(true);
        return;
      }
      if (!res.ok) {
        // 400 的 reason 是内部代码 → 一律过人话翻译，绝不原样显示。
        let reason: string | undefined;
        try {
          const data = (await res.json()) as { reason?: unknown; error?: unknown };
          reason = typeof data?.reason === "string" ? data.reason : undefined;
          if (!reason && typeof data?.error === "string") reason = data.error;
        } catch {
          reason = undefined;
        }
        setError(humanizeSkillError(reason, res.status));
        return;
      }
      setForm(null);
      await loadSkills();
    } catch {
      setError(humanizeSkillError("network_error"));
    } finally {
      setSaving(false);
    }
  }, [form, localIssue, loadSkills, saving]);

  const remove = useCallback(
    async (id: string) => {
      const headers = tryAuthHeaders();
      if (!headers) {
        setLoggedOut(true);
        return;
      }
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(mineSkillUrl(id), { method: "DELETE", headers });
        if (res.status === 401) {
          setLoggedOut(true);
          return;
        }
        if (!res.ok) {
          let reason: string | undefined;
          try {
            const data = (await res.json()) as { reason?: unknown; error?: unknown };
            reason = typeof data?.reason === "string" ? data.reason : undefined;
            if (!reason && typeof data?.error === "string") reason = data.error;
          } catch {
            reason = undefined;
          }
          setError(humanizeSkillError(reason, res.status));
          return;
        }
        setConfirmId(null);
        await loadSkills();
      } catch {
        setError(humanizeSkillError("network_error"));
      } finally {
        setBusyId(null);
      }
    },
    [loadSkills],
  );

  const patch = useCallback((delta: Partial<SkillFormState>): void => {
    setForm((prev) => (prev ? { ...prev, ...delta } : prev));
  }, []);

  // portal 到 document.body（2026-10-04 FIX-2）：
  // 本对话框原由 AgentSettingsPopover 直接（非 portal）渲染，因而落在
  // ImagePlayground → CanvasChatWorkstation → .canvas-chat-panel
  // （fixed z-60; overflow:hidden）这个堆叠脉络里 ⇒ z-[90] 在 canvas 态被宿主面板盖掉、
  // 且 overflow:hidden 会把 fixed 对话框裁在面板框内（真浏览器 elementsFromPoint 已复现）。
  // 搬出树后 fixed 满屏与 z-[90] 才生效。SSR 安全照站内既有 portal 配方
  // （AgentChatSurface 窄屏历史抽屉、AgentComposer 思考级别面板）：typeof document 守卫，
  // server render 阶段不执行 createPortal。呼叫端 AgentSettingsPopover:163 维持不动。
  return typeof document !== "undefined" ? createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="我的技能"
      data-my-skills-dialog="true"
    >
      {/* 遮罩：点外面收起（与站内浮层同一条规矩）。 */}
      <button
        type="button"
        aria-label="关闭我的技能"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-[2px]"
      />
      <div className="lg-sheet relative flex max-h-[min(82dvh,42rem)] w-full max-w-md flex-col overflow-hidden rounded-ios-2xl p-1">
        {/* MASTER.md：每张 sheet 都要有一条顶缘高光线。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
        />
        <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pt-2 pb-1.5">
          <span className="text-ios-footnote font-medium text-foreground">我的技能</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="agent-scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2">
          {loggedOut ? (
            <div className="flex flex-col items-start gap-2 py-3">
              <p className="text-ios-caption1 leading-relaxed text-foreground/55">
                登录后可以保存自己的技能
              </p>
              <button
                type="button"
                onClick={() => void startLogin("github")}
                className="cursor-pointer rounded-full bg-ios-blue px-3 py-1 text-ios-caption1 font-medium text-white transition-colors hover:bg-ios-blue/90"
              >
                去登录
              </button>
            </div>
          ) : form ? (
            /* ── 表单（新增／编辑）── */
            <div className="flex flex-col gap-2.5 py-1">
              <Field label="名称">
                <input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  maxLength={32}
                  placeholder="例如：咖啡馆开场镜头"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="一句话介绍">
                <input
                  value={form.oneLiner}
                  onChange={(e) => patch({ oneLiner: e.target.value })}
                  maxLength={24}
                  placeholder="一句话说清它干什么（24 字内）"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="题材家族">
                {familyOptions.length > 0 ? (
                  <select
                    value={form.family}
                    onChange={(e) => patch({ family: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">请选择</option>
                    {familyOptions.map((family) => (
                      <option key={family.id} value={family.id}>
                        {family.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={form.family}
                    onChange={(e) => patch({ family: e.target.value })}
                    placeholder="家族标识（例如 cinema-auteur）"
                    className={INPUT_CLASS}
                  />
                )}
              </Field>
              <Field label="使用场景">
                <textarea
                  value={form.useScenario}
                  onChange={(e) => patch({ useScenario: e.target.value })}
                  rows={2}
                  placeholder="什么情况下用它"
                  className={cn(INPUT_CLASS, "resize-none")}
                />
              </Field>
              <Field label="如何使用（需要提供什么）">
                <textarea
                  value={form.inputType}
                  onChange={(e) => patch({ inputType: e.target.value })}
                  rows={2}
                  placeholder="例如：一句场景描述 + 参考图"
                  className={cn(INPUT_CLASS, "resize-none")}
                />
              </Field>
              <Field label="输出内容">
                <textarea
                  value={form.outputContent}
                  onChange={(e) => patch({ outputContent: e.target.value })}
                  rows={2}
                  placeholder="会交付什么"
                  className={cn(INPUT_CLASS, "resize-none")}
                />
              </Field>
              <Field label="类型">
                <select
                  value={form.outputKind}
                  onChange={(e) => patch({ outputKind: e.target.value })}
                  className={INPUT_CLASS}
                >
                  {SKILL_OUTPUT_KINDS.map((kind) => (
                    <option key={kind.id} value={kind.id}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="标签">
                <input
                  value={form.tags}
                  onChange={(e) => patch({ tags: e.target.value })}
                  placeholder="用逗号分隔，最多 8 个"
                  className={INPUT_CLASS}
                />
              </Field>
              <div className="mt-0.5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setForm(null);
                    setError(null);
                  }}
                  disabled={saving}
                  className="cursor-pointer rounded-full px-3 py-1 text-ios-caption1 font-medium text-foreground/55 transition-colors hover:bg-black/5 disabled:cursor-not-allowed"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={saving}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full bg-ios-blue px-3 py-1 text-ios-caption1 font-medium text-white transition-colors hover:bg-ios-blue/90 disabled:cursor-wait disabled:opacity-70"
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                  {form.id ? "保存修改" : "保存技能"}
                </button>
              </div>
            </div>
          ) : (
            /* ── 清单 ── */
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 pb-1">
                <span className="text-ios-caption2 text-foreground/45">
                  {skills === null ? "正在加载…" : `共 ${skills.length} 条`}
                </span>
                <button
                  type="button"
                  onClick={startCreate}
                  className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue transition-colors hover:bg-ios-blue/10"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  新增
                </button>
              </div>

              {skills === null ? (
                <p className="px-1 py-3 text-center text-ios-caption1 text-foreground/45">
                  正在加载我的技能…
                </p>
              ) : skills.length === 0 && !error ? (
                <p className="px-1 py-3 text-center text-ios-caption1 text-foreground/45">
                  还没有自己的技能，点「新增」建一条
                </p>
              ) : (
                skills.map((skill) => {
                  const label =
                    families.find((family) => family.id === skill.family)?.label ?? skill.family;
                  const confirming = confirmId === skill.id;
                  return (
                    <div
                      key={skill.id}
                      className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-black/[0.04]"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-ios-caption1 font-medium text-foreground">
                            {skill.name}
                          </span>
                          {label ? (
                            <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 py-px text-ios-caption2 text-foreground/55">
                              {label}
                            </span>
                          ) : null}
                        </span>
                        {skill.oneLiner ? (
                          <span className="truncate text-ios-caption2 text-foreground/50">
                            {skill.oneLiner}
                          </span>
                        ) : null}
                      </span>
                      {confirming ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="text-ios-caption2 text-foreground/55">确定删除？</span>
                          <button
                            type="button"
                            onClick={() => void remove(skill.id)}
                            disabled={busyId === skill.id}
                            className="cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-white bg-ios-red transition-colors hover:bg-ios-red/90 disabled:cursor-wait disabled:opacity-70"
                          >
                            {busyId === skill.id ? "删除中…" : "删除"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            className="cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-foreground/55 transition-colors hover:bg-black/5"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => startEdit(skill)}
                            aria-label={`编辑 ${skill.name}`}
                            title="编辑"
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setError(null);
                              setConfirmId(skill.id);
                            }}
                            aria-label={`删除 ${skill.name}`}
                            title="删除"
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-ios-red/10 hover:text-ios-red focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-red/30"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {error ? (
            <p className="mt-2 rounded-lg bg-ios-red/[0.08] px-2.5 py-1.5 text-ios-caption2 leading-relaxed text-ios-red">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      {/* 交接面与卡片同一个 portal / stacking context（本对话框自行 portal，
          面板再 portal 出去会被卡片盖住）：成功后关掉交接面并刷新登入态。 */}
      {handoffUrl ? (
        <PwaHandoffPanel
          loginUrl={handoffUrl}
          onSuccess={handleHandoffSuccess}
          onClose={closeHandoff}
        />
      ) : null}
    </div>,
    document.body,
  ) : null;
}
