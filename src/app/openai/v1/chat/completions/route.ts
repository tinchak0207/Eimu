// POST /openai/v1/chat/completions — **对话形式**的生图兼容面。
//
// 酒馆（SillyTavern）、Cherry Studio、LobeChat、Dify 这类客户端只说 chat.completions：
// 它们把最后一条 user 讯息当 prompt 送进来，期待回覆里能渲染出图。本路由取最后一条 user
// 讯息 → 走既有 durable 生图管线 → 同步等出图 → 回标准 chat.completion，content 是
// `![image](<url>)`（markdown，客户端直接渲染）。
//
// `stream:true` 是这几家的主通道：先送 role delta，出图前每 10s 送一个 SSE 注释当
// keep-alive（注释行被所有 SSE 客户端忽略，但足以让 nginx/中转站不切断连线），出图后送
// 含图片的 content delta，最后 `[DONE]`。
//
// 非生图模型（gpt-4o 之类）→ 400 model_not_supported：我们没有文本模型，假装能答会更糟。
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isModelAllowedForKey } from "@/lib/biz-api-keys";
import { extractLastUserPrompt, imageMarkdown } from "@/lib/openai-compat/chat-messages";
import { guardBizApiKey, openAICompatError, openAIError, type OpenAIErrorFields } from "@/lib/openai-compat/errors";
import {
  awaitImageTask,
  resolveGenerationOrigin,
  resolveMaxWaitMs,
  submitImageTask,
  taskFailureToError,
  taskTimeoutError,
} from "@/lib/openai-compat/generation";
import { resolveCompatibleImageModelId } from "@/lib/openai-compat/models";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
// Next.js 只静态解析字面量：段配置 export 引用识别符会让整包 build 失败
// （`Unknown identifier ... at maxDuration`）。值须与 lib/openai-compat/generation.ts 的
// FUNCTION_MAX_DURATION_SECONDS 保持一致。
export const maxDuration = 300;
export const preferredRegion = "sfo1";

/** 出图前的 SSE keep-alive 间隔。 */
const KEEPALIVE_INTERVAL_MS = 10_000;

interface ChatRequestBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function usageZeros() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const guard = await guardBizApiKey(req, traceId);
  if (!guard.ok) return guard.response;
  const key = guard.key;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return openAICompatError(400, "invalid_json", "请求体不是合法的 JSON。", traceId);
  }
  const body = (isRecord(parsed) ? parsed : {}) as ChatRequestBody;

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!rawModel) {
    return openAICompatError(
      400,
      "missing_model",
      "缺少必填参数 model。可用模型见 GET /openai/v1/models。",
      traceId,
    );
  }
  const model = resolveCompatibleImageModelId(rawModel);
  if (!model) {
    return openAICompatError(
      400,
      "model_not_supported",
      `本服务只提供生图模型，不支持 ${rawModel}。可用模型见 GET /openai/v1/models（回复内容为图片 markdown）。`,
      traceId,
    );
  }
  if (!isModelAllowedForKey(key, model)) {
    return openAICompatError(403, "model_not_permitted", `当前密钥无权调用模型 ${model}。`, traceId);
  }

  const extracted = extractLastUserPrompt(body.messages);
  if (!extracted.ok) {
    return openAICompatError(400, extracted.code, extracted.message, traceId);
  }

  const authorization = req.headers.get("authorization");
  const origin = resolveGenerationOrigin(req.url);
  const deadlineAt = Date.now() + resolveMaxWaitMs();
  const created = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "")}`;

  const submitted = await submitImageTask({
    origin,
    authorization,
    model,
    prompt: extracted.prompt,
    n: 1,
    size: "1024x1024",
    idempotencyKey: req.headers.get("idempotency-key") ?? `openai-chat-${randomUUID()}`,
    ...(req.signal ? { signal: req.signal } : {}),
  });
  // 提交失败（认证/额度/模型闸）发生在开流之前 → 回正常 HTTP 错误，客户端 SDK 直接抛。
  if (!submitted.ok) return openAIError(submitted.error, traceId);

  const streaming = body.stream === true;
  const wantsUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;

  if (!streaming) {
    const polled = await awaitImageTask({ origin, authorization, taskId: submitted.taskId, deadlineAt });
    if (!polled.settled) return openAIError(taskTimeoutError(submitted.taskId), traceId);
    if (polled.outcome.status !== "succeeded") {
      return openAIError(taskFailureToError(polled.outcome, submitted.taskId), traceId);
    }
    const url = polled.outcome.artifacts.find((artifact) => artifact.url)?.url;
    if (!url) {
      return openAICompatError(
        502,
        "generation_no_artifact",
        `任务 ${submitted.taskId} 已结束但没有可交付的产物（本次未出图，未扣费）。`,
        traceId,
      );
    }
    return withTraceId(
      NextResponse.json(
        {
          id: completionId,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: imageMarkdown(url) },
              finish_reason: "stop",
            },
          ],
          usage: usageZeros(),
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      ),
      traceId,
    );
  }

  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
      };
      try {
        // ① 立刻开场（客户端拿到 role delta 就算连上了）。
        send(chunk({ role: "assistant", content: "" }, null));
        // ② 出图前的 keep-alive：SSE 注释行，客户端解析器一律忽略。
        keepAlive = setInterval(() => {
          try {
            send(": keep-alive\n\n");
          } catch {
            // 连线已被客户端关闭：下一次 send 会抛，交由外层收尾。
          }
        }, KEEPALIVE_INTERVAL_MS);

        const polled = await awaitImageTask({ origin, authorization, taskId: submitted.taskId, deadlineAt });
        const failure: OpenAIErrorFields | null = !polled.settled
          ? taskTimeoutError(submitted.taskId)
          : polled.outcome.status === "succeeded"
            ? null
            : taskFailureToError(polled.outcome, submitted.taskId);
        const url =
          failure === null && polled.settled && polled.outcome.status === "succeeded"
            ? polled.outcome.artifacts.find((artifact) => artifact.url)?.url
            : undefined;

        if (failure) {
          // OpenAI 串流错误语义：一个带 error 的 chunk，SDK 收到即抛。
          send(`data: ${JSON.stringify({ error: { ...failure, param: null, trace_id: traceId } })}\n\n`);
        } else if (!url) {
          send(
            `data: ${JSON.stringify({
              error: {
                message: `任务 ${submitted.taskId} 已结束但没有可交付的产物（本次未出图，未扣费）。`,
                type: "api_error",
                code: "generation_no_artifact",
                param: null,
                trace_id: traceId,
              },
            })}\n\n`,
          );
        } else {
          // ③ 图片 markdown delta + 收尾。
          send(chunk({ content: imageMarkdown(url) }, null));
          send(chunk({}, "stop"));
          if (wantsUsage) {
            send(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: usageZeros(),
              })}\n\n`,
            );
          }
        }
      } catch (error) {
        console.error(`[openai-compat] chat stream aborted task=${submitted.taskId}`, error);
        try {
          send(
            `data: ${JSON.stringify({
              error: {
                message: "连接中断，生成任务仍在后台运行。",
                type: "api_error",
                code: "stream_aborted",
                param: null,
                trace_id: traceId,
              },
            })}\n\n`,
          );
        } catch {
          // 客户端已断，无处可送。
        }
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        try {
          send("data: [DONE]\n\n");
        } catch {
          // 同上
        }
        controller.close();
      }
    },
  });

  return withTraceId(
    new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // 反代不缓冲（Vercel/nginx 都会尊重这个头），否则 delta 会被攒到最后才吐出。
        "X-Accel-Buffering": "no",
      },
    }),
    traceId,
  );
}
