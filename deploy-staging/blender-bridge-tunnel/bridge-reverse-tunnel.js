#!/usr/bin/env node
// bridge-reverse-tunnel.js — VPS 127.0.0.1:<REMOTE_BIND_PORT> 反向轉發 → 本機 blender-bridge 127.0.0.1:<LOCAL_TARGET_PORT>
//
// 誰連誰（方向鐵律）：本機在 NAT 後，VPS 無法主動連入。本機 ssh2 客戶端主動出站 →
//   127.0.0.1:<SSH_PORT>（ws-tunnel-node.js，SSH-over-443）→ nginx store.tinchak0207.xyz/ssh
//   → VPS gost(18083) → VPS sshd:22；SSH ready 後 forwardIn 請求 VPS sshd 綁 127.0.0.1:<REMOTE_BIND_PORT>
//   （GatewayPorts 不需要——只綁 loopback，VPS 本機進程可達即夠）；之後 VPS 側對該端口的每條
//   連線以 'tcp connection' 事件回到本機，本機 pipe 到 <LOCAL_TARGET_PORT>（blender-bridge）。
//
// ═════════ 輪子出處與白名單（禁止造輪子鐵律，2026-09-06 片W）═════════
// 基底（交互邏輯逐行保留）：
//   /home/lenovo/Desktop/image-app/.dsh-ssh/reverse-tunnel-443.js
//   —— ssh2 反向隧道輪子，08-21 對同一台 VPS sshd 實彈驗證 forwardIn('127.0.0.1') 可綁。
//   保留：ssh2 Client 連線參數（readyTimeout/keepaliveInterval/私鑰慣例）、forwardIn、
//         'tcp connection' → accept() + net.connect + 雙向 pipe + 四路 cleanup（原 L27-45）。
// 白名單改動（逐條標明）：
//   1) 常數 → env 可覆寫（SSH_HOST/SSH_PORT/SSH_USER/KEY_PATH/REMOTE_BIND_PORT/LOCAL_TARGET_PORT）。
//      理由：本地自測須指向本機臨時 sshd，禁碰 VPS（片W 鐵律）；生產默認值與原輪子同構。
//   2) 重連骨架來自 ~/.local/bin/dsh-groq-tunnel.mjs（isPortListening/ensureWsTunnel/
//      scheduleReconnect：單一定時器防級聯 + 指數退避 2s→30s——08-24 OOM 級聯事故後的加固形態）。
//   3) 一處交互偏離（原輪子為一次性設計）：reverse-tunnel-443.js 的 exec('sleep 3600') 會話錨
//      與 stream close → process.exit(0) 移除，改為 close/end/error → scheduleReconnect。
//      理由：sleep 3600 錨會讓隧道每小時斷一次，正在渲染的 job（可達 30 分鐘）會被殺；
//      會話存活只靠 keepaliveInterval=15000（dsh-groq 同傳輸鏈 08-24 起長期實證）。
//      回退開關：若落位實測會話被 sshd 閒置回收，啟動時帶 USE_EXEC_ANCHOR=1 恢復原輪子錨。
// ═════════════════════════════════════════════════════════════════════════
const net = require('net');
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const { execFile } = require('child_process');

// —— 白名單改動 1)：常數 env 化（生產默認值 = 原輪子形態，僅端口 18443→8765）——
const SSH_HOST = process.env.SSH_HOST || '127.0.0.1';
const SSH_PORT = parseInt(process.env.SSH_PORT || '22222', 10);
const SSH_USER = process.env.SSH_USER || 'ubuntu';
const KEY_PATH = process.env.KEY_PATH || (process.env.HOME + '/.ssh/new.pem');
const REMOTE_BIND_PORT = parseInt(process.env.REMOTE_BIND_PORT || '8765', 10);   // VPS sshd 綁定端口
const LOCAL_TARGET_PORT = parseInt(process.env.LOCAL_TARGET_PORT || '8765', 10); // 本機 blender-bridge
const WS_TUNNEL_SCRIPT = '/home/lenovo/Desktop/image-app/.pixai-refresh/start-ssh443.sh';
const USE_EXEC_ANCHOR = process.env.USE_EXEC_ANCHOR === '1';
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const READY_TIMEOUT = 25000;

let client = null;          // 當前 ssh2 Client（同一時刻僅一個，dsh-groq 鐵律）
let retryMs = BASE_RETRY_MS;
let reconnectTimer = null;
let connecting = false;
let shuttingDown = false;

function log(...args) { console.log('[' + new Date().toISOString() + ']', ...args); }

function destroyClient() {
  if (client) {
    try { client.removeAllListeners(); client.end(); } catch (e) { /* ignore */ }
    client = null;
  }
}

function isPortListening(port, cb) {   // dsh-groq-tunnel.mjs L53-58 逐行
  const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
  s.once('connect', () => { s.destroy(); cb(true); });
  s.once('error', () => { s.destroy(); cb(false); });
  s.once('timeout', () => { s.destroy(); cb(false); });
}

// 22222 未監聽時冪等拉起 ws-tunnel（login 後手動啟動會丟，這裡自愈）——dsh-groq-tunnel.mjs L61-71 同構
function ensureWsTunnel(cb) {
  isPortListening(SSH_PORT, (ok) => {
    if (ok) return cb(true);
    log('port ' + SSH_PORT + ' not listening, starting ws-tunnel via start-ssh443.sh');
    execFile('bash', [WS_TUNNEL_SCRIPT, String(SSH_PORT)], { timeout: 15000 }, (err, stdout, stderr) => {
      if (stdout && String(stdout).trim()) log('start-ssh443:', String(stdout).trim());
      if (stderr && String(stderr).trim()) log('start-ssh443 stderr:', String(stderr).trim());
      setTimeout(() => isPortListening(SSH_PORT, cb), 1000);
    });
  });
}

// 單一重連定時器: reconnectTimer 非空即 return, 杜絕級聯——dsh-groq-tunnel.mjs L73-78 逐行
function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

function connect() {
  if (connecting || shuttingDown) return;
  connecting = true;
  destroyClient();

  ensureWsTunnel((up) => {
    if (!up) {
      connecting = false;
      log('ws-tunnel unavailable on port ' + SSH_PORT + ', retry in ' + retryMs + 'ms');
      scheduleReconnect();
      return;
    }
    log('SSH connect ' + SSH_USER + '@' + SSH_HOST + ':' + SSH_PORT + ' ...');
    const c = new Client();
    client = c;

    const fail = (why, errMsg) => {
      if (client === c) client = null;
      connecting = false;
      if (errMsg) log('ssh error:', errMsg);
      log('disconnected (' + why + '), retry in ' + retryMs + 'ms');
      scheduleReconnect();
    };

    c.on('ready', () => {
      retryMs = BASE_RETRY_MS;
      log('SSH ready, requesting remote forward: VPS 127.0.0.1:' + REMOTE_BIND_PORT + ' -> laptop 127.0.0.1:' + LOCAL_TARGET_PORT);
      connecting = false;
      // 原輪子 exec('sleep 3600') 會話錨按偏離 3) 移除；USE_EXEC_ANCHOR=1 時回退
      if (USE_EXEC_ANCHOR) {
        c.exec('sleep 3600', (err, stream) => {
          if (err) { log('exec anchor err:', err.message); return; }
          stream.on('close', () => fail('anchor-close'));
        });
      }
      c.forwardIn('127.0.0.1', REMOTE_BIND_PORT, (err) => {
        if (err) { fail('forwardIn', err.message); return; }  // 端口被佔等 → 退避重試（等價 ExitOnForwardFailure）
        log('reverse forward established: VPS 127.0.0.1:' + REMOTE_BIND_PORT + ' -> laptop 127.0.0.1:' + LOCAL_TARGET_PORT);
      });
    });

    // 'tcp connection' → accept + net.connect + 雙向 pipe：reverse-tunnel-443.js L27-45 逐行
    // （原輪子關鍵坑：accept() 返回 Channel 流，必須手動 pipe，只 accept 不 pipe = 數據黑洞）
    c.on('tcp connection', (info, accept, reject) => {
      log('incoming tunnel connection from VPS (' + info.srcIP + ':' + info.srcPort + ')');
      try {
        const stream = accept(); // ssh2 Channel（雙向流）
        const sock = net.connect(LOCAL_TARGET_PORT, '127.0.0.1', () => {
          log('piped to local bridge 127.0.0.1:' + LOCAL_TARGET_PORT);
        });
        stream.pipe(sock);
        sock.pipe(stream);
        const cleanup = () => { try { stream.end(); sock.end(); } catch (e) {} };
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        sock.on('close', cleanup);
        sock.on('error', cleanup);
      } catch (e) {
        log('accept error: ' + e.message);
        try { reject(); } catch (e2) {}
      }
    });

    // 原輪子 close/error → process.exit(0) 按偏離 3) 改為退避重連
    c.on('close', () => fail('close'));
    c.on('end', () => fail('end'));
    c.on('error', (e) => fail('error', e.message));

    try {
      c.connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        privateKey: fs.readFileSync(KEY_PATH),
        readyTimeout: READY_TIMEOUT,
        keepaliveInterval: 15000,   // 原輪子值；< nginx /ssh proxy_read_timeout 300s
        keepaliveCountMax: 3,
      });
    } catch (e) {
      fail('connect-throw', e.message);
    }
  });
}

function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  destroyClient();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

connect();
log('bridge-reverse-tunnel: VPS 127.0.0.1:' + REMOTE_BIND_PORT + ' -> laptop 127.0.0.1:' + LOCAL_TARGET_PORT +
    ' via ' + SSH_USER + '@' + SSH_HOST + ':' + SSH_PORT);
