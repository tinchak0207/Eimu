const { chromium } = require('playwright-core');
(async () => {
  const extPath = '/home/lenovo/Projects/Default Project/pixai_local/turnstile-ext';
  const ctx = await chromium.launchPersistentContext('/tmp/ts-chrome-profile3', {
    channel: 'chrome',
    headless: false,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-proxy-server',
      '--no-first-run',
      '--remote-debugging-port=9225',
      '--remote-allow-origins=*',
    ],
  });
  console.log('chrome launched, opening pixai.art');
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://pixai.art/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('page loaded:', page.url());
  let got = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r = await fetch('http://127.0.0.1:8780/take');
      const j = await r.json();
      if (j.token) { console.log('TOKEN len:', j.token.length); got = true; break; }
    } catch (e) { console.log('take err', e.message); }
  }
  if (!got) console.log('NO TOKEN in 150s');
  await new Promise(r => setTimeout(r, 300000));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });