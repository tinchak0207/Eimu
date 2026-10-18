#!/usr/bin/env python3
"""Headless Blender launcher for the Image Studio blender-bridge.

Spawns and supervises one Blender process running the verbatim blender-mcp
addon (bridge/blender-bridge/blender_addon.py, source: ahujasid/blender-mcp)
in background mode:

    [unshare -rn] blender --background --factory-startup --disable-autoexec --python-expr <bootstrap>

Design notes (field-verified facts baked in):
- `unshare -rn true` works on this host (rootless user namespaces enabled).
  In isolated mode Blender has no external network. TCP loopback cannot cross
  a netns boundary, so a unix domain socket forwarder
  ($BLENDER_WORK/bridge.sock) bridges the host to the addon's TCP server on
  127.0.0.1:9876 inside the netns (unix sockets live in the shared mount
  namespace, not the netns). Loopback inside a fresh netns is DOWN; the
  bootstrap raises it with SIOCSIFFLAGS (works as mapped root under
  `unshare -rn`).
- bpy.app.timers never fire in background mode (field-verified on Blender
  5.2.1: 0 fires across a 3s main-thread sleep), so the bootstrap keeps
  Blender's main thread in a pump loop calling
  BlenderMCPServer._drain_command_queue() directly — same thread, same queue,
  same semantics the stock timer would provide.
- Environment injected into the Blender process:
    BLENDER_WORK          job working directory (scripts CWD, out/ root)
    BLENDER_ADDON_PATH    absolute path of blender_addon.py
    BLENDER_BRIDGE_SOCK   unix forwarder path (isolated mode only)

Blender stdout+stderr go to $BLENDER_WORK/blender.log (append); the addon's
whitelisted get_stdout_tail command reads its tail. blender.log is rotated to
blender.log.1 (one generation kept) at every blender (re)launch so old crash
tracebacks cannot crowd script prints out of the stdout_tail window. Python
level stdout inside Blender (bootstrap markers, pump errors, script prints
that escape exec's StringIO capture) is redirected to $BLENDER_WORK/job-output.log
so it stays separate from the engine's C-level log.

Standalone use:
    python3 launcher.py    # start blender, print handshake, supervise
"""
import glob
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
ADDON_PATH = os.path.join(BRIDGE_DIR, "blender_addon.py")
DEFAULT_WORKDIR = os.path.join(
    os.path.dirname(os.path.dirname(BRIDGE_DIR)), ".blender-work")
ADDON_PORT = 9876


def default_blender_bin():
    env_bin = os.getenv("BLENDER_BIN")
    if env_bin and os.path.isfile(env_bin):
        return env_bin
    for cand in sorted(glob.glob(
            "/home/lenovo/Applications/blender-5.2*-linux-x64/blender")):
        if os.path.isfile(cand):
            return cand
    return shutil.which("blender")


def unshare_available():
    try:
        r = subprocess.run(["unshare", "-rn", "true"], timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return r.returncode == 0
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Bootstrap executed inside Blender via --python-expr (runs on main thread).
# ---------------------------------------------------------------------------
_BOOTSTRAP = r'''
import bpy, os, sys, time, socket, threading, importlib.util
_work = os.environ.get("BLENDER_WORK") or os.getcwd()
os.chdir(_work)
# [image-studio bridge stdout-separation] Python-level stdout (bootstrap
# markers, pump errors, prints that escape exec's StringIO capture) goes to
# job-output.log; Blender engine logs keep going to blender.log via C-level
# fds (text-mode append: sys.stdout must be a text stream for print).
_joblog = open(os.path.join(_work, "job-output.log"), "a")
sys.stdout = _joblog
sys.stderr = _joblog
_spec = importlib.util.spec_from_file_location(
    "blender_addon", os.environ["BLENDER_ADDON_PATH"])
_mod = importlib.util.module_from_spec(_spec)
sys.modules["blender_addon"] = _mod
_spec.loader.exec_module(_mod)
_mod.register()
_srv = getattr(bpy.types, "blendermcp_server", None)
if _srv is None or not getattr(_srv, "running", False):
    _srv = _mod.BlenderMCPServer(port=int(os.environ.get("BLENDER_ADDON_PORT", "9876")))
    _srv.start()

_sock_path = os.environ.get("BLENDER_BRIDGE_SOCK")
if _sock_path:
    import struct as _struct, fcntl as _fcntl
    _SIOCSIFFLAGS = 0x8914
    _IFF_UP = 0x1
    _s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        _ifreq = _struct.pack("16sH", b"lo", _IFF_UP)
        _fcntl.ioctl(_s, _SIOCSIFFLAGS, _ifreq)
    except Exception as _e:
        print("BRIDGE_LO_UP_FAIL %s" % _e, flush=True)
    finally:
        try:
            _s.close()
        except Exception:
            pass

    def _bridge_pipe(_a, _b):
        try:
            while True:
                _d = _a.recv(65536)
                if not _d:
                    break
                _b.sendall(_d)
        except Exception:
            pass
        finally:
            try:
                _b.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    def _bridge_unix_to_tcp(_uc):
        try:
            _tc = socket.create_connection(
                ("127.0.0.1", int(os.environ.get("BLENDER_ADDON_PORT", "9876"))),
                timeout=5)
            _t1 = threading.Thread(target=_bridge_pipe, args=(_uc, _tc), daemon=True)
            _t2 = threading.Thread(target=_bridge_pipe, args=(_tc, _uc), daemon=True)
            _t1.start(); _t2.start(); _t1.join(); _t2.join()
        except Exception as _e:
            print("BRIDGE_FWD_ERR %s" % _e, flush=True)
        finally:
            try:
                _uc.close()
            except Exception:
                pass

    def _bridge_serve_unix():
        try:
            if os.path.exists(_sock_path):
                os.unlink(_sock_path)
            _ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _ls.bind(_sock_path)
            os.chmod(_sock_path, 0o600)
            _ls.listen(8)
            while True:
                _conn, _ = _ls.accept()
                threading.Thread(target=_bridge_unix_to_tcp, args=(_conn,),
                                 daemon=True).start()
        except Exception as _e:
            print("BRIDGE_UNIX_SERV_ERR %s" % _e, flush=True)

    threading.Thread(target=_bridge_serve_unix, daemon=True).start()

print("BRIDGE_BOOTSTRAP_READY", flush=True)

# Main-thread pump loop (replaces bpy.app.timers, which never fires in -b).
while getattr(_srv, "running", False):
    try:
        _iv = _srv._drain_command_queue()
    except Exception as _e:
        print("BRIDGE_PUMP_ERR %s" % _e, flush=True)
        _iv = 0.05
    time.sleep(_iv if isinstance(_iv, float) and _iv > 0 else 0.05)
print("BRIDGE_PUMP_EXIT", flush=True)
'''


class ExecutionTimeout(Exception):
    pass


class ConnectionLost(Exception):
    pass


def recv_json(sock, deadline):
    """Receive one JSON document (the addon sends exactly one per command)."""
    buf = b""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExecutionTimeout("recv timeout")
        sock.settimeout(min(remaining, 1.0))
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        except OSError as e:
            raise ConnectionLost("socket error: %s" % e)
        if not chunk:
            raise ConnectionLost("connection closed by blender")
        buf += chunk
        try:
            return json.loads(buf.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue


class BlenderSupervisor:
    """Owns the blender process and the transport to its addon socket."""

    def __init__(self, blender_bin=None, port=ADDON_PORT, workdir=None,
                 isolate=None, handshake_timeout=120.0):
        self.blender_bin = blender_bin or default_blender_bin()
        self.port = port
        self.workdir = workdir or os.getenv("BLENDER_WORK") or DEFAULT_WORKDIR
        self.handshake_timeout = handshake_timeout
        self.isolate = unshare_available() if isolate is None else bool(isolate)
        self.proc = None
        self.bridge_sock_path = os.path.join(self.workdir, "bridge.sock")
        self.log_path = os.path.join(self.workdir, "blender.log")
        self._lock = threading.RLock()

    # -- lifecycle ----------------------------------------------------------
    def is_alive(self):
        with self._lock:
            return self.proc is not None and self.proc.poll() is None

    def start(self, wait=True):
        with self._lock:
            if self.is_alive():
                return self.wait_handshake() if wait else None
            if not self.blender_bin or not os.path.isfile(self.blender_bin):
                raise RuntimeError(
                    "blender binary not found; set BLENDER_BIN (looked at %s)"
                    % self.blender_bin)
            os.makedirs(self.workdir, exist_ok=True)
            os.makedirs(os.path.join(self.workdir, "out"), exist_ok=True)
            # Rotate the previous generation aside (keep exactly one
            # generation in blender.log.1): old crash tracebacks used to
            # accumulate forever in blender.log and crowd script prints out
            # of the stdout_tail window. Safe here — the previous process is
            # already dead, so nothing holds the log fd; os.replace is atomic
            # and preserves the previous log for crash diagnosis (clearing
            # it would destroy the crash evidence).
            try:
                os.replace(self.log_path, self.log_path + ".1")
            except OSError:
                pass

            env = dict(os.environ)
            env["BLENDER_WORK"] = self.workdir
            env["BLENDER_ADDON_PATH"] = ADDON_PATH
            env["BLENDER_ADDON_PORT"] = str(self.port)
            env.pop("BLENDER_BRIDGE_SOCK", None)
            if self.isolate:
                env["BLENDER_BRIDGE_SOCK"] = self.bridge_sock_path

            cmd = []
            if self.isolate:
                cmd += ["unshare", "-rn"]
            cmd += [self.blender_bin, "--background", "--factory-startup",
                    "--disable-autoexec", "--python-expr", _BOOTSTRAP]

            # start_new_session => own process group => killpg reaches blender
            # and every child it spawned.
            with open(self.log_path, "ab") as log:
                log.write(("\n=== bridge launch %s isolate=%s ===\n"
                           % (time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                              self.isolate)).encode())
                log.flush()
                self.proc = subprocess.Popen(
                    cmd, cwd=self.workdir, env=env,
                    stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True)
            if not wait:
                return None
            return self.wait_handshake()

    def kill(self):
        with self._lock:
            proc, self.proc = self.proc, None
            if proc is None or proc.poll() is not None:
                return False
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=10)
            except Exception:
                pass
            return True

    # -- transport ----------------------------------------------------------
    def _connect(self, timeout_s):
        deadline = time.monotonic() + timeout_s
        last_err = None
        while time.monotonic() < deadline:
            if not self.is_alive():
                raise ConnectionLost(
                    "blender process exited (code %s); log tail: %s"
                    % (self.proc.poll() if self.proc else "?",
                       self.stdout_tail(500)))
            sock = None
            try:
                if self.isolate:
                    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    sock.connect(self.bridge_sock_path)
                else:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.connect(("127.0.0.1", self.port))
                sock.settimeout(5)
                return sock
            except OSError as e:
                last_err = e
                if sock:
                    try:
                        sock.close()
                    except Exception:
                        pass
                time.sleep(0.25)
        raise ConnectionLost("cannot reach blender addon socket: %s" % last_err)

    def call(self, cmd_type, params=None, timeout_s=60.0):
        """Send one command, return the parsed response dict."""
        deadline = time.monotonic() + timeout_s
        sock = self._connect(timeout_s)
        try:
            payload = json.dumps({"type": cmd_type, "params": params or {}})
            sock.sendall(payload.encode("utf-8"))
            return recv_json(sock, deadline)
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def wait_handshake(self, timeout=None):
        """Wait until get_addon_info answers; returns the handshake result."""
        timeout = self.handshake_timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        last_err = None
        while time.monotonic() < deadline:
            try:
                resp = self.call("get_addon_info", timeout_s=10)
                if resp.get("status") == "success":
                    return resp.get("result") or {}
                last_err = RuntimeError(
                    "handshake rejected: %s" % json.dumps(resp)[:300])
            except (ConnectionLost, ExecutionTimeout, OSError) as e:
                last_err = e
                if self.proc is not None and self.proc.poll() is not None:
                    raise ConnectionLost(
                        "blender exited during startup (code %s); log tail: %s"
                        % (self.proc.poll(), self.stdout_tail(1000)))
                time.sleep(0.5)
        raise ConnectionLost("handshake timeout after %.0fs: %s"
                             % (timeout, last_err))

    # -- observability ------------------------------------------------------
    def stdout_tail(self, max_chars=2000):
        try:
            size = os.path.getsize(self.log_path)
            with open(self.log_path, "rb") as f:
                f.seek(max(0, size - max(4096, int(max_chars) * 4)))
                data = f.read().decode("utf-8", errors="replace")
            return data[-int(max_chars):]
        except Exception as e:
            return "blender.log unavailable: %s" % e


def main():
    sup = BlenderSupervisor()
    info = sup.start()
    print("blender: %s" % sup.blender_bin)
    print("isolated: %s" % sup.isolate)
    print("workdir: %s" % sup.workdir)
    print("handshake: %s" % json.dumps(info, ensure_ascii=False))
    print("supervising... Ctrl+C to stop")
    try:
        while True:
            if not sup.is_alive():
                print("blender exited (code %s)"
                      % (sup.proc.poll() if sup.proc else "?"))
                return 1
            time.sleep(2)
    except KeyboardInterrupt:
        sup.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
