"""Independent CLI update metadata; native SDKs own App package updates."""
from __future__ import annotations
from .i18n import tr

import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import time

import httpx

REPOSITORY = "konbakuyomu/smartsearch"
RELEASE_URL = f"https://github.com/{REPOSITORY}/releases"
NPM_URL = "https://registry.npmjs.org/@konbakuyomu%2fsmart-search/latest"
PACKAGE = "@konbakuyomu/smart-search"


def stable_version(value):
    match = re.fullmatch(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?", str(value))
    return tuple(map(int, match.groups())) if match else None


def newer(remote, current):
    a, b = stable_version(remote), stable_version(current)
    return a is not None and b is not None and a > b


def platform_target():
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"amd64", "x86_64"} else "unsupported"
    system = "windows" if os.name == "nt" else "macos" if platform.system() == "Darwin" else "unsupported"
    return system, "x86_64" if system == "macos" and arch == "x64" else arch


def cache_directory():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "SmartSearch/updates"
    return Path.home() / "Library/Caches/SmartSearch/updates"


def verified_file(path, asset):
    if not path.is_file() or path.stat().st_size != asset["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == asset["sha256"]


def check_error(error):
    if isinstance(error, httpx.TimeoutException):
        return "timeout", tr('请求超时，请稍后重试。')
    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {403, 429}:
        return "rate_limited", tr('发行服务拒绝请求或限流，请稍后重试。')
    if isinstance(error, httpx.HTTPError):
        return "network_error", tr('无法连接发行服务，请检查网络后重试。')
    return "invalid_metadata", tr('发行信息不完整或无效，请查看官方发行页面。')


class Updates:
    def __init__(self, emit, *, directory=None):
        self.emit = emit
        self.directory = Path(directory) if directory else cache_directory()
        self.current_version = ""
        self.enabled = False
        self.check_task = self.cli_task = None
        self.state = {"auto_check": True, "last_attempt": 0, "last_success": 0, "checking": False,
                      "error": "", "app": {}, "cli": {},
                      "cli_update": {"status": "idle"}, "release_url": RELEASE_URL}
        try:
            saved = json.loads((self.directory / "state.json").read_text(encoding="utf-8"))
            if type(saved.get("auto_check")) is bool:
                self.state["auto_check"] = saved["auto_check"]
            for key in ("last_attempt", "last_success"):
                if type(saved.get(key)) in {int, float} and 0 <= saved[key] <= time.time():
                    self.state[key] = saved[key]
            for key in ("cli",):
                if isinstance(saved.get(key), dict):
                    self.state[key] = {k: v for k, v in saved[key].items()
                                       if k in {"latest_version", "latest_release", "checked_at", "package_pending"}}
                    self.state[key].update(available=False, error=tr('此前检查结果，需重新检查后才能更新。'), cached=True)
        except (OSError, ValueError, TypeError):
            pass

    def changed(self):
        self.emit("updates", self.state)

    def refresh_installed(self, cli_info):
        """Keep local facts current without promoting cached remote metadata."""
        self.state["app"] = {"current_version": self.current_version,
                             "version_known": stable_version(self.current_version) is not None,
                             "managed_by": "native", "available": False}
        self.state["installed_cli"] = dict(cli_info)
        status = self.state["cli"]
        current, latest = cli_info.get("external_version"), status.get("latest_version")
        fresh = bool(status.get("checked_at") and not status.get("cached") and not status.get("error"))
        repair = (stable_version(current) is not None and stable_version(current) == stable_version(latest)
                  and cli_info.get("can_update") and cli_info.get("external_runtime_verified") is False)
        status.update(current_version=current, runtime_needs_repair=bool(repair),
                      available=bool(fresh and (newer(latest, current) or repair)))
        status.pop("command", None)
        if fresh and cli_info.get("can_update") and stable_version(latest) is not None:
            from .desktop_cli import update_command
            command = update_command(cli_info, latest)
            status["command"] = subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)

    def save(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        data = {k: self.state[k] for k in ("auto_check", "last_attempt", "last_success", "cli")}
        temporary = self.directory / "state.json.tmp"
        temporary.write_text(json.dumps(data), encoding="utf-8")
        temporary.replace(self.directory / "state.json")

    def auto_check(self, cli_info):
        if self.enabled and self.state["auto_check"] and time.time() - self.state["last_attempt"] >= 86400:
            self.check(cli_info)

    def check(self, cli_info):
        self.refresh_installed(cli_info)
        if self.check_task and not self.check_task.done():
            return self.state
        self.state.update(checking=True, last_attempt=time.time(), error="")
        self.save()
        self.changed()
        self.check_task = asyncio.create_task(self._check(dict(cli_info)))
        return self.state

    async def _check(self, cli_info):
        try:
            async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
                response = await client.get(NPM_URL)
                response.raise_for_status()
                latest = response.json()["version"]
                if stable_version(latest) is None:
                    raise ValueError(tr('invalid stable version'))
                self.state["cli"] = {"current_version": cli_info.get("external_version"), "latest_version": latest,
                                     "available": newer(latest, cli_info.get("external_version")),
                                     "checked_at": time.time(), "error": ""}
                self.state["last_success"] = time.time()
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            error_type, message = check_error(error)
            self.state["error"] = tr('CLI 检查失败：') + message
            self.state["cli"] = {**self.state["cli"], "error": self.state["error"], "error_type": error_type}
        finally:
            self.state["checking"] = False
            self.refresh_installed(self.state.get("installed_cli", cli_info))
            self.save()
            self.changed()

    async def close(self):
        if self.check_task and not self.check_task.done():
            self.check_task.cancel()
        await asyncio.gather(*(task for task in (self.check_task, self.cli_task) if task), return_exceptions=True)
