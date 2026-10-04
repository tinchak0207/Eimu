-- 025: user_attribution —— 可触达联络方式（provider 已验证真实 email）＋ 注册来源归因。
--
-- 定位（不另造第二套用户资料存储）：
--   身分／凭证的唯一 owner 仍是 new-api 的 users 表（合成帐号、派生密码、quota、角色）。
--   本表是**以 new-api users.id 为主键的侧车表**，只放两类 new-api 存不下的补充事实：
--     ① 触达：provider 回传且**已验证**的真实 email。new-api 上存的是合成位址
--        （github-<id>-gh4@users.noreply.github.com / google-<sub>@oauth...），
--        真实 email 在登入流程被丢弃 ⇒ 用户离站即无法触达（2026-09-27 生产事实：150 个
--        有效用户 email 非空 = 0，且没有 SMTP）。**不改动合成 email 的身份逻辑**，
--        避免旧帐号撞号（09-09 GitHub 旧用户全灭同型死法）。
--     ② 归因：首次触达（first-touch）的 utm_source / utm_medium / utm_campaign /
--        referrer host / landing path，以及由它推导的分组键 signup_source。
--
-- 写入语义（幂等 upsert，每次登入都跑，老用户再登入一次即被补上）：
--   email 系列     = 「最新一笔已验证值胜出」；新值为 NULL（provider 没给）时保留旧值。
--   归因系列       = 「首次触达胜出」（first-touch wins）：既有非 NULL 值永不覆盖。
--   ⇒ 因为归因只在第一次写入时落地，重放安全；email 只在验证通过时才带值。
--
-- signup_source 是**分组键**（小写），不是原文：优先用 utm_source，其次 referrer host，
--   都没有＝'direct'（首次触达时确实没有任何来源参数）。没有本表列、或列上为 NULL 的用户
--   （例如 150 个存量用户）在统计投影里归入哨兵值 '__unknown__'，由展示层本地化为
--   「未标记」——不会被算成 direct（direct 是一句真话：cookie 记下「确实没带来源」）。
--
-- 隐私：email 属个资，只进本表，永不进日志／回报／commit（本档仅 DDL）。
--
-- 执行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL（首用即建，免人工迁移）。

CREATE TABLE IF NOT EXISTS user_attribution (
  user_id           bigint PRIMARY KEY,
  -- 已验证真实 email（NULL = 尚未取得，例如 provider 未给或旧授权缺 user:email scope）。
  email             text,
  -- 提供该 email 的 provider：'github' | 'google'（微信无 email，刻意不列）。
  email_provider    text CHECK (email_provider IS NULL OR email_provider IN ('github', 'google')),
  email_verified_at timestamptz,
  -- 分组键（小写）：utm_source → referrer host → 'direct'，首触胜出。
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

-- 统计投影按 signup_source 分组（窗口内注册用户的来源拆分升）。
CREATE INDEX IF NOT EXISTS user_attribution_signup_source_idx ON user_attribution (signup_source);
