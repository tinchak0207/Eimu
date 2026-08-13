import { createHash } from "node:crypto";
import { get, list, put } from "./blob-backend";
import { generationDatabaseConfigured, getGenerationSql } from "./generation-core/database";

export interface LoraUserStateItem {
  versionId: string;
  title: string;
  thumb: string;
  favorite: boolean;
  lastUsedAt?: string;
  updatedAt: string;
}

interface LoraUserStateRow {
  model_version_id: string;
  title: string;
  thumb_url: string;
  favorite: boolean;
  last_used_at: Date | string | null;
  updated_at: Date | string;
}

const memoryState = new Map<number, LoraUserStateItem[]>();

function hasBlobState(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.IMAGE_DATA_BASE_URL && process.env.IMAGE_DATA_API_KEY));
}

function blobPrefix(userId: number): string {
  return `preferences/lora/${userId}/`;
}

function blobPath(userId: number, versionId: string): string {
  const digest = createHash("sha256").update(versionId).digest("hex");
  return `${blobPrefix(userId)}${digest}.json`;
}

async function readBlobItem(pathname: string): Promise<LoraUserStateItem | null> {
  try {
    const blob = await get(pathname, { access: "public" });
    if (!blob || blob.statusCode !== 200) return null;
    const payload = JSON.parse(await new Response(blob.stream).text()) as LoraUserStateItem;
    return payload?.versionId && payload?.title && payload?.thumb ? payload : null;
  } catch {
    return null;
  }
}

async function listBlobState(userId: number): Promise<LoraUserStateItem[]> {
  if (!hasBlobState()) return memoryState.get(userId) ?? [];
  const refs: Array<{ pathname: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: blobPrefix(userId), cursor, limit: 200 });
    refs.push(...page.blobs.map((blob) => ({ pathname: blob.pathname })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && refs.length < 200);
  return (await Promise.all(refs.slice(0, 200).map((ref) => readBlobItem(ref.pathname))))
    .filter((item): item is LoraUserStateItem => Boolean(item));
}

async function upsertBlobState(input: {
  userId: number;
  versionId: string;
  title: string;
  thumb: string;
  favorite?: boolean;
  markUsed?: boolean;
}): Promise<LoraUserStateItem> {
  const pathname = blobPath(input.userId, input.versionId);
  const current = hasBlobState()
    ? await readBlobItem(pathname)
    : (memoryState.get(input.userId) ?? []).find((item) => item.versionId === input.versionId) ?? null;
  const now = new Date().toISOString();
  const item: LoraUserStateItem = {
    versionId: input.versionId,
    title: input.title,
    thumb: input.thumb,
    favorite: input.favorite ?? current?.favorite ?? false,
    ...(input.markUsed ? { lastUsedAt: now } : current?.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
    updatedAt: now,
  };
  if (hasBlobState()) {
    await put(pathname, JSON.stringify(item), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  } else {
    const state = memoryState.get(input.userId) ?? [];
    memoryState.set(input.userId, [item, ...state.filter((entry) => entry.versionId !== input.versionId)]);
  }
  return item;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: LoraUserStateRow): LoraUserStateItem {
  return {
    versionId: row.model_version_id,
    title: row.title,
    thumb: row.thumb_url,
    favorite: row.favorite,
    ...(row.last_used_at ? { lastUsedAt: iso(row.last_used_at) } : {}),
    updatedAt: iso(row.updated_at),
  };
}

export async function listLoraUserState(userId: number): Promise<LoraUserStateItem[]> {
  if (!generationDatabaseConfigured()) {
    const items = await listBlobState(userId);
    return items
      .filter((item) => item.favorite || item.lastUsedAt)
      .sort((left, right) => Number(right.favorite) - Number(left.favorite) || Date.parse(right.lastUsedAt ?? right.updatedAt) - Date.parse(left.lastUsedAt ?? left.updatedAt));
  }
  const sql = getGenerationSql();
  const rows = await sql<LoraUserStateRow[]>`
    SELECT model_version_id, title, thumb_url, favorite, last_used_at, updated_at
    FROM lora_user_state
    WHERE user_id = ${userId}
      AND (favorite OR last_used_at IS NOT NULL)
    ORDER BY favorite DESC, last_used_at DESC NULLS LAST, updated_at DESC
    LIMIT 200
  `;
  return rows.map(mapRow);
}

export async function upsertLoraUserState(input: {
  userId: number;
  versionId: string;
  title: string;
  thumb: string;
  favorite?: boolean;
  markUsed?: boolean;
}): Promise<LoraUserStateItem> {
  if (!generationDatabaseConfigured()) return upsertBlobState(input);
  const sql = getGenerationSql();
  const favorite = input.favorite ?? null;
  const markUsed = input.markUsed === true;
  const rows = await sql<LoraUserStateRow[]>`
    INSERT INTO lora_user_state (
      user_id, model_version_id, title, thumb_url, favorite, last_used_at
    ) VALUES (
      ${input.userId}, ${input.versionId}, ${input.title}, ${input.thumb},
      ${favorite ?? false}, ${markUsed ? new Date() : null}
    )
    ON CONFLICT (user_id, model_version_id) DO UPDATE SET
      title = EXCLUDED.title,
      thumb_url = EXCLUDED.thumb_url,
      favorite = COALESCE(${favorite}, lora_user_state.favorite),
      last_used_at = CASE WHEN ${markUsed} THEN now() ELSE lora_user_state.last_used_at END,
      updated_at = now()
    RETURNING model_version_id, title, thumb_url, favorite, last_used_at, updated_at
  `;
  return mapRow(rows[0]);
}
