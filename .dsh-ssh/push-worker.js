const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const fs = require('fs');
const c = new Client();
c.on('ready', () => {
  const files = [
    ['/home/lenovo/Desktop/image-app/src/lib/generation-core/worker-service.ts', '/opt/image-control-plane/app/src/lib/generation-core/worker-service.ts'],
    ['/home/lenovo/Desktop/image-app/worker/generation-worker.ts', '/opt/image-control-plane/app/worker/generation-worker.ts'],
  ];
  let i = 0;
  const next = () => {
    if (i >= files.length) { console.log('UPLOAD_DONE'); c.end(); return; }
    const [local, remote] = files[i++];
    c.sftp((err, sftp) => {
      if (err) { console.error('SFTP_ERR', err.message); process.exit(1); }
      sftp.fastPut(local, remote, (err2) => {
        if (err2) { console.error('PUT_ERR', err2.message); process.exit(1); }
        console.log('uploaded', remote);
        next();
      });
    });
  };
  next();
}).on('error', (e) => { console.error('SSH_ERR', e.message); process.exit(1); })
  .connect({ host: '43.172.85.76', port: 22443, username: 'ubuntu', privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem') });
