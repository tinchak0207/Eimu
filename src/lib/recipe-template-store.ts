/**
 * 用户配方模板存储（模板捕获器的持久层）。
 *
 * 存储纪律沿用 lora-user-state / agent-profile-store 的既有兜底链：
 *   1. Blob（preferences/recipe-templates/{userId}/…）—— 持久；
 *   2. 进程内 Map —— Blob 不可用时的本地调试兜底（重启即失）。
 * 不新建数据库表、不新建第二套存储系统；Blob 路径沿用 preferences/ 前缀约定。
 *
 * 存的内容 = workflow-recall 规范化配方（parseWorkflowRecallConfig 的产物）
 * + 一个加法式扩展字段 modelId（模板载入时切回当时的模型；旧记录无此字段也合法）。
 * 写入边界统一走 parseWorkflowRecallConfig：脏字段（超界 copies、非法 role、
 * 未知枚举）在这里被清洗，存下来的永远是合法配方。
 */

import { createHash, randomUUID } from "node:crypto";
import { del, get, list, put } from "./blob-backend";
import { parseWorkflowRecallConfig, type WorkflowRecallConfig } from "./workflow-recall";

/** 契约扩展点：在 WorkflowRecallConfig 之上加可选 modelId（向后兼容，旧数据无此字段照常载入）。 */
export type RecipeTemplateConfig = WorkflowRecallConfig & { modelId?: string };

export interface StoredRecipeTemplate {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: RecipeTemplateConfig;
}

/** 每用户上限：模板库随用量增长，但要防无界膨胀拖慢列表读取。 */
export const USER_RECIPE_TEMPLATE_LIMIT = 50;
const NAME_MAX_LENGTH = 30;

const memoryState = new Map<number, StoredRecipeTemplate[]>();

function hasBlobState(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.IMAGE_DATA_BASE_URL && process.env.IMAGE_DATA_API_KEY));
}

function blobPrefix(userId: number): string {
  return `preferences/recipe-templates/${userId}/`;
}

/** id 不直接进路径（防路径注入），哈希后作为文件名 —— 与 lora-user-state 同款约定。 */
function blobPath(userId: number, templateId: string): string {
  const digest = createHash("sha256").update(templateId).digest("hex");
  return `${blobPrefix(userId)}${digest}.json`;
}

function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, NAME_MAX_LENGTH);
}

/**
 * 把任意提交（成片 provenance JSON / 粘贴配置 / 旧模板）规范化为合法配方。
 * parseWorkflowRecallConfig 负责清洗与拒绝空配置；modelId 是加法式扩展，
 * 单独提取回填（parse 的 schema 里没有它）。
 */
function normalizeRecipeConfig(raw: unknown): RecipeTemplateConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result = parseWorkflowRecallConfig(JSON.stringify(raw));
  if (!result.ok) return null;
  const modelId = typeof (raw as Record<string, unknown>).modelId === "string"
    ? ((raw as Record<string, unknown>).modelId as string).trim()
    : "";
  return modelId ? { ...result.config, modelId } : { ...result.config };
}

function sanitizeStoredTemplate(value: unknown): StoredRecipeTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
  const name = sanitizeName(item.name);
  const config = item.config && typeof item.config === "object" && !Array.isArray(item.config)
    ? normalizeRecipeConfig(item.config)
    : null;
  if (!id || !name || !config) return null;
  return {
    id,
    name,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
    config,
  };
}

async function readBlobTemplate(pathname: string): Promise<StoredRecipeTemplate | null> {
  try {
    const blob = await get(pathname, { access: "public" });
    if (!blob || blob.statusCode !== 200) return null;
    return sanitizeStoredTemplate(JSON.parse(await new Response(blob.stream).text()));
  } catch {
    return null;
  }
}

export async function listUserRecipeTemplates(userId: number): Promise<StoredRecipeTemplate[]> {
  if (!hasBlobState()) {
    return [...(memoryState.get(userId) ?? [])].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }
  const refs: Array<{ pathname: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: blobPrefix(userId), cursor, limit: 200 });
    refs.push(...page.blobs.map((blob) => ({ pathname: blob.pathname })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && refs.length < USER_RECIPE_TEMPLATE_LIMIT);
  const templates = (await Promise.all(refs.slice(0, USER_RECIPE_TEMPLATE_LIMIT).map((ref) => readBlobTemplate(ref.pathname))))
    .filter((item): item is StoredRecipeTemplate => Boolean(item));
  return templates.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export type SaveRecipeTemplateResult =
  | { ok: true; template: StoredRecipeTemplate }
  | { ok: false; code: "invalid_name" | "invalid_config" | "limit_reached"; message: string };

export async function saveUserRecipeTemplate(input: {
  userId: number;
  name: string;
  config: unknown;
  /** 覆盖更新既有模板；缺省新建（同名时视为覆盖，捕获器重复保存不堆积同名列目）。 */
  templateId?: string;
}): Promise<SaveRecipeTemplateResult> {
  const name = sanitizeName(input.name);
  if (!name) {
    return { ok: false, code: "invalid_name", message: "模板名称不能为空。" };
  }
  const config = normalizeRecipeConfig(input.config);
  if (!config) {
    return { ok: false, code: "invalid_config", message: "模板内容不是有效的配方。" };
  }

  const now = new Date().toISOString();
  let existing: StoredRecipeTemplate | null = null;

  if (input.templateId) {
    existing = hasBlobState()
      ? await readBlobTemplate(blobPath(input.userId, input.templateId))
      : (memoryState.get(input.userId) ?? []).find((item) => item.id === input.templateId) ?? null;
  } else {
    const all = await listUserRecipeTemplates(input.userId);
    existing = all.find((item) => item.name === name) ?? null;
  }

  if (!existing) {
    const current = await listUserRecipeTemplates(input.userId);
    if (current.length >= USER_RECIPE_TEMPLATE_LIMIT) {
      return { ok: false, code: "limit_reached", message: `我的模板已达 ${USER_RECIPE_TEMPLATE_LIMIT} 个上限，请先删除不需要的模板。` };
    }
  }

  const template: StoredRecipeTemplate = {
    id: existing?.id ?? input.templateId?.trim() ?? randomUUID(),
    name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    config,
  };

  if (hasBlobState()) {
    await put(blobPath(input.userId, template.id), JSON.stringify(template), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  } else {
    const state = memoryState.get(input.userId) ?? [];
    memoryState.set(input.userId, [template, ...state.filter((item) => item.id !== template.id)]);
  }
  return { ok: true, template };
}

export async function deleteUserRecipeTemplate(userId: number, templateId: string): Promise<boolean> {
  if (!templateId.trim()) return false;
  if (hasBlobState()) {
    const pathname = blobPath(userId, templateId);
    const existing = await readBlobTemplate(pathname);
    if (!existing) return false;
    try {
      await del([pathname]);
    } catch {
      return false;
    }
    return true;
  }
  const state = memoryState.get(userId) ?? [];
  if (!state.some((item) => item.id === templateId)) return false;
  memoryState.set(userId, state.filter((item) => item.id !== templateId));
  return true;
}
