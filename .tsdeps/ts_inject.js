const { chromium } = require('playwright-core');
const SITEKEY = '0x4AAAAAAAGM--P3VuJYItj9'; // REG_KEY from content.js
const PUSH_URL = 'http://127.0.0.1:8780/push';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-proxy-server', '--no-first-run'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('[page]', msg.type(), msg.text().slice(0, 120)));
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto('https://pixai.art/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('loaded:', page.url());

  // 注入 turnstile api + 渲染 widget + 捕获 token
  const gotToken = await page.evaluate(async ({ sitekey, pushUrl }) => {
    return await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/api.js?render=explicit&onload=__tsOnLoad';
      window.__tsOnLoad = () => {
        const el = document.createElement('div');
        el.id = 'ts-widget';
        document.body.appendChild(el);
        try {
          window.turnstile.render(el, {
            sitekey,
            action: 'registerOrLogin',
            callback: (token) => {
              console.log('TURNSTILE TOKEN len=' + token.length);
              // push 到本地 8780
              fetch(pushUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, reg: true, ts: Date.now() }),
              }).then(r => r.json()).then(j => {
                console.log('push result:', JSON.stringify(j));
                resolve({ token, pushed: true });
              }).catch(e => resolve({ token, pushErr: String(e) }));
            },
            'error-callback': (code) => { console.log('TS ERROR', code); resolve({ err: code }); },
            'expired-callback': () => console.log('TS EXPIRED'),
          });
        } catch (e) {
          console.log('render ERR', String(e));
          resolve({ renderErr: String(e) });
        }
      };
      document.head.appendChild(s);
      // 15s 超时
      setTimeout(() => resolve({ timeout: true }), 15000);
    });
  }, { sitekey: SITEKEY, pushUrl: PUSH_URL });

  console.log('RESULT:', JSON.stringify(gotToken).slice(0, 300));
  await new Promise(r => setTimeout(r, 3000));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });