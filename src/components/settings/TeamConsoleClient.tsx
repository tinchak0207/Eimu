"use client";

// 團隊治理控制台（片F 六面 API 的前端入口）：成員/角色、建畫布開關、加入審批、
// 席位、解散冷靜期、用量。
//
// 認證：六面 API 是 B 端密鑰端點（`/api/v1/team/*`，生產由 next.config 的 beforeFiles
// 改寫到控制面）。**站內 session token 不是 B 端密鑰**，瀏覽器無法用它換，故本面板
// 要求粘貼團隊主帳號的 B 端密鑰（在 /settings/api-keys 建立）。
// 密鑰只存 sessionStorage（關分頁即清）＋記憶體，不進 localStorage、不進 log、不落任何後端。
//
// 樣式逐項照抄既有面板 `src/components/settings/ApiKeysClient.tsx`（lg-card / lg-tint /
// rounded-ios-* / text-ios-* / 主色 #007AFF），不另立一套設計語言。
// 本檔無浮層（確認一律走 window.confirm，與 ApiKeysClient 同款）——
// 因此不觸發「祖先 overflow-hidden / backdrop-filter 必須 portal」的裁切規律。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Crown,
  KeyRound,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const KEY_STORAGE = "eimu.team.bizKey";

type TeamRole = "owner" | "admin" | "member";

interface MemberRow {
  member_key_id: string;
  member_user_id: number;
  display_name: string;
  enabled: boolean;
  role: TeamRole;
}

interface MembersPayload {
  team_user_id: number;
  actor: { user_id: number; role: TeamRole; is_owner: boolean };
  seats: number;
  capacity: { min_members: number; default_max_members: number; max_members: number; member_count: number };
  settings: { member_create_canvas: boolean };
  members: MemberRow[];
}

interface JoinRequestRow {
  request_id: string;
  applicant_user_id: number;
  applicant_member_key_id: string;
  display_name: string;
  status: string;
  created_at: string;
  decided_at: string | null;
}

interface JoinRequestsPayload {
  status: string;
  requests: JoinRequestRow[];
}

interface SeatsPayload {
  seats: number;
  member_count: number;
  capacity: { min_members: number; default_max_members: number; max_members: number };
  can_admit_more: boolean;
  /** 誠實標註：席位目前只是意圖整數，未接計費（不支援按席位購買/續費）。 */
  billing_connected?: boolean;
}

interface LifecyclePayload {
  member_count: number;
  dissolved: boolean;
  dissolved_at: string | null;
  dissolve_scheduled_at: string | null;
  due: boolean;
  remaining_ms: number | null;
  cooloff_hours: number;
}

interface UsageMemberRow {
  member_key_id: string;
  member_user_id: number;
  display_name: string;
  role: TeamRole;
  enabled: boolean;
  granted_quota: number;
  used_quota: number;
  remaining_quota: number;
  granted_coins: number;
  used_coins: number;
  remaining_coins: number;
  unavailable?: boolean;
}

interface UsagePayload {
  seats: number;
  member_count: number;
  totals: {
    granted_quota: number;
    used_quota: number;
    remaining_quota: number;
    granted_coins: number;
    used_coins: number;
    remaining_coins: number;
  };
  conservation: {
    master_remaining_quota: number;
    members_remaining_quota: number;
    team_remaining_quota: number;
    consumed_quota: number;
    balanced: boolean;
    formula: string;
  };
  members: UsageMemberRow[];
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; code?: string };

async function call<T>(key: string, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (init?.body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...init, headers, cache: "no-store" });
    const json = (await res.json()) as {
      success?: boolean;
      error?: { message?: string; code?: string };
      message?: string;
    };
    if (!res.ok || json.success !== true) {
      return {
        ok: false,
        message: json.error?.message ?? (typeof json.message === "string" ? json.message : `请求失败（HTTP ${res.status}）`),
        ...(json.error?.code ? { code: json.error.code } : {}),
      };
    }
    return { ok: true, data: json as unknown as T };
  } catch {
    return { ok: false, message: "网络异常，请稍后重试。" };
  }
}

const ROLE_LABEL: Record<TeamRole, string> = { owner: "所有者", admin: "管理员", member: "成员" };

function Section({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="lg-card relative mb-5 overflow-hidden rounded-ios-3xl">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
      <div className="flex items-center justify-between border-b border-[rgba(0,0,0,0.05)] px-5 py-4 sm:px-7">
        <p className="inline-flex items-center gap-2 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
          {icon}
          {title}
        </p>
        {action}
      </div>
      <div className="px-5 py-4 sm:px-7">{children}</div>
    </section>
  );
}

function SmallButton({
  children,
  onClick,
  tone = "plain",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "plain" | "primary" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-ios-caption1 font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        tone === "primary" && "bg-[#007AFF] text-white shadow-[0_2px_10px_rgba(0,122,255,0.24)] hover:bg-[#0066DD]",
        tone === "danger" && "lg-tint-red text-[#b3271c] hover:bg-[rgba(255,59,48,0.16)]",
        tone === "plain" && "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.66)] hover:bg-[rgba(0,0,0,0.09)]",
      )}
    >
      {children}
    </button>
  );
}

export function TeamConsoleClient() {
  const [bizKey, setBizKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const [members, setMembers] = useState<MembersPayload | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequestsPayload | null>(null);
  const [seats, setSeats] = useState<SeatsPayload | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecyclePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);

  const [seatsDraft, setSeatsDraft] = useState("");
  const [joinTeamDraft, setJoinTeamDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const stored = typeof window === "undefined" ? null : window.sessionStorage.getItem(KEY_STORAGE);
    if (stored) setBizKey(stored);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadAll = useCallback(
    async (key: string) => {
      setLoading(true);
      const [m, j, s, l, u] = await Promise.all([
        call<MembersPayload>(key, "/api/v1/team/members"),
        call<JoinRequestsPayload>(key, "/api/v1/team/join-requests"),
        call<SeatsPayload>(key, "/api/v1/team/seats"),
        call<LifecyclePayload>(key, "/api/v1/team/lifecycle"),
        call<UsagePayload>(key, "/api/v1/team/usage"),
      ]);
      setLoading(false);
      if (!m.ok) {
        setNotice({ tone: "bad", text: `密鑰校驗失敗：${m.message}` });
        return;
      }
      setMembers(m.data);
      setSeatsDraft(String(m.data.seats));
      if (j.ok) setJoinRequests(j.data);
      if (s.ok) {
        setSeats(s.data);
        setSeatsDraft(String(s.data.seats));
      }
      if (l.ok) setLifecycle(l.data);
      if (u.ok) setUsage(u.data);
    },
    [],
  );

  useEffect(() => {
    if (bizKey) void loadAll(bizKey);
  }, [bizKey, loadAll]);

  const connect = () => {
    const next = keyDraft.trim();
    if (!next) return;
    window.sessionStorage.setItem(KEY_STORAGE, next);
    setKeyDraft("");
    setBizKey(next);
  };

  const disconnect = () => {
    window.sessionStorage.removeItem(KEY_STORAGE);
    setBizKey("");
    setMembers(null);
    setJoinRequests(null);
    setSeats(null);
    setLifecycle(null);
    setUsage(null);
  };

  const run = useCallback(
    async (label: string, fn: () => Promise<ApiResult<unknown>>) => {
      if (!bizKey) return;
      setBusy(label);
      const result = await fn();
      setBusy(null);
      if (!result.ok) {
        setNotice({ tone: "bad", text: `${label}：${result.message}` });
        return;
      }
      setNotice({ tone: "ok", text: `${label}：已完成` });
      await loadAll(bizKey);
    },
    [bizKey, loadAll],
  );

  const actorRole = members?.actor.role ?? null;
  const isManager = actorRole === "owner" || actorRole === "admin";

  if (!bizKey) {
    return (
      <div className="page-shell min-h-screen pb-28 pt-24">
        <div className="mx-auto w-full max-w-3xl">
          <header className="mb-8">
            <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              团队管理
            </h1>
            <p className="mt-2 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:text-ios-body">
              席位、角色、建画布权限、加入审批、解散与用量，全部走 B 端接口
            </p>
          </header>
          <Section title="连接团队" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}>
            <p className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.56)]">
              团队管理接口需要<b>团队主账号的 B 端密钥</b>（<code className="font-mono">sk-biz-…</code>）。
              可在 <Link href="/settings/api-keys" className="text-[#007AFF] hover:underline">API 密钥</Link> 页签发。
              密钥只保存在本页签的会话里（关闭标签页即失效），不会写入任何存储或日志。
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                placeholder="sk-biz-…"
                aria-label="B 端密钥"
                className="min-w-0 flex-1 rounded-ios-xl border border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.72)] px-4 py-3 font-mono text-ios-footnote text-[rgba(0,0,0,0.80)] outline-none transition-colors placeholder:text-[rgba(0,0,0,0.30)] focus:border-[rgba(0,122,255,0.45)] focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
              />
              <SmallButton tone="primary" onClick={connect} disabled={!keyDraft.trim()}>
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                连接
              </SmallButton>
            </div>
          </Section>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell min-h-screen pb-28 pt-24">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
          <div>
            <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              团队管理
            </h1>
            <p className="mt-2 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:text-ios-body">
              团队主账号 {members?.team_user_id ?? "—"} · 你的角色 {actorRole ? ROLE_LABEL[actorRole] : "—"}
            </p>
          </div>
          <div className="flex gap-2">
            <SmallButton onClick={() => void loadAll(bizKey)} disabled={loading}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
              刷新
            </SmallButton>
            <SmallButton onClick={disconnect}>断开密钥</SmallButton>
          </div>
        </header>

        {notice && (
          <div
            className={cn(
              "mb-5 flex items-start gap-2.5 rounded-ios-xl px-4 py-3 text-ios-footnote",
              notice.tone === "ok" ? "lg-tint-green text-[#1a7a3a]" : "lg-tint-red text-[#b3271c]",
            )}
          >
            {notice.tone === "ok" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            {notice.text}
          </div>
        )}

        {/* ① 建立画布权限开关 */}
        <Section
          title="建立画布权限"
          icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
          action={
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ios-caption1 font-semibold",
                members?.settings.member_create_canvas ? "lg-tint-green text-[#1a7a3a]" : "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.44)]",
              )}
            >
              {members?.settings.member_create_canvas ? "成员可建画布" : "仅所有者/管理员可建"}
            </span>
          }
        >
          <p className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.56)]">
            关闭时，普通成员无法新建共享画布（所有者与管理员始终可以；个人画布不受影响）。
          </p>
          <div className="mt-3">
            <SmallButton
              tone={isManager ? "primary" : "plain"}
              disabled={!isManager || busy !== null}
              onClick={() =>
                void run("切换建画布开关", () =>
                  call(bizKey, "/api/v1/team/settings", {
                    method: "POST",
                    body: JSON.stringify({ member_create_canvas: !members?.settings.member_create_canvas }),
                  }),
                )
              }
            >
              {members?.settings.member_create_canvas ? "关闭成员建画布" : "开启成员建画布"}
            </SmallButton>
            {!isManager && <span className="ml-3 text-ios-caption1 text-[rgba(0,0,0,0.44)]">只有所有者/管理员可改</span>}
          </div>
        </Section>

        {/* ② 成员列表 + 角色 */}
        <Section
          title={`成员（${members?.members.length ?? 0} / 席位 ${members?.seats ?? "—"}）`}
          icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {!members || members.members.length === 0 ? (
            <p className="py-4 text-center text-ios-footnote text-[rgba(0,0,0,0.44)]">还没有成员。审批通过加入申请后会出现。</p>
          ) : (
            <ul className="divide-y divide-[rgba(0,0,0,0.05)]">
              {members.members.map((member) => (
                <li key={member.member_key_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ios-body font-semibold text-[rgba(0,0,0,0.78)]">
                      {member.display_name || `用户 ${member.member_user_id}`}
                    </p>
                    <p className="mt-1 font-mono text-ios-caption1 text-[rgba(0,0,0,0.44)]">
                      user {member.member_user_id} · key {member.member_key_id}
                    </p>
                  </div>
                  <select
                    aria-label={`${member.display_name} 的角色`}
                    value={member.role}
                    disabled={!isManager || busy !== null}
                    onChange={(event) =>
                      void run("变更角色", () =>
                        call(bizKey, "/api/v1/team/members", {
                          method: "POST",
                          body: JSON.stringify({ action: "set_role", member_key_id: member.member_key_id, role: event.target.value }),
                        }),
                      )
                    }
                    className="cursor-pointer rounded-full border border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.72)] px-3 py-1.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.70)] outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                    <option value="owner">所有者</option>
                  </select>
                  <button
                    type="button"
                    title="移除成员"
                    aria-label={`移除 ${member.display_name}`}
                    disabled={!isManager || busy !== null}
                    onClick={() => {
                      if (!window.confirm(`确定把「${member.display_name || member.member_user_id}」移出团队？`)) return;
                      void run("移除成员", () =>
                        call(bizKey, "/api/v1/team/members", {
                          method: "POST",
                          body: JSON.stringify({ action: "remove", member_key_id: member.member_key_id }),
                        }),
                      );
                    }}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-[rgba(255,59,48,0.10)] hover:text-[#c72a1e] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ③ 加入申请审批 */}
        <Section
          title={`加入申请（${joinRequests?.requests.length ?? 0}）`}
          icon={<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {!joinRequests || joinRequests.requests.length === 0 ? (
            <p className="py-2 text-ios-footnote text-[rgba(0,0,0,0.44)]">没有待审申请。</p>
          ) : (
            <ul className="divide-y divide-[rgba(0,0,0,0.05)]">
              {joinRequests.requests.map((request) => (
                <li key={request.request_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ios-body font-semibold text-[rgba(0,0,0,0.78)]">
                      {request.display_name || `用户 ${request.applicant_user_id}`}
                    </p>
                    <p className="mt-1 text-ios-caption1 text-[rgba(0,0,0,0.44)]">
                      user {request.applicant_user_id} · {new Date(request.created_at).toLocaleString("zh-CN")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <SmallButton
                      tone="primary"
                      disabled={!isManager || busy !== null}
                      onClick={() =>
                        void run("批准申请", () =>
                          call(bizKey, "/api/v1/team/join-requests", {
                            method: "POST",
                            body: JSON.stringify({ action: "decide", request_id: request.request_id, decision: "approve" }),
                          }),
                        )
                      }
                    >
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      批准
                    </SmallButton>
                    <SmallButton
                      disabled={!isManager || busy !== null}
                      onClick={() =>
                        void run("拒绝申请", () =>
                          call(bizKey, "/api/v1/team/join-requests", {
                            method: "POST",
                            body: JSON.stringify({ action: "decide", request_id: request.request_id, decision: "reject" }),
                          }),
                        )
                      }
                    >
                      <Ban className="h-3 w-3" aria-hidden="true" />
                      拒绝
                    </SmallButton>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-[rgba(0,0,0,0.05)] pt-4">
            <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)]">以当前密钥申请加入其他团队</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={joinTeamDraft}
                onChange={(event) => setJoinTeamDraft(event.target.value)}
                placeholder="团队主账号 user id"
                aria-label="要加入的团队主账号 user id"
                className="min-w-0 flex-1 rounded-ios-xl border border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.72)] px-4 py-2.5 text-ios-footnote text-[rgba(0,0,0,0.80)] outline-none placeholder:text-[rgba(0,0,0,0.30)] focus:border-[rgba(0,122,255,0.45)]"
              />
              <SmallButton
                disabled={!joinTeamDraft.trim() || busy !== null}
                onClick={() =>
                  void run("提交加入申请", () =>
                    call(bizKey, "/api/v1/team/join-requests", {
                      method: "POST",
                      body: JSON.stringify({ action: "apply", team_user_id: Number(joinTeamDraft.trim()) }),
                    }),
                  )
                }
              >
                <UserPlus className="h-3 w-3" aria-hidden="true" />
                提交申请
              </SmallButton>
            </div>
          </div>
        </Section>

        {/* ④ 席位 */}
        <Section title="席位数" icon={<Crown className="h-3.5 w-3.5" aria-hidden="true" />}>
          <p className="text-ios-footnote text-[rgba(0,0,0,0.56)]">
            当前席位 {seats?.seats ?? "—"} · 已用 {seats?.member_count ?? "—"} · 容量上限 {seats?.capacity.max_members ?? "—"}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={1}
              value={seatsDraft}
              onChange={(event) => setSeatsDraft(event.target.value)}
              aria-label="席位数"
              className="w-28 rounded-ios-xl border border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.72)] px-3 py-2 text-ios-footnote text-[rgba(0,0,0,0.80)] outline-none focus:border-[rgba(0,122,255,0.45)]"
            />
            <SmallButton
              tone="primary"
              disabled={!isManager || busy !== null || !seatsDraft.trim()}
              onClick={() =>
                void run("调整席位", () =>
                  call(bizKey, "/api/v1/team/seats", { method: "POST", body: JSON.stringify({ seats: Number(seatsDraft.trim()) }) }),
                )
              }
            >
              保存席位数
            </SmallButton>
          </div>
          <p className="mt-3 rounded-ios-xl px-4 py-3 text-ios-caption1 leading-relaxed text-[#8a6410] lg-tint-gold">
            席位目前只是<b>人数上限的意图整数</b>：尚未接入计费，不能按席位购买、续费或扣款。购买与续费仍走
            <Link href="/pricing" className="mx-1 text-[#007AFF] hover:underline">套餐页</Link>
            （充值进团队主账号余额后，成员额度分配走 B 端接口）。
          </p>
        </Section>

        {/* ⑤ 解散 / 退出 */}
        <Section title="解散与退出" icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />}>
          {lifecycle?.dissolved ? (
            <p className="rounded-ios-xl px-4 py-3 text-ios-footnote text-[#b3271c] lg-tint-red">
              团队已解散（{lifecycle.dissolved_at ? new Date(lifecycle.dissolved_at).toLocaleString("zh-CN") : "—"}）。
            </p>
          ) : lifecycle?.dissolve_scheduled_at ? (
            <div className="rounded-ios-xl px-4 py-3 text-[#b3271c] lg-tint-red">
              <p className="text-ios-footnote font-semibold">
                已排程解散：{new Date(lifecycle.dissolve_scheduled_at).toLocaleString("zh-CN")}
              </p>
              <p className="mt-1 text-ios-caption1">
                冷静期 {lifecycle.cooloff_hours} 小时，剩余{" "}
                {lifecycle.remaining_ms ? `${Math.ceil(lifecycle.remaining_ms / 3_600_000)} 小时` : "已到期"}。
              </p>
              <div className="mt-3">
                <SmallButton
                  disabled={!isManager || busy !== null}
                  onClick={() =>
                    void run("撤回解散", () => call(bizKey, "/api/v1/team/lifecycle", { method: "POST", body: JSON.stringify({ action: "withdraw" }) }))
                  }
                >
                  冷静期内撤回解散
                </SmallButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <SmallButton
                tone="danger"
                disabled={!isManager || busy !== null}
                onClick={() => {
                  if (!window.confirm(`确定排程解散团队？${lifecycle?.cooloff_hours ?? 48} 小时内可撤回。`)) return;
                  void run("排程解散", () => call(bizKey, "/api/v1/team/lifecycle", { method: "POST", body: JSON.stringify({ action: "dissolve" }) }));
                }}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                解散团队（{lifecycle?.cooloff_hours ?? 48}h 冷静期）
              </SmallButton>
              <SmallButton
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm("确定退出团队？退出后需要重新申请加入。")) return;
                  void run("退出团队", () => call(bizKey, "/api/v1/team/lifecycle", { method: "POST", body: JSON.stringify({ action: "leave" }) }));
                }}
              >
                退出团队
              </SmallButton>
            </div>
          )}
        </Section>

        {/* ⑥ 用量 */}
        <Section title="用量" icon={<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />}>
          {!usage ? (
            <p className="py-2 text-ios-footnote text-[rgba(0,0,0,0.44)]">用量暂不可用。</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "已发放金币", value: usage.totals.granted_coins },
                  { label: "已消耗金币", value: usage.totals.used_coins },
                  { label: "剩余金币", value: usage.totals.remaining_coins },
                  { label: "成员数", value: usage.member_count },
                ].map((item) => (
                  <div key={item.label} className="rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3 py-2.5">
                    <p className="text-ios-caption1 text-[rgba(0,0,0,0.48)]">{item.label}</p>
                    <p className="mt-0.5 text-ios-body font-semibold text-[rgba(0,0,0,0.78)]">{item.value}</p>
                  </div>
                ))}
              </div>
              <p className={cn("mt-3 text-ios-caption1", usage.conservation.balanced ? "text-[#1a7a3a]" : "text-[#b3271c]")}>
                余额守恒：{usage.conservation.balanced ? "平衡" : "不平衡"} · {usage.conservation.formula}
              </p>
              {usage.members.length > 0 && (
                <ul className="mt-3 divide-y divide-[rgba(0,0,0,0.05)]">
                  {usage.members.map((member) => (
                    <li key={member.member_key_id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-ios-footnote font-semibold text-[rgba(0,0,0,0.74)]">
                          {member.display_name || `用户 ${member.member_user_id}`} · {ROLE_LABEL[member.role]}
                        </p>
                        <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.44)]">
                          发放 {member.granted_coins} · 已用 {member.used_coins} · 剩余 {member.remaining_coins}
                          {member.unavailable ? " · 上游暂不可读" : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>

        <p className="mt-5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.46)]">
          团队治理接口的团队身份来自密钥本身（团队主账号 user id），不信任请求体；角色/席位/解散只写意图，
          不触碰任何点数。额度分配走独立的 B 端额度接口，本页不代做转账。
        </p>
      </div>
    </div>
  );
}
