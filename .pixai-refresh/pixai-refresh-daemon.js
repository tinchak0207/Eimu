#!/usr/bin/env node
// PixAI 池 24/7 守护进程
// 周期:刷新 token(refresh-pixai-tokens.js 子进程)→ 推送 pool 到 VPS bridge
// 推送失败自动重试;刷新失败则保留旧 pool 不推送(绝不推空池/坏池)
// 配置(环境变量或 .pixai-refresh/daemon-config.json):
//   REFRESH_INTERVAL_HOURS  刷新间隔小时数(默认 72)
//   PIXAI_BRIDGE_KEY        bridge API key(PIXAI_BRIDGE_API_KEY)
//   PIXAI_SYNC_URL          推送端点(默认 https://store.tinchak0207.xyz/pixai/v1/pool-sync)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const POOL_FILE = path.join(DIR, '..', 'pixai-pool-new.json');
const CONFIG_FILE = path.join(DIR, 'daemon-config.json');
const STATE_FILE = path.join(DIR, 'daemon-state.json');
const REFRESH_SCRIPT = path.join(DIR, 'refresh-pixai-tokens.js');

function loadEnv() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {
    intervalHours: Number(cfg.refresh_interval_hours || process.env.REFRESH_INTERVAL_HOURS || 72),
    bridgeKey: cfg.bridge_key || process.env.PIXAI_BRIDGE_KEY || '',
    syncUrl: cfg.sync_url || process.env.PIXAI_SYNC_URL || 'https://store.tinchak0207.xyz/pixai/v1/pool-sync',
  };
}

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function runRefresh() {
  return new Promise((resolve) => {
    log('refresh: starting (headless Chrome)');
    const nodeBin = process.execPath; // 用当前 node 的绝对路径,避免 systemd 环境无 PATH
    const p = spawn(nodeBin, [REFRESH_SCRIPT], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      log(`refresh: exit=${code}`);
      log('refresh tail: ' + out.trim().split('\n').slice(-4).join(' | ').slice(0, 400));
      if (code === 0) {
        try {
          const summary = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
          resolve({ ok: true, summary });
        } catch {
          resolve({ ok: true, summary: null });
        }
      } else {
        resolve({ ok: false, output: out.slice(-500) });
      }
    });
  });
}

async function pushPool(cfg) {
  const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  const active = pool.filter((a) => a.status === 'active' && a.token);
  if (!active.length) throw new Error('refusing to push: pool has no active account with token');

  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await fetch(cfg.syncUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.bridgeKey}`,
        },
        body: JSON.stringify(pool),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.status === 'ok') {
        log(`push: ok accounts=${data.accounts} active=${data.active_with_token}`);
        return data;
      }
      throw new Error(`push http ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      log(`push attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 30_000));
    }
  }
  throw lastErr;
}

async function runCycle(cfg) {
  const state = loadState();
  state.lastCycleStartedAt = new Date().toISOString();
  saveState(state);

  // 1. 刷新(失败则中止本轮,不动 VPS)
  const refreshed = await runRefresh();
  if (!refreshed.ok) {
    log('cycle ABORTED: refresh failed, VPS pool untouched');
    return false;
  }

  // 2. 推送(重试 5 次)
  try {
    await pushPool(cfg);
    const s = loadState();
    s.lastSuccessAt = new Date().toISOString();
    s.lastSummary = refreshed.summary;
    s.consecutiveFailures = 0;
    saveState(s);
    log('cycle COMPLETE');
    return true;
  } catch (e) {
    const s = loadState();
    s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
    s.lastPushError = String(e.message).slice(0, 300);
    saveState(s);
    log('cycle push FAILED: ' + e.message);
    return false;
  }
}

async function main() {
  const cfg = loadEnv();
  if (!cfg.bridgeKey) {
    log('FATAL: PIXAI_BRIDGE_KEY not configured (daemon-config.json bridge_key or env)');
    process.exit(1);
  }
  log(`daemon starting: interval=${cfg.intervalHours}h sync=${cfg.syncUrl}`);

  // 启动时若距上次成功超过间隔,立即跑一轮;否则等到下一个周期
  const state = loadState();
  const elapsedMs = state.lastSuccessAt ? Date.now() - new Date(state.lastSuccessAt).getTime() : Infinity;
  let nextDelay = elapsedMs >= cfg.intervalHours * 3600_000 ? 30_000 : cfg.intervalHours * 3600_000 - elapsedMs;
  nextDelay = Math.max(nextDelay, 30_000);
  log(`next cycle in ${Math.round(nextDelay / 60000)} min`);

  // 主循环:失败后退避(1h),成功后按完整间隔
  for (;;) {
    await new Promise((r) => setTimeout(r, nextDelay));
    const ok = await runCycle(cfg);
    nextDelay = ok ? cfg.intervalHours * 3600_000 : 3600_000;
    log(`next cycle in ${Math.round(nextDelay / 60000)} min`);
  }
}

main().catch((e) => {
  log('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
