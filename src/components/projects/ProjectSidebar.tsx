"use client";

// 项目侧栏（P0-W2，2026-10-09）。
//
// 槽位：本元件渲染在画布工作站的 .canvas-chat-panel 槽位里（桌面，宽度仍吃
// --ws-panel-w），或手机端推入抽屉（.mobile-sidebar-panel 内部）。壳由容器给，
// 本档只出内容（header ＋ 单一卷动区），所以同一份内容能同时住进两种容器。
//
// 两段（照 ZCode 侧栏分区做法）：
//   ① 项目段：每个项目一行（名称＋相对时间），当前项高亮；可展开成该项目下的
//      聊天列表；行尾常驻改名／归档；底部「＋ 新建项目」。归档＝折进「已归档」
//      （默认折叠，不硬删）。空态给一句引导。
//   ② 最近聊天：全部会话按 last_activity_at 降序；未挂项目的显示「未分类」。
//
// 轮子复用：行样式与相对时间全走既有 AgentSessionList / formatSessionRelativeTime
// （2026-10-03 对标 Grok 抽出的共用清单），不复制第二份。
//
// props 冻结（宿主 ImagePlayground 经 CanvasChatWorkstation 的 projectPanel 接线）：
//   currentSessionId / onPickChat / onClose。

import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderKanban,
  Loader2,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import {
  AgentSessionList,
  formatSessionRelativeTime,
} from "@/components/agent-chat/AgentSessionList";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";
import {
  useCreativeProjects,
  type ProjectChatView,
  type ProjectView,
} from "@/hooks/use-creative-projects";
import { cn } from "@/lib/utils";

export interface ProjectSidebarProps {
  /** 当前会话 id（高亮用），来自宿主（ImagePlayground 已持有：handleAgentSessionChange 那一带）。 */
  currentSessionId: string | null;
  /** 点某条聊天：宿主走 switchSessionRef 真切会话。 */
  onPickChat: (sessionId: string) => void;
  /** 关闭并回到聊天。 */
  onClose: () => void;
}

/**
 * ProjectChatView → AgentSessionList 吃的 AgentSessionSummary。
 * updatedAt 是 ms epoch（见 hook 的 ProjectChatView 契约），三个时间栏位同值——
 * 列表只读 last_activity_at 显相对时间、created_at 作 formatLabel 的时间兜底。
 */
function toSummary(chat: ProjectChatView): AgentSessionSummary {
  return {
    session_id: chat.sessionId,
    created_at: chat.updatedAt,
    updated_at: chat.updatedAt,
    last_activity_at: chat.updatedAt,
    status: chat.status,
    // title 已是 hook 解析好的显示标题（含「未命名对话」兜底），直接当网关标题注入。
    title: chat.title,
  };
}

/** 标题优先显示 hook 解析好的显示标题；空字串才退回「未命名对话」。 */
function labelFromTitle(it: AgentSessionSummary): string {
  return it.title?.trim() || "未命名对话";
}

export function ProjectSidebar({ currentSessionId, onPickChat, onClose }: ProjectSidebarProps) {
  const {
    projects,
    unassigned,
    activeProjectId,
    loading,
    error,
    selectProject,
    createProject,
    renameProject,
    setProjectArchived,
  } = useCreativeProjects();

  // 展开的项目（一次只开一个：ZCode 侧栏同款树状展开）。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 「已归档」折叠区默认收起（暴君裁定：归档项目默认折叠）。
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 行内改名态：null＝没有在改名。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);

  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const archivedProjects = useMemo(() => projects.filter((p) => p.archived), [projects]);

  // 最近聊天：全部会话（跨项目 + 未分类），按 updatedAt 降序，同一 session 去重。
  const recentChats = useMemo(() => {
    const seen = new Set<string>();
    const all: ProjectChatView[] = [];
    for (const project of projects) {
      for (const chat of project.chats) {
        if (chat.archived) continue;
        if (!chat.sessionId || seen.has(chat.sessionId)) continue;
        seen.add(chat.sessionId);
        all.push(chat);
      }
    }
    for (const chat of unassigned) {
      if (!chat.sessionId || seen.has(chat.sessionId)) continue;
      seen.add(chat.sessionId);
      all.push(chat);
    }
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects, unassigned]);

  // 「未分类」判定：不属于任何项目的会话。
  const assignedSessions = useMemo(() => {
    const set = new Set<string>();
    for (const project of projects) for (const chat of project.chats) if (chat.sessionId) set.add(chat.sessionId);
    return set;
  }, [projects]);

  const recentFormatLabel = (it: AgentSessionSummary): string => {
    const title = labelFromTitle(it);
    return assignedSessions.has(it.session_id) ? title : `未分类 · ${title}`;
  };

  const pickChat = (sessionId: string) => {
    onPickChat(sessionId);
    // 点某条聊天＝回到聊天（暴君裁定）。
    onClose();
  };

  const toggleExpand = (project: ProjectView) => {
    selectProject(project.id);
    setExpandedId((current) => (current === project.id ? null : project.id));
  };

  const beginRename = (project: ProjectView) => {
    setRenamingId(project.id);
    setRenameDraft(project.title);
  };

  const commitRename = (project: ProjectView) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (next && next !== project.title) void renameProject(project.id, next);
  };

  const handleCreate = () => {
    setCreating(true);
    void createProject().finally(() => setCreating(false));
  };

  /** 一份聊天清单：空则给一句，非空走共用 AgentSessionList（行样式轮子）。 */
  const renderChatList = (
    chats: ProjectChatView[],
    emptyText: string,
    formatLabel: (it: AgentSessionSummary) => string,
  ) => {
    if (chats.length === 0) {
      return <p className="px-3 py-2 text-ios-footnote text-foreground/40">{emptyText}</p>;
    }
    return (
      <AgentSessionList
        sessions={chats.map(toSummary)}
        currentSessionId={currentSessionId}
        switchingTo={null}
        startingNew={false}
        formatLabel={formatLabel}
        onPick={pickChat}
        // 非空清单不会走到 AgentSessionList 自己的空态 CTA（本档已各自处理空态）。
        onStartNew={() => {
          /* 不可达：仅非空清单走 AgentSessionList，其空态 CTA 不渲染。 */
        }}
      />
    );
  };

  const isFirstLoadEmpty = loading && projects.length === 0 && unassigned.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <FolderKanban className="h-[1.125rem] w-[1.125rem] shrink-0 text-foreground/45" aria-hidden="true" />
        <h2 className="text-ios-headline text-foreground/85">项目</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭项目侧栏"
          title="关闭"
          className="ml-auto flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-black/[0.06] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] [-webkit-tap-highlight-color:transparent]"
        >
          <X className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {/* ── 项目段 ─────────────────────────────────────────── */}
        <section aria-label="项目">
          <p className="px-3 pb-1 pt-1 text-ios-subhead font-semibold text-foreground/45">项目</p>

          {isFirstLoadEmpty ? (
            <p className="px-3 py-3 text-ios-footnote text-foreground/45">正在加载项目…</p>
          ) : activeProjects.length === 0 ? (
            <div className="px-3 py-2">
              <p className="text-ios-footnote leading-relaxed text-foreground/45">
                还没有项目。新建一个，把这次的作品和对话收进去。
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {activeProjects.map((project) => {
                const expanded = expandedId === project.id;
                const active = activeProjectId === project.id;
                return (
                  <li key={project.id}>
                    <div
                      className={cn(
                        "flex items-center gap-0.5 rounded-[14px] pr-1 transition-colors",
                        active ? "bg-black/[0.05]" : "hover:bg-black/[0.04]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpand(project)}
                        aria-expanded={expanded}
                        className="flex min-h-[52px] min-w-0 flex-1 cursor-pointer touch-manipulation items-center gap-2 px-2 py-2 text-left focus:outline-none focus-visible:bg-black/[0.04] [-webkit-tap-highlight-color:transparent]"
                      >
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 shrink-0 text-foreground/40 transition-transform",
                            expanded && "rotate-90",
                          )}
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          {renamingId === project.id ? (
                            // eslint-disable-next-line jsx-a11y/no-autofocus
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") commitRename(project);
                                if (event.key === "Escape") setRenamingId(null);
                              }}
                              onBlur={() => commitRename(project)}
                              aria-label="项目名称"
                              className="w-full rounded-md border border-input bg-black/5 px-2 py-0.5 text-ios-subhead font-medium text-foreground/85 outline-none focus:border-ios-blue"
                            />
                          ) : (
                            <span className="truncate text-ios-subhead font-medium text-foreground/85">
                              {project.title}
                            </span>
                          )}
                          <span className="text-ios-footnote text-foreground/45">
                            {formatSessionRelativeTime(project.updatedAt)}
                            {project.chats.length > 0 ? ` · ${project.chats.length} 个聊天` : ""}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => beginRename(project)}
                        aria-label="重命名项目"
                        title="重命名"
                        className="flex h-8 w-8 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-black/[0.06] hover:text-foreground/75 focus:outline-none focus-visible:bg-black/[0.06] [-webkit-tap-highlight-color:transparent]"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void setProjectArchived(project.id, true)}
                        aria-label="归档项目"
                        title="归档（收进「已归档」）"
                        className="flex h-8 w-8 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-black/[0.06] hover:text-foreground/75 focus:outline-none focus-visible:bg-black/[0.06] [-webkit-tap-highlight-color:transparent]"
                      >
                        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    {expanded && (
                      <div className="pb-1 pl-4 pr-1">
                        {renderChatList(project.chats, "这个项目还没有聊天。", labelFromTitle)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="mt-1 flex min-h-[44px] w-full cursor-pointer touch-manipulation items-center gap-2 rounded-[14px] px-3 text-left text-ios-subhead font-medium text-ios-blue transition-colors hover:bg-ios-blue/[0.08] active:bg-ios-blue/[0.12] disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:bg-ios-blue/[0.08] [-webkit-tap-highlight-color:transparent]"
          >
            {creating ? (
              <Loader2 className="h-[1.125rem] w-[1.125rem] shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-[1.125rem] w-[1.125rem] shrink-0" aria-hidden="true" />
            )}
            新建项目
          </button>

          {/* 已归档折叠区（默认收起，不硬删）。 */}
          {archivedProjects.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setArchivedOpen((open) => !open)}
                aria-expanded={archivedOpen}
                className="flex min-h-[44px] w-full cursor-pointer touch-manipulation items-center gap-2 rounded-[14px] px-3 text-left text-ios-footnote font-medium text-foreground/45 transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:bg-black/[0.04] [-webkit-tap-highlight-color:transparent]"
              >
                <ChevronRight
                  className={cn("h-4 w-4 shrink-0 transition-transform", archivedOpen && "rotate-90")}
                  aria-hidden="true"
                />
                已归档（{archivedProjects.length}）
              </button>
              {archivedOpen && (
                <ul className="flex flex-col gap-0.5">
                  {archivedProjects.map((project) => (
                    <li key={project.id}>
                      <div className="flex items-center gap-0.5 rounded-[14px] pr-1">
                        <span className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center gap-0.5 px-3">
                          <span className="truncate text-ios-subhead font-medium text-foreground/60">
                            {project.title}
                          </span>
                          <span className="text-ios-footnote text-foreground/40">
                            {formatSessionRelativeTime(project.updatedAt)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void setProjectArchived(project.id, false)}
                          aria-label="取消归档"
                          title="取消归档"
                          className="flex h-8 w-8 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-black/[0.06] hover:text-foreground/75 focus:outline-none focus-visible:bg-black/[0.06] [-webkit-tap-highlight-color:transparent]"
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* ── 最近聊天段 ─────────────────────────────────────── */}
        <section aria-label="最近聊天" className="mt-2">
          <p className="px-3 pb-1 pt-2 text-ios-subhead font-semibold text-foreground/45">最近聊天</p>
          {recentChats.length === 0 ? (
            <p className="px-3 py-2 text-ios-footnote text-foreground/40">还没有聊天记录</p>
          ) : (
            <div className="px-1">
              {renderChatList(recentChats, "还没有聊天记录", recentFormatLabel)}
            </div>
          )}
        </section>

        {error && (
          <p className="px-3 pt-3 text-ios-footnote text-ios-red" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
