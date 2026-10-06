#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveConfig } from "./config.js";
import {
  generateAndWait,
  requestJson,
  safeJsonText,
  toolResult,
} from "./client.js";

async function run(): Promise<void> {
  const config = resolveConfig();
  if (!config.apiKey) {
    process.stderr.write("mcp-server: IMAGE_STUDIO_BIZ_KEY 未设定，无法呼叫 Image Studio API。\n");
    process.exit(1);
  }

  const server = new McpServer({
    name: "image-studio",
    version: "1.0.0",
  });

  server.tool(
    "list_models",
    "列出 Image Studio 支持的模型（图像与视频），含端点与订阅价格资讯",
    {},
    async () => {
      const payload = await requestJson(`${config.apiBase}/models`, { method: "GET" }, config.apiKey);
      return { content: [{ type: "text", text: safeJsonText(payload) }] };
    },
  );

  server.tool(
    "generate_image",
    "以 prompt 生成图片。异步任务，内部会等待完成后返回成品 URL。",
    {
      model: z.string().describe("模型 id，例如 gpt-image-2 / gemini-3.1-flash-image"),
      prompt: z.string().describe("生成提示词"),
      n: z.number().int().min(1).max(10).optional().describe("一次生成的数量，默认 1"),
      size: z.string().optional().describe("图像尺寸，例如 1024x1024"),
      quality: z
        .enum(["fast", "quality"])
        .optional()
        .describe("品质档位：quality 为品质档，fast 为速度档，默认 fast；同时兼容 OpenAI 写法的 hd/high（等同 quality）"),
    },
    async ({ model, prompt, n, size, quality }) => {
      const body: Record<string, unknown> = { model, prompt };
      if (n !== undefined) body.n = n;
      if (size !== undefined) body.size = size;
      if (quality !== undefined) body.quality = quality;
      return toolResult(await generateAndWait(config, "/images/generations", body));
    },
  );

  server.tool(
    "generate_video",
    "以 prompt 生成视频。异步任务，内部会等待完成后返回成品 URL。",
    {
      model: z.string().describe("视频模型 id，例如 seedance-2.0 / minimax-h3"),
      prompt: z.string().describe("视频提示词"),
      n: z.number().int().min(1).max(4).optional().describe("一次生成的数量，默认 1"),
      size: z.string().optional().describe("画面比例或尺寸，例如 16:9 或 1920x1080"),
      duration_seconds: z.number().int().min(1).max(30).optional().describe("秒数"),
      generate_audio: z.boolean().optional().describe("是否生成音频"),
    },
    async ({ model, prompt, n, size, duration_seconds, generate_audio }) => {
      const body: Record<string, unknown> = { model, prompt };
      if (n !== undefined) body.n = n;
      if (size !== undefined) body.size = size;
      if (duration_seconds !== undefined) body.duration_seconds = duration_seconds;
      if (generate_audio !== undefined) body.generate_audio = generate_audio;
      return toolResult(await generateAndWait(config, "/videos/generations", body));
    },
  );

  server.tool(
    "get_image_task",
    "查询一个图像生成任务的当前状态（不等待完成）",
    { task_id: z.string().describe("图像任务 id") },
    async ({ task_id }) => {
      const payload = await requestJson(`${config.apiBase}/images/${task_id}`, { method: "GET" }, config.apiKey);
      return { content: [{ type: "text", text: safeJsonText(payload) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  process.stderr.write(`mcp-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});