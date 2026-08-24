#!/usr/bin/env node
// reverse-tunnel-443.js — 本機主動出站，經 443 ws 隧道把 VPS:18443 反向轉發到本機 gost:18443
// 鏈路: VPS sshd (RemoteForward 18443) ← ssh2 ← 127.0.0.1:22222 (ws-tunnel) ← 本機
// 關鍵: ssh2 'tcp connection' 的 accept() 返回 Channel 流，必須手動 pipe 到本地 socket
// 用法: node reverse-tunnel-443.js
const net = require('net');
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');

const LOCAL_TARGET = { host: '127.0.0.1', port: 18443 };

const c = new Client();
let lastLog = '';
function log(s) { if (s !== lastLog) { console.log(new Date().toISOString().slice(11, 19), s); lastLog = s; } }

c.on('ready', () => {
  log('ssh ready, requesting remote forward 18443 -> local gost:18443');
  c.exec('sleep 3600', (err, stream) => {
    if (err) { console.log('exec err', err.message); process.exit(1); }
    stream.on('close', () => { console.log('stream closed, exiting'); process.exit(0); });
  });
  c.forwardIn('127.0.0.1', 18443, (err) => {
    if (err) { console.log('forwardIn err:', err.message); process.exit(1); }
    log('remote forward established: VPS 127.0.0.1:18443 -> local gost');
  });
});
c.on('tcp connection', (info, accept, reject) => {
  log(`incoming tunnel connection from VPS (${info.srcIP}:${info.srcPort})`);
  try {
    const stream = accept(); // ssh2 Channel（雙向流）
    const sock = net.connect(LOCAL_TARGET.port, LOCAL_TARGET.host, () => {
      log(`piped to local gost ${LOCAL_TARGET.host}:${LOCAL_TARGET.port}`);
    });
    stream.pipe(sock);
    sock.pipe(stream);
    const cleanup = () => { try { stream.end(); sock.end(); } catch {} };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  } catch (e) {
    log(`accept error: ${e.message}`);
    try { reject(); } catch {}
  }
});
c.on('error', (e) => { console.log('SSH_ERR', e.message); process.exit(1); });
c.on('close', () => { console.log('ssh closed'); process.exit(0); });

c.connect({
  host: '127.0.0.1', port: 22222, username: 'ubuntu',
  privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
  readyTimeout: 25000,
  keepaliveInterval: 15000,
});
