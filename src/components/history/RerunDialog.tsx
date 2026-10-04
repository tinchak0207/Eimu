"use client";

// 歷史「再來 N 組／微調變體」對話框：把一條歷史記錄的配方 payload 批量重跑。
//
// rerun = 原樣重跑（N 張、參數零改動）；variant = 先改提示詞/模型/尺寸再批量。
// 提交走既有 /api/generation-jobs 任務通道（每個任務獨立帳本預檢，餘額不足
// 會在提交時被擋下），retryOfTaskId 同時承擔父鏈與參考圖繼承。
//
// 費用預估由計費配置即時計算（generationCoins），不寫死數字；管理員改價後
// 通過 usePricingRevision 觸發重算，這裡的數字不會滯後。
//
// 面板風格複用歷史頁既有語法（SaveCardDialog 同款）：lg-sheet 玻璃面板 +
// iOS 字級/圓角；N 與尺寸用 segmented radiogroup（站內 kind 三選同形態）。
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Coins, Layers, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { GENERATION_TRACE_ID_HEADER, newGenerationTraceId } from "@/lib/generation-request-headers";
import { formatModelLabel, coinsFromQuota, primaryModelId } from "@/lib/history-types";
import type { HistoryEntry } from "@/lib/history-types";
import { extractPromptSection } from "@/lib/workflow-recall";
import { IMAGE_MODEL_IDS } from "@/lib/generation-model-catalog";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { ModelPicker } from "@/components/ModelPicker";
import {
  HISTORY_RERUN_COUNT_OPTIONS,
  HISTORY_RERUN_DEFAULT_COUNT,
  buildHistoryRerunPlan,
  historyRerunCoinsPerImage,
  historyRerunEstimate,
} from "@/lib/history-rerun";

export type HistoryRerunMode = "rerun" | "variant";

export interface RerunDialogProps {
  entry: HistoryEntry;
  mode: HistoryRerunMode;
  onClose: () => void;
  /** 完成回调（成功或明确失败都由这里带回页面通知条）。 */
  onDone: (message: string) => void;
}

const SIZE_OPTIONS = ["1024x1024", "1536x1024", "1024x1536"] as const;

/** 按返回码把服务端错误翻成用户能行动的话。 */
function failureMessage(code: string | undefined, error: string | undefined, submitted: number): string {
  if (code === "insufficient_quota") {
    return submitted > 0 ? `余额不足，已提交 ${submitted} 个任务后停止` : "余额不足，请先充值再重跑";
  }
  if (code === "control_plane_disabled") return "任务队列暂不可用，请稍后重试";
  return error?.trim() || "任务提交失败";
}

function SegmentedOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-ios-xl px-2 py-2.5",
        "text-ios-footnote font-medium transition-colors duration-200",
        "focus:outline-none focus:ring-2 focus:ring-ring/20",
        active
          ? "bg-ios-blue/[0.12] text-[#007AFF]"
          : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.62)] hover:bg-[rgba(0,0,0,0.09)]",
      )}
    >
      {children}
    </button>
  );
}

export function RerunDialog({ entry, mode, onClose, onDone }: RerunDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [count, setCount] = useState<number>(HISTORY_RERUN_DEFAULT_COUNT);
  const [variantPrompt, setVariantPrompt] = useState(() => extractPromptSection(entry.prompt));
  const entryModelId = primaryModelId(entry) ?? IMAGE_MODEL_IDS[0];
  const [variantModelId, setVariantModelId] = useState(entryModelId);
  const entrySize = entry.workflow?.imageSize ?? entry.workflow?.imageSizes?.[0];
  const [variantSize, setVariantSize] = useState<string>(
    (SIZE_OPTIONS as readonly string[]).includes(entrySize ?? "") ? (entrySize as string) : "1024x1024",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();

  const isVariant = mode === "variant";
  // 管理员改价后 generationCoins 读到的覆写表会变；引用 revision 让预估立即重算。
  const pricingRevision = usePricingRevision();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const plan = useMemo(
    () =>
      buildHistoryRerunPlan(entry, isVariant
        ? { prompt: variantPrompt, modelId: variantModelId, imageSize: variantSize }
        : {}),
    [entry, isVariant, variantPrompt, variantModelId, variantSize],
  );
  const perImage = useMemo(
    () => historyRerunCoinsPerImage(plan),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pricingRevision 只影响 generationCoins 读到的覆写表
    [plan, pricingRevision],
  );
  const total = useMemo(
    () => historyRerunEstimate(plan, count),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：改价后预估必须重算
    [plan, count, pricingRevision],
  );

  // 源记录的模型可能不在图像模型清单里（如后台直连渠道）；并进选项避免选中值落空。
  const modelOptions = useMemo(() => {
    const current = primaryModelId(entry);
    return current && !IMAGE_MODEL_IDS.includes(current)
      ? [current, ...IMAGE_MODEL_IDS]
      : [...IMAGE_MODEL_IDS];
  }, [entry]);

  const displaySize = isVariant ? variantSize : (entrySize ?? null);

  // 实付：只从 entry.quota 换算（上游计费日志归并）。生成任务的两条
  // 落盘路径都不写 quota，所以本站记录通常是 null——这里诚实显示。
  const paidCoins = coinsFromQuota(entry.quota);
  const formatPaidCoins = (coins: number) =>
    coins < 1 ? coins.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(Math.round(coins));

  if (!mounted) return null;

  const handleSubmit = async () => {
    if (submitting) return;
    if (!plan.prompt) {
      setError("提示词不能为空");
      return;
    }
    const token = getStoredToken();
    if (!token) {
      setError("请先登录后再重跑");
      return;
    }
    const user = getStoredUser();
    setSubmitting(true);
    setError(null);

    let submitted = 0;
    let failure: string | null = null;
    const keyBase = `${entry.id}-${Date.now().toString(36)}`;
    for (let i = 0; i < count; i += 1) {
      try {
        const response = await fetch("/api/generation-jobs", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(user?.id ? { "x-user-id": String(user.id) } : {}),
            "Content-Type": "application/json",
            "Idempotency-Key": `rerun-${keyBase}-${i}`,
            [GENERATION_TRACE_ID_HEADER]: newGenerationTraceId(),
          },
          body: JSON.stringify({
            prompt: plan.prompt,
            modelId: plan.modelId,
            qualityMode: plan.qualityMode,
            aspectRatio: plan.aspectRatio,
            outputResolution: plan.outputResolution,
            ...(plan.workflow ? { workflow: plan.workflow } : {}),
            ...(plan.retryOfTaskId ? { retryOfTaskId: plan.retryOfTaskId } : {}),
          }),
        });
        const payload = await response.json().catch(() => ({}) as { success?: boolean; error?: string; code?: string });
        if (!response.ok || payload.success !== true) {
          failure = failureMessage(payload.code, payload.error, submitted);
          break;
        }
        submitted += 1;
      } catch {
        failure = `网络中断，已提交 ${submitted} 个任务后停止`;
        break;
      }
    }

    setSubmitting(false);
    if (submitted > 0) {
      onDone(
        failure
          ? `已提交 ${submitted} 个重跑任务；${failure}`
          : `已提交 ${count} 个重跑任务，完成后会出现在历史里`,
      );
      return;
    }
    setError(failure ?? "提交失败，请稍后重试");
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md"
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
              {isVariant
                ? <SlidersHorizontal className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
                : <Layers className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />}
              {isVariant ? "微调变体" : "再来 N 组"}
            </p>
            <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.55)]">
              {isVariant ? "改提示词、模型或尺寸后，按新配方批量重跑" : "按这条记录的原配方原样重跑，参数不改动"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-ring/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 原配方摘要：让用户在按下提交前确认「重跑的就是这套」 */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.62)]">
            {formatModelLabel(plan.modelId)}
          </span>
          <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.62)]">
            {displaySize ?? "默认尺寸"}
          </span>
        </div>
        {plan.hasReferenceImages && (
          <p className="mt-2 text-ios-caption1 text-[rgba(120,90,20,0.85)]">
            {plan.referencesInheritable
              ? `原配方带参考图，重跑会由任务系统原样带上`
              : "原配方带参考图，但这条记录的参考图文件无法自动找回，重跑将不含参考图"}
          </p>
        )}

        {isVariant && (
          <>
            <label className="mt-4 block">
              <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">提示词</span>
              <textarea
                value={variantPrompt}
                rows={4}
                maxLength={8000}
                onChange={(event) => setVariantPrompt(event.target.value)}
                placeholder="只改想改的部分，其余参数保持原样"
                className="mt-1.5 w-full resize-none rounded-ios-xl border border-black/10 bg-white/70 px-3 py-2.5 text-ios-footnote text-foreground placeholder:text-[rgba(0,0,0,0.35)] focus:border-[rgba(0,122,255,0.45)] focus:outline-none focus:ring-2 focus:ring-ring/20"
              />
            </label>

            <div className="mt-3">
              <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">模型</span>
              <div className="mt-1.5">
                <ModelPicker
                  models={modelOptions}
                  value={variantModelId}
                  onChange={setVariantModelId}
                  resolution={plan.outputResolution}
                  stripVendorPrefix
                />
              </div>
            </div>

            <div className="mt-3">
              <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">尺寸</span>
              <div role="radiogroup" aria-label="输出尺寸" className="mt-1.5 grid grid-cols-3 gap-1.5">
                {SIZE_OPTIONS.map((size) => (
                  <SegmentedOption key={size} active={size === variantSize} onClick={() => setVariantSize(size)}>
                    {size}
                  </SegmentedOption>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="mt-4">
          <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">组数（每张一个任务）</span>
          <div role="radiogroup" aria-label="重跑组数" className="mt-1.5 grid grid-cols-5 gap-1.5">
            {HISTORY_RERUN_COUNT_OPTIONS.map((value) => (
              <SegmentedOption key={value} active={value === count} onClick={() => setCount(value)}>
                {value}
              </SegmentedOption>
            ))}
          </div>
        </div>

      {/* 费用：实付优先，没有实付就只给预估并明确标「预估」。
          实付来源是 entry.quota（上游计费日志归并进来的真实消耗）。这里有一个
          诚实的缺口：generate-images 与 generation-task-history 两条落盘路径都
          不写 quota，所以本站自己的记录绝大多数没有实付数据。此时宁可只显示
          预估，也不拿预估冒充实付——把一个编出来的数字标成「上次实付」，
          用户会据此判断这次会不会被多扣。 */}
      <div className="mt-4 space-y-1">
        <div className="flex items-center gap-1.5">
          <Coins className={cn("h-3 w-3 shrink-0", paidCoins !== null ? "text-[#FF9500]" : "text-[rgba(0,0,0,0.44)]")} />
          {paidCoins !== null ? (
            <p className="text-ios-footnote text-[rgba(0,0,0,0.72)]">
              上次实付 {formatPaidCoins(paidCoins)} 币
            </p>
          ) : (
            <p className="text-ios-footnote text-[rgba(0,0,0,0.44)]">
              上次实付未知
              <span className="ml-1 text-ios-caption1">（这条记录没有留下计费数据）</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Coins className="h-3 w-3 shrink-0 text-[rgba(120,90,20,0.85)]" />
          <p className="text-ios-footnote text-[rgba(120,90,20,0.85)]">
            本次预估 {count} 张 × {perImage} 币 ≈ {total} 币
            <span className="ml-1 text-ios-caption1 text-[rgba(0,0,0,0.45)]">（预估，按任务实际计费）</span>
          </p>
        </div>
      </div>

        {error && (
          <p role="alert" className="mt-3 text-ios-footnote text-[#FF3B30]">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-4 py-2.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] transition-colors hover:bg-[rgba(0,0,0,0.09)] focus:outline-none focus:ring-2 focus:ring-ring/20"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className={cn(
              "rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-medium text-white",
              "shadow-[0_4px_12px_rgba(0,122,255,0.32)] transition-all duration-200",
              "hover:bg-[#0066D6] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring/30",
              submitting && "cursor-wait opacity-70 active:scale-100",
              !submitting && "cursor-pointer",
            )}
          >
            {submitting ? "提交中…" : `提交 ${count} 个任务`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
