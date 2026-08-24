// Push refreshed pixai pool to VPS with retry (flaky WiFi, ~33% TCP success)
// Usage: node push-pool.js
// Success marker: .pixai-refresh/push-result.json
const fs = require('fs');
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');

const LOCAL = '/home/lenovo/Desktop/image-app/pixai-pool-new.json';
const REMOTE = '/opt/pixai-bridge/pixai_pool/pool.json';
const RESULT = '/home/lenovo/Desktop/image-app/.pixai-refresh/push-result.json';
const LOG = '/home/lenovo/Desktop/image-app/.pixai-refresh/push.log';

function log(m) {
  fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n');
}

function attempt() {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      resolve({ ok, msg });
    };
    conn.on('ready', () => {
      log('ssh ready, opening sftp');
      conn.sftp((err, sftp) => {
        if (err) return done(false, 'sftp-err ' + err.message);
        const tmp = REMOTE + '.push.tmp';
        sftp.fastWrite(fs.createReadStream(LOCAL), tmp, (err) => {
          if (err) return done(false, 'write-err ' + err.message);
          conn.exec(
            `wc -c ${tmp} && python3 -c "import json; d=json.load(open('${tmp}')); ok=[a for a in d if a.get('token')]; print('accounts', len(d), 'with_token', len(ok))" && cp ${REMOTE} ${REMOTE}.bak-$(date +%s) && mv ${tmp} ${REMOTE} && echo POOL_REPLACED`,
            (err, stream) => {
              if (err) return done(false, 'exec-err ' + err.message);
              let out = '';
              stream.on('close', (code) => {
                log('exec out: ' + out.trim().slice(0, 300));
                if (out.includes('POOL_REPLACED')) done(true, out.trim());
                else done(false, 'exec-exit-' + code + ' ' + out.trim().slice(0, 200));
              }).on('data', (d) => { out += d; });
              stream.stderr.on('data', (d) => { out += d; });
            });
        });
      });
    }).on('error', (e) => done(false, e.message))
      .connect({
        host: '43.172.85.76', port: 22, username: 'ubuntu',
        privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
        localAddress: '192.168.1.106',
        readyTimeout: 45000,
        keepaliveInterval: 10000,
      });
    setTimeout(() => done(false, 'overall-timeout'), 90000);
  });
}

(async () => {
  log('=== push-pool started, local size ' + fs.statSync(LOCAL).size + ' ===');
  for (let i = 1; i <= 30; i++) {
    const r = await attempt();
    log('attempt ' + i + ': ' + (r.ok ? 'OK' : 'FAIL') + ' ' + r.msg.slice(0, 200));
    if (r.ok) {
      fs.writeFileSync(RESULT, JSON.stringify({ ok: true, attempts: i, detail: r.msg, at: new Date().toISOString() }, null, 2));
      console.log('PUSH_OK after ' + i + ' attempts');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  fs.writeFileSync(RESULT, JSON.stringify({ ok: false, at: new Date().toISOString() }, null, 2));
  console.log('PUSH_FAILED after 30 attempts');
  process.exit(1);
})();
