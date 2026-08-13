"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Check, Clock3, RefreshCw, X } from "lucide-react";
import { GenerationJobLookup } from "./GenerationJobLookup";

export type GatusResult = {
  status: number;
  duration: number;
  success: boolean;
  timestamp: string;
  conditionResults?: Array<{
    condition: string;
    success: boolean;
  }>;
};

export type GatusEndpoint = {
  name: string;
  group: string;
  key: string;
  results: GatusResult[];
};

type Props = {
  initialEndpoints: GatusEndpoint[];
};

const STATUS_API = "/status/api/endpoints/statuses";
const REFRESH_INTERVAL_MS = 60_000;

function latestResult(endpoint: GatusEndpoint) {
  return [...endpoint.results].sort(
    (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
  )[0];
}

function formatDuration(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Hong_Kong",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function successRate(results: GatusResult[]) {
  if (!results.length) return "--";
  const successful = results.filter((result) => result.success).length;
  return `${((successful / results.length) * 100).toFixed(1)}%`;
}

export function StatusDashboard({ initialEndpoints }: Props) {
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(STATUS_API, { cache: "no-store" });
      if (!response.ok) throw new Error(`Status API returned ${response.status}`);
      setEndpoints((await response.json()) as GatusEndpoint[]);
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const overallHealthy = useMemo(
    () =>
      endpoints.length > 0 &&
      endpoints.every((endpoint) => latestResult(endpoint)?.success === true),
    [endpoints],
  );
  const hasResults = endpoints.some((endpoint) => endpoint.results.length > 0);

  return (
    <div className="min-h-screen bg-[#f7f8fa] px-4 pb-20 pt-24 text-[#16181d] sm:px-6 sm:pt-28">
      <div className="mx-auto w-full max-w-5xl">
        <header className="border-b border-[#dfe3e8] pb-8">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-sm font-semibold text-[#65707d]">image.tinchak0207.xyz</p>
              <h1 className="mt-2 text-3xl font-bold text-[#111318] sm:text-4xl">系统状态</h1>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              title="刷新状态"
              aria-label="刷新状态"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#cfd5dc] bg-white text-[#4b5562] transition-colors hover:bg-[#eef1f4] disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-full ${
                hasResults && overallHealthy
                  ? "bg-[#daf5e6] text-[#087443]"
                  : "bg-[#fee2e2] text-[#b42318]"
              }`}
            >
              {hasResults && overallHealthy ? (
                <Check className="h-5 w-5" />
              ) : (
                <X className="h-5 w-5" />
              )}
            </span>
            <div>
              <p className="text-lg font-semibold">
                {hasResults && overallHealthy ? "所有服务运行正常" : "部分服务当前异常"}
              </p>
              <p className="mt-0.5 text-sm text-[#65707d]">
                每 2 小时执行一次真实的 GPT Image 2 1K 生成探测
              </p>
            </div>
          </div>

          {refreshError ? (
            <p className="mt-4 text-sm text-[#b42318]">状态刷新失败，正在保留最近一次结果。</p>
          ) : null}
        </header>

        <section className="mt-8" aria-labelledby="services-heading">
          <div className="flex items-center justify-between gap-4">
            <h2 id="services-heading" className="text-base font-semibold">
              服务
            </h2>
            <span className="text-sm text-[#65707d]">{endpoints.length} 个监控项</span>
          </div>

          <div className="mt-3 space-y-3">
            {endpoints.map((endpoint) => {
              const latest = latestResult(endpoint);
              const history = [...endpoint.results]
                .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
                .slice(-30);

              return (
                <article
                  key={endpoint.key}
                  className="rounded-md border border-[#dfe3e8] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:p-6"
                >
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 shrink-0 text-[#65707d]" />
                        <h3 className="truncate text-base font-semibold">{endpoint.name}</h3>
                      </div>
                      <p className="mt-2 text-sm text-[#65707d]">
                        POST /v1/images/generations · gpt-image-2 · 1024 × 1024
                      </p>
                    </div>
                    <span
                      className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${
                        latest?.success
                          ? "bg-[#e8f7ee] text-[#087443]"
                          : "bg-[#fff0f0] text-[#b42318]"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${latest?.success ? "bg-[#12a05c]" : "bg-[#d92d20]"}`}
                      />
                      {latest?.success ? "Up" : "Down"}
                    </span>
                  </div>

                  <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 border-y border-[#edf0f2] py-5 sm:grid-cols-4">
                    <div>
                      <dt className="text-xs font-medium text-[#7a8490]">HTTP 状态</dt>
                      <dd className="mt-1 text-sm font-semibold">{latest?.status ?? "--"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-[#7a8490]">响应时间</dt>
                      <dd className="mt-1 text-sm font-semibold">
                        {latest ? formatDuration(latest.duration) : "--"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-[#7a8490]">历史可用率</dt>
                      <dd className="mt-1 text-sm font-semibold">{successRate(endpoint.results)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-[#7a8490]">最近探测</dt>
                      <dd className="mt-1 text-sm font-semibold">
                        {latest ? formatTimestamp(latest.timestamp) : "等待首检"}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-4 text-xs text-[#7a8490]">
                      <span>最近 {history.length} 次探测</span>
                      <span className="inline-flex items-center gap-1.5">
                        <Clock3 className="h-3.5 w-3.5" /> 每 2 小时
                      </span>
                    </div>
                    <div
                      className="mt-3 grid h-8 grid-flow-col auto-cols-fr gap-1"
                      aria-label="最近探测历史"
                    >
                      {history.map((result) => (
                        <span
                          key={result.timestamp}
                          title={`${formatTimestamp(result.timestamp)} · HTTP ${result.status} · ${formatDuration(result.duration)}`}
                          className={`h-8 min-w-1 rounded-[2px] ${
                            result.success ? "bg-[#21a366]" : "bg-[#e0443e]"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <GenerationJobLookup />

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-[#dfe3e8] pt-5 text-xs text-[#7a8490]">
          <span>由 Gatus 持续监控</span>
          <span>时区：Asia/Hong_Kong</span>
        </footer>
      </div>
    </div>
  );
}
