import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  CONTROL_PLANE_PROXY_SOURCES,
  controlPlaneRewrites,
} from "./control-plane-proxy-routes.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const API_DIR = path.join(SRC_DIR, "app", "api");

// ── 行为不变：照改动前 next.config.mjs 手抄（不许从被测模组推导）──────────────
const EXPECTED_REWRITES = [
  { source: "/v1/:path*", destination: "https://o.example/image-control/v1/:path*" },
  { source: "/api/v1/:path*", destination: "https://o.example/image-control/api/v1/:path*" },
  { source: "/api/generate-images", destination: "https://o.example/image-control/api/generate-images" },
  { source: "/api/generation-jobs", destination: "https://o.example/image-control/api/generation-jobs" },
  { source: "/api/generation-jobs/:path*", destination: "https://o.example/image-control/api/generation-jobs/:path*" },
  { source: "/api/admin/billing-operations", destination: "https://o.example/image-control/api/admin/billing-operations" },
  { source: "/api/admin/biz-keys/provision", destination: "https://o.example/image-control/api/admin/biz-keys/provision" },
  { source: "/api/probe/stuck", destination: "https://o.example/image-control/api/probe/stuck" },
  { source: "/api/probe/jobs/:path*", destination: "https://o.example/image-control/api/probe/jobs/:path*" },
  { source: "/api/internal/team-membership", destination: "https://o.example/image-control/api/internal/team-membership" },
  { source: "/api/email/unsubscribe", destination: "https://o.example/image-control/api/email/unsubscribe" },
  { source: "/openai/v1/:path*", destination: "https://o.example/image-control/openai/v1/:path*" },
  { source: "/api/admin/statistics", destination: "https://o.example/image-control/api/admin/statistics" },
  { source: "/api/admin/model-routes", destination: "https://o.example/image-control/api/admin/model-routes" },
  { source: "/api/admin/account-adjustments", destination: "https://o.example/image-control/api/admin/account-adjustments" },
  { source: "/api/pixai/edit", destination: "https://o.example/image-control/api/pixai/edit" },
  { source: "/api/pixai/upscale", destination: "https://o.example/image-control/api/pixai/upscale" },
  { source: "/api/pixai/template-generations", destination: "https://o.example/image-control/api/pixai/template-generations" },
  { source: "/api/canvas/storyboard-qc", destination: "https://o.example/image-control/api/canvas/storyboard-qc" },
  { source: "/api/canvas/storyboard-voiceover", destination: "https://o.example/image-control/api/canvas/storyboard-voiceover" },
];

test("controlPlaneRewrites：有 origin 时与改动前手写清单逐条相等", () => {
  assert.deepEqual(controlPlaneRewrites("https://o.example"), EXPECTED_REWRITES);
});

test("controlPlaneRewrites：origin 为空回 []", () => {
  assert.deepEqual(controlPlaneRewrites(""), []);
  assert.deepEqual(controlPlaneRewrites(undefined), []);
});

// ── 漂移棘轮 ─────────────────────────────────────────────────────────────────
// 基线：DB 绑定（import 闭包碰到含 GENERATION_DATABASE_URL 的模组）却未被代理、
// 目前在 Vercel 本地执行的 route。只准缩不准涨：新 route 要嘛被代理，要嘛写进来
// 并附具体理由；已不再违规的条目也会红，逼人删掉。
const KNOWN_VERCEL_LOCAL: Record<string, string> = {
  "/api/admin/biz-keys": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/admin/biz-keys/[id]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/admin/channels": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/admin/channels/audit": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/admin/channels/rollback": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/admin/control-plane-diagnostics": "以 generationControlPlaneEnabled() 分流，Vercel 侧经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN relay 取控面诊断",
  "/api/admin/external-channels": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/admin/model-pricing": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/admin/proxy-pool": "以 generationControlPlaneEnabled() 分流，Vercel 侧 relay 到控面 /image-control/api/internal/proxy-pool，未配 relay 回 available:false",
  "/api/admin/image-upstream-probe": "运维探针（IMAGE_UPSTREAM_PROBE_TOKEN 头鉴权）：渠道运行时配置 admin-pool-store/channel-overrides 以 BLOB_READ_WRITE_TOKEN 的 Blob 为真源（非 DB，读失败回空集合），探针直连上游生成、不写本站 DB",
  "/api/admin/slo": "slo-service 辨识 getGenerationSql 未配置讯息（NOT_CONFIGURED），Vercel 回不可用而不抛",
  "/api/admin/templates": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/admin/tier-pricing": "admin-audit 以 generationDatabaseConfigured() 闸 DB，未配置回 null 不写审计",
  "/api/agent/biz/[...path]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/agent/biz/resolve-owner": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/agent/device-token": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底；本端点自身纯代理换票，不写 DB/log（W7a 桌面壳装置桥，2026-10-05）",
  "/api/agent/memory/export": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体",
  "/api/agent/memory/ingest": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体",
  "/api/agent/memory/retract": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体",
  "/api/agent/memory/review": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体",
  "/api/agent/profile": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/记忆体；其余只经 newapi relay",
  "/api/agent/profile/lessons": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/记忆体；其余只经 newapi relay",
  "/api/agent/quota": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/记忆体；其余只经 newapi relay；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）与 dbAvailable 判定的记忆库",
  "/api/agent/sessions/[id]": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/abort": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/attachments": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/canvas-ops-result": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/canvas-state": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/confirm": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/director/[[...sub]]": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/memory": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/记忆体；其余只经 newapi relay；agent-memory-injection 同 /api/agent/sessions",
  "/api/agent/sessions/[id]/memory-trace": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/messages": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/question": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/sse-ticket": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/steer": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/transcript": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/uploads-ticket": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/workflow-node-rerun": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/sessions/[id]/workflow-node-update": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/agent/settings": "经 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）闸住，Vercel 走 Blob/记忆体兜底",
  "/api/assets": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/auth/emu-oauth/exchange": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/auth/github/callback": "pwa-handoff 双模式（Vercel 走 HMAC relay）＋ recordUserAttributionViaRelay，本地不直连 DB",
  "/api/auth/google/callback": "pwa-handoff 双模式（Vercel 走 HMAC relay）＋ recordUserAttributionViaRelay，本地不直连 DB",
  "/api/auth/handoff": "pwa-handoff 双模式：Vercel 无 DB 时经 HMAC relay 转投控面",
  "/api/auth/me": "只用 *ViaRelay（lookupUserIdByToken/welcome-gift/user-attribution）打控面，relay 失败回 503 transient",
  "/api/auth/wechat/callback": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/auth/wechat/msg": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/auth/wechat/poll": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/auth/wechat/start": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/biz/character-cards": "biz-openai-error 只取 authenticateBizApiKey（Blob 兜底）；其余只经 newapi relay",
  "/api/biz/character-resolve": "biz-openai-error 只取 authenticateBizApiKey（Blob 兜底）；artifact-service 只取纯函式 validateImageBuffer",
  "/api/blender-artifact": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/assets": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/format-crops": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/image-proxy": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/nodes/[id]/history": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/nodes/[id]/restore": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/nodes/[id]/revert": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/nodes/restore": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/projects": "team-canvas-gate：Vercel governanceStoreEnabled()=false ⇒ 闸走 relay/放行，不直连 DB",
  "/api/canvas/scene-3d": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/scene-3d/link": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/canvas/video-frames": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/character-cards": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/checkin": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/cron/generation-worker": "generationControlPlaneEnabled()=false 直接回 503（控面 worker 另行常驻）",
  "/api/data/self": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/generate-videos": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/generation-gates/stats": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  // MCP 闸门工具（2026-10-03 从 /api/v1 搬来，避免被 beforeFiles 整包代理到控面而 404）：
  // 两条 route 本身是纯函式（契约校验／媒体硬检），不触 generation DB；只经
  // authenticateBizApiKey→biz-api-key-store，该 store 以 bizKeyDatabaseEnabled() 闸 DB，
  // Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底（与 /api/mcp 同源安全）。
  "/api/harness/expert/deliverable/validate": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底（同 /api/mcp）；本体为纯函式契约校验，不触 generation DB",
  "/api/harness/media/quality": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底（同 /api/mcp）；本体为纯函式硬检（ffprobe 不可用时诚实回 probe_unavailable）",
  "/api/history": "以 generationControlPlaneEnabled() 分流，Vercel 走 Blob 历史",
  "/api/history/[id]": "server-history-store 只取 artifact-service 纯函式 validateAndDescribeBase64Image，走 Blob",
  "/api/history/stats": "以 generationControlPlaneEnabled() 分流，Vercel 不触库",
  "/api/internal/biz-keys": "控面侧 HMAC 端点，Vercel 本地无 DB 回 503「控制面数据库未配置」",
  "/api/internal/callback-worker": "真触发是 VPS crontab 打控面自身（x-internal-worker-secret）；Vercel 不排 cron，本地副本不承担流量",
  "/api/internal/first-charge": "控面侧 HMAC 端点，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客户端直打控面 origin",
  "/api/internal/generation-billing": "billing relay HMAC 端点（verifyBillingRelayRequest）；image-billing 只经 newapi relay，不直连 DB",
  "/api/internal/mapay-credit": "控面侧 HMAC 端点，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客户端直打控面 origin",
  "/api/internal/mapay-intake": "控面侧 HMAC 端点，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客户端直打控面 origin（mapay_order_intake 存证）",
  "/api/internal/model-status": "HMAC 端点；model-availability-gate 以 generationControlPlaneEnabled() 闸住回空 verdicts，supplier-health-signal 双模式走 relay",
  "/api/internal/newapi-session-token": "控面侧 HMAC 端点；relay 直打控面 origin，Vercel 本地副本触库失败被 try/catch 收成 {ok:false}",
  "/api/internal/pwa-handoff": "控面侧 HMAC 端点；pwa-handoff 双模式，relay 直打控面 origin",
  "/api/internal/supplier-health": "控面侧 HMAC 端点；supplier-health-signal 双模式，relay 直打控面 origin",
  "/api/internal/user-attribution": "控面侧 HMAC 端点，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客户端直打控面 origin",
  "/api/internal/welcome-gift": "控面侧 HMAC 端点，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客户端直打控面 origin",
  "/api/log/self": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/log/self/search": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/log/self/stat": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/lora-preferences": "lora-user-state 以 generationDatabaseConfigured() 闸，Vercel 走 Blob",
  "/api/mcp": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/media-download": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB；只做上游媒体 fetch 代理，不触库",
  "/api/notifications": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/notifications/active-modal": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/notifications/announcements/[id]": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/notifications/banners": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/notifications/banners/[id]/dismiss": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/notifications/mark-read": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/payments/first-charge/eligibility": "只用 readFirstChargeEligibilityViaRelay／lookupUserIdByTokenViaRelay 打控面",
  "/api/payments/mapay/checkout": "只用 readFirstChargeEligibilityViaRelay／lookupUserIdByTokenViaRelay 打控面",
  "/api/payments/mapay/notify": "只用 creditMapayOrderViaRelay／readFirstChargeEligibilityViaRelay 打控面",
  "/api/payments/mapay/return": "只用 creditMapayOrderViaRelay 打控面",
  "/api/payments/mapay/health": "只读付款对帐探针；需控制面 DB＋支付商凭证，Vercel 本地副本 generationDatabaseConfigured()=false 回 configured=false＋HTTP 503（不假装 healthy）；gatus 探针直打控面 origin 的 /image-control 同路径",
  "/api/pixai/upload": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/project-assets": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/project-assets/shares": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/recipe-templates": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/share": "server-history-store 只取 artifact-service 纯函式 validateAndDescribeBase64Image，走 Blob",
  "/api/skills/mine": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）",
  "/api/skills/mine/[id]": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）",
  "/api/token": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/token/[id]": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/topup": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/usage": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  // 两段式上传（P1-10／对称差 D36，2026-09-29）：本体只走 blob-backend（VPS image-data-api
  // 或 Vercel Blob）与 blob 记录，执行期不查 generation DB。闭包到达 DB 模组的路径与
  // /api/canvas/scene-3d 同源（server-user → image-billing → sub2api 供应商 registry），
  // Vercel 侧不配置该库 ⇒ 留在本地安全。
  "/api/uploads": "上传本体只走 blob-backend（VPS image-data-api／Vercel Blob）；闭包触 DB 模组的路径同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供应商 registry），Vercel 侧不配置 generation DB",
  "/api/uploads/commit": "上传本体只走 blob-backend（VPS image-data-api／Vercel Blob）；闭包触 DB 模组的路径同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供应商 registry），Vercel 侧不配置 generation DB",
  "/api/uploads/sign": "上传本体只走 blob-backend（VPS image-data-api／Vercel Blob）；闭包触 DB 模组的路径同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供应商 registry），Vercel 侧不配置 generation DB",
  "/api/user/aff": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/biz-keys": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/user/biz-keys/[id]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 闸 DB，Vercel 走 Blob 镜像＋BIZ_API_KEY_HASHES 兜底",
  "/api/user/invite": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/models": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/self": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/self/groups": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/topup/info": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/user/topup/self": "闭包只经 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直连 DB",
  "/api/workflow-completion": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/记忆体；server-history-store 只取 artifact-service 纯函式",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const SRC_FILES = walk(SRC_DIR).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));

const DB_BOUND_MODULES = new Set(
  SRC_FILES.filter(
    (f) => !f.endsWith(".test.ts") && readFileSync(f, "utf8").includes("GENERATION_DATABASE_URL"),
  ),
);

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".mjs"];

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC_DIR, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  if (!base.startsWith(SRC_DIR + path.sep)) return null;
  const candidates = [
    base,
    ...RESOLVE_EXTS.map((e) => base + e),
    ...RESOLVE_EXTS.map((e) => path.join(base, "index" + e)),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    if (m[1]) continue; // import type / export type：不进执行期
    const spec = m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    const resolved = resolveSpecifier(file, spec);
    if (resolved) out.push(resolved);
  }
  return out;
}

const importCache = new Map<string, string[]>();
function reachesDbModule(entry: string): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (DB_BOUND_MODULES.has(f)) return true;
    let deps = importCache.get(f);
    if (!deps) {
      deps = importsOf(f);
      importCache.set(f, deps);
    }
    stack.push(...deps);
  }
  return false;
}

function routeUrlPath(file: string): string {
  const rel = path.relative(path.join(SRC_DIR, "app"), path.dirname(file)).split(path.sep);
  const segs = rel.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segs.join("/");
}

// Next 语义：精确相等；`/x/:path*` 只匹配 `/x/<至少一段>`，不匹配裸 `/x`。
function isProxied(urlPath: string): boolean {
  return CONTROL_PLANE_PROXY_SOURCES.some((source: string) => {
    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      return urlPath.startsWith(prefix + "/") && urlPath.length > prefix.length + 1;
    }
    return urlPath === source;
  });
}

test("漂移棘轮：每支 DB 绑定 route 要嘛被控面代理，要嘛在 KNOWN_VERCEL_LOCAL 基线内", () => {
  assert.ok(DB_BOUND_MODULES.size > 0, "找不到任何含 GENERATION_DATABASE_URL 的模组，扫描失效");
  const routes = walk(API_DIR).filter((f) => path.basename(f) === "route.ts");
  assert.ok(routes.length > 0, "src/app/api 下找不到 route.ts，扫描失效");

  const dbBound = routes.filter(reachesDbModule).map(routeUrlPath).sort();
  const unproxied = new Set(dbBound.filter((p) => !isProxied(p)));

  const newViolations = [...unproxied].filter((p) => !(p in KNOWN_VERCEL_LOCAL));
  const staleBaseline = Object.keys(KNOWN_VERCEL_LOCAL).filter((p) => !unproxied.has(p));

  assert.deepEqual(
    newViolations,
    [],
    `以下 DB 绑定 route 未被控面代理、也不在 KNOWN_VERCEL_LOCAL 基线内（在 Vercel 上没有 GENERATION_DATABASE_URL，触库即 500/503）：\n  ${newViolations.join("\n  ")}\n` +
      "修法：把它加进 src/lib/control-plane-proxy-routes.mjs（并确认控面副本有该 route），或在基线写明它在 Vercel 上为何安全。",
  );
  assert.deepEqual(
    staleBaseline,
    [],
    `以下 KNOWN_VERCEL_LOCAL 条目已不再是「DB 绑定且未代理」（已被代理、已删除或不再触库），请从基线删除：\n  ${staleBaseline.join("\n  ")}`,
  );
});
