// SSH 隧道:本机 14000 -> VPS 127.0.0.1:40000 (WARP socks5)
// 用法: node warp-tunnel.js  (常驻, ctrl-c 退出)
const { Client } = require('/home/lenovo/.local/lib/node_modules/ssh2');
const net = require('net');
const fs = require('fs');

const REMOTE = { host: '43.172.85.76', port: 22443, username: 'ubuntu', privateKey: fs.readFileSync(process.env.HOME + '/.ssh/new.pem') };
const LOCAL_PORT = 14000;
const TARGET = { host: '127.0.0.1', port: 40000 };

const conn = new Client();
const clients = new Set();

function handleConn(localSocket) {
  conn.forwardOut(TARGET.host, TARGET.port, 'localhost', LOCAL_PORT, (err, remoteStream) => {
    if (err) {
      localSocket.end();
      return;
    }
    clients.add(localSocket); clients.add(remoteStream);
    localSocket.pipe(remoteStream); remoteStream.pipe(localSocket);
    localSocket.on('close', () => { remoteStream.destroy(); clients.delete(localSocket); clients.delete(remoteStream); });
    remoteStream.on('close', () => { localSocket.destroy(); clients.delete(localSocket); clients.delete(remoteStream); });
  });
}

conn.on('ready', () => {
  const server = net.createServer(handleConn);
  server.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`WARP tunnel ready: socks5 at 127.0.0.1:${LOCAL_PORT} -> VPS WARP`));
  conn.on('close', () => { server.close(); console.log('tunnel closed'); process.exit(1); });
}).on('error', (e) => { console.error('SSH ERR', e.message); process.exit(1); })
  .connect(REMOTE);

process.on('SIGINT', () => { conn.end(); process.exit(0); });
