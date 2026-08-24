#!/usr/bin/env node
// sftp-put-443.js — 透過 SSH-over-443 隧道上傳本地文件到 VPS（SFTP fastPut，帶 md5 校驗）
// 用法: node sftp-put-443.js <localPath> <remotePath>
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const crypto = require('crypto');
const [local, remote] = process.argv.slice(2);
if (!local || !remote) { console.error('usage: node sftp-put-443.js <local> <remote>'); process.exit(2); }
const localMd5 = crypto.createHash('md5').update(fs.readFileSync(local)).digest('hex');
const c = new Client();
c.on('ready', () => {
  c.sftp((err, sftp) => {
    if (err) { console.log('SFTP_ERR', err.message); process.exit(1); }
    sftp.fastPut(local, remote, (err2) => {
      if (err2) { console.log('PUT_ERR', err2.message); process.exit(1); }
      c.exec('md5sum ' + JSON.stringify(remote), (err3, stream) => {
        if (err3) { console.log('VERIFY_ERR', err3.message); process.exit(1); }
        let out = '';
        stream.on('close', () => {
          const remoteMd5 = (out.trim().split(/\s+/)[0] || '');
          console.log(out.trim());
          console.log('local_md5=' + localMd5);
          console.log(remoteMd5 === localMd5 ? 'MATCH' : 'MISMATCH');
          process.exit(remoteMd5 === localMd5 ? 0 : 1);
        }).on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; });
      });
    });
  });
});
c.on('error', (e) => { console.log('SSH_ERR', e.message); process.exit(1); });
c.connect({
  host: '127.0.0.1', port: 22222, username: 'ubuntu',
  privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'),
  readyTimeout: 25000
});
