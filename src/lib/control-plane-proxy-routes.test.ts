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

// ── 行為不變：照改動前 next.config.mjs 手抄（不許從被測模組推導）──────────────
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

test("controlPlaneRewrites：有 origin 時與改動前手寫清單逐條相等", () => {
  assert.deepEqual(controlPlaneRewrites("https://o.example"), EXPECTED_REWRITES);
});

test("controlPlaneRewrites：origin 為空回 []", () => {
  assert.deepEqual(controlPlaneRewrites(""), []);
  assert.deepEqual(controlPlaneRewrites(undefined), []);
});

// ── 漂移棘輪 ─────────────────────────────────────────────────────────────────
// 基線：DB 綁定（import 閉包碰到含 GENERATION_DATABASE_URL 的模組）卻未被代理、
// 目前在 Vercel 本地執行的 route。只准縮不准漲：新 route 要嘛被代理，要嘛寫進來
// 並附具體理由；已不再違規的條目也會紅，逼人刪掉。
const KNOWN_VERCEL_LOCAL: Record<string, string> = {
  "/api/admin/biz-keys": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/admin/biz-keys/[id]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/admin/channels": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/admin/channels/audit": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/admin/channels/rollback": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/admin/control-plane-diagnostics": "以 generationControlPlaneEnabled() 分流，Vercel 側經 GENERATION_CONTROL_PLANE_PROXY_ORIGIN relay 取控面診斷",
  "/api/admin/external-channels": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/admin/model-pricing": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/admin/proxy-pool": "以 generationControlPlaneEnabled() 分流，Vercel 側 relay 到控面 /image-control/api/internal/proxy-pool，未配 relay 回 available:false",
  "/api/admin/slo": "slo-service 辨識 getGenerationSql 未配置訊息（NOT_CONFIGURED），Vercel 回不可用而不拋",
  "/api/admin/templates": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/admin/tier-pricing": "admin-audit 以 generationDatabaseConfigured() 閘 DB，未配置回 null 不寫審計",
  "/api/agent/biz/[...path]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/agent/biz/resolve-owner": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/agent/memory/export": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體",
  "/api/agent/memory/ingest": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體",
  "/api/agent/memory/retract": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體",
  "/api/agent/memory/review": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體",
  "/api/agent/profile": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/記憶體；其餘只經 newapi relay",
  "/api/agent/profile/lessons": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/記憶體；其餘只經 newapi relay",
  "/api/agent/quota": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/記憶體；其餘只經 newapi relay；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）與 dbAvailable 判定的記憶庫",
  "/api/agent/sessions/[id]": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/abort": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/attachments": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/canvas-ops-result": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/canvas-state": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/confirm": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/director/[[...sub]]": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/memory": "agent-profile-store 以 dbAvailable() try/catch 判定，Vercel 走 Blob/記憶體；其餘只經 newapi relay；agent-memory-injection 同 /api/agent/sessions",
  "/api/agent/sessions/[id]/memory-trace": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/messages": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/question": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/sse-ticket": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/steer": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/transcript": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/uploads-ticket": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/workflow-node-rerun": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/sessions/[id]/workflow-node-update": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/agent/settings": "經 agent-session-guard→agent-user-key，DB 以 bizKeyDatabaseEnabled()（=controlPlaneEnabled）閘住，Vercel 走 Blob/記憶體兜底",
  "/api/assets": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/auth/emu-oauth/exchange": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/auth/github/callback": "pwa-handoff 雙模式（Vercel 走 HMAC relay）＋ recordUserAttributionViaRelay，本地不直連 DB",
  "/api/auth/google/callback": "pwa-handoff 雙模式（Vercel 走 HMAC relay）＋ recordUserAttributionViaRelay，本地不直連 DB",
  "/api/auth/handoff": "pwa-handoff 雙模式：Vercel 無 DB 時經 HMAC relay 轉投控面",
  "/api/auth/me": "只用 *ViaRelay（lookupUserIdByToken/welcome-gift/user-attribution）打控面，relay 失敗回 503 transient",
  "/api/auth/wechat/callback": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/auth/wechat/msg": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/auth/wechat/poll": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/auth/wechat/start": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/biz/character-cards": "biz-openai-error 只取 authenticateBizApiKey（Blob 兜底）；其餘只經 newapi relay",
  "/api/biz/character-resolve": "biz-openai-error 只取 authenticateBizApiKey（Blob 兜底）；artifact-service 只取純函式 validateImageBuffer",
  "/api/blender-artifact": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/assets": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/format-crops": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/image-proxy": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/nodes/[id]/history": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/nodes/[id]/restore": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/nodes/[id]/revert": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/nodes/restore": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/projects": "team-canvas-gate：Vercel governanceStoreEnabled()=false ⇒ 閘走 relay/放行，不直連 DB",
  "/api/canvas/scene-3d": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/scene-3d/link": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/canvas/video-frames": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/character-cards": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/checkin": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/cron/generation-worker": "generationControlPlaneEnabled()=false 直接回 503（控面 worker 另行常駐）",
  "/api/data/self": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/generate-videos": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/generation-gates/stats": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  // MCP 閘門工具（2026-10-03 從 /api/v1 搬來，避免被 beforeFiles 整包代理到控面而 404）：
  // 兩條 route 本身是純函式（契約校驗／媒體硬檢），不觸 generation DB；只經
  // authenticateBizApiKey→biz-api-key-store，該 store 以 bizKeyDatabaseEnabled() 閘 DB，
  // Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底（與 /api/mcp 同源安全）。
  "/api/harness/expert/deliverable/validate": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底（同 /api/mcp）；本體為純函式契約校驗，不觸 generation DB",
  "/api/harness/media/quality": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底（同 /api/mcp）；本體為純函式硬檢（ffprobe 不可用時誠實回 probe_unavailable）",
  "/api/history": "以 generationControlPlaneEnabled() 分流，Vercel 走 Blob 歷史",
  "/api/history/[id]": "server-history-store 只取 artifact-service 純函式 validateAndDescribeBase64Image，走 Blob",
  "/api/history/stats": "以 generationControlPlaneEnabled() 分流，Vercel 不觸庫",
  "/api/internal/biz-keys": "控面側 HMAC 端點，Vercel 本地無 DB 回 503「控制面数据库未配置」",
  "/api/internal/callback-worker": "真觸發是 VPS crontab 打控面自身（x-internal-worker-secret）；Vercel 不排 cron，本地副本不承擔流量",
  "/api/internal/first-charge": "控面側 HMAC 端點，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客戶端直打控面 origin",
  "/api/internal/generation-billing": "billing relay HMAC 端點（verifyBillingRelayRequest）；image-billing 只經 newapi relay，不直連 DB",
  "/api/internal/mapay-credit": "控面側 HMAC 端點，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客戶端直打控面 origin",
  "/api/internal/mapay-intake": "控面側 HMAC 端點，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客戶端直打控面 origin（mapay_order_intake 存證）",
  "/api/internal/model-status": "HMAC 端點；model-availability-gate 以 generationControlPlaneEnabled() 閘住回空 verdicts，supplier-health-signal 雙模式走 relay",
  "/api/internal/newapi-session-token": "控面側 HMAC 端點；relay 直打控面 origin，Vercel 本地副本觸庫失敗被 try/catch 收成 {ok:false}",
  "/api/internal/pwa-handoff": "控面側 HMAC 端點；pwa-handoff 雙模式，relay 直打控面 origin",
  "/api/internal/supplier-health": "控面側 HMAC 端點；supplier-health-signal 雙模式，relay 直打控面 origin",
  "/api/internal/user-attribution": "控面側 HMAC 端點，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客戶端直打控面 origin",
  "/api/internal/welcome-gift": "控面側 HMAC 端點，Vercel 本地副本 generationDatabaseConfigured()=false 直接回 503；relay 客戶端直打控面 origin",
  "/api/log/self": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/log/self/search": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/log/self/stat": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/lora-preferences": "lora-user-state 以 generationDatabaseConfigured() 閘，Vercel 走 Blob",
  "/api/mcp": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/media-download": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB；只做上游媒體 fetch 代理，不觸庫",
  "/api/models": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications/active-modal": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications/announcements/[id]": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications/banners": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications/banners/[id]/dismiss": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/notifications/mark-read": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/payments/first-charge/eligibility": "只用 readFirstChargeEligibilityViaRelay／lookupUserIdByTokenViaRelay 打控面",
  "/api/payments/mapay/checkout": "只用 readFirstChargeEligibilityViaRelay／lookupUserIdByTokenViaRelay 打控面",
  "/api/payments/mapay/notify": "只用 creditMapayOrderViaRelay／readFirstChargeEligibilityViaRelay 打控面",
  "/api/payments/mapay/return": "只用 creditMapayOrderViaRelay 打控面",
  "/api/payments/mapay/health": "只讀付款對帳探針；需控制面 DB＋支付商憑證，Vercel 本地副本 generationDatabaseConfigured()=false 回 configured=false＋HTTP 503（不假裝 healthy）；gatus 探針直打控面 origin 的 /image-control 同路徑",
  "/api/pixai/upload": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/pricing": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/project-assets": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/project-assets/shares": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/recipe-templates": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/share": "server-history-store 只取 artifact-service 純函式 validateAndDescribeBase64Image，走 Blob",
  "/api/skills/mine": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）",
  "/api/skills/mine/[id]": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體；agent-memory-injection 只取 authenticateBizApiKey（Blob 兜底）",
  "/api/token": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/token/[id]": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/topup": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/usage": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  // 兩段式上傳（P1-10／對稱差 D36，2026-09-29）：本體只走 blob-backend（VPS image-data-api
  // 或 Vercel Blob）與 blob 記錄，執行期不查 generation DB。閉包到達 DB 模組的路徑與
  // /api/canvas/scene-3d 同源（server-user → image-billing → sub2api 供應商 registry），
  // Vercel 側不配置該庫 ⇒ 留在本地安全。
  "/api/uploads": "上傳本體只走 blob-backend（VPS image-data-api／Vercel Blob）；閉包觸 DB 模組的路徑同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供應商 registry），Vercel 側不配置 generation DB",
  "/api/uploads/commit": "上傳本體只走 blob-backend（VPS image-data-api／Vercel Blob）；閉包觸 DB 模組的路徑同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供應商 registry），Vercel 側不配置 generation DB",
  "/api/uploads/sign": "上傳本體只走 blob-backend（VPS image-data-api／Vercel Blob）；閉包觸 DB 模組的路徑同 /api/canvas/scene-3d（server-user→image-billing→sub2api 供應商 registry），Vercel 側不配置 generation DB",
  "/api/user/aff": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/biz-keys": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/user/biz-keys/[id]": "biz-api-key-store 以 bizKeyDatabaseEnabled() 閘 DB，Vercel 走 Blob 鏡像＋BIZ_API_KEY_HASHES 兜底",
  "/api/user/invite": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/models": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/self": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/self/groups": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/topup/info": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/user/topup/self": "閉包只經 new-api-auth-server 取 ensureNewApiSessionTokenViaRelay（HMAC relay 打控面），本地不直連 DB",
  "/api/version": "只讀 generationControlPlaneEnabled()/generationDatabaseConfigured() 布林值作取證，不觸庫",
  "/api/workflow-completion": "agent-memory-store 以 dbAvailable()（getGenerationSql 包 try/catch）判定，Vercel 走 Blob/記憶體；server-history-store 只取 artifact-service 純函式",
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
    if (m[1]) continue; // import type / export type：不進執行期
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

// Next 語義：精確相等；`/x/:path*` 只匹配 `/x/<至少一段>`，不匹配裸 `/x`。
function isProxied(urlPath: string): boolean {
  return CONTROL_PLANE_PROXY_SOURCES.some((source: string) => {
    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      return urlPath.startsWith(prefix + "/") && urlPath.length > prefix.length + 1;
    }
    return urlPath === source;
  });
}

test("漂移棘輪：每支 DB 綁定 route 要嘛被控面代理，要嘛在 KNOWN_VERCEL_LOCAL 基線內", () => {
  assert.ok(DB_BOUND_MODULES.size > 0, "找不到任何含 GENERATION_DATABASE_URL 的模組，掃描失效");
  const routes = walk(API_DIR).filter((f) => path.basename(f) === "route.ts");
  assert.ok(routes.length > 0, "src/app/api 下找不到 route.ts，掃描失效");

  const dbBound = routes.filter(reachesDbModule).map(routeUrlPath).sort();
  const unproxied = new Set(dbBound.filter((p) => !isProxied(p)));

  const newViolations = [...unproxied].filter((p) => !(p in KNOWN_VERCEL_LOCAL));
  const staleBaseline = Object.keys(KNOWN_VERCEL_LOCAL).filter((p) => !unproxied.has(p));

  assert.deepEqual(
    newViolations,
    [],
    `以下 DB 綁定 route 未被控面代理、也不在 KNOWN_VERCEL_LOCAL 基線內（在 Vercel 上沒有 GENERATION_DATABASE_URL，觸庫即 500/503）：\n  ${newViolations.join("\n  ")}\n` +
      "修法：把它加進 src/lib/control-plane-proxy-routes.mjs（並確認控面副本有該 route），或在基線寫明它在 Vercel 上為何安全。",
  );
  assert.deepEqual(
    staleBaseline,
    [],
    `以下 KNOWN_VERCEL_LOCAL 條目已不再是「DB 綁定且未代理」（已被代理、已刪除或不再觸庫），請從基線刪除：\n  ${staleBaseline.join("\n  ")}`,
  );
});
