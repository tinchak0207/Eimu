"""Thread-safe rotating proxy pool for adobe2api upstream requests.

All behaviour is driven by environment variables and is fully backward
compatible: when ADOBE_PROXY_POOL is unset or empty the pool is disabled and
every method is a no-op (pick() returns "" so callers keep their static
proxy semantics).

No third-party dependencies beyond `requests` (already used by the service).
Importing this module has zero side effects; the singleton is built lazily
by get_proxy_pool().
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Set

import requests

logger = logging.getLogger(__name__)

_PROBE_URL = "https://api64.ipify.org"

_POOL_SINGLETON: Optional["ProxyPool"] = None
_POOL_SINGLETON_LOCK = threading.Lock()


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        val = int(str(raw).strip())
    except Exception:
        return default
    return max(lo, min(hi, val))


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _env_status_codes(name: str, default: Set[int]) -> Set[int]:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return set(default)
    codes: Set[int] = set()
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            code = int(part)
        except Exception:
            continue
        if 100 <= code <= 599:
            codes.add(code)
    return codes or set(default)


def _parse_proxy_urls(raw: Optional[str]) -> List[str]:
    if raw is None or not str(raw).strip():
        return []
    urls: List[str] = []
    seen = set()
    for part in str(raw).split(","):
        url = part.strip()
        if not url or url in seen:
            continue
        seen.add(url)
        urls.append(url)
    return urls


class ProxyPool:
    """Rotating proxy pool with failure cooldowns and background health probes."""

    def __init__(
        self,
        proxy_urls: List[str],
        *,
        network_cooldown_seconds: int = 90,
        risk_cooldown_seconds: int = 1800,
        risk_status_codes: Optional[Set[int]] = None,
        max_failures_before_cooldown: int = 2,
        health_probe_interval: int = 300,
        probe_timeout_seconds: int = 5,
        allow_direct: bool = False,
        probe_url: str = _PROBE_URL,
    ) -> None:
        self.enabled = bool(proxy_urls)
        self.network_cooldown_seconds = max(1, int(network_cooldown_seconds))
        self.risk_cooldown_seconds = max(1, int(risk_cooldown_seconds))
        self.risk_status_codes: Set[int] = set(
            risk_status_codes if risk_status_codes is not None else {408, 429}
        )
        self.max_failures_before_cooldown = max(1, int(max_failures_before_cooldown))
        self.health_probe_interval = max(5, int(health_probe_interval))
        self.probe_timeout_seconds = max(1, int(probe_timeout_seconds))
        self.allow_direct = bool(allow_direct)
        self.probe_url = probe_url

        self._lock = threading.Lock()
        self._states: Dict[str, Dict[str, Any]] = {
            url: {
                "url": url,
                "status": "unknown",
                "consecutive_failures": 0,
                "risk_count": 0,
                "last_used_at": None,
                "last_exit_ip": None,
                "cooldown_until": None,
            }
            for url in proxy_urls
        }
        self._last_picked: Optional[str] = None
        self._probe_stop = threading.Event()
        self._probe_thread: Optional[threading.Thread] = None
        if self.enabled:
            logger.info(
                "proxy pool enabled with %d proxies (network_cooldown=%ss risk_cooldown=%ss "
                "max_failures=%d probe_interval=%ss allow_direct=%s)",
                len(self._states),
                self.network_cooldown_seconds,
                self.risk_cooldown_seconds,
                self.max_failures_before_cooldown,
                self.health_probe_interval,
                self.allow_direct,
            )
            self._probe_thread = threading.Thread(
                target=self._probe_loop,
                name="proxy-pool-probe",
                daemon=True,
            )
            self._probe_thread.start()
        else:
            logger.info("proxy pool disabled (no proxies configured)")

    # ------------------------------------------------------------------ pick

    def _thaw_expired(self, now: float) -> None:
        for state in self._states.values():
            if (
                state["status"] == "cooldown"
                and state["cooldown_until"] is not None
                and state["cooldown_until"] <= now
            ):
                state["status"] = "unknown"
                state["cooldown_until"] = None
                state["consecutive_failures"] = 0

    def pick(self) -> str:
        if not self.enabled:
            return ""
        now = time.time()
        with self._lock:
            self._thaw_expired(now)
            candidates = [
                state
                for state in self._states.values()
                if state["status"] in ("unknown", "healthy")
            ]
            if candidates:
                # oldest last_used_at first (never used wins) -> natural rotation
                chosen = min(
                    candidates,
                    key=lambda s: (
                        s["last_used_at"] if s["last_used_at"] is not None else 0.0
                    ),
                )
                chosen["last_used_at"] = now
                url = chosen["url"]
                if url != self._last_picked:
                    logger.info("proxy pool pick -> %s", url)
                self._last_picked = url
                return url
            # nothing available: honour PROXY_ALLOW_DIRECT policy
            if self.allow_direct:
                logger.warning(
                    "proxy pool exhausted (all cooling/unhealthy); allow_direct=1 -> direct connection"
                )
                return ""
            # never fall back to direct: return the earliest-thawing proxy;
            # if none has a scheduled thaw (all unhealthy), take the stalest one.
            with_thaw = [
                s for s in self._states.values() if s["cooldown_until"] is not None
            ]
            if with_thaw:
                chosen = min(with_thaw, key=lambda s: s["cooldown_until"])
            else:
                chosen = min(
                    self._states.values(),
                    key=lambda s: (
                        s["last_used_at"] if s["last_used_at"] is not None else 0.0
                    ),
                )
            url = chosen["url"]
            logger.warning(
                "proxy pool exhausted (all cooling/unhealthy); forced earliest-thaw proxy %s",
                url,
            )
            return url

    # --------------------------------------------------------------- reports

    def report_success(self, url: str) -> None:
        if not self.enabled or not url:
            return
        with self._lock:
            state = self._states.get(url)
            if state is None:
                return
            was = state["status"]
            state["consecutive_failures"] = 0
            state["status"] = "healthy"
            state["cooldown_until"] = None
            if was != "healthy":
                logger.info("proxy %s healthy again (was %s)", url, was)

    def report_network_failure(self, url: str) -> None:
        if not self.enabled or not url:
            return
        with self._lock:
            state = self._states.get(url)
            if state is None:
                return
            state["consecutive_failures"] = int(state["consecutive_failures"] or 0) + 1
            if state["consecutive_failures"] >= self.max_failures_before_cooldown:
                state["status"] = "cooldown"
                state["cooldown_until"] = time.time() + self.network_cooldown_seconds
                state["consecutive_failures"] = 0
                logger.warning(
                    "proxy %s network cooldown %ss (>= %d consecutive failures)",
                    url,
                    self.network_cooldown_seconds,
                    self.max_failures_before_cooldown,
                )

    def report_risk_failure(self, url: str) -> None:
        if not self.enabled or not url:
            return
        with self._lock:
            state = self._states.get(url)
            if state is None:
                return
            state["risk_count"] = int(state["risk_count"] or 0) + 1
            state["status"] = "cooldown"
            state["cooldown_until"] = time.time() + self.risk_cooldown_seconds
            state["consecutive_failures"] = 0
            logger.warning(
                "proxy %s risk cooldown %ss (risk_count=%d)",
                url,
                self.risk_cooldown_seconds,
                state["risk_count"],
            )

    # ---------------------------------------------------------------- probe

    def _probe_one(self, url: str) -> tuple:
        try:
            resp = requests.get(
                self.probe_url,
                proxies={"http": url, "https": url},
                timeout=self.probe_timeout_seconds,
            )
            if resp.status_code == 200:
                exit_ip = str(resp.text or "").strip()[:64]
                return url, True, exit_ip
            return url, False, None
        except Exception:
            return url, False, None

    def _probe_loop(self) -> None:
        try:
            self._run_probe_cycle()
            while not self._probe_stop.wait(self.health_probe_interval):
                self._run_probe_cycle()
        except Exception:
            # probe failures must never kill the loop silently-restarting path
            logger.debug("proxy pool probe loop crashed", exc_info=True)

    def _run_probe_cycle(self) -> None:
        try:
            now = time.time()
            with self._lock:
                self._thaw_expired(now)
                targets = [
                    state["url"]
                    for state in self._states.values()
                    if state["status"] in ("unknown", "unhealthy")
                ]
            if not targets:
                return
            with ThreadPoolExecutor(
                max_workers=min(len(targets), 16), thread_name_prefix="proxy-probe"
            ) as executor:
                results = list(executor.map(self._probe_one, targets))
            with self._lock:
                for url, ok, exit_ip in results:
                    state = self._states.get(url)
                    if state is None:
                        continue
                    if ok:
                        state["status"] = "healthy"
                        state["last_exit_ip"] = exit_ip
                        state["consecutive_failures"] = 0
                        logger.info(
                            "proxy %s probe ok (exit_ip=%s)", url, exit_ip or "?"
                        )
                    else:
                        state["status"] = "unhealthy"
                        logger.info("proxy %s probe failed", url)
        except Exception:
            logger.debug("proxy pool probe cycle failed", exc_info=True)

    # ------------------------------------------------------------ observability

    def snapshot(self) -> List[Dict[str, Any]]:
        with self._lock:
            now = time.time()
            return [
                {
                    "url": state["url"],
                    "status": state["status"],
                    "consecutive_failures": state["consecutive_failures"],
                    "risk_count": state["risk_count"],
                    "last_used_at": state["last_used_at"],
                    "last_exit_ip": state["last_exit_ip"],
                    "cooldown_until": state["cooldown_until"],
                    "cooldown_remaining_seconds": (
                        max(0, int(state["cooldown_until"] - now))
                        if state["cooldown_until"] is not None
                        else 0
                    ),
                }
                for state in self._states.values()
            ]

    def shutdown(self) -> None:
        """Stop the background probe thread (best effort; daemon anyway)."""
        self._probe_stop.set()


def get_proxy_pool() -> ProxyPool:
    """Return the process-wide ProxyPool singleton built from env vars.

    Importing this module has no side effects; the pool (and its background
    probe thread) is created lazily on first call. When ADOBE_PROXY_POOL is
    unset or empty, a disabled pool is returned whose every method is a no-op.
    """
    global _POOL_SINGLETON
    if _POOL_SINGLETON is not None:
        return _POOL_SINGLETON
    with _POOL_SINGLETON_LOCK:
        if _POOL_SINGLETON is None:
            proxy_urls = _parse_proxy_urls(os.getenv("ADOBE_PROXY_POOL"))
            _POOL_SINGLETON = ProxyPool(
                proxy_urls,
                network_cooldown_seconds=_env_int(
                    "PROXY_NETWORK_COOLDOWN_SECONDS", 90, 1, 86400
                ),
                risk_cooldown_seconds=_env_int(
                    "PROXY_RISK_COOLDOWN_SECONDS", 1800, 1, 86400
                ),
                risk_status_codes=_env_status_codes("PROXY_RISK_STATUS_CODES", {408, 429}),
                max_failures_before_cooldown=_env_int(
                    "PROXY_MAX_FAILURES_BEFORE_COOLDOWN", 2, 1, 100
                ),
                health_probe_interval=_env_int(
                    "PROXY_HEALTH_PROBE_INTERVAL", 300, 10, 86400
                ),
                probe_timeout_seconds=_env_int("PROXY_PROBE_TIMEOUT_SECONDS", 5, 1, 60),
                allow_direct=_env_bool("PROXY_ALLOW_DIRECT", False),
            )
        return _POOL_SINGLETON
