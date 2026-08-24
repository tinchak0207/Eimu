#!/usr/bin/env node
// upload-443.js — 經 SSH-over-443 隧道上傳檔案到 VPS
// 用法: node upload-443.js <本地檔案> <遠端路徑>
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const [local, remote] = process.argv.slice(2);
if (!local || !remote) { console.error('usage: node upload-443.js <local> <remote>'); process.exit(2); }
const c = new Client();
c.on('ready', () => {
  c.sftp((err, sftp) => {
    if (err) { console.log('SFTP_ERR', err.message); process.exit(1); }
    sftp.fastPut(local, remote, (err2) => {
      if (err2) { console.log('PUT_ERR', err2.message); process.exit(1); }
      console.log('UPLOAD_OK', local, '->', remote);
      c.end();
    });
  });
});
c.on('error', (e) => { console.log('SSH_ERR', e.message); process.exit(1); });
c.connect({
  host: '127.0.0.1', port: 22222, username: 'ubuntu',
  privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
  readyTimeout: 25000
});
