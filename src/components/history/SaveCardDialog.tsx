"use client";

// 歷史「存为角色卡」輕量命名對話框：kind 三選（角色/場景/風格）+ 名稱輸入，
// POST /api/character-cards（復用 character-card-client，不重複造 API 層）。
// 面板風格複用歷史頁既有語法：lg-sheet 玻璃面板 + iOS 字級/圓角。
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IdCard, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveCharacterCard } from "@/lib/character-card-client";
import { cardFromHistoryEntry, anchorSuccessMessage } from "@/lib/history-card-anchor";
import { CHARACTER_CARD_KIND_LABEL, CHARACTER_CARD_KIND_VALUES } from "@/lib/character-cards";
import type { CharacterCardKind } from "@/lib/character-cards";
import type { HistoryEntry } from "@/lib/history-types";

export interface SaveCardDialogProps {
  entry: HistoryEntry;
  onClose: () => void;
  /** 完成回調（成功或明確失敗都由這裡把結果帶回頁面通知條）。 */
  onDone: (message: string) => void;
}

const KIND_HINT: Record<CharacterCardKind, string> = {
  character: "锁定角色外观",
  scene: "锁定场景环境",
  style: "锁定画面风格",
};

export function SaveCardDialog({ entry, onClose, onDone }: SaveCardDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [kind, setKind] = useState<CharacterCardKind>("character");
  const [name, setName] = useState(() => entry.prompt.trim().slice(0, 40));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  // 打开时聚焦名称输入，默认全选，方便直接改名。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  const handleSubmit = async () => {
    if (saving) return;
    const card = cardFromHistoryEntry(entry, kind, name);
    if (!card) {
      setError(!name.trim() ? "请填写卡片名称" : "这条记录没有可用的图片");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await saveCharacterCard(card);
    setSaving(false);
    if (result.ok) {
      onDone(anchorSuccessMessage(card));
      return;
    }
    setError(
      result.reason === "not_authenticated"
        ? "请先登录后再保存卡片"
        : (result.message ?? "保存失败，请稍后再试"),
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet w-full max-w-sm rounded-ios-2xl p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={titleId} className="flex items-center gap-1.5 text-ios-subhead font-semibold text-foreground">
              <IdCard className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
              存为角色卡
            </p>
            <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.55)]">
              锁定后挂到画布，所有生成自动携带这张图
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* kind 三选：segmented，选中态用站内蓝 */}
        <div role="radiogroup" aria-label="卡片类型" className="mt-4 grid grid-cols-3 gap-1.5">
          {CHARACTER_CARD_KIND_VALUES.map((value) => {
            const active = value === kind;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setKind(value)}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-0.5 rounded-ios-xl px-2 py-2.5",
                  "text-ios-footnote font-medium transition-colors duration-200",
                  "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
                  active
                    ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF]"
                    : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.62)] hover:bg-[rgba(0,0,0,0.09)]",
                )}
              >
                <span>{CHARACTER_CARD_KIND_LABEL[value]}卡</span>
                <span className={cn("text-ios-caption1", active ? "text-[#007AFF]/70" : "text-[rgba(0,0,0,0.42)]")}>
                  {KIND_HINT[value]}
                </span>
              </button>
            );
          })}
        </div>

        <label className="mt-4 block">
          <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">卡片名称</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSubmit();
            }}
            placeholder="给这张卡起个名字"
            className="mt-1.5 w-full rounded-ios-xl border border-black/10 bg-white/70 px-3 py-2.5 text-ios-footnote text-foreground placeholder:text-[rgba(0,0,0,0.35)] focus:border-[rgba(0,122,255,0.45)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 text-ios-footnote text-[#FF3B30]">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-4 py-2.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] transition-colors hover:bg-[rgba(0,0,0,0.09)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className={cn(
              "rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-medium text-white",
              "shadow-[0_4px_12px_rgba(0,122,255,0.32)] transition-all duration-200",
              "hover:bg-[#0066D6] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.30)]",
              saving && "cursor-wait opacity-70 active:scale-100",
              !saving && "cursor-pointer",
            )}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
