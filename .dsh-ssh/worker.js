// 持久 SSH worker：一条连接跑所有命令，彻底绕开 Max Startups。
// 用法：node worker.js 后台常驻；往 queue/ 写 cmd-<id>.sh，读 queue/out-<id>.txt。
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const path = require('path');

const DIR = __dirname + '/queue';
fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(DIR)) { try { fs.unlinkSync(path.join(DIR, f)); } catch {} }

let active = null;
let busy = false;

function log(m) { console.log('[worker ' + new Date().toISOString() + '] ' + m); }

function connect() {
  const c = new Client();
  c.on('ready', () => {
    active = c;
    fs.writeFileSync(path.join(DIR, 'connected'), String(Date.now()));
    log('connected');
    pump();
  }).on('close', () => {
    if (active === c) active = null;
    try { fs.unlinkSync(path.join(DIR, 'connected')); } catch {}
    log('connection closed; reconnect in 15s');
    setTimeout(connect, 15000);
  }).on('error', (e) => {
    log('error: ' + e.message);
  }).connect({
    host: '43.172.85.76', port: 22443, username: 'ubuntu',
    privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
    readyTimeout: 90000, keepaliveInterval: 15000, keepaliveCountMax: 6,
  });
}

function pump() {
  if (!active || busy) return;
  const files = fs.readdirSync(DIR).filter(f => /^cmd-.*\.sh$/.test(f)).sort();
  if (files.length === 0) { setTimeout(pump, 400); return; }
  const cmdPath = path.join(DIR, files[0]);
  const id = files[0].slice(4, -3);
  const cmd = fs.readFileSync(cmdPath, 'utf8');
  try { fs.unlinkSync(cmdPath); } catch {}
  busy = true;
  let out = '';
  const c = active;
  log('exec ' + id + ' (' + cmd.length + ' bytes)');
  c.exec(cmd, (err, stream) => {
    const finish = () => {
      fs.writeFileSync(path.join(DIR, 'out-' + id + '.txt'), out);
      log('done ' + id);
      busy = false;
      setTimeout(pump, 100);
    };
    if (err) { out = 'EXEC_ERR ' + err.message; finish(); return; }
    stream.on('close', (code) => { out += '\n[exit ' + code + ']'; finish(); })
      .on('data', (d) => { out += d; })
      .stderr.on('data', (d) => { out += d; });
  });
}

connect();
