"use client";

// Customer-facing "check a generation request" panel. Separate from the Gatus
// infra dashboard above it on the same page: Gatus tells you the *service* is up,
// this tells a customer what happened to *their specific request* — status,
// structured error code/message, and the trace id to hand to support.
//
// This page has no session/identity model of its own (it's a public status page),
// so the form collects whatever the caller has: for biz/aggregator customers that's
// their `sk-biz-...` API key (sent as a Bearer token); for logged-in web users the
// browser's existing session cookie is enough and the key field can stay empty —
// same-origin fetch with credentials included covers that case for free.

import { useState } from "react";
import { Search } from "lucide-react";

type ApiErrorBody = {
  code: string;
  message: string;
  trace_id: string;
};

type GenerationJobStatusResponse = {
  id: string;
  status: string;
  kind: string;
  model_id: string;
  requested_count: number;
  completed_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: ApiErrorBody | null;
  result: unknown;
};

type LookupState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string; traceId?: string }
  | { phase: "success"; job: GenerationJobStatusResponse };

const STATUS_LABELS: Record<string, string> = {
  pending_billing: "等待计费",
  billing_unknown: "计费状态未知",
  queued: "排队中",
  leased: "已分配",
  submitting: "提交中",
  running: "生成中",
  submit_unknown: "提交状态未知",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  refunded: "已退款",
};

export function GenerationJobLookup() {
  const [jobId, setJobId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<LookupState>({ phase: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedId = jobId.trim();
    if (!trimmedId) return;

    setState({ phase: "loading" });
    try {
      const response = await fetch(`/api/generation-jobs/${encodeURIComponent(trimmedId)}`, {
        method: "GET",
        credentials: "include",
        headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      });
      const traceId = response.headers.get("X-Request-Id") ?? undefined;

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setState({
          phase: "error",
          message: payload?.error ?? `请求失败（HTTP ${response.status}）。`,
          traceId,
        });
        return;
      }

      const job = (await response.json()) as GenerationJobStatusResponse;
      setState({ phase: "success", job });
    } catch {
      setState({ phase: "error", message: "网络请求失败，请稍后重试。" });
    }
  }

  return (
    <section className="mt-8" aria-labelledby="job-lookup-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="job-lookup-heading" className="text-base font-semibold">
          查询生成请求
        </h2>
      </div>
      <p className="mt-2 text-sm text-[#65707d]">
        输入请求 id（以及聚合平台密钥，如适用）查看具体这一次生成的状态、错误原因与追踪 id。
      </p>

      <form
        onSubmit={handleSubmit}
        className="lg-card mt-4 rounded-ios-2xl p-5 sm:p-6"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-[#4b5562]">请求 id</span>
            <input
              type="text"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              placeholder="例如 5f2c8b0a-..."
              required
              className="mt-1.5 w-full rounded-md border border-[#cfd5dc] px-3 py-2 text-sm outline-none focus:border-[#4b5562]"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-[#4b5562]">API 密钥（可选，聚合平台客户填写）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-biz-..."
              autoComplete="off"
              className="mt-1.5 w-full rounded-md border border-[#cfd5dc] px-3 py-2 text-sm outline-none focus:border-[#4b5562]"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={state.phase === "loading" || !jobId.trim()}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-[#111318] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2a2e37] disabled:cursor-wait disabled:opacity-60"
        >
          <Search className="h-4 w-4" />
          {state.phase === "loading" ? "查询中…" : "查询状态"}
        </button>
      </form>

      {state.phase === "error" ? (
        <div className="mt-4 rounded-md border border-[#fecaca] bg-[#fff5f5] p-4 text-sm text-[#b42318]">
          <p>{state.message}</p>
          {state.traceId ? <p className="mt-1 text-xs text-[#b42318]/80">追踪 id：{state.traceId}</p> : null}
        </div>
      ) : null}

      {state.phase === "success" ? (
        <div className="lg-card mt-4 rounded-ios-2xl p-5 text-sm sm:p-6">
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs font-medium text-[#7a8490]">状态</dt>
              <dd className="mt-1 font-semibold">{STATUS_LABELS[state.job.status] ?? state.job.status}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[#7a8490]">模型</dt>
              <dd className="mt-1 font-semibold">{state.job.model_id}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[#7a8490]">完成数量</dt>
              <dd className="mt-1 font-semibold">
                {state.job.completed_count} / {state.job.requested_count}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[#7a8490]">创建时间</dt>
              <dd className="mt-1 font-semibold">{new Date(state.job.created_at).toLocaleString("zh-CN")}</dd>
            </div>
          </dl>

          {state.job.error ? (
            <div className="mt-5 rounded-md border border-[#fecaca] bg-[#fff5f5] p-4">
              <p className="text-xs font-medium text-[#b42318]">错误代码：{state.job.error.code}</p>
              <p className="mt-1 text-[#b42318]">{state.job.error.message}</p>
              <p className="mt-1 text-xs text-[#b42318]/80">追踪 id：{state.job.error.trace_id}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
