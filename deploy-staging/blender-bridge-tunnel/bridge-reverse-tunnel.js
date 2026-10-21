#!/usr/bin/env node
// bridge-reverse-tunnel.js — VPS 127.0.0.1:<REMOTE_BIND_PORT> 反向转发 → 本机 blender-bridge 127.0.0.1:<LOCAL_TARGET_PORT>
//
// 谁连谁（方向铁律）：本机在 NAT 后，VPS 无法主动连入。本机 ssh2 客户端主动出站 →
//   127.0.0.1:<SSH_PORT>（ws-tunnel-node.js，SSH-over-443）→ nginx store.tinchak0207.xyz/ssh
//   → VPS gost(18083) → VPS sshd:22；SSH ready 后 forwardIn 请求 VPS sshd 绑 127.0.0.1:<REMOTE_BIND_PORT>
//   （GatewayPorts 不需要——只绑 loopback，VPS 本机进程可达即够）；之后 VPS 侧对该端口的每条
//   连线以 'tcp connection' 事件回到本机，本机 pipe 到 <LOCAL_TARGET_PORT>（blender-bridge）。
//
// ═════════ 轮子出处与白名单（禁止造轮子铁律，2026-09-06 片W）═════════
// 基底（交互逻辑逐行保留）：
//   /home/lenovo/Desktop/image-app/.dsh-ssh/reverse-tunnel-443.js
//   —— ssh2 反向隧道轮子，08-21 对同一台 VPS sshd 实弹验证 forwardIn('127.0.0.1') 可绑。
//   保留：ssh2 Client 连线参数（readyTimeout/keepaliveInterval/私钥惯例）、forwardIn、
//         'tcp connection' → accept() + net.connect + 双向 pipe + 四路 cleanup（原 L27-45）。
// 白名单改动（逐条标明）：
//   1) 常数 → env 可覆写（SSH_HOST/SSH_PORT/SSH_USER/KEY_PATH/REMOTE_BIND_PORT/LOCAL_TARGET_PORT）。
//      理由：本地自测须指向本机临时 sshd，禁碰 VPS（片W 铁律）；生产默认值与原轮子同构。
//   2) 重连骨架来自 ~/.local/bin/dsh-groq-tunnel.mjs（isPortListening/ensureWsTunnel/
//      scheduleReconnect：单一定时器防级联 + 指数退避 2s→30s——08-24 OOM 级联事故后的加固形态）。
//   3) 一处交互偏离（原轮子为一次性设计）：reverse-tunnel-443.js 的 exec('sleep 3600') 会话锚
//      与 stream close → process.exit(0) 移除，改为 close/end/error → scheduleReconnect。
//      理由：sleep 3600 锚会让隧道每小时断一次，正在渲染的 job（可达 30 分钟）会被杀；
//      会话存活只靠 keepaliveInterval=15000（dsh-groq 同传输链 08-24 起长期实证）。
//      回退开关：若落位实测会话被 sshd 闲置回收，启动时带 USE_EXEC_ANCHOR=1 恢复原轮子锚。
// ═════════════════════════════════════════════════════════════════════════
const net = require('net');
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const { execFile } = require('child_process');

// —— 白名单改动 1)：常数 env 化（生产默认值 = 原轮子形态，仅端口 18443→8765）——
const SSH_HOST = process.env.SSH_HOST || '127.0.0.1';
const SSH_PORT = parseInt(process.env.SSH_PORT || '22222', 10);
const SSH_USER = process.env.SSH_USER || 'ubuntu';
const KEY_PATH = process.env.KEY_PATH || (process.env.HOME + '/.ssh/new.pem');
const REMOTE_BIND_PORT = parseInt(process.env.REMOTE_BIND_PORT || '8765', 10);   // VPS sshd 绑定端口
const LOCAL_TARGET_PORT = parseInt(process.env.LOCAL_TARGET_PORT || '8765', 10); // 本机 blender-bridge
const WS_TUNNEL_SCRIPT = '/home/lenovo/Desktop/image-app/.pixai-refresh/start-ssh443.sh';
const USE_EXEC_ANCHOR = process.env.USE_EXEC_ANCHOR === '1';
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const READY_TIMEOUT = 25000;

let client = null;          // 当前 ssh2 Client（同一时刻仅一个，dsh-groq 铁律）
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

// 22222 未监听时幂等拉起 ws-tunnel（login 后手动启动会丢，这里自愈）——dsh-groq-tunnel.mjs L61-71 同构
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

// 单一重连定时器: reconnectTimer 非空即 return, 杜绝级联——dsh-groq-tunnel.mjs L73-78 逐行
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
      // 原轮子 exec('sleep 3600') 会话锚按偏离 3) 移除；USE_EXEC_ANCHOR=1 时回退
      if (USE_EXEC_ANCHOR) {
        c.exec('sleep 3600', (err, stream) => {
          if (err) { log('exec anchor err:', err.message); return; }
          stream.on('close', () => fail('anchor-close'));
        });
      }
      c.forwardIn('127.0.0.1', REMOTE_BIND_PORT, (err) => {
        if (err) { fail('forwardIn', err.message); return; }  // 端口被占等 → 退避重试（等价 ExitOnForwardFailure）
        log('reverse forward established: VPS 127.0.0.1:' + REMOTE_BIND_PORT + ' -> laptop 127.0.0.1:' + LOCAL_TARGET_PORT);
      });
    });

    // 'tcp connection' → accept + net.connect + 双向 pipe：reverse-tunnel-443.js L27-45 逐行
    // （原轮子关键坑：accept() 返回 Channel 流，必须手动 pipe，只 accept 不 pipe = 数据黑洞）
    c.on('tcp connection', (info, accept, reject) => {
      log('incoming tunnel connection from VPS (' + info.srcIP + ':' + info.srcPort + ')');
      try {
        const stream = accept(); // ssh2 Channel（双向流）
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

    // 原轮子 close/error → process.exit(0) 按偏离 3) 改为退避重连
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
        keepaliveInterval: 15000,   // 原轮子值；< nginx /ssh proxy_read_timeout 300s
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
