const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const cmd = process.argv[2];
const c = new Client();
c.on('ready', () => {
  c.exec(cmd, (err, stream) => {
    if (err) { console.error('EXEC_ERR', err.message); c.end(); process.exit(1); }
    let out = '';
    stream.on('close', (code) => { console.log(out); console.log('EXIT', code); c.end(); })
      .on('data', (d) => { out += d; })
      .stderr.on('data', (d) => { out += d; });
  });
}).on('error', (e) => { console.error('SSH_ERR', e.message); process.exit(1); })
  .connect({ host: '43.172.85.76', port: 22443, username: 'ubuntu', privateKey: require('fs').readFileSync(process.env.HOME + '/.ssh/new.pem') });
