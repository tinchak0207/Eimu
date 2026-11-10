-- S-01 / S-17：PWA 登录交接改为 PKCE 式绑定 + ticket 只存摘要。
--   ticket_hash：sha256(ticket) 十六进制；新行的 ticket 主键列也只放该摘要，明文 ticket 不落库。
--   challenge  ：sha256(发起设备本地 verifier) 十六进制；claim 必须出示 verifier 才可领取。
-- ticket_hash / challenge 均为 NULL 的行 = 部署切换前已发出的旧 ticket，TTL（10 分钟）内仍可凭明文领取一次
--（应用层 PWA_HANDOFF_ALLOW_LEGACY_TICKETS 开关）；部署满 1 天后这类行必已过期，可移除该兼容分支。
-- 过期清理保留期同步由 1 day 缩到 1 hour（见 src/lib/pwa-handoff.ts createHandoffTicket）。
ALTER TABLE pwa_login_handoff ADD COLUMN IF NOT EXISTS ticket_hash TEXT;
ALTER TABLE pwa_login_handoff ADD COLUMN IF NOT EXISTS challenge TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS pwa_login_handoff_ticket_hash_idx
  ON pwa_login_handoff (ticket_hash) WHERE ticket_hash IS NOT NULL;
