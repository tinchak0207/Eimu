#!/usr/bin/env node
// PixAI 长效账号池 token 刷新器(24/7 持久化组件)
// 流程(2026-08-20 验证):Chrome 打开 pixai.art → 注入 reCAPTCHA Enterprise →
// 页面内 execute 铸 token → 页面内 fetch sign-in → 读响应头 token → 写回 pool 文件
// 用法: node refresh-pixai-tokens.js [--headful]
// 退出码: 0=全部成功; 1=有失败(看 stderr 摘要)

const fs = require('fs');
const path = require('path');

const WORKDIR = __dirname;
const POOL_FILE = path.join(WORKDIR, '..', 'pixai-pool-new.json');
const PROFILE_DIR = path.join(WORKDIR, 'chrome-profile');
const RECAPTCHA_KEY = '6Ld_hskiAAAAADfg9HredZvZx8Z_C8FrNJ519Rc6';
const RECAPTCHA_ACTION = 'registerOrLogin';
const HEADFUL = process.argv.includes('--headful');

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function readPool() {
  return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
}

function writePool(pool) {
  const tmp = POOL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
  fs.renameSync(tmp, POOL_FILE);
}

// 页面内运行的刷新循环(与 2026-08-20 手工验证的流程一致)
// accounts: [{email, password}]; 返回 [{e, ok, t, uid, ev, st, err}]
const PAGE_LOOP = async ({ accounts, KEY, ACTION }) => {
  // 注入 reCAPTCHA Enterprise
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/enterprise.js?render=${KEY}`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('recaptcha script load failed'));
    document.head.appendChild(s);
  });
  await new Promise((r) => setTimeout(r, 1500));

  const results = [];
  for (const acc of accounts) {
    const item = { e: acc.email, ok: false, t: '', uid: '', ev: false, st: 0, err: '' };
    try {
      const token = await grecaptcha.enterprise.execute(KEY, { action: ACTION });
      const resp = await fetch('https://api.pixai.art/v2/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: acc.email,
          password: acc.password,
          recaptchaToken: token,
        }),
      });
      item.st = resp.status;
      item.t = resp.headers.get('token') || '';
      if (resp.ok && item.t) {
        let uid = '';
        let ev = false;
        try {
          const body = await resp.json();
          uid = String(body?.user?.id ?? body?.id ?? '');
          ev = Boolean(body?.user?.email_verified ?? body?.email_verified ?? true);
        } catch {}
        item.uid = uid;
        item.ev = ev;
        item.ok = true;
      } else {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 120); } catch {}
        item.err = `status=${resp.status} ${detail}`;
      }
    } catch (e) {
      item.err = String(e && e.message || e).slice(0, 120);
    }
    results.push(item);
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 350));
  }
  return results;
};

async function main() {
  const { chromium } = require(path.join(
    '/home/lenovo/Desktop/image-app/node_modules', 'playwright-core'));
  const pool = readPool();
  const accounts = pool.filter((a) => a.status === 'active');
  log(`pool: ${pool.length} accounts, ${accounts.length} active`);

  const browser = await chromium.launch({
    executablePath: '/opt/google/chrome/chrome',
    headless: !HEADFUL,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto('https://pixai.art/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  log('page loaded, starting refresh loop');

  let results = await page.evaluate(PAGE_LOOP, { accounts, KEY: RECAPTCHA_KEY, ACTION: RECAPTCHA_ACTION });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    log(`first pass: ${results.length - failed.length}/${results.length} ok, retrying ${failed.length} failed`);
    const retryAccounts = failed.map((r) => accounts.find((a) => a.email === r.e)).filter(Boolean);
    await page.waitForTimeout(5000);
    const retried = await page.evaluate(PAGE_LOOP, { accounts: retryAccounts, KEY: RECAPTCHA_KEY, ACTION: RECAPTCHA_ACTION });
    const byEmail = new Map(results.map((r) => [r.e, r]));
    for (const r of retried) byEmail.set(r.e, r);
    results = [...byEmail.values()];
  }

  // 写回
  let applied = 0;
  const expires = new Date(Date.now() + 7 * 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  for (const r of results) {
    const acc = pool.find((a) => a.email === r.e);
    if (!acc) continue;
    if (r.ok) {
      acc.token = r.t;
      if (r.uid) acc.user_id = r.uid;
      acc.email_verified = Boolean(r.ev);
      acc.token_expires_at = expires;
      acc.status = 'active';
      applied++;
    }
  }
  writePool(pool);

  const okCount = results.filter((r) => r.ok).length;
  const failedList = results.filter((r) => !r.ok).map((r) => `${r.e}(${r.err})`);
  log(`done: ${okCount}/${results.length} refreshed, pool file updated (expires ${expires})`);
  await browser.close();

  if (failedList.length) {
    console.error('FAILED:');
    failedList.forEach((f) => console.error('  ' + f));
    process.exitCode = 1;
  }
  // stdout 输出机器可读摘要
  console.log(JSON.stringify({ total: results.length, ok: okCount, applied, expires }));
}

main().catch((e) => {
  log('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
