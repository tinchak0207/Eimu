const { chromium } = require('playwright-core');
const SITEKEY = '0x4AAAAAAAGM--P3VuJYItj9';
const PUSH_URL = 'http://127.0.0.1:8780/push';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--no-proxy-server', '--no-first-run', '--window-size=1280,900'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('[page]', msg.type(), msg.text().slice(0, 160)));
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 90), r.failure()?.errorText));

  await page.goto('https://pixai.art/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('loaded:', page.url());

  const result = await page.evaluate(async ({ sitekey, pushUrl }) => {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (obj) => { if (!settled) { settled = true; resolve(obj); } };
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsOnLoad';
      s.onerror = () => { console.log('api.js LOAD ERROR'); done({ apiLoadError: true }); };
      window.__tsOnLoad = () => {
        console.log('turnstile api ONLOAD, typeof turnstile =', typeof window.turnstile);
        const el = document.createElement('div');
        el.id = 'ts-widget';
        el.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;width:300px;height:65px;';
        document.body.appendChild(el);
        try {
          window.turnstile.render(el, {
            sitekey,
            action: 'registerOrLogin',
            callback: (token) => {
              console.log('TURNSTILE TOKEN len=' + token.length + ' first20=' + token.slice(0, 20));
              fetch(pushUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, reg: true, ts: Date.now() }),
              }).then(r => r.json()).then(j => {
                console.log('push result:', JSON.stringify(j));
                done({ token, pushed: true, pushResult: j });
              }).catch(e => done({ token, pushErr: String(e) }));
            },
            'error-callback': (code) => { console.log('TS ERROR', code); done({ err: code }); },
            'expired-callback': () => console.log('TS EXPIRED'),
          });
          console.log('turnstile.render called');
        } catch (e) {
          console.log('render ERR', String(e));
          done({ renderErr: String(e) });
        }
      };
      document.head.appendChild(s);
      setTimeout(() => { if (!settled) { console.log('timeout 40s, typeof turnstile =', typeof window.turnstile); done({ timeout: true }); } }, 40000);
    });
  }, { sitekey: SITEKEY, pushUrl: PUSH_URL });

  console.log('RESULT:', JSON.stringify(result).slice(0, 300));
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });