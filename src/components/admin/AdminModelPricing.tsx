"use client";

// 模型定价：管理员逐模型改有效价，保存后后端扣费（generationCoins）与前端展示立刻
// 生效。视觉严格对齐 AdminRelayChannels：bg-[#f4f5f7] 外框、bg-white 卡片、
// border-black/10、#2878d0 主按钮、#20242c 无（本面板无主色块）。
//
// 编辑模型：draft（Record<modelId, 覆写栏位>）是唯一编辑状态，空输入 = 不覆写走基准；
// 被改动的列显示「已覆写」+「重置此模型」。保存 PATCH 带 expectedVersion 乐观并发：
// 409 用回应里的最新完整 payload 覆盖本地并提示被他人更新。

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2, RotateCcw } from "lucide-react";
import { PRICING_DECIMALS } from "@/lib/generation-model-catalog";

type CreditTable = Record<string, number>;

interface PricingFields {
  imageCredits?: CreditTable;
  videoCreditsPerSecond?: CreditTable;
  videoCreditsWithAudioPerSecond?: CreditTable;
  fixedCoins?: number;
}

interface PricingModel {
  id: string;
  displayName: string;
  vendor: string;
  kind: "image" | "video";
  resolutions: string[];
  durations: number[];
  supportsAudio: boolean;
  base: PricingFields;
  effective: PricingFields;
  override: PricingFields | null;
  priceLabels: Array<{ resolution: string; coins: number; withAudioCoins?: number }>;
  modified: boolean;
}

interface PricingPayload {
  models: PricingModel[];
  overrides: Record<string, PricingFields>;
  overridesVersion: string | null;
  storage: "blob" | "memory";
  propagationNote: string;
}

type PriceEntry = PricingFields;
type PriceDraft = Record<string, PriceEntry>;

function cloneOverrides(overrides: Record<string, PricingFields>): PriceDraft {
  const copy: PriceDraft = {};
  for (const [modelId, entry] of Object.entries(overrides)) {
    const cloned: PriceEntry = {};
    if (entry.imageCredits) cloned.imageCredits = { ...entry.imageCredits };
    if (entry.videoCreditsPerSecond) cloned.videoCreditsPerSecond = { ...entry.videoCreditsPerSecond };
    if (entry.videoCreditsWithAudioPerSecond) cloned.videoCreditsWithAudioPerSecond = { ...entry.videoCreditsWithAudioPerSecond };
    if (entry.fixedCoins !== undefined) cloned.fixedCoins = entry.fixedCoins;
    if (Object.keys(cloned).length > 0) copy[modelId] = cloned;
  }
  return copy;
}

/**
 * 10 credits = 1 币。币价显示精度由 PRICING_DECIMALS 派生、整数不带尾零。
 * 管理员输入与 placeholder 一律以「币」为单位；后端持久化仍以 credits 为单位（×10）。
 */
function formatCoins(value: number): string {
  const rounded = Math.round(value * 10 ** PRICING_DECIMALS) / 10 ** PRICING_DECIMALS;
  return String(parseFloat(rounded.toFixed(PRICING_DECIMALS)));
}

function resolutionLabel(resolution: string): string {
  if (resolution === "1k") return "1K 标准";
  if (resolution === "2k") return "2K 高清";
  if (resolution === "4k") return "4K 超清";
  if (resolution === "360p") return "360p 流畅";
  if (resolution === "480p") return "480p 标清";
  if (resolution === "540p") return "540p 标准";
  if (resolution === "720p") return "720p 高清";
  return "1080p 全高清";
}

function groupByVendor(models: PricingModel[]): Array<[string, PricingModel[]]> {
  const map = new Map<string, PricingModel[]>();
  for (const model of models) {
    const list = map.get(model.vendor) ?? [];
    list.push(model);
    map.set(model.vendor, list);
  }
  return [...map.entries()];
}

export function AdminModelPricing() {
  const [payload, setPayload] = useState<PricingPayload | null>(null);
  const [draft, setDraft] = useState<PriceDraft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/model-pricing", { cache: "no-store" });
      const result = (await response.json()) as PricingPayload & { message?: string };
      if (!response.ok) throw new Error(result.message || "读取失败。");
      setPayload(result);
      setDraft(cloneOverrides(result.overrides));
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "读取失败。" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overriddenCount = Object.keys(draft).length;

  const hasChanges = (() => {
    const server = payload?.overrides ?? {};
    const serverKeys = Object.keys(server).sort();
    const draftKeys = Object.keys(draft).sort();
    if (serverKeys.join("|") !== draftKeys.join("|")) return true;
    return serverKeys.some((modelId) => JSON.stringify(server[modelId]) !== JSON.stringify(draft[modelId]));
  })();

  const updateEntry = (modelId: string, mutate: (entry: PriceEntry) => PriceEntry) => {
    setDraft((prev) => {
      const next = { ...prev };
      const nextEntry = mutate(prev[modelId] ?? {});
      if (Object.keys(nextEntry).length === 0) delete next[modelId];
      else next[modelId] = nextEntry;
      return next;
    });
  };

  const setCredit = (
    modelId: string,
    field: "imageCredits" | "videoCreditsPerSecond" | "videoCreditsWithAudioPerSecond",
    resolution: string,
    raw: string,
  ) => {
    updateEntry(modelId, (entry) => {
      const table = { ...(entry[field] ?? {}) };
      const trimmed = raw.trim();
      if (trimmed === "") {
        delete table[resolution];
      } else {
        // 输入单位是「币」；后端 credit = 币 × 10，精度 = PRICING_DECIMALS 派生
        // （credit 小数位 = PRICING_DECIMALS - 1）。允许 0：打字中间态（「0.」「0.0」）
        // Number() 为 0，需让它进 draft 才能继续输入；0 本身保存时会被后端拦下。
        const value = Number(trimmed);
        if (Number.isFinite(value)) {
          const creditScale = 10 ** (PRICING_DECIMALS - 1);
          table[resolution] = Math.round(value * 10 * creditScale) / creditScale;
        }
      }
      const next = { ...entry };
      if (Object.keys(table).length === 0) delete next[field];
      else next[field] = table;
      return next;
    });
  };

  const setFixedCoins = (modelId: string, raw: string) => {
    updateEntry(modelId, (entry) => {
      const next = { ...entry };
      const trimmed = raw.trim();
      if (trimmed === "") {
        delete next.fixedCoins;
      } else {
        const value = Number(trimmed);
        if (Number.isFinite(value)) {
          const scale = 10 ** PRICING_DECIMALS;
          next.fixedCoins = Math.round(value * scale) / scale;
        }
      }
      return next;
    });
  };

  const resetModel = (modelId: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  };

  const resetAll = () => setDraft({});

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/model-pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: draft, expectedVersion: payload?.overridesVersion ?? null }),
      });
      const result = (await response.json()) as PricingPayload & { success?: boolean; message?: string };
      if (response.status === 409) {
        // 409 body 就是最新完整 payload（含 success:false/message）。
        setPayload(result);
        setDraft(cloneOverrides(result.overrides ?? {}));
        setNotice({ tone: "error", text: result.message || "配置已被其他会话更新，已刷新为最新数据，请确认后重新保存。" });
      } else if (!response.ok) {
        // 400 附 message；保留本地 draft 让管理员修正。
        setNotice({ tone: "error", text: result.message || "保存失败。" });
      } else {
        setPayload(result);
        setDraft(cloneOverrides(result.overrides ?? {}));
        setNotice({ tone: "ok", text: "定价已保存并生效。" });
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败。" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center text-sm text-black/45">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />读取模型定价
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center rounded-md border border-black/10 bg-white px-5 text-center">
        <CircleAlert className="mb-3 h-8 w-8 text-black/25" />
        <p className="font-medium">无法加载模型定价</p>
        <button type="button" onClick={load} className="mt-3 rounded-md border border-black/10 px-3 py-2 text-sm font-medium hover:bg-black/5">重试</button>
      </div>
    );
  }

  const imageModels = payload.models.filter((model) => model.kind === "image");
  const videoModels = payload.models.filter((model) => model.kind === "video");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">模型定价</h2>
          <p className="mt-1 text-sm text-black/45">改价保存后立即生效：本实例即时、其他温实例最多 15 秒、用户端最多 60 秒。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-black/10 bg-white px-3 py-1.5 text-sm text-black/60">{overriddenCount} 个模型已覆写</span>
          <button
            type="button"
            onClick={resetAll}
            disabled={overriddenCount === 0 || saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium text-black/60 hover:bg-black/5 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />全部重置
          </button>
        </div>
      </div>

      {notice && (
        <div className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${notice.tone === "ok" ? "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]" : "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]"}`}>
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}{notice.text}
        </div>
      )}

      {payload.storage === "memory" && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-[#e7c78a] bg-[#fff8ec] px-3 py-2.5 text-sm text-[#8a5b00]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>未配置 Blob 存储：改动只保存在当前实例内存，重启或冷启动后恢复基准价，不会持久化。</span>
        </div>
      )}

      <div className="space-y-6">
        {imageModels.length > 0 && (
          <PricingSection title="图片模型" models={imageModels} draft={draft} onCredit={setCredit} onFixedCoins={setFixedCoins} onReset={resetModel} />
        )}
        {videoModels.length > 0 && (
          <PricingSection title="视频模型" models={videoModels} draft={draft} onCredit={setCredit} onFixedCoins={setFixedCoins} onReset={resetModel} />
        )}
      </div>

      <div className="sticky bottom-0 mt-6 rounded-md border border-black/10 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-xs text-black/45">{payload.propagationNote}{payload.storage === "memory" ? " 未配置 Blob，重启后恢复基准价。" : ""}</p>
          <button
            type="button"
            onClick={save}
            disabled={saving || !hasChanges}
            className="inline-flex items-center gap-2 rounded-md bg-[#2878d0] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}保存定价
          </button>
        </div>
      </div>
    </>
  );
}

function PricingSection({
  title,
  models,
  draft,
  onCredit,
  onFixedCoins,
  onReset,
}: {
  title: string;
  models: PricingModel[];
  draft: PriceDraft;
  onCredit: (modelId: string, field: "imageCredits" | "videoCreditsPerSecond" | "videoCreditsWithAudioPerSecond", resolution: string, raw: string) => void;
  onFixedCoins: (modelId: string, raw: string) => void;
  onReset: (modelId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-black/10 bg-white">
      <div className="border-b border-black/10 px-5 py-4">
        <h3 className="font-semibold">{title}<span className="ml-2 rounded bg-[#f4f5f7] px-1.5 py-0.5 align-middle text-[11px] font-normal text-black/45">{models.length}</span></h3>
      </div>
      <div className="divide-y divide-black/10">
        {groupByVendor(models).map(([vendor, vendorModels]) => (
          <div key={vendor} className="px-5 py-4">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-black/40">{vendor}</h4>
            <div className="space-y-4">
              {vendorModels.map((model) => (
                <ModelRow key={model.id} model={model} draft={draft} onCredit={onCredit} onFixedCoins={onFixedCoins} onReset={onReset} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModelRow({
  model,
  draft,
  onCredit,
  onFixedCoins,
  onReset,
}: {
  model: PricingModel;
  draft: PriceDraft;
  onCredit: (modelId: string, field: "imageCredits" | "videoCreditsPerSecond" | "videoCreditsWithAudioPerSecond", resolution: string, raw: string) => void;
  onFixedCoins: (modelId: string, raw: string) => void;
  onReset: (modelId: string) => void;
}) {
  const overridden = draft[model.id] !== undefined;
  const badge = model.priceLabels[0];
  const badgeText = badge
    ? model.kind === "video"
      ? `${badge.coins} 币/秒${badge.withAudioCoins !== undefined ? ` · 含音讯 ${badge.withAudioCoins} 币/秒` : ""}`
      : `${badge.coins} 币/张`
    : "—";
  const hasFixedCoins = model.base.fixedCoins !== undefined || model.effective.fixedCoins !== undefined;

  return (
    <article className="rounded-md border border-black/10 bg-[#f7f8f9] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="font-semibold">{model.displayName}</h5>
        <span className="rounded border border-black/10 px-1.5 py-0.5 text-[11px] text-black/50">{model.kind === "image" ? "图片" : "视频"}</span>
        <span className="rounded bg-[#f4f5f7] px-2 py-0.5 text-xs text-black/60">{badgeText}</span>
        {overridden && (
          <>
            <span className="rounded bg-[#2878d0]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#2878d0]">已覆写</span>
            <button type="button" onClick={() => onReset(model.id)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-black/55 hover:bg-black/5">
              <RotateCcw className="h-3 w-3" />重置此模型
            </button>
          </>
        )}
      </div>

      <div className="mt-3">
        {hasFixedCoins ? (
          <FixedCoinsField model={model} entry={draft[model.id]} onChange={(raw) => onFixedCoins(model.id, raw)} />
        ) : model.kind === "image" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {model.resolutions.map((resolution) => {
              const value = draft[model.id]?.imageCredits?.[resolution];
              const base = model.base.imageCredits?.[resolution];
              const hint = value !== undefined
                ? `= ${formatCoins(value / 10)} 币/张`
                : base !== undefined
                  ? `基准 ${formatCoins(base / 10)} 币/张`
                  : "无基准价";
              return (
                <label key={resolution} className="block text-xs text-black/60">
                  <span className="mb-1 flex items-baseline justify-between gap-2">
                    <span>{resolutionLabel(resolution)}</span>
                    <span className="font-medium text-black/80">{hint}</span>
                  </span>
                  <CoinInput
                    value={value !== undefined ? value / 10 : undefined}
                    placeholder={base !== undefined ? String(base / 10) : ""}
                    ariaLabel={`${model.displayName} ${resolutionLabel(resolution)} 每张币价`}
                    onCommit={(raw) => onCredit(model.id, "imageCredits", resolution, raw)}
                  />
                </label>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {model.resolutions.map((resolution) => {
              const value = draft[model.id]?.videoCreditsPerSecond?.[resolution];
              const base = model.base.videoCreditsPerSecond?.[resolution];
              const hint = value !== undefined
                ? `= ${formatCoins(value / 10)} 币/秒`
                : base !== undefined
                  ? `基准 ${formatCoins(base / 10)} 币/秒`
                  : "无基准价";
              return (
                <label key={resolution} className="block text-xs text-black/60">
                  <span className="mb-1 flex items-baseline justify-between gap-2">
                    <span>{resolutionLabel(resolution)}</span>
                    <span className="font-medium text-black/80">{hint}</span>
                  </span>
                  <CoinInput
                    value={value !== undefined ? value / 10 : undefined}
                    placeholder={base !== undefined ? String(base / 10) : ""}
                    ariaLabel={`${model.displayName} ${resolutionLabel(resolution)} 每秒币价`}
                    onCommit={(raw) => onCredit(model.id, "videoCreditsPerSecond", resolution, raw)}
                  />
                </label>
              );
            })}
            {model.supportsAudio && model.resolutions.map((resolution) => {
              const value = draft[model.id]?.videoCreditsWithAudioPerSecond?.[resolution];
              const base = model.base.videoCreditsWithAudioPerSecond?.[resolution];
              const hint = value !== undefined
                ? `= ${formatCoins(value / 10)} 币/秒`
                : base !== undefined
                  ? `基准 ${formatCoins(base / 10)} 币/秒`
                  : "无基准价";
              return (
                <label key={`audio-${resolution}`} className="block text-xs text-black/60">
                  <span className="mb-1 flex items-baseline justify-between gap-2">
                    <span>{resolutionLabel(resolution)} · 含音讯</span>
                    <span className="font-medium text-black/80">{hint}</span>
                  </span>
                  <CoinInput
                    value={value !== undefined ? value / 10 : undefined}
                    placeholder={base !== undefined ? String(base / 10) : ""}
                    ariaLabel={`${model.displayName} ${resolutionLabel(resolution)} 含音讯 每秒币价`}
                    onCommit={(raw) => onCredit(model.id, "videoCreditsWithAudioPerSecond", resolution, raw)}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * 币价输入框：本地 raw state、onBlur 才 commit。解决受控 number input 打小数时
 * 中间态（「0.」「0.0」）被 Number() 解析为 0 而瞬间清空、导致「0.01」打不出来的
 * 问题。格式非法（非空且非正小数）时还原为外部值；空输入 = 不覆写走基准。
 * 显示单位为「币」，credits 转换由 onCommit 侧（×10）负责。
 */
function CoinInput({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value?: number;
  placeholder?: string;
  ariaLabel: string;
  onCommit: (raw: string) => void;
}) {
  const [raw, setRaw] = useState(value !== undefined ? String(value) : "");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setRaw(value !== undefined ? String(value) : "");
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    const trimmed = raw.trim();
    if (trimmed === "" || /^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
      onCommit(trimmed);
    } else {
      setRaw(value !== undefined ? String(value) : "");
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={raw}
      onChange={(event) => setRaw(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="admin-field !mt-0.5 !px-2.5 !py-1.5 text-sm"
    />
  );
}

function FixedCoinsField({ model, entry, onChange }: { model: PricingModel; entry?: PriceEntry; onChange: (raw: string) => void }) {
  const base = model.base.fixedCoins;
  const value = entry?.fixedCoins;
  const hint = value !== undefined
    ? `= ${formatCoins(value)} 币/张`
    : base !== undefined
      ? `基准 ${formatCoins(base)} 币/张`
      : "无基准价";
  return (
    <label className="block max-w-xs text-xs text-black/60">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span>固定币/张</span>
        <span className="font-medium text-black/80">{hint}</span>
      </span>
      <CoinInput
        value={value}
        placeholder={base !== undefined ? String(base) : ""}
        ariaLabel={`${model.displayName} 固定币/张`}
        onCommit={onChange}
      />
    </label>
  );
}
