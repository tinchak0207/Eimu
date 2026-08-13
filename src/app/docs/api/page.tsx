"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Server, ShieldCheck } from "lucide-react";
import { toSimplified } from "@/lib/traditional-to-simplified";

interface OpenApiSchema {
  openapi: string;
  servers: Array<{ url: string; description?: string }>;
  info: { title: string; version: string; description?: string };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        summary?: string;
        description?: string;
        parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
        requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
        responses?: Record<string, { description?: string }>;
      }
    >
  >;
}

const METHOD_COLORS: Record<string, string> = {
  get: "bg-[#007AFF]/10 text-[#007AFF]",
  post: "bg-[#34C759]/12 text-[#1E9E4F]",
  put: "bg-[#FF9500]/12 text-[#C76A00]",
  delete: "bg-[#FF3B30]/12 text-[#D92A20]",
  patch: "bg-[#AF52DE]/12 text-[#9B3FBF]",
};

function schemaName(ref: string | undefined): string {
  if (!ref) return "";
  const name = ref.split("/").pop();
  return name ?? "";
}

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<OpenApiSchema | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/openapi.json")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => setSpec(data as OpenApiSchema))
      .catch((err) => setError(err instanceof Error ? err.message : "载入失败"));
  }, []);

  const entries = useMemo(() => {
    if (!spec) return [];
    return Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b));
  }, [spec]);

  return (
    <div className="flex flex-col gap-6">
      <section className="pt-2">
        <p className="text-ios-footnote font-semibold text-[#007AFF]">B 端 API</p>
        <h1 className="mt-2 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
          OpenAI 兼容生成 API
        </h1>
        <p className="mt-3 max-w-2xl text-ios-body leading-relaxed text-[rgba(0,0,0,0.58)]">
          {spec
            ? `${toSimplified(spec.info.title)} · v${spec.info.version} · OpenAPI ${spec.openapi}`
            : "从 OpenAPI spec 动态渲染，与线上行为保持一致。"}
        </p>
      </section>

      <section className="lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
        <div className="grid gap-6 p-5 sm:grid-cols-3 sm:gap-8 sm:p-7">
          <div>
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-[#007AFF]" />
              <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">Base URL</p>
            </div>
            <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
              https://image.tinchak0207.xyz/v1
            </code>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#007AFF]" />
              <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">认证</p>
            </div>
            <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
              Authorization: Bearer sk-biz-&lt;key&gt;
            </code>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#007AFF]" />
              <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">限流</p>
            </div>
            <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              60 requests/min，认证通过的回应带 x-ratelimit-* 头。
            </p>
          </div>
        </div>
      </section>

      {error ? (
        <section className="rounded-ios-3xl bg-[rgba(0,0,0,0.04)] p-5 text-ios-body text-[rgba(0,0,0,0.58)]">
          无法载入 OpenAPI spec：{error}
        </section>
      ) : !spec ? (
        <div className="space-y-3">
          <div className="skeleton h-5 w-40 rounded-full" />
          <div className="skeleton h-40 w-full rounded-ios-2xl" />
        </div>
      ) : (
        <>
          <nav aria-label="API 端点目录">
            <p className="px-1 pb-2 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">端点目录</p>
            <ol className="flex flex-wrap gap-1.5">
              {entries.map(([path]) => (
                <li key={path}>
                  <a
                    href={`#endpoint-${encodeURIComponent(path)}`}
                    className="inline-flex items-center rounded-full bg-[rgba(0,122,255,0.08)] px-3 py-1.5 text-ios-footnote font-medium text-[#007AFF] lg-transition hover:bg-[rgba(0,122,255,0.14)]"
                  >
                    <span className="font-mono">{path}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <section className="lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
            <div className="divide-y divide-[rgba(0,0,0,0.06)]">
              {entries.map(([path, methods]) =>
                Object.entries(methods).map(([method, operation]) => (
                  <section
                    key={`${method}-${path}`}
                    id={`endpoint-${encodeURIComponent(path)}`}
                    className="scroll-mt-28 p-5 sm:p-7"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-ios-caption1 font-bold uppercase tracking-wide ${METHOD_COLORS[method] ?? "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.66)]"}`}
                      >
                        {method}
                      </span>
                      <code className="font-mono text-ios-footnote font-semibold text-[#242830]">/v1{path}</code>
                      {operation.operationId ? (
                        <span className="text-ios-caption1 text-[rgba(0,0,0,0.46)]">{operation.operationId}</span>
                      ) : null}
                    </div>

                    {operation.summary ? (
                      <h3 className="mt-3 text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">
                        {toSimplified(operation.summary)}
                      </h3>
                    ) : null}

                    {operation.description ? (
                      <p className="mt-2 whitespace-pre-line text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                        {toSimplified(operation.description)}
                      </p>
                    ) : null}

                    {(operation.parameters?.length ?? 0) > 0 ? (
                      <div className="mt-4">
                        <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">参数</p>
                        <ul className="mt-2 space-y-1">
                          {operation.parameters?.map((param) => (
                            <li key={param.name} className="flex flex-wrap items-baseline gap-2 text-ios-footnote">
                              <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">
                                {param.name}
                              </code>
                              <span className="text-[rgba(0,0,0,0.52)]">{param.in}</span>
                              {param.required ? (
                                <span className="font-semibold text-[#D92A20]">必填</span>
                              ) : (
                                <span className="text-[rgba(0,0,0,0.46)]">可选</span>
                              )}
                              {param.description ? (
                                <span className="text-[rgba(0,0,0,0.58)]">{toSimplified(param.description)}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {operation.requestBody?.content ? (
                      <div className="mt-4">
                        <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">请求体</p>
                        <code className="mt-1 inline-block rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-ios-footnote text-[#242830]">
                          {schemaName(operation.requestBody.content["application/json"]?.schema?.$ref)}
                        </code>
                      </div>
                    ) : null}

                    {operation.responses ? (
                      <div className="mt-4">
                        <p className="text-ios-caption1 font-semibold text-[rgba(0,0,0,0.48)]">响应</p>
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {Object.entries(operation.responses).map(([status, response]) => (
                            <li
                              key={status}
                              className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 text-[rgba(0,0,0,0.62)]"
                              title={toSimplified(response.description ?? "")}
                            >
                              <span className="font-mono font-semibold text-[#242830]">{status}</span>
                              {response.description ? (
                                <span>{toSimplified(response.description)}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </section>
                )),
              )}
            </div>
          </section>

          <section className="pt-1">
            <p className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">OpenAPI Spec</p>
            <p className="mt-2 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              完整机器可读 spec（含请求/响应 schema 定义）：
            </p>
            <a
              href="/api/v1/openapi.json"
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#007AFF] px-4 py-2.5 text-ios-body font-semibold text-white transition-colors hover:bg-[#0066DD]"
            >
              下载 /api/v1/openapi.json
            </a>
          </section>
        </>
      )}
    </div>
  );
}