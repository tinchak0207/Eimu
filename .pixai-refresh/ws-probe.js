const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const OUT = '/home/lenovo/Desktop/image-app/.pixai-refresh/ws-test3.txt';
try { fs.unlinkSync(OUT); } catch {}
const out = (m) => { fs.appendFileSync(OUT, m + '\n'); };
out('script started');

const key = crypto.randomBytes(16).toString('base64');
const options = {
  hostname: 'edgetunnel.20136045.workers.dev',
  port: 443,
  path: '/',
  method: 'GET',
  headers: {
    'Connection': 'Upgrade',
    'Upgrade': 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
  },
};
const req = https.request(options, (res) => {
  out('STATUS ' + res.statusCode);
  out('HEADERS ' + JSON.stringify(res.headers).slice(0, 300));
  res.on('data', () => {});
  res.on('end', () => process.exit(0));
});
req.on('error', (e) => { out('ERR ' + e.message); process.exit(0); });
req.setTimeout(20000, () => { out('TIMEOUT'); req.destroy(); });
req.end();
out('request sent');
setInterval(() => out('tick ' + Date.now()), 5000);
