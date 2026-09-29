-- 025: user_attribution —— 可觸達聯絡方式（provider 已驗證真實 email）＋ 註冊來源歸因。
--
-- 定位（不另造第二套用戶資料存儲）：
--   身分／憑證的唯一 owner 仍是 new-api 的 users 表（合成帳號、派生密碼、quota、角色）。
--   本表是**以 new-api users.id 為主鍵的側車表**，只放兩類 new-api 存不下的補充事實：
--     ① 觸達：provider 回傳且**已驗證**的真實 email。new-api 上存的是合成位址
--        （github-<id>-gh4@users.noreply.github.com / google-<sub>@oauth...），
--        真實 email 在登入流程被丟棄 ⇒ 用戶離站即無法觸達（2026-09-27 生產事實：150 個
--        有效用戶 email 非空 = 0，且沒有 SMTP）。**不改動合成 email 的身份邏輯**，
--        避免舊帳號撞號（09-09 GitHub 舊用戶全滅同型死法）。
--     ② 歸因：首次觸達（first-touch）的 utm_source / utm_medium / utm_campaign /
--        referrer host / landing path，以及由它推導的分組鍵 signup_source。
--
-- 寫入語義（冪等 upsert，每次登入都跑，老用戶再登入一次即被補上）：
--   email 系列     = 「最新一筆已驗證值勝出」；新值為 NULL（provider 沒給）時保留舊值。
--   歸因系列       = 「首次觸達勝出」（first-touch wins）：既有非 NULL 值永不覆蓋。
--   ⇒ 因為歸因只在第一次寫入時落地，重放安全；email 只在驗證通過時才帶值。
--
-- signup_source 是**分組鍵**（小寫），不是原文：優先用 utm_source，其次 referrer host，
--   都沒有＝'direct'（首次觸達時確實沒有任何來源參數）。沒有本表列、或列上為 NULL 的用戶
--   （例如 150 個存量用戶）在統計投影裡歸入哨兵值 '__unknown__'，由展示層本地化為
--   「未標記」——不會被算成 direct（direct 是一句真話：cookie 記下「確實沒帶來源」）。
--
-- 隱私：email 屬個資，只進本表，永不進日誌／回報／commit（本檔僅 DDL）。
--
-- 執行時首用會 CREATE TABLE IF NOT EXISTS 同一 DDL（首用即建，免人工遷移）。

CREATE TABLE IF NOT EXISTS user_attribution (
  user_id           bigint PRIMARY KEY,
  -- 已驗證真實 email（NULL = 尚未取得，例如 provider 未給或舊授權缺 user:email scope）。
  email             text,
  -- 提供該 email 的 provider：'github' | 'google'（微信無 email，刻意不列）。
  email_provider    text CHECK (email_provider IS NULL OR email_provider IN ('github', 'google')),
  email_verified_at timestamptz,
  -- 分組鍵（小寫）：utm_source → referrer host → 'direct'，首觸勝出。
  signup_source     text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  referrer_host     text,
  landing_path      text,
  first_touch_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 統計投影按 signup_source 分組（窗口內註冊用戶的來源拆分升）。
CREATE INDEX IF NOT EXISTS user_attribution_signup_source_idx ON user_attribution (signup_source);
