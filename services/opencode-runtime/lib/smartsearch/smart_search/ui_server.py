"""A short-lived loopback HTTP server for the local config UI.

Runs on demand, serves one page plus a small JSON API, and exits when the browser
tab goes away. There is no daemon and nothing to leave running, which is what the
feature request asked for.

The page reads and writes API keys, so the security model is the load-bearing part:

* the socket binds to 127.0.0.1 only, and no flag can make it bind anywhere else;
* every request carries a per-run token, compared with ``hmac.compare_digest``;
* ``Host`` must be loopback and ``Origin``, when present, must be same-origin, which
  is what stops a DNS-rebinding page from reaching the API;
* the token travels in a custom header, so any cross-origin attempt is preflighted,
  and ``OPTIONS`` is answered with 405 without ever emitting a CORS header. There are
  no cookies, so a hostile page has nothing to ride;
* routing is an explicit method+path dict with no filesystem mapping anywhere, so
  there is no path traversal to get wrong;
* responses carry only masked secrets.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import socket
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from . import ui_api

MAX_BODY_BYTES = 256 * 1024
DEFAULT_IDLE_TIMEOUT = 900.0
TOKEN_HEADER = "X-Smart-Search-Token"
ASSET_RELATIVE_PATH = ("assets", "ui", "index.html")


def load_page_source() -> str:
    """Read the bundled page, from a wheel, a source checkout or the npm venv."""
    try:
        from importlib.resources import files

        resource = files("smart_search")
        for part in ASSET_RELATIVE_PATH:
            resource = resource / part
        return resource.read_text(encoding="utf-8")
    except (ImportError, FileNotFoundError, ModuleNotFoundError, AttributeError, OSError):
        fallback = Path(__file__).resolve().parent.joinpath(*ASSET_RELATIVE_PATH)
        return fallback.read_text(encoding="utf-8")


@dataclass
class UIServerConfig:
    port: int = 0
    idle_timeout: float = DEFAULT_IDLE_TIMEOUT
    lang: str = "zh"
    open_browser: bool = True


@dataclass
class UIRuntime:
    """Per-run secrets and liveness, shared between the handler and the watchdog."""

    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    nonce: str = field(default_factory=lambda: secrets.token_urlsafe(16))
    idle_timeout: float = DEFAULT_IDLE_TIMEOUT
    lang: str = "zh"
    port: int = 0
    last_seen: float = field(default_factory=time.monotonic)
    stopping: threading.Event = field(default_factory=threading.Event)
    write_lock: threading.Lock = field(default_factory=threading.Lock)
    probe_slots: threading.Semaphore = field(default_factory=lambda: threading.Semaphore(4))

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    @property
    def origins(self) -> set[str]:
        return {f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"}

    @property
    def hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?token={self.token}"


def _run_async(coro) -> Any:
    """Each handler thread gets its own loop; the server itself stays synchronous."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class SmartSearchUIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "smart-search-ui"
    sys_version = ""
    # Without this a client that promises a body and never sends it pins a handler
    # thread for good. StreamRequestHandler turns it into a socket timeout.
    timeout = 30

    runtime: UIRuntime
    page_source: str

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        """Stay quiet: request lines would put the token in the terminal scrollback."""

    def _security_headers(self) -> list[tuple[str, str]]:
        return [
            ("Cache-Control", "no-store"),
            ("Pragma", "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "no-referrer"),
            ("X-Frame-Options", "DENY"),
            (
                "Content-Security-Policy",
                "default-src 'none'; "
                f"script-src 'nonce-{self.runtime.nonce}'; "
                "style-src 'unsafe-inline'; "
                "img-src data:; "
                "connect-src 'self'; "
                "form-action 'none'; "
                "base-uri 'none'; "
                "frame-ancestors 'none'",
            ),
        ]

    def _respond(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        for name, value in self._security_headers():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        if getattr(self, "_body_rejected", False):
            # Send FIN after the response, then briefly drain the transport. On
            # Windows closing with unread upload bytes can discard the 413/411.
            # This is not HTTP parsing: this connection will never be reused.
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            deadline, remaining = time.monotonic() + 0.25, MAX_BODY_BYTES * 2
            while remaining > 0 and time.monotonic() < deadline:
                self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                try:
                    chunk = self.connection.recv(min(65536, remaining))
                except OSError:
                    break
                if not chunk:
                    break
                remaining -= len(chunk)

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._respond(code, body, "application/json; charset=utf-8")

    def _forbidden(self) -> None:
        # Deliberately vague: a probe learns nothing about which check it failed.
        self._json(403, {"ok": False, "error_type": "auth_error", "error": "forbidden"})

    # -- security ---------------------------------------------------------
    def _origin_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in self.runtime.hosts:
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin.lower() not in self.runtime.origins:
            return False
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site and site not in {"same-origin", "none"}:
            return False
        return True

    def _token_ok(self, supplied: str) -> bool:
        return bool(supplied) and hmac.compare_digest(supplied, self.runtime.token)

    def _read_body(self) -> tuple[dict[str, Any] | None, str]:
        if (self.headers.get("Transfer-Encoding") or "").strip().lower() == "chunked":
            return None, "chunked"
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return {}, ""
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            return None, "bad-length"
        if length < 0 or length > MAX_BODY_BYTES:
            return None, "too-large"
        if length == 0:
            return {}, ""
        try:
            raw = self.rfile.read(length)
        except (OSError, socket.timeout, TimeoutError):
            return None, "incomplete"
        if len(raw) != length:
            return None, "incomplete"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, "bad-json"
        if not isinstance(payload, dict):
            return None, "bad-json"
        return payload, ""

    # -- routing ----------------------------------------------------------
    def _split_path(self) -> tuple[str, dict[str, str]]:
        raw = self.path or "/"
        path, _, query_text = raw.partition("?")
        query: dict[str, str] = {}
        for chunk in query_text.split("&"):
            if not chunk:
                continue
            name, _, value = chunk.partition("=")
            from urllib.parse import unquote_plus

            query[unquote_plus(name)] = unquote_plus(value)
        return path, query

    def do_OPTIONS(self) -> None:  # noqa: N802
        # No CORS headers, ever. A cross-origin preflight must simply fail.
        self._json(405, {"ok": False, "error_type": "parameter_error", "error": "method not allowed"})

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._json(405, {"ok": False, "error_type": "parameter_error", "error": "method not allowed"})

    do_DELETE = do_PUT  # noqa: N815
    do_PATCH = do_PUT  # noqa: N815

    def _handle(self, method: str) -> None:
        try:
            path, query = self._split_path()
            if not self._origin_ok():
                self._forbidden()
                return

            if method == "GET" and path == "/":
                if not self._token_ok(query.get("token", "")):
                    self._forbidden()
                    return
                self.runtime.touch()
                page = (
                    self.page_source
                    .replace("__SS_UI_TOKEN__", self.runtime.token)
                    .replace("__SS_UI_NONCE__", self.runtime.nonce)
                    .replace("__SS_UI_LANG__", self.runtime.lang)
                )
                self._respond(200, page.encode("utf-8"), "text/html; charset=utf-8")
                return

            if not path.startswith("/api/"):
                self._json(404, {"ok": False, "error_type": "parameter_error", "error": "not found"})
                return

            if not self._token_ok(self.headers.get(TOKEN_HEADER, "")):
                self._forbidden()
                return

            body: dict[str, Any] = {}
            if method == "POST":
                body, problem = self._read_body()
                if problem:
                    # The body was refused unread, so the connection can no longer be
                    # reused: whatever is still in flight would look like a new request.
                    self.close_connection = True
                    self._body_rejected = True
                if problem == "chunked":
                    self._json(411, {"ok": False, "error_type": "parameter_error", "error": "length required"})
                    return
                if problem == "too-large":
                    self._json(413, {"ok": False, "error_type": "parameter_error", "error": "request body too large"})
                    return
                if problem:
                    self._json(400, {"ok": False, "error_type": "parameter_error", "error": "invalid JSON body"})
                    return

            self.runtime.touch()
            handler = ROUTES.get((method, path))
            if handler is None:
                self._json(404, {"ok": False, "error_type": "parameter_error", "error": "not found"})
                return
            self._json(200, handler(self, body, query))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout, TimeoutError):
            self.close_connection = True
            return
        except Exception:
            # Never leak a traceback to the page.
            try:
                self._json(500, {"ok": False, "error_type": "runtime_error", "error": "internal error"})
            except Exception:
                return


# -- endpoint handlers ----------------------------------------------------
Handler = Callable[[SmartSearchUIHandler, dict[str, Any], dict[str, str]], dict[str, Any]]


def _h_state(handler, body, query):
    return ui_api.state()


def _h_status(handler, body, query):
    return ui_api.status()


def _h_test(handler, body, query):
    with handler.runtime.probe_slots:
        return _run_async(ui_api.test_provider(body))


def _h_doctor(handler, body, query):
    return _run_async(ui_api.run_doctor())


def _h_reset(handler, body, query):
    with handler.runtime.write_lock:
        return ui_api.reset_health(body)


def _h_config(handler, body, query):
    # One lock for every write, so two open tabs cannot interleave.
    with handler.runtime.write_lock:
        return ui_api.apply_config(body)


def _h_preview(handler, body, query):
    return ui_api.preview(body)


def _h_run(handler, body, query):
    with handler.runtime.probe_slots:
        return _run_async(ui_api.run_query(body))


def _h_skills_install(handler, body, query):
    with handler.runtime.write_lock:
        return ui_api.skills_install(body)


def _h_skills(handler, body, query):
    return ui_api.skills_status(query.get("targets"))


def _h_heartbeat(handler, body, query):
    runtime = handler.runtime
    if runtime.idle_timeout <= 0:
        return {"ok": True, "idle_deadline_seconds": 0, "idle_timeout": 0}
    remaining = runtime.idle_timeout - (time.monotonic() - runtime.last_seen)
    return {
        "ok": True,
        "idle_deadline_seconds": round(max(0.0, remaining), 1),
        "idle_timeout": runtime.idle_timeout,
    }


def _h_shutdown(handler, body, query):
    handler.runtime.stopping.set()
    return {"ok": True}


ROUTES: dict[tuple[str, str], Handler] = {
    ("GET", "/api/state"): _h_state,
    ("GET", "/api/status"): _h_status,
    ("GET", "/api/skills"): _h_skills,
    ("POST", "/api/config"): _h_config,
    ("POST", "/api/preview"): _h_preview,
    ("POST", "/api/skills/install"): _h_skills_install,
    ("POST", "/api/run"): _h_run,
    ("POST", "/api/test"): _h_test,
    ("POST", "/api/doctor"): _h_doctor,
    ("POST", "/api/providers/reset"): _h_reset,
    ("POST", "/api/heartbeat"): _h_heartbeat,
    ("POST", "/api/shutdown"): _h_shutdown,
}


# -- lifecycle ------------------------------------------------------------
def build_server(options: UIServerConfig) -> tuple[ThreadingHTTPServer, UIRuntime]:
    runtime = UIRuntime(idle_timeout=options.idle_timeout, lang=options.lang)
    page_source = load_page_source()

    class BoundHandler(SmartSearchUIHandler):
        pass

    BoundHandler.runtime = runtime
    BoundHandler.page_source = page_source

    # 127.0.0.1 is not configurable: this page edits API keys and has no business
    # listening on an interface anyone else can reach.
    httpd = ThreadingHTTPServer(("127.0.0.1", options.port), BoundHandler)
    httpd.daemon_threads = True
    runtime.port = httpd.server_address[1]
    return httpd, runtime


def _watchdog(httpd: ThreadingHTTPServer, runtime: UIRuntime) -> None:
    while not runtime.stopping.wait(timeout=1.0):
        if runtime.idle_timeout > 0 and time.monotonic() - runtime.last_seen > runtime.idle_timeout:
            break
    httpd.shutdown()


def _should_open_browser(options: UIServerConfig) -> bool:
    """Only try when a browser could plausibly appear.

    On a headless Linux box ``webbrowser`` happily launches a terminal browser such
    as www-browser, which takes over the TTY the URL was just printed to.
    """
    if not options.open_browser:
        return False
    if os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"):
        return False
    if sys.platform.startswith("linux"):
        if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            return True
        return bool(os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"))
    return True


def _startup_notes(runtime: UIRuntime, opened: bool, lang: str) -> list[str]:
    zh = lang == "zh"
    notes = [
        ("配置页已启动：" if zh else "Config UI is running at:"),
        f"  {runtime.url}",
        "",
        (
            "链接里的 token 每次启动都会换，只在本机有效。"
            if zh
            else "The token in that link is regenerated on every run and only works on this machine."
        ),
    ]
    if not opened:
        notes.append(
            "没有自动打开浏览器，复制上面的地址即可。" if zh else "No browser was opened; copy the URL above."
        )
        notes.append(
            f"  远程机器上可以转发端口： ssh -L 8765:127.0.0.1:{runtime.port} 用户@主机"
            if zh
            else f"  From a remote host: ssh -L 8765:127.0.0.1:{runtime.port} user@host"
        )
    if runtime.idle_timeout > 0:
        notes.append(
            f"关掉页面后 {int(runtime.idle_timeout)} 秒内自动退出，按 Ctrl+C 也可以。"
            if zh
            else f"Exits on its own {int(runtime.idle_timeout)}s after the tab closes, or press Ctrl+C."
        )
    return notes


def serve(options: UIServerConfig, *, announce: Callable[[str], None] = lambda line: None) -> dict[str, Any]:
    """Run the UI until the tab closes, the idle timeout expires, or Ctrl+C."""
    httpd, runtime = build_server(options)
    started = time.time()

    opened = False
    if _should_open_browser(options):
        try:
            opened = webbrowser.open(runtime.url)
        except Exception:
            opened = False

    for line in _startup_notes(runtime, opened, options.lang):
        announce(line)

    watchdog = threading.Thread(target=_watchdog, args=(httpd, runtime), daemon=True)
    watchdog.start()
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        runtime.stopping.set()
        httpd.server_close()
    return {
        "ok": True,
        "url": runtime.url,
        "port": runtime.port,
        "pid": os.getpid(),
        "idle_timeout": runtime.idle_timeout,
        "duration_seconds": round(time.time() - started, 3),
    }
