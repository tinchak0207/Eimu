// ws-tunnel-node.js: 127.0.0.1:22222 <-> wss://store.tinchak0207.xyz/ssh
// SSH over HTTPS(443) 隧道 — SSH 流量伪装成 WebSocket,绕开 ISP 对 SSH 端口的封锁
const net = require('net');
const WebSocket = require('/home/lenovo/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/ws');

const LISTEN = parseInt(process.argv[2] || '22222');
const WSS_URL = process.argv[3] || 'wss://store.tinchak0207.xyz/ssh';

const srv = net.createServer((client) => {
  const ws = new WebSocket(WSS_URL, { perMessageDeflate: false, handshakeTimeout: 15000 });
  let wsOpen = false;
  let wsDead = false;
  let clientBuf = [];   // client -> ws 缓冲(ws 未 open 时)
  let pending = [];     // ws -> client 缓冲(client 未 ready 时)

  const sendClient = (data) => {
    if (client.writable) {
      client.write(data);
    } else {
      pending.push(data);
    }
  };

  ws.on('open', () => {
    wsOpen = true;
    console.log(`[tunnel] ws up: ${WSS_URL}`, new Date().toISOString());
    if (clientBuf.length) {
      for (const b of clientBuf) ws.send(b);
      clientBuf = [];
    }
  });
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (client.writable && !client.destroyed) {
      client.write(buf);
    } else {
      pending.push(buf);
    }
  });
  ws.on('close', () => { wsDead = true; client.destroy(); });
  ws.on('error', (e) => { console.log('[tunnel] ws err:', e.message); wsDead = true; client.destroy(); });

  client.on('data', (d) => {
    if (wsOpen && ws.readyState === WebSocket.OPEN) {
      ws.send(d);
    } else if (!wsDead) {
      clientBuf.push(d);
    }
  });
  client.on('error', () => { try { ws.close(); } catch (e) {} });
  client.on('close', () => { try { ws.close(); } catch (e) {} });
});

srv.on('connection', (c) => {
  c.setNoDelay(true);
  c.on('drain', () => {
    // flush pending when writable
    if (pending.length) {
      const chunk = Buffer.concat(pending);
      pending = [];
      c.write(chunk);
    }
  });
});

srv.listen(LISTEN, '127.0.0.1', () => {
  console.log(`[tunnel] listening 127.0.0.1:${LISTEN} -> ${WSS_URL}`);
});
