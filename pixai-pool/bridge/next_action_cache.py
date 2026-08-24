"""Next-Action ID 缓存与自动刷新。

适用场景：Next.js Server Action 的 Action ID 会随部署变更而失效。
本模块提供 bootstrap → 缓存 → 自动失效 → 重新提取 的完整生命周期。

=== 用法 ===
```python
from next_action_cache import NextActionCache

cache = NextActionCache("mage-space", "https://www.mage.space/explore")

# 获取生成 Action ID（自动从缓存或页面提取）
gen_id = cache.get("generation",
    bootstrap="4005bcac9aed1481ebb903b9c5911acac73f432ff6",
    page_url="https://www.mage.space/explore",
)

# 获取轮询 Action ID
poll_id = cache.get("poll_history",
    bootstrap="",  # 未知，从页面提取
    page_url="https://www.mage.space/explore",
)

# 标记失效（下次调用自动重新提取）
cache.invalidate("generation")

# 强制刷新
cache.force_refresh("poll_history", page_url="https://www.mage.space/explore")
```

=== 缓存文件格式 ===
```
~/.cache/mage-space/next-action-cache.json
{
  "generation": {
    "id": "4005bcac9aed1481ebb903b9c5911acac73f432ff6",
    "updated_at": 1786965742.635,
    "source": "bootstrap"
  },
  "poll_history": {
    "id": "a1b2c3d4e5f6...",
    "updated_at": 1786965742.635,
    "source": "page-extract"
  }
}
```
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Optional

# 正则：从 JS bundle 中提取 Next-Action ID
_NEXT_ACTION_RE = re.compile(
    r'(?:\$ACTION_ID_|next-action["\']?\s*[:=]\s*["\']|["\'])([0-9a-f]{40,44})["\']',
    re.I,
)
_SERVER_REF_RE = re.compile(
    r'createServerReference\)?\(["\']([0-9a-f]{40,44})["\']',
    re.I,
)
_CALL_SERVER_RE = re.compile(
    r'["\']([0-9a-f]{40,44})["\']\s*,\s*(?:callServer|findSourceMapURL)',
    re.I,
)

# 缓存 TTL（秒）：bootstrap 来源 24h，页面提取 7d
BOOTSTRAP_TTL = 24 * 3600
EXTRACT_TTL = 7 * 24 * 3600


class NextActionCache:
    """Next-Action ID 缓存管理器。

    每个平台实例化一个对象，缓存文件位于 ~/.cache/<platform>/next-action-cache.json。
    """

    def __init__(self, platform: str, page_url: str = ""):
        self.platform = platform
        self.page_url = page_url
        cache_dir = Path.home() / ".cache" / platform
        cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_path = cache_dir / "next-action-cache.json"
        self._data: dict[str, dict] = {}

    # ── 公开 API ──────────────────────────────────────────────────

    def get(self, key: str, *, bootstrap: str = "", page_url: str = "") -> str:
        """获取 Action ID。

        优先级：
        1. 磁盘缓存（未过期）
        2. bootstrap（首次）
        3. 从页面 JS bundle 提取

        Args:
            key: Action ID 的用途标识（如 "generation", "poll_history"）
            bootstrap: 内置的已知 ID，仅在缓存为空时使用
            page_url: 页面 URL，用于提取 JS bundle（空时用 self.page_url）
        """
        now = time.time()

        # 1. 读缓存
        entry = self._load().get(key)
        if entry:
            action_id = str(entry.get("id") or "").strip()
            source = str(entry.get("source") or "")
            updated = float(entry.get("updated_at") or 0)
            ttl = BOOTSTRAP_TTL if source == "bootstrap" else EXTRACT_TTL
            if action_id and len(action_id) >= 40 and (now - updated) < ttl:
                return action_id
            # 缓存过期，清除
            self._remove(key)

        # 2. bootstrap
        bootstrap = bootstrap.strip()
        if bootstrap and len(bootstrap) >= 40:
            self._set(key, bootstrap, source="bootstrap")
            return bootstrap

        # 3. 从页面提取
        page_url = page_url or self.page_url
        if not page_url:
            return ""
        action_id = self._extract_from_page(page_url, key)
        if action_id:
            self._set(key, action_id, source="page-extract")
            return action_id
        return ""

    def invalidate(self, key: str) -> None:
        """标记某 Action ID 失效（下次 get 时重新提取）。"""
        self._remove(key)

    def invalidate_all(self) -> None:
        """清除全部缓存。"""
        self._data = {}
        self._persist()

    def force_refresh(self, key: str, *, page_url: str = "") -> str:
        """强制刷新某 Action ID，忽略缓存。"""
        page_url = page_url or self.page_url
        if not page_url:
            return ""
        self._remove(key)
        action_id = self._extract_from_page(page_url, key)
        if action_id:
            self._set(key, action_id, source="page-extract")
        return action_id

    # ── 缓存管理 ──────────────────────────────────────────────────

    def _load(self) -> dict:
        if self._data:
            return self._data
        if self._cache_path.exists():
            try:
                self._data = json.loads(self._cache_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                self._data = {}
        return self._data

    def _persist(self) -> None:
        try:
            self._cache_path.write_text(
                json.dumps(self._data, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _set(self, key: str, action_id: str, *, source: str = "bootstrap") -> None:
        self._data[key] = {
            "id": action_id,
            "updated_at": time.time(),
            "source": source,
        }
        self._persist()

    def _remove(self, key: str) -> None:
        if key in self._data:
            del self._data[key]
            self._persist()

    # ── 页面提取 ──────────────────────────────────────────────────

    def _extract_from_page(self, page_url: str, hint: str = "") -> str:
        """从页面 HTML 和 JS bundle 中提取 Action ID。

        策略：
        1. 获取页面 HTML，查找 __NEXT_DATA__ 或 script src
        2. 对每个 JS chunk 搜索 Action ID 模式
        3. 优先返回匹配 hint 关键词的 ID
        """
        try:
            html = self._fetch_text(page_url)
        except Exception:
            return ""

        # 收集所有 JS chunk URL
        chunk_urls = set()
        for m in re.finditer(r'src=["\']([^"\']+\.js)["\']', html):
            src = m.group(1)
            if src.startswith("/"):
                src = self._resolve_url(page_url, src)
            chunk_urls.add(src)

        # 从 JS chunk 中提取 Action ID
        candidates = []
        for chunk_url in chunk_urls:
            try:
                js = self._fetch_text(chunk_url)
            except Exception:
                continue
            for pattern in (_NEXT_ACTION_RE, _SERVER_REF_RE, _CALL_SERVER_RE):
                for m in pattern.finditer(js):
                    action_id = m.group(1).strip().lower()
                    if re.match(r'^[0-9a-f]{40,44}$', action_id):
                        candidates.append(action_id)

        if not candidates:
            return ""

        # 如果有 hint，尝试匹配（hint 可能是 Action ID 的前缀或用途描述）
        if hint:
            for c in candidates:
                if hint in c:
                    return c

        # 返回第一个有效 ID
        return candidates[0]

    def _fetch_text(self, url: str) -> str:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/138.0.0.0 Safari/537.36"
                ),
            },
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode("utf-8", errors="replace")

    def _resolve_url(self, base: str, path: str) -> str:
        from urllib.parse import urljoin
        return urljoin(base, path)


# ── 快捷函数（mage.space 专用） ──────────────────────────────────────

_MAGE_ACTION_CACHE: Optional[NextActionCache] = None


def _mage_cache() -> NextActionCache:
    global _MAGE_ACTION_CACHE
    if _MAGE_ACTION_CACHE is None:
        _MAGE_ACTION_CACHE = NextActionCache(
            "mage-space",
            page_url="https://www.mage.space/explore",
        )
    return _MAGE_ACTION_CACHE


def get_mage_action_id(key: str, *, bootstrap: str = "", page_url: str = "") -> str:
    """获取 mage.space 的 Next-Action ID。

    预定义的 key：
    - "generation"    → 生成请求（bootstrap: 4005bcac...）
    - "balance"       → 余额查询（bootstrap: 00294718...）
    - "poll_history"  → 历史记录轮询（未知，需从页面提取）

    Args:
        key: Action ID 的用途标识
        bootstrap: 内置的已知 ID（仅在缓存为空时使用）
        page_url: 页面 URL，用于从 JS bundle 提取（空时用默认值）
    """
    return _mage_cache().get(key, bootstrap=bootstrap, page_url=page_url)


def invalidate_mage_action_id(key: str) -> None:
    _mage_cache().invalidate(key)


# 已知的 mage.space Action ID（2026-08-17 实测）
MAGE_KNOWN_ACTION_IDS = {
    "generation": "4005bcac9aed1481ebb903b9c5911acac73f432ff6",
    "balance": "00294718d1095dc4d10e5fd5de80df5acfc4fc2d32",
    # "poll_history": 待发现
}


if __name__ == "__main__":
    # 命令行测试
    import sys
    if len(sys.argv) >= 2:
        key = sys.argv[1]
        bootstrap = MAGE_KNOWN_ACTION_IDS.get(key, "")
        action_id = get_mage_action_id(key, bootstrap=bootstrap)
        print(f"{key}: {action_id}")
    else:
        for key in MAGE_KNOWN_ACTION_IDS:
            action_id = get_mage_action_id(key, bootstrap=MAGE_KNOWN_ACTION_IDS[key])
            print(f"{key}: {action_id}")