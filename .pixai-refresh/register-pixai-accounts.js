#!/usr/bin/env node
// PixAI 批量注册器(域名邮箱版)
// 流程:浏览器铸 recaptcha → sign-in(新邮箱=自动注册)→ genCode 发验证邮件
//       → Node 侧轮询 tinmail API 拿验证码 → 页面内 verifyEmail → 入池
// 用法: node register-pixai-accounts.js [数量] [--batch-size 20]
// 产出: 追加到 ../pixai-pool-new.json + 注册结果 JSON(register-result-*.json)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const POOL_FILE = path.join(DIR, '..', 'pixai-pool-new.json');
const MAILBOX_FILE = '/home/lenovo/Desktop/ai-trial-automation/tinmail/mailbox_1000.txt';
const TINMAIL = {
  base: 'http://43.172.85.76:8025',
  key: (fs.readFileSync(path.join(DIR, 'tinmail-key.txt'), 'utf8') || '').trim(),
};
const RECAPTCHA_KEY = '6Ld_hskiAAAAADfg9HredZvZx8Z_C8FrNJ519Rc6';
const RECAPTCHA_ACTION = 'registerOrLogin';

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
}

function loadPool() {
  try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
  catch { return []; }
}

function savePool(pool) {
  const tmp = POOL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
  fs.renameSync(tmp, POOL_FILE);
}

async function tinmailGetCode(email, sinceTs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const url = `${TINMAIL.base}/api/emails?to=${encodeURIComponent(email)}&since=${Math.floor(sinceTs / 1000)}`;
      const resp = await fetch(url, {
        headers: { 'X-API-Key': TINMAIL.key },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      const emails = Array.isArray(data) ? data : data.emails || [];
      for (const m of emails) {
        if (m.code && /^\d{4,8}$/.test(String(m.code))) return String(m.code);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

// 页面内:对一个邮箱执行 注册+genCode,返回 {token, uid} 或错误
const PAGE_REGISTER = async ({ email, password, KEY, ACTION }) => {
  const out = { email, ok: false, token: '', uid: '', stage: '', err: '' };
  try {
    // 1. recaptcha token(轮询等待 execute 就绪——enterprise 核心库异步加载,经代理更慢)
    let rc = '';
    for (let attempt = 0; attempt < 20 && !rc; attempt++) {
      rc = await new Promise((resolve) => {
        try {
          if (grecaptcha && grecaptcha.enterprise && typeof grecaptcha.enterprise.execute === 'function') {
            grecaptcha.enterprise.execute(KEY, { action: ACTION }).then(resolve).catch((e) => resolve(''));
          } else {
            resolve('');
          }
        } catch (e) {
          resolve('');
        }
      });
      if (!rc) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!rc) { out.err = 'recaptcha execute unavailable'; return out; }
    // 2. sign-in(新邮箱 = 注册)
    const resp = await fetch('https://api.pixai.art/v2/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, recaptchaToken: rc }),
    });
    out.stage = 'sign_in';
    const token = resp.headers.get('token') || '';
    if (!resp.ok || !token) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 150); } catch {}
      out.err = `http ${resp.status} ${detail}`;
      return out;
    }
    out.token = token;
    let uid = '';
    try {
      const body = await resp.json();
      uid = String(body?.user?.id ?? '');
    } catch {}
    out.uid = uid;
    // 3. genCode(发验证邮件)
    const g = await fetch('https://api.pixai.art/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: 'mutation { genCode(input: {intent: VerifyEmail}) }' }),
    });
    out.stage = 'gen_code';
    if (!g.ok) {
      out.err = `genCode http ${g.status}`;
      // 注册本身成功了,genCode 失败也返回 token(后续 verify 失败仍可重试)
      out.ok = true;
      out.genCodeOk = false;
      return out;
    }
    out.ok = true;
    out.genCodeOk = true;
    return out;
  } catch (e) {
    out.err = String(e && e.message || e).slice(0, 150);
    return out;
  }
};

// 页面内:verifyEmail
const PAGE_VERIFY = async ({ token, code }) => {
  try {
    const resp = await fetch('https://api.pixai.art/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: `mutation { verifyEmail(code: "${code}") }` }),
    });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok && body?.data?.verifyEmail === true, status: resp.status, body: JSON.stringify(body).slice(0, 150) };
  } catch (e) {
    return { ok: false, status: 0, body: String(e).slice(0, 100) };
  }
};

async function main() {
  const count = Number(process.argv[2] || 50);
  const { chromium } = require(path.join('/home/lenovo/Desktop/image-app/node_modules', 'playwright-core'));

  // 未注册邮箱 = mailbox 列表 - 池内已有
  const pool = loadPool();
  const existing = new Set(pool.map((a) => a.email));
  const candidates = fs.readFileSync(MAILBOX_FILE, 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((e) => !existing.has(e));
  if (candidates.length < count) {
    log(`only ${candidates.length} unused mailboxes available (requested ${count})`);
  }
  const batch = candidates.slice(0, count);
  log(`registering ${batch.length} accounts (pool has ${pool.length})`);

  const browser = await chromium.launch({
    executablePath: '/opt/google/chrome/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });
  const PROXY = process.env.PROXY || ''; // e.g. socks5://127.0.0.1:14000 (WARP 出口轮换)
  const PROXY_PORTS = (process.env.PROXY_PORTS || '').split(',').map(s => s.trim()).filter(Boolean); // e.g. "24000,24001,24006" 每账号轮换
  const pickProxy = (i) => {
    if (PROXY_PORTS.length) return `http://127.0.0.1:${PROXY_PORTS[i % PROXY_PORTS.length]}`;
    return PROXY;
  };
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ...(PROXY || PROXY_PORTS.length ? { proxy: { server: pickProxy(0) } } : {}),
  });
  log('browser ready');

  const results = [];
  const mkPage = async (idx) => {
    // 每账号新 context:清 cookie + 指纹自然变化(避 429 指纹限速)
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      ...(PROXY || PROXY_PORTS.length ? { proxy: { server: pickProxy(idx) } } : {}),
    });
    const p = await ctx.newPage();
    await p.goto('https://pixai.art/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(1500);
    await p.evaluate((KEY) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.google.com/recaptcha/enterprise.js?render=${KEY}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('recaptcha load failed'));
      document.head.appendChild(s);
    }), RECAPTCHA_KEY);
    await p.waitForTimeout(1000);
    return { ctx, p };
  };
  const runOne = async (i) => {
    const email = batch[i];
    const password = randomPassword();
    const startedTs = Date.now();
    log(`[${i + 1}/${batch.length}] ${email}`);
    let page = null;
    let curCtx = null;
    // sign-in(短退避快速换节点重试;每次重试换新 context + 下一个代理端口)
    let r = null;
    const backoffs = [0, 2_000, 4_000, 8_000, 15_000];
    for (let b = 0; b < backoffs.length; b++) {
      if (backoffs[b]) {
        log(`  retry ${b + 1} after ${backoffs[b] / 1000}s (node may be flaky)`);
        await new Promise((res) => setTimeout(res, backoffs[b]));
      }
      if (curCtx) { try { await curCtx.close(); } catch {} }
      try {
        const made = await mkPage(i + b);
        curCtx = made.ctx;
        page = made.p;
        r = await page.evaluate(PAGE_REGISTER, { email, password, KEY: RECAPTCHA_KEY, ACTION: RECAPTCHA_ACTION });
      } catch (e) {
        r = { ok: false, err: 'ctx:' + String(e && e.message || e).slice(0, 100) };
      }
      if (r.ok) break;
      if (b === backoffs.length - 1) break;
    }
    if (!r.ok) {
      results.push({ email, status: 'sign_in_failed', err: r.err });
      if (curCtx) { try { await curCtx.close(); } catch {} curCtx = null; }
      await new Promise((res) => setTimeout(res, 5000));
      return;
    }
    // 等验证码(tinmail,最多 3 分钟)
    const code = r.genCodeOk ? await tinmailGetCode(email, startedTs, 180_000) : null;
    let verified = false;
    if (code) {
      const v = await page.evaluate(PAGE_VERIFY, { token: r.token, code });
      verified = v.ok;
      if (!verified) log(`  verify failed: ${v.status} ${v.body}`);
    }
    results.push({
      email, password, token: r.token, user_id: r.uid,
      verified, genCodeOk: Boolean(r.genCodeOk), gotCode: Boolean(code),
      status: 'ok',
    });
    // 入池(未验证也入,token 有效;verified 字段记录状态)
    pool.push({
      email,
      password,
      token: r.token,
      user_id: r.uid || '',
      email_verified: verified,
      status: 'active',
      priority: 500,
      pool: 'pixai',
      platform: 'pixai',
      type: 'oauth',
      created_at: new Date().toISOString(),
      last_claim_date: '',
      last_claim_amount: 0,
      token_expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      remark: 'domain-mailbox',
    });
    savePool(pool); // 每个账号立即落盘,中断不丢
    log(`  ok verified=${verified}`);
    if (curCtx) { try { await curCtx.close(); } catch {} curCtx = null; }
    await new Promise((res) => setTimeout(res, 6000 + Math.random() * 6000));
  };

  // 并发调度(单进程内并发;pool/results 内存共享,JS 单线程无竞争)
  const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '1'));
  log(`concurrency=${CONCURRENCY}`);
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < batch.length) {
      const i = cursor++;
      await runOne(i);
    }
  });
  await Promise.all(workers);

  await browser.close();

  // 结果报告
  const okCount = results.filter((r) => r.status === 'ok').length;
  const verifiedCount = results.filter((r) => r.verified).length;
  const reportFile = path.join(DIR, `register-result-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(results, null, 2));
  log(`done: ${okCount}/${batch.length} registered, ${verifiedCount} verified. report: ${reportFile}`);
  console.log(JSON.stringify({ requested: batch.length, ok: okCount, verified: verifiedCount, poolSize: pool.length }));
  if (okCount < batch.length) process.exitCode = 1;
}

main().catch((e) => {
  log('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
