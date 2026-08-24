#!/usr/bin/env node
// exec-443.js — SSH-over-443 通道(主用)
// 链路: ssh2 -> 127.0.0.1:22222 (ws-tunnel-node.js) -> wss://store.tinchak0207.xyz/ssh
//        -> nginx /ssh -> gost forward+ws(18083) -> VPS sshd
// 绕过 ISP 对 SSH 端口(22/22443)的封锁与 DPI 限流。443 永通。
// 用法: node exec-443.js "<命令>"    (需先启动 .pixai-refresh/ws-tunnel-node.js)
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const cmd = process.argv[2] || 'hostname';
const c = new Client();
let out = '';
c.on('ready', () => {
  c.exec(cmd, (err, stream) => {
    if (err) { console.log('SSH_ERR', err.message); process.exit(1); }
    stream.on('close', (code) => {
      if (out.trim()) console.log(out.trim().replace(/\n+$/, ''));
      process.exit(code || 0);
    }).on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; });
  });
});
c.on('error', (e) => { console.log('SSH_ERR', e.message); process.exit(1); });
c.connect({
  host: '127.0.0.1', port: 22222, username: 'ubuntu',
  privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
  readyTimeout: 25000
});
