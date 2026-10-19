-- 026: welcome_gift_grant.modal_seen_at —— 新人礼首登弹窗「已展示」的 additive 回执。
--
-- 为什么要另开一列而不是复用 noticed_at：同一轮登录里 welcome-gift-login.ts 会在
-- 发放成功后**立刻**写一条站内通知并经 op=noticed 回执，也就是用户第一次登录的
-- 当下 noticed_at 就已经非空。拿 `noticed_at IS NULL` 当弹窗闸门 = 弹窗永远不会
-- 出现（追溯发放的既有用户同理）。所以展示回执单独记一列：
--
--   弹窗闸门 = status = 'applied' AND modal_seen_at IS NULL
--
-- 服务端是唯一权威（换设备/换浏览器不能再弹一次）；客户端 localStorage 只是
-- 本设备上的辅助闸门（见 src/lib/welcome-gift-modal.ts）。
--
-- 运行时首用会执行同一条 ALTER TABLE ... ADD COLUMN IF NOT EXISTS（见
-- src/lib/welcome-gift.ts 的 ensureSchema），本文件为留档与手工迁移用。
-- 024 已 applied，其 content 不可改（generation_schema_migration 有 checksum），
-- 故走新增迁移文件。

ALTER TABLE welcome_gift_grant
  ADD COLUMN IF NOT EXISTS modal_seen_at timestamptz;
