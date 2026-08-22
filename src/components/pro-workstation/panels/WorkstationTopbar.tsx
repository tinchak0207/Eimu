"use client";

import { memo } from "react";
import Link from "next/link";
import { ArrowLeft, CircleHelp, CreditCard, History, Keyboard, Loader2, LogOut, User } from "lucide-react";
import { WalletBadge } from "@/components/WalletBadge";
import { CheckinCalendar } from "@/components/CheckinCalendar";
import type { NewApiUser } from "@/lib/new-api-client";
import type { WorkstationCommandId } from "@/lib/workstation-commands";
import { cn } from "@/lib/utils";
import { MOBILE_PANELS, WORKSPACE_MODES, type MobilePanel, type WorkspaceMode } from "../workstation-constants";

export interface WorkstationTopbarProps {
  activeWorkspaceTitle: string;
  workspaceMode: WorkspaceMode;
  onActivateWorkspace: (mode: WorkspaceMode) => void;
  completedSlots: number;
  runningSlots: number;
  failedSlots: number;
  executeCommand: (commandId: WorkstationCommandId) => void;
  isLoggedIn: boolean;
  user: NewApiUser | null;
  onLogout: () => void;
  startTour: () => void;
  onExitProfessionalMode?: () => void;
  /** 手机版进度条与生成按钮的共享状态。 */
  isLoading: boolean;
  runTotal: number;
  runSettled: number;
  runProgress: number;
  runEtaLabel: string | null;
  mobilePanel: MobilePanel;
  onActivateMobilePanel: (panel: MobilePanel) => void;
  prompt: string;
  handleRunClick: () => void;
  canRun: boolean;
  copies: number;
}

/**
 * 顶栏 + 手机版进度条 + 手机版底部导航（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 纯展示：所有状态与命令派发留在工作台入口，这里只收 props。
 */
export const WorkstationTopbar = memo(function WorkstationTopbar({
  activeWorkspaceTitle,
  workspaceMode,
  onActivateWorkspace,
  completedSlots,
  runningSlots,
  failedSlots,
  executeCommand,
  isLoggedIn,
  user,
  onLogout,
  startTour,
  onExitProfessionalMode,
  isLoading,
  runTotal,
  runSettled,
  runProgress,
  runEtaLabel,
  mobilePanel,
  onActivateMobilePanel,
  prompt,
  handleRunClick,
  canRun,
  copies,
}: WorkstationTopbarProps) {
  return (
    <>
      <header className="pro-studio-topbar">
        {/* 左：站点标识 + 工作站名。专业模式顶栏已与全局导航合并，这里承担全站 header 角色。 */}
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            aria-label="回到首页"
            className="lg-float flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-ios-lg"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Eimu" width={32} height={32} className="h-full w-full object-cover" />
          </Link>
          <h2 className="flex min-w-0 items-baseline gap-1.5 truncate text-ios-subhead font-bold text-foreground">
            <span className="pro-title-desktop shrink-0">Eimu · 创作工作站</span>
            <span className="pro-title-mobile">Eimu</span>
          </h2>
          <p className="hidden truncate text-ios-caption1 font-semibold text-foreground/45 lg:block">{activeWorkspaceTitle}</p>
        </div>
        <div className="pro-mode-segment" id="pro-tour-segment" aria-label="中央视图切换">
          {WORKSPACE_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => onActivateWorkspace(mode.id)}
              className={cn(workspaceMode === mode.id && "is-active")}
              title={mode.title}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {/*
          队列速览是按钮，不是状态灯。看到「失败 2」的下一个动作必然是
          「去看是哪两个」，纯 <span> 点下去没反应，用户只能自己去右栏找 tab。
          1024px 以下由 CSS 收起，让位给顶栏其余动作。
        */}
        <div className="pro-topbar-chips" role="group" aria-label="队列速览">
          <button type="button" data-state="done" onClick={() => executeCommand("open_gallery")} title="查看已完成的成片">
            已完成 {completedSlots}
          </button>
          <button type="button" data-state="running" onClick={() => executeCommand("open_queue")} title="查看正在生成的任务">
            进行中 {runningSlots}
          </button>
          <button type="button" data-state="failed" onClick={() => executeCommand("open_queue")} title="查看失败任务与原因">
            失败 {failedSlots}
          </button>
        </div>
        <div className="pro-topbar-actions flex shrink-0 items-center gap-2">
          {/* 全局导航右区并入：余额 / 历史 / 充值 / 账号，与工作站动作同栏。 */}
          {isLoggedIn && user && (
            <>
              <WalletBadge showTopUp={false} showCheckin={false} className="hidden min-w-0 xl:flex" />
              <CheckinCalendar className="hidden shrink-0 xl:flex" />
              <Link
                href="/history"
                aria-label="历史"
                title="历史"
                className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl lg-float px-3 py-1.5 text-ios-footnote font-semibold text-muted-foreground transition-all hover:bg-white/75 lg:inline-flex"
              >
                <History className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/pricing"
                aria-label="充值"
                title="充值"
                className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl bg-ios-blue px-3 py-1.5 text-ios-footnote font-semibold text-white shadow-[0_8px_22px_rgba(0,122,255,0.30)] transition-all hover:bg-ios-blue/80 lg:inline-flex"
              >
                <CreditCard className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => executeCommand("show_commands")}
            aria-label="查看工作台快捷键"
            title="快捷键（?）"
            className="pro-topbar-tool inline-flex items-center gap-1.5 rounded-ios-xl lg-float px-3 py-1.5 text-ios-footnote font-semibold text-muted-foreground transition-all hover:bg-white/75"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={startTour}
            aria-label="播放引导"
            title="播放引导"
            className="pro-topbar-tool inline-flex items-center gap-1.5 rounded-ios-xl lg-float px-3 py-1.5 text-ios-footnote font-semibold text-muted-foreground transition-all hover:bg-white/75"
          >
            <CircleHelp className="h-3.5 w-3.5" />
            <span className="pro-action-label">播放引导</span>
          </button>
          {isLoggedIn && user && (
            <div className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl lg-float px-3 py-1.5 xl:inline-flex">
              <User className="h-3.5 w-3.5 text-foreground/45" aria-hidden="true" />
              <span className="max-w-[88px] truncate text-ios-footnote font-medium text-muted-foreground">
                {user.display_name || user.username}
              </span>
              <button
                type="button"
                onClick={onLogout}
                aria-label="退出登录"
                title="退出登录"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 transition-colors hover:text-muted-foreground"
              >
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          )}
          {onExitProfessionalMode && (
            <button
              type="button"
              onClick={onExitProfessionalMode}
              aria-label="返回普通模式"
              title="返回普通模式"
              className="pro-topbar-tool inline-flex items-center gap-2 rounded-ios-xl lg-float px-3 py-1.5 text-ios-footnote font-semibold text-muted-foreground transition-all hover:bg-white/75"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="pro-action-label">返回普通模式</span>
            </button>
          )}
        </div>
      </header>

      {/*
        手机版的进度条。桌面版有顶栏三个数字 chip 和队列面板，手机版把它们都藏了，
        于是点完生成之后除了按钮变灰之外没有任何反馈，用户只能反复切到「产出」面板看。
      */}
      {(isLoading || runningSlots > 0) && (
        <div className="pro-mobile-progress" role="status" aria-live="polite">
          <div
            className="pro-run-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={runTotal}
            aria-valuenow={runSettled}
            aria-label="生成进度"
          >
            <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
          </div>
          <span>
            {runSettled} / {runTotal}
            {runEtaLabel ? ` · ${runEtaLabel}` : ""}
          </span>
        </div>
      )}

      <div className="pro-mobile-bottom-area">
        <nav className="pro-mobile-nav" aria-label="工作面导航">
          {MOBILE_PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              aria-current={mobilePanel === panel.id ? "page" : undefined}
              onClick={() => onActivateMobilePanel(panel.id)}
              className={cn(mobilePanel === panel.id && "is-active")}
            >
              {panel.label}
            </button>
          ))}
        </nav>

        {/* 手机版生成按钮：有提示词才显示 */}
        {prompt.trim() && <div className="pro-mobile-generate-bar">
          <button
            type="button"
            onClick={handleRunClick}
            data-disabled={!canRun || undefined}
            aria-label={isLoading ? "正在生成" : `生成 ${copies} 张`}
            title={canRun ? "生成（⌘ Enter）" : isLoading ? "正在生成" : "先写画面描述"}
            className="pro-mobile-generate-btn"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>正在生成…</span>
              </>
            ) : (
              <span>生成 {copies} 张</span>
            )}
          </button>
        </div>}
      </div>
    </>
  );
});
