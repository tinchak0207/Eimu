/** @jsxRuntime automatic @jsxImportSource react */
"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FolderCheck, FolderOpen, Loader2, MonitorDown, ShieldCheck } from "lucide-react";
import {
  BRIDGE_UNAVAILABLE_LABEL,
  bridgeToneClass,
  createDeviceBridgeController,
  describeBridgeAvailability,
  describeBridgeStatus,
  getDeviceBridgeApi,
  type BridgeAvailability,
  type BridgeDisplay,
} from "@/lib/device-bridge-display";
import { cn } from "@/lib/utils";

/** 頂部高光：Liquid Glass 材質的標準頂邊反射線（照 settings 既有版式）。 */
function Specular() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
  );
}

/**
 * 純展示層（受控）：所有文案／色調由 `device-bridge-display.ts` 的純函式先算好，
 * 本層只畫。拆出來是為了能在無 DOM 的 node:test 以 renderToStaticMarkup 驗各態。
 */
export interface LocalFilesViewProps {
  available: boolean;
  availability: BridgeAvailability;
  display: BridgeDisplay;
  enabled: boolean;
  loading: boolean;
  busy: boolean;
  notice: string | null;
  onToggle: () => void;
  onPickFolder: () => void;
}

export function LocalFilesView({
  available,
  availability,
  display,
  enabled,
  loading,
  busy,
  notice,
  onToggle,
  onPickFolder,
}: LocalFilesViewProps) {
  return (
    <div className="page-shell min-h-screen pb-28 pt-24">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
            本機檔案
          </h1>
          <p className="mt-2 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:text-ios-body">
            授權桌面版讀取本機資料夾，讓 agent 能在你指定的範圍內讀檔。
          </p>
        </header>

        {!available ? (
          /* 純瀏覽器：漸進增強的「需要桌面版」，不是錯誤；不顯示開關。 */
          <section className="lg-card relative overflow-hidden rounded-ios-3xl p-8 text-center" data-testid="bridge-unavailable">
            <Specular />
            <MonitorDown className="mx-auto h-10 w-10 text-[rgba(0,0,0,0.20)]" aria-hidden="true" />
            <p className="mt-4 text-ios-body font-semibold text-[rgba(0,0,0,0.72)]">{BRIDGE_UNAVAILABLE_LABEL}</p>
            <p className="mx-auto mt-1.5 max-w-md text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
              {availability.description}
            </p>
          </section>
        ) : (
          <section className="lg-card relative overflow-hidden rounded-ios-3xl" data-testid="bridge-enabled-surface">
            <Specular />

            {/* 狀態列：三態人話 + 開關 */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[rgba(0,0,0,0.05)] px-5 py-4 sm:px-7">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[rgba(0,0,0,0.40)]" aria-hidden="true" />}
                  <span className={cn("text-ios-body font-semibold", bridgeToneClass(display.tone))} data-testid="bridge-status-label">
                    {display.label}
                  </span>
                </div>
                {display.description && (
                  <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]" data-testid="bridge-status-description">
                    {display.description}
                  </p>
                )}
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="本機檔案授權"
                data-testid="bridge-toggle"
                disabled={busy || loading}
                onClick={onToggle}
                className={cn(
                  "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
                  enabled ? "bg-[#34C759]" : "bg-[rgba(0,0,0,0.18)]",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.20)] transition-transform duration-200",
                    enabled ? "translate-x-6" : "translate-x-1",
                  )}
                />
              </button>
            </div>

            {/* 動作與已授權資料夾清單 */}
            <div className="px-5 py-5 sm:px-7">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="bridge-pick-folder"
                  disabled={busy}
                  onClick={onPickFolder}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}
                  選擇資料夾
                </button>
                <span className="text-ios-caption1 text-[rgba(0,0,0,0.44)]">可重複選擇多個資料夾</span>
              </div>

              <div className="mt-5">
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)]">已授權的資料夾</p>
                {display.roots.length === 0 ? (
                  <p className="mt-1.5 text-ios-footnote text-[rgba(0,0,0,0.44)]" data-testid="bridge-roots-empty">
                    尚未授權任何資料夾。
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5" data-testid="bridge-roots">
                    {display.roots.map((root) => (
                      <li
                        key={root}
                        className="flex items-center gap-2 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3.5 py-2.5"
                      >
                        <FolderCheck className="h-3.5 w-3.5 shrink-0 text-[#1a7a3a]" aria-hidden="true" />
                        <code className="min-w-0 flex-1 truncate font-mono text-ios-footnote text-[rgba(0,0,0,0.74)]">
                          {root}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {notice && (
                <p className="mt-4 rounded-ios-xl px-4 py-3 text-ios-footnote leading-relaxed text-[#b3271c] lg-tint-red" data-testid="bridge-notice">
                  {notice}
                </p>
              )}
            </div>
          </section>
        )}

        {/* 誠實說明：授權範圍與不讀什麼 */}
        <div className="mt-5 flex items-start gap-2.5 rounded-ios-xl px-4 py-3.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.54)] lg-tint-blue">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0a5bd3]" aria-hidden="true" />
          <span>
            agent 只能讀你在這裡授權的資料夾；憑證、私鑰等敏感路徑（如 <code className="font-mono">~/.ssh</code>、
            <code className="font-mono">~/.aws</code>）一律不讀，授權範圍之外一律拒絕。
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 薄殼：建立 controller、訂閱它（useSyncExternalStore）、把純函式吐出的語義交給展示層。
 * 純瀏覽器（無 `window.eimuLocal`）時 controller 快照 available:false ⇒ 展示層只出「需要桌面版」。
 */
export function LocalFilesClient() {
  const controller = useMemo(() => createDeviceBridgeController(getDeviceBridgeApi), []);

  useEffect(() => {
    controller.init();
    // 卸載時取消訂閱 onBridgeStatus。
    return () => controller.dispose();
  }, [controller]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const availability = describeBridgeAvailability(snap.available ? getDeviceBridgeApi() : undefined);
  const display = describeBridgeStatus(snap.status);

  return (
    <LocalFilesView
      available={snap.available}
      availability={availability}
      display={display}
      enabled={snap.status?.enabled ?? false}
      loading={snap.loading}
      busy={snap.busy}
      notice={snap.notice}
      onToggle={() => void controller.setEnabled(!(snap.status?.enabled ?? false))}
      onPickFolder={() => void controller.pickDirectory()}
    />
  );
}