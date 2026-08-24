#!/usr/bin/env python3
"""ws-tunnel.py: 127.0.0.1:22222 <-> wss://store.tinchak0207.xyz/ssh
SSH over HTTPS(443) 隧道 — 把 SSH 流量伪装成 WebSocket,绕开 ISP 对 SSH 端口的封锁。
用法: python3 ws-tunnel.py [listen_port] [wss_url]
"""
import socket, ssl, threading, hashlib, base64, os, struct, sys, time

LISTEN = int(sys.argv[1]) if len(sys.argv) > 1 else 22222
WSS_URL = sys.argv[2] if len(sys.argv) > 2 else "wss://store.tinchak0207.xyz/ssh"

def parse_url(u):
    rest = u.split("://", 1)[1]
    hostport, _, path = rest.partition("/")
    path = "/" + path
    if ":" in hostport:
        host, port = hostport.rsplit(":", 1)
        port = int(port)
    else:
        host, port = hostport, 443
    return host, port, path

def ws_connect(host, port, path):
    """完成 TLS + WS 升级握手,返回 (socket, recv_buf)"""
    ctx = ssl.create_default_context()
    s = ctx.wrap_socket(socket.create_connection((host, port), timeout=15),
                        server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise ConnectionError("closed during handshake")
        buf += chunk
    head, _, _ = buf.partition(b"\r\n\r\n")
    if b"101" not in head.split(b"\r\n", 1)[0]:
        raise ConnectionError("handshake failed: " + head.decode(errors="replace"))
    return s, buf.split(b"\r\n\r\n", 1)[1]

def ws_send(s, payload):
    """客户端->服务端帧: 必须 masked"""
    mask = os.urandom(4)
    n = len(payload)
    hdr = bytearray([0x82])
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126)
        hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127)
        hdr += struct.pack(">Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(bytes(hdr) + mask + masked)

def ws_recv(s, buf):
    """从 buf 中解析服务端帧(未 masked),返回 payload 或 None(需更多数据)"""
    while True:
        if len(buf) < 2:
            return None
        opcode = buf[0] & 0x0F
        ln = buf[1] & 0x7F
        off = 2
        if ln == 126:
            if len(buf) < 4:
                return None
            ln = struct.unpack(">H", buf[2:4])[0]
            off = 4
        elif ln == 127:
            if len(buf) < 10:
                return None
            ln = struct.unpack(">Q", buf[2:10])[0]
            off = 10
        if opcode == 0x8:  # close
            return b""
        if opcode == 0x9:  # ping -> pong
            mask = os.urandom(4)
            n = len(buf[off:off + ln])
            s.sendall(bytes([0x8A, 0x80 | n]) + mask + buf[off:off + ln])
            buf = buf[off + ln:]
            continue
        if len(buf) < off + ln:
            return None
        payload = buf[off:off + ln]
        buf = buf[off + ln:]
        if opcode == 0x1 or opcode == 0x2:  # text/binary
            return payload
        # continuation / fragmented: 简化,只处理单帧

def handle(client):
    try:
        host, port, path = parse_url(WSS_URL)
        ws, buf = ws_connect(host, port, path)
    except Exception as e:
        print(f"[tunnel] ws connect failed: {e}", flush=True)
        client.close()
        return
    print(f"[tunnel] ws up: {host}:{port}{path}", flush=True)
    stop = threading.Event()

    def to_ws():
        try:
            while not stop.is_set():
                d = client.recv(16384)
                if not d:
                    break
                ws_send(ws, d)
        except Exception:
            pass
        finally:
            stop.set()
            try:
                ws.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    threading.Thread(target=to_ws, daemon=True).start()
    try:
        while not stop.is_set():
            try:
                d = ws.recv(65536)
            except Exception:
                break
            if not d:
                break
            buf += d
            while True:
                payload = ws_recv(ws, buf)
                if payload is None:
                    break
                if payload == b"":
                    stop.set()
                    break
                try:
                    client.sendall(payload)
                except Exception:
                    stop.set()
                    break
                buf = b""
    except Exception:
        pass
    stop.set()
    client.close()
    try:
        ws.close()
    except Exception:
        pass
    print("[tunnel] closed", flush=True)

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", LISTEN))
    srv.listen(16)
    print(f"[tunnel] listening 127.0.0.1:{LISTEN} -> {WSS_URL}", flush=True)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()

if __name__ == "__main__":
    main()
