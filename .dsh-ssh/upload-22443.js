const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const [local, remote] = process.argv.slice(2);
if (!local || !remote) { console.error('usage: node upload-22443.js <local> <remote>'); process.exit(2); }
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
c.connect({ host: '43.172.85.76', port: 22443, username: 'ubuntu', privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem'), readyTimeout: 25000 });
