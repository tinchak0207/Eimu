"use client";

// 中转渠道：池 CRUD（新增/编辑/删除/测试）+ .env 渠道只读列表。
// 从 AdminPoolManager 抽出，供侧边栏「中转渠道」项使用。

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  CloudCog,
  Edit3,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { AdminPoolKind, EnvironmentEndpointSummary, PublicAdminPool } from "@/lib/admin-pools";
import { DEFAULT_IMAGE_MODEL_ID, NANO_BANANA_PRO_MODEL_ID, modelDisplayName } from "@/lib/provider-config";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids.js";

interface PoolDraft {
  kind: AdminPoolKind;
  name: string;
  baseURL: string;
  apiKey: string;
  supportedModels: string[];
  enabled: boolean;
  priority: number;
}

const EMPTY_DRAFT: PoolDraft = {
  kind: "relay",
  name: "",
  baseURL: "",
  apiKey: "",
  supportedModels: [DEFAULT_IMAGE_MODEL_ID, NANO_BANANA_PRO_MODEL_ID],
  enabled: true,
  priority: 50,
};

async function readJson(response: Response) {
  const result = await response.json() as { success?: boolean; data?: unknown; message?: string; elapsedMs?: number };
  if (!response.ok) throw new Error(result.message || "操作失败。");
  return result;
}

export function AdminRelayChannels() {
  const [pools, setPools] = useState<PublicAdminPool[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentEndpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PublicAdminPool | null | undefined>(undefined);
  const [draft, setDraft] = useState<PoolDraft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const loadPools = useCallback(async () => {
    setLoading(true);
    try {
      const result = await readJson(await fetch("/api/admin/pools", { cache: "no-store" }));
      const data = result.data as { pools: PublicAdminPool[]; environment: EnvironmentEndpointSummary[] };
      setPools(data.pools);
      setEnvironment(data.environment);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "读取失败。" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPools(); }, [loadPools]);

  const openCreate = () => {
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT, priority: Math.min(99, (pools.at(-1)?.priority ?? 40) + 10) });
  };

  const openEdit = (pool: PublicAdminPool) => {
    setEditing(pool);
    setDraft({
      kind: "relay",
      name: pool.name,
      baseURL: pool.baseURL,
      apiKey: "",
      supportedModels: pool.supportedModels,
      enabled: pool.enabled,
      priority: pool.priority,
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(editing ? `/api/admin/pools/${editing.id}` : "/api/admin/pools", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      await readJson(response);
      setEditing(undefined);
      setNotice({ tone: "ok", text: editing ? "渠道已更新。" : "渠道已新增。" });
      await loadPools();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败。" });
    } finally {
      setSaving(false);
    }
  };

  const togglePool = async (pool: PublicAdminPool) => {
    try {
      await readJson(await fetch(`/api/admin/pools/${pool.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pool, apiKey: "", enabled: !pool.enabled }),
      }));
      await loadPools();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "更新失败。" });
    }
  };

  const testPool = async (pool: PublicAdminPool) => {
    setTestingId(pool.id);
    setNotice(null);
    try {
      const result = await readJson(await fetch(`/api/admin/pools/${pool.id}/test`, { method: "POST" }));
      setNotice({ tone: "ok", text: `${pool.name}：${result.message} ${result.elapsedMs ?? 0}ms` });
    } catch (error) {
      setNotice({ tone: "error", text: `${pool.name}：${error instanceof Error ? error.message : "测试失败。"}` });
    } finally {
      setTestingId(null);
    }
  };

  const deletePool = async (pool: PublicAdminPool) => {
    if (!window.confirm(`删除「${pool.name}」？此操作不能撤销。`)) return;
    try {
      await readJson(await fetch(`/api/admin/pools/${pool.id}`, { method: "DELETE" }));
      setNotice({ tone: "ok", text: "渠道已删除。" });
      await loadPools();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败。" });
    }
  };

  const activeCount = pools.filter((pool) => pool.enabled).length;

  return (
    <>
      <section className="mb-6 grid border-y border-black/10 bg-white sm:grid-cols-3">
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r"><p className="text-xs text-black/45">已配置</p><strong className="mt-1 block text-2xl">{pools.length}</strong></div>
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r"><p className="text-xs text-black/45">正在参与调度</p><strong className="mt-1 block text-2xl text-[#137a46]">{activeCount}</strong></div>
        <div className="px-5 py-4"><p className="text-xs text-black/45">调度规则</p><strong className="mt-1 block text-sm">数字越小，优先级越高</strong></div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">中转渠道<span className="ml-2 rounded bg-[#f4f5f7] px-1.5 py-0.5 align-middle text-[11px] font-normal text-black/45">遗留</span></h2>
          <p className="mt-1 text-sm text-black/45">请求先按模型过滤，再按优先级从小到大自动切换；.env 渠道固定参与 P50/P90 队列。</p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7]">
          <Plus className="h-4 w-4" />新增渠道
        </button>
      </div>

      {notice && (
        <div className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${notice.tone === "ok" ? "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]" : "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]"}`}>
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}{notice.text}
        </div>
      )}

      <section className="overflow-hidden rounded-md border border-black/10 bg-white">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-black/45"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取渠道</div>
        ) : pools.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <CloudCog className="mb-3 h-8 w-8 text-black/25" />
            <p className="font-medium">还没有后台管理的渠道</p>
            <p className="mt-1 text-sm text-black/45">现有环境变量渠道仍在运行。新增后会优先使用这里的配置。</p>
          </div>
        ) : (
          <div className="divide-y divide-black/10">
            {[...pools].sort((a, b) => a.priority - b.priority).map((pool) => (
              <article key={pool.id} className="grid gap-4 px-4 py-4 md:grid-cols-[72px_minmax(0,1fr)_160px_auto] md:items-center">
                <div><span className="inline-flex rounded bg-black/5 px-2 py-1 font-mono text-xs font-semibold text-black/55">P{pool.priority}</span></div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold">{pool.name}</h3>
                    <span className="rounded border border-black/10 px-1.5 py-0.5 text-[11px] text-black/50">中转 API</span>
                    <span className={`flex items-center gap-1 text-xs ${pool.enabled ? "text-[#137a46]" : "text-black/35"}`}><span className={`h-1.5 w-1.5 rounded-full ${pool.enabled ? "bg-[#20a65a]" : "bg-black/25"}`} />{pool.enabled ? "启用" : "停用"}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-black/45">{pool.baseURL}</p>
                  <p className="mt-1 text-xs text-black/35">{pool.maskedApiKey} · {pool.supportedModels.map(modelLabel).join("、")}</p>
                </div>
                <button type="button" onClick={() => testPool(pool)} disabled={testingId === pool.id || !pool.enabled} className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-xs font-semibold text-black/60 hover:bg-black/5 disabled:opacity-40">
                  {testingId === pool.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}测试连接
                </button>
                <div className="flex items-center justify-end gap-1">
                  <button type="button" onClick={() => togglePool(pool)} title={pool.enabled ? "停用" : "启用"} className={`relative h-6 w-11 rounded-full transition-colors ${pool.enabled ? "bg-[#20a65a]" : "bg-black/15"}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${pool.enabled ? "left-6" : "left-1"}`} /></button>
                  <button type="button" onClick={() => openEdit(pool)} title="编辑" className="flex h-8 w-8 items-center justify-center rounded-md text-black/45 hover:bg-black/5 hover:text-black"><Edit3 className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => deletePool(pool)} title="删除" className="flex h-8 w-8 items-center justify-center rounded-md text-black/35 hover:bg-[#fff0ef] hover:text-[#b42318]"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-5 overflow-hidden rounded-md border border-black/10 bg-white">
        <div className="border-b border-black/10 px-5 py-4">
          <h2 className="font-semibold">.env 渠道</h2>
          <p className="mt-1 text-xs text-black/40">只读兜底渠道，与中转渠道按同一优先级排队。此处不含「路由调度」分页的启停与优先级覆写——生效队列以该分页的预览为准。</p>
        </div>
        {environment.length === 0 ? <p className="px-5 py-4 text-sm text-black/40">未配置 .env 渠道。</p> : (
          <div className="divide-y divide-black/10">
            {environment.map((endpoint) => (
              <article key={`${endpoint.name}-${endpoint.baseURL}`} className="grid gap-2 px-5 py-3 sm:grid-cols-[64px_minmax(0,1fr)_minmax(180px,auto)] sm:items-center">
                <span className="font-mono text-xs font-semibold text-black/55">P{endpoint.priority}</span>
                <div className="min-w-0"><strong className="text-sm">{endpoint.name}</strong><p className="truncate font-mono text-xs text-black/40">{endpoint.baseURL}</p></div>
                <span className="text-xs text-black/45">{endpoint.supportedModels.map(modelLabel).join("、")}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      {editing !== undefined && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#20242c]/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={editing ? "编辑渠道" : "新增渠道"}>
          <form onSubmit={save} className="max-h-[calc(100vh-32px)] w-full max-w-lg overflow-y-auto rounded-lg bg-white shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-black/10 bg-white px-5 py-4">
              <h2 className="font-semibold">{editing ? "编辑渠道" : "新增渠道"}</h2>
              <button type="button" onClick={() => setEditing(undefined)} title="关闭" className="flex h-8 w-8 items-center justify-center rounded-md text-black/45 hover:bg-black/5"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div className="rounded-md border border-black/10 bg-[#f7f8f9] px-3 py-2.5 text-sm"><strong>中转 API</strong><span className="ml-2 text-black/40">Base URL + API Key</span></div>
              <Field label="名称"><input required maxLength={40} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：备用中转" className="admin-field" /></Field>
              <Field label="Base URL"><input required type="url" maxLength={300} value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} placeholder="https://api.example.com/v1" className="admin-field font-mono" /></Field>
              <Field label="API Key" hint={editing ? `留空则保留 ${editing.maskedApiKey}` : "只会加密保存在服务端"}><input required={!editing} type="password" autoComplete="new-password" maxLength={500} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={editing ? "留空保持不变" : "sk-..."} className="admin-field font-mono" /></Field>
              <Field label="支持模型" hint="请求只会进入勾选了对应模型的渠道">
                <div className="grid grid-cols-2 gap-2">
                  {SUPPORTED_IMAGE_MODEL_IDS.map((model) => (
                    <label key={model} className="flex items-center gap-2 rounded-md border border-black/10 bg-[#f7f8f9] px-3 py-2.5 text-xs">
                      <input
                        type="checkbox"
                        checked={draft.supportedModels.includes(model)}
                        onChange={(event) => setDraft({ ...draft, supportedModels: event.target.checked ? [...draft.supportedModels, model] : draft.supportedModels.filter((item) => item !== model) })}
                        className="h-4 w-4 accent-[#2878d0]"
                      />
                      {modelLabel(model)}
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="优先级" hint="1 最高，99 最低"><input required type="number" min={1} max={99} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} className="admin-field" /></Field>
                <label className="flex items-end"><span className="flex w-full items-center justify-between rounded-md border border-black/10 bg-[#f7f8f9] px-3 py-2.5 text-sm"><span>保存后启用</span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 accent-[#2878d0]" /></span></label>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-black/10 px-5 py-4">
              <button type="button" onClick={() => setEditing(undefined)} className="rounded-md border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5">取消</button>
              <button type="submit" disabled={saving || draft.supportedModels.length === 0} className="inline-flex items-center gap-2 rounded-md bg-[#2878d0] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}保存</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium">{label}{children}{hint && <span className="mt-1 block text-xs font-normal text-black/40">{hint}</span>}</label>;
}

function modelLabel(modelId: string) {
  return modelDisplayName(modelId).split(" · ")[0];
}
