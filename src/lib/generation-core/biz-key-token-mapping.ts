// biz key ↔ new-api token 映射的 Postgres 存取層。
//
// 表結構見 db/migrations/012_biz_key_newapi_token.sql。手術計畫 P1：配額執法
// 歸 new-api 內核後，鑑權流在 biz key 驗證通過後解析出 new-api token id，
// 供提交前配額原子預檢與事後消費日誌投影使用。
//
// 模式複製 biz-api-key-repository.ts：GENERATION_DATABASE_URL 未配置時返回
// null/false，讓調用方走降級路徑 —— C 端 Vercel 部署沒有這個庫，不能因此炸掉。

import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";

type Row = {
  biz_key_id: string;
  token_id: number;
  token_key_preview: string;
};

/** Postgres 可用作權威源嗎。 */
export function bizKeyTokenMappingEnabled(): boolean {
  return generationControlPlaneEnabled();
}

/**
 * 按 biz key id 解析 new-api token id。
 *
 * 鑑權後的熱路徑（配額預檢的第一跳）：只取一行。映射缺失返回 null ——
 * 調用方（預檢）對 null fail-closed，不靜默放行無配額執法的訂單。
 */
export async function findNewApiTokenIdForBizKey(
  bizKeyId: string,
  sql?: GenerationSql,
): Promise<number | null> {
  // 先判開關再取連接：getGenerationSql 在未配置時會拋錯，不能放進參數缺省值
  // （缺省值在調用時即求值，會炸掉本應降級返回 null 的 C 端路徑）。
  if (!bizKeyTokenMappingEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<Row[]>`
    SELECT biz_key_id, token_id, token_key_preview
    FROM biz_key_newapi_token
    WHERE biz_key_id = ${bizKeyId}
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].token_id) : null;
}

/**
 * 按 token id 反查 biz key id（事後記帳投影方向）。
 * new-api 消費日誌記的是 token 維度，投影回 biz key 對帳用。
 */
export async function findBizKeyIdForNewApiToken(
  tokenId: number,
  sql?: GenerationSql,
): Promise<string | null> {
  if (!bizKeyTokenMappingEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<Row[]>`
    SELECT biz_key_id, token_id, token_key_preview
    FROM biz_key_newapi_token
    WHERE token_id = ${tokenId}
    LIMIT 1
  `;
  return rows[0] ? rows[0].biz_key_id : null;
}

/** 簽發/後台綁定映射。token_id 唯一：一把 token 不許掛到兩把 biz key。 */
export async function upsertBizKeyTokenMapping(
  mapping: { bizKeyId: string; tokenId: number; tokenKeyPreview?: string },
  sql?: GenerationSql,
): Promise<boolean> {
  if (!bizKeyTokenMappingEnabled()) return false;
  const db = sql ?? getGenerationSql();
  await db`
    INSERT INTO biz_key_newapi_token (biz_key_id, token_id, token_key_preview)
    VALUES (${mapping.bizKeyId}, ${mapping.tokenId}, ${mapping.tokenKeyPreview ?? ""})
    ON CONFLICT (biz_key_id) DO UPDATE SET
      token_id = EXCLUDED.token_id,
      token_key_preview = EXCLUDED.token_key_preview,
      updated_at = now()
  `;
  return true;
}
