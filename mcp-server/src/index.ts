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
    process.stderr.write("mcp-server: IMAGE_STUDIO_BIZ_KEY 未設定，無法呼叫 Image Studio API。\n");
    process.exit(1);
  }

  const server = new McpServer({
    name: "image-studio",
    version: "1.0.0",
  });

  server.tool(
    "list_models",
    "列出 Image Studio 支援的模型（影像與影片），含端點與訂閱價格資訊",
    {},
    async () => {
      const payload = await requestJson(`${config.apiBase}/models`, { method: "GET" }, config.apiKey);
      return { content: [{ type: "text", text: safeJsonText(payload) }] };
    },
  );

  server.tool(
    "generate_image",
    "以 prompt 生成圖片。非同步任務，內部會等待完成後回傳成品 URL。",
    {
      model: z.string().describe("模型 id，例如 gpt-image-2 / nano-banana-3"),
      prompt: z.string().describe("生成提示詞"),
      n: z.number().int().min(1).max(10).optional().describe("一次生成的數量，預設 1"),
      size: z.string().optional().describe("影像尺寸，例如 1024x1024"),
      quality: z.enum(["fast", "quality"]).optional().describe("品質模式，預設 fast"),
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
    "以 prompt 生成影片。非同步任務，內部會等待完成後回傳成品 URL。",
    {
      model: z.string().describe("影片模型 id，例如 veo-3-1 / kling-3-0"),
      prompt: z.string().describe("影片提示詞"),
      n: z.number().int().min(1).max(4).optional().describe("一次生成的數量，預設 1"),
      size: z.string().optional().describe("畫面比例或尺寸，例如 16:9 或 1920x1080"),
      duration_seconds: z.number().int().min(1).max(30).optional().describe("秒數"),
      generate_audio: z.boolean().optional().describe("是否生成音訊"),
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
    "查詢一個影像生成任務的目前狀態（不等待完成）",
    { task_id: z.string().describe("影像任務 id") },
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