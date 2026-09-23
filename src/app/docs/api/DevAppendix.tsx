"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Gauge,
  KeyRound,
  Rocket,
  Server,
  ShieldCheck,
} from "lucide-react";
import { toSimplified } from "@/lib/traditional-to-simplified";
import { CodeBlock, InlineCode, SectionTitle, Specular, Step } from "../DocsShell";

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
  post: "bg-[#34C759]/[0.12] text-[#1E9E4F]",
  put: "bg-[#FF9500]/[0.12] text-[#C76A00]",
  delete: "bg-[#FF3B30]/[0.12] text-[#D92A20]",
  patch: "bg-[#AF52DE]/[0.12] text-[#9B3FBF]",
};

function schemaName(ref: string | undefined): string {
  if (!ref) return "";
  const name = ref.split("/").pop();
  return name ?? "";
}

// ---- 开发进阶代码块：路径一律以 $BASE 模板串拼，杜绝内联手写的端点字面量 ----

const SETUP = `KEY="sk-biz-…"            # 你的 B 端密钥
BASE="https://eimu.dev/v1"`;

const STEP1 = `# ① 列出可用模型（含私有单价字段 x_coins_per_image）
curl -s "$BASE/models" \\
  -H "Authorization: Bearer $KEY"`;

const STEP2 = `# ② 提交任务 → 202 + task_id，不在同一响应里给图
curl -s -X POST "$BASE/images/generations" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"pixai-haruka-v2","prompt":"1girl, silver hair, cinematic lighting","n":1,"size":"1024x1024"}'
# → { "task_id": "3988af81-…", "status": "queued", "task_url": "/v1/images/3988af81-…" }`;

const STEP3 = `# ③ 轮询：3~5 秒一次，直到 status 变为 succeeded；轮询不消耗限流额度
TASK="3988af81-…"        # 换成上一步返回的 task_id
curl -s "$BASE/images/$TASK" \\
  -H "Authorization: Bearer $KEY"
# succeeded 的回应已内嵌 data[]，直接读 data[0].url 即成品 URL；/result 只是便捷入口`;

export function DevAppendix() {
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
    <section id="dev" className="scroll-mt-28 border-t border-dashed border-[rgba(0,0,0,0.1)] pt-8">
      <div className="flex items-center gap-2">
        <Rocket className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
        <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.66)]">开发进阶</h2>
      </div>
      <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
        给要把生成能力接进自己系统的开发者：B 端 API，与助理同一套生成核心、同一套计费与失败语义。
      </p>
      <p className="mt-2 text-ios-caption1 text-[rgba(0,0,0,0.46)]">
        {spec
          ? `${toSimplified(spec.info.title)} · v${spec.info.version} · OpenAPI ${spec.openapi}`
          : "以下端点目录从 OpenAPI spec 动态渲染，与线上行为保持一致。"}
      </p>

      <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
        <Specular />
        <div className="grid gap-6 p-5 sm:grid-cols-3 sm:gap-8 sm:p-7">
          <div>
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-[#007AFF]" />
              <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">Base URL</p>
            </div>
            <code className="mt-2 block overflow-x-auto rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote text-[#242830]">
              https://eimu.dev/v1
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

      <section className="mt-6">
        <SectionTitle icon={Gauge}>快速开始（异步三步）</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          先设两个变量，后续命令都复用它：
        </p>
        <div className="mt-3 max-w-2xl">
          <CodeBlock>{SETUP}</CodeBlock>
        </div>
      </section>

      <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
        <Specular />
        <div className="divide-y divide-[rgba(0,0,0,0.06)]">
          <Step
            n="1"
            title="列出可用模型"
            note={
              <>
                <InlineCode>GET {"$BASE"}/models</InlineCode>
                返回全站支持的模型，每个带私有单价字段 <InlineCode>x_coins_per_image</InlineCode>
                ；你调用的模型须在该 key 的白名单内，否则回 403。
              </>
            }
            code={STEP1}
          />
          <Step
            n="2"
            title="提交生成任务"
            note={
              <>
                <InlineCode>POST {"$BASE"}/images/generations</InlineCode>{" "}
                <strong className="font-semibold text-[rgba(0,0,0,0.72)]">永远</strong>先回 202 与一个 task_id，
                不在同一响应里给图。
              </>
            }
            code={STEP2}
          />
          <Step
            n="3"
            title="轮询到 succeeded"
            note={
              <>
                用 task_id 轮询 <InlineCode>{"$BASE"}/images/{"{id}"}</InlineCode>，3~5 秒一次直到状态变为
                succeeded——该回应已内嵌 <InlineCode>data[]</InlineCode>，直接读{" "}
                <InlineCode>data[0].url</InlineCode> 即成品（<InlineCode>/result</InlineCode>{" "}
                只是便捷入口）。轮询不消耗限流额度，实测 15~20 秒出图。
              </>
            }
            code={STEP3}
          />
        </div>
      </section>

      <p className="mt-4 max-w-3xl rounded-ios-2xl bg-[rgba(0,0,0,0.04)] p-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
        <strong className="font-semibold text-[rgba(0,0,0,0.72)]">契约要点：</strong>
        所有生成端点都是异步提交＋轮询；错误体为 OpenAI 形状并带 <InlineCode>trace_id</InlineCode>（值同{" "}
        <InlineCode>X-Request-Id</InlineCode> 头）；支持 <InlineCode>Idempotency-Key</InlineCode>（同键同体放回同一
        task，可安全重试）与 <InlineCode>callback_url</InlineCode>（终态 webhook 回调，轮询仍是兜底）。
      </p>

      {error ? (
        <section className="rounded-ios-3xl bg-[rgba(0,0,0,0.04)] p-5 text-ios-body text-[rgba(0,0,0,0.58)]">
          无法载入 OpenAPI spec：{error}
        </section>
      ) : !spec ? (
        <div className="mt-6 space-y-3">
          <div className="skeleton h-5 w-40 rounded-full" />
          <div className="skeleton h-40 w-full rounded-ios-2xl" />
        </div>
      ) : (
        <>
          <nav id="endpoint-catalog" aria-label="API 端点目录" className="mt-8 scroll-mt-28">
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

          <section className="mt-4 lg-card relative overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
            <Specular />
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
    </section>
  );
}
