// `POST /openai/v1/chat/completions` 的**真行為斷言**。
//
// 酒館／Cherry Studio／LobeChat 走的是 chat 形狀：最後一條 user 訊息當 prompt，回覆內容
// 必須是能渲染的 markdown 圖片；`stream:true` 要能從頭收到 `[DONE]`。這裡逐欄驗 OpenAI
// chat.completion(/chunk) 的形狀（沒有 `openai` npm 套件，且紅線禁止新增依賴）。
//
// 上游一律替身：零外網、零付費調用。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  ARTIFACT_URL,
  AUTH_HEADER,
  TASK_ID,
  clearCompatEnv,
  installUpstreamStub,
  resetCompatEnv,
  restoreFetch,
} from "@/lib/openai-compat/upstream-stub";
import { POST } from "./route";

const SUCCEEDED = {
  object: "image_generation.task",
  id: TASK_ID,
  status: "succeeded",
  data: [{ id: "art-1", url: ARTIFACT_URL, mimeType: "image/png" }],
};

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const head = new Headers({ authorization: AUTH_HEADER, "content-type": "application/json", ...headers });
  return new NextRequest("http://localhost/openai/v1/chat/completions", {
    method: "POST",
    headers: head,
    body: JSON.stringify(body),
  });
}

/** 解析 SSE 文字成 data 行（忽略註釋行與空行）。 */
function sseData(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

test.beforeEach(() => {
  resetCompatEnv();
});

test.afterEach(() => {
  restoreFetch();
});

test.after(() => {
  clearCompatEnv();
});

test("同步：最后一条 user 訊息當 prompt，回 chat.completion + markdown 图片", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(
    req({
      model: "gpt-image-2",
      messages: [
        { role: "system", content: "你是绘图助手" },
        { role: "user", content: "第一张：一只狗" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "第二张：一只在雨夜戴墨镜的猫" },
      ],
    }),
  );
  const body = (await response.json()) as {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
    usage: Record<string, number>;
  };

  assert.equal(response.status, 200);
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.object, "chat.completion");
  assert.ok(Number.isInteger(body.created));
  assert.equal(body.model, "gpt-image-2", "回覆必須回帶客戶端送來的模型 id");
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].index, 0);
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, `![image](${ARTIFACT_URL})`);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

  assert.equal(calls.submits.length, 1);
  assert.equal(
    calls.submits[0].body.prompt,
    "第二张：一只在雨夜戴墨镜的猫",
    "prompt 必须取最后一条 user 訊息，不是拼历史",
  );
});

test("content 为分片数组时取 text 分片", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(
    req({
      model: "gpt-image-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "赛博" },
            { type: "text", text: "朋克城市" },
          ],
        },
      ],
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.submits[0].body.prompt, "赛博\n朋克城市");
});

test("stream:true：role delta → 图片 delta → stop → [DONE]", async () => {
  installUpstreamStub({ taskSnapshots: [{ status: "running" }, SUCCEEDED] });

  const response = await POST(
    req({ model: "gpt-image-2", messages: [{ role: "user", content: "一只猫" }], stream: true }),
  );
  assert.match(String(response.headers.get("content-type")), /^text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no", "反代不得缓冲 SSE");

  const lines = sseData(await response.text());
  assert.equal(lines[lines.length - 1], "[DONE]", "串流必须以 [DONE] 收尾");

  const chunks = lines
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as { object: string; choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> });

  assert.ok(chunks.length >= 3, `至少要有 role/图片/stop 三个 chunk，实得 ${chunks.length}`);
  assert.ok(
    chunks.every((chunk) => chunk.object === "chat.completion.chunk"),
    "每个 chunk 的 object 必须是 chat.completion.chunk",
  );
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" }, "先送 keep-alive 开场");
  const imageChunk = chunks.find((chunk) => typeof chunk.choices[0].delta.content === "string" && chunk.choices[0].delta.content);
  assert.equal(imageChunk?.choices[0].delta.content, `![image](${ARTIFACT_URL})`);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, "stop");
});

test("stream:true + 任务失败：串流内送 error 事件后仍以 [DONE] 收尾", async () => {
  installUpstreamStub({
    taskSnapshots: [{ status: "failed", error: { code: "overloaded", message: "上游额度打满" } }],
  });

  const response = await POST(
    req({ model: "gpt-image-2", messages: [{ role: "user", content: "一只猫" }], stream: true }),
  );
  const lines = sseData(await response.text());
  const errorLine = lines.find((line) => line.includes("\"error\""));
  assert.ok(errorLine, "失败必须以 error 事件告知客户端，不能静默 [DONE]");
  const parsed = JSON.parse(errorLine) as { error: { code: string; message: string; param: null } };
  assert.equal(parsed.error.code, "overloaded");
  assert.match(parsed.error.message, new RegExp(TASK_ID));
  assert.equal(lines[lines.length - 1], "[DONE]");
});

test("非生图模型：400 model_not_supported（我们只有生图模型，不假装能答）", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(req({ model: "gpt-4o", messages: [{ role: "user", content: "你好" }] }));
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "model_not_supported");
  assert.equal(calls.submits.length, 0);
});

test("图片输入：400 image_input_not_supported（不静默丢图后乱画）", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(
    req({
      model: "gpt-image-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "把它改成夜景" },
            { type: "image_url", image_url: { url: "https://cdn.example/in.png" } },
          ],
        },
      ],
    }),
  );
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "image_input_not_supported");
  assert.equal(calls.submits.length, 0);
});

test("没有 user 訊息：400 invalid_request", async () => {
  installUpstreamStub({ taskSnapshots: [SUCCEEDED] });
  const response = await POST(req({ model: "gpt-image-2", messages: [{ role: "system", content: "x" }] }));
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_request");
});
